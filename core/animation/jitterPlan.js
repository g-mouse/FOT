/* ============ 抖动路径的规划（纯函数，零 DOM、零时钟） ============
   一根 K 线在「正在走」的那一小段里，现价要依次摸到它的 开/高/低/收，
   中间还得像真的行情那样来回蹭。这一层只负责算出**那条路径**：

     路径 = 几个触点（waypoints）+ 每个触点落在第几步（steps）+ 逐下标的值（base）
            + 叠加在上面的随机游走偏离（dev）

   规划一次、逐帧只查表 + 插值 —— 抖动是每帧都要读的（见 tickEngine.js）。

   ============ 这条路径的**规格**（用户口径，两个模式共用）============
     1) 起手扫到 Open、收尾落在 Close —— 第一个触点是开盘价、最后一个是收盘价；
     2) 中间**必须**碰到 High 与 Low，而**先碰哪一头是随机的**（50/50）；
     3) 中间的随机折返次数 N ∈ 1..5（设置里可调，也可以整个关掉，见 animSettings）；
     4) 所有折返都**不许越出 High/Low**：触点在带子里生成，随机游走撞到上下界
        是**反弹**（不是夹平），逐点读数再由 priceAt 夹一次。
     自检：tools/check-ticks.mjs（纯逻辑）+ tools/check-story-tick.mjs（真浏览器里量幅度）。

   ============ 这一段是从哪来的 ============
   原实现住在 modes/story/storyAnim.js 里（它原本只给故事模式用），
   与旧教程页 game/js/market/ticks.js 是同一套意思。现在两个模式都要抖动，
   所以整段搬进 core/ —— 搬的时候**算法一个字都没改**，只做了两件事：

     1) 随机源从 Math.random 改成可注入的 rnd()（默认仍是 Math.random）。
        传进来一条具名流就能得到确定性的路径 —— 于是「同一根 K 线两次抖动
        走一样的路」这件事可以逐点比对（tools/parity-jitter.mjs）。
        不传时行为与搬迁前逐帧一致。
     2) 拆出这个文件，让单文件守在**当时**的 400 行上限以内。

   ★ 后来有两处**有意**偏离 legacy（都在 parity-jitter 里写明）：
     · 1× 的 H/L 顺序：legacy 跟着涨跌方向走，现在 50/50 随机（规格第 2 条）；
     · 噪声层：手写的「随机数表 + 一维线性插值」换成 **simplex-noise**（vendor，MIT）。
       两者都用 `opts.firstExtreme` / 独立的噪声流对齐，所以**步数分配、骨架、
       幅度公式、撞界反弹、桥上收 0、阻尼**这些没改的部分仍然被 legacy 逐点比着。 */
CS.define('core/animation/jitterPlan', ["lib/simplex-noise"], function () {
  'use strict';

  /* 噪声库（vendor/，MIT），挂 window.SimplexNoise。
     装不上就直接抛 —— 静默退回「没有噪声」的抖动看起来仍然「在动」，
     只是退化成折线（旧注释叫它「机械臂」），而那种缺陷肉眼很难判定。
     ★ 两种形状都要认：池子里那份是 simplex-noise **4.x**，它挂出来的是命名空间对象
       （createNoise2D / createNoise3D / buildPermutationTable…），没有构造函数；
       2.x 才是 `new SimplexNoise(rnd)`。这里按形状判定，不按版本号猜 ——
       换回 2.x 的分发文件时这段代码照样能用。 */
  const SimplexNoise = window.SimplexNoise;
  const isFactory = typeof SimplexNoise === 'function';
  const isNamespace = !!SimplexNoise && typeof SimplexNoise.createNoise2D === 'function';
  if (!isFactory && !isNamespace) {
    throw new Error('vendor 没装齐：core/animation/jitterPlan.js 需要 window.SimplexNoise（simplex-noise）。见 index.html 的 vendor 段与 tools/build-vendor.mjs');
  }

  /* 一段抖动预先算好的步数：之后每帧只是查表 + 插值 */
  const STEPS = 400;
  /* OU 的回归强度（每单位进度）：相关时间约 1/THETA 个 tick */
  const THETA = 60;
  /* 触点上「站住」那一段的时长权重（普通一段均值 1） */
  const HOLD_WEIGHT = .18;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* ---------- 骨架：这一轮要走到哪些价 ----------
     1× = 四个触点 开 → 一个极值 → 另一个极值 → 收（OHLC 各扫一遍，这是默认值）；
     N× = 前两遍仍各认领一个真极值（保证四个价都扫得到），其余几遍在
     「随次数收窄的带子」里随机折返，最后一点一定是真实的收盘价。
     触点上「站住」一下（同一个价连着放两个点）：动画是逐帧采样的，
     不站住的话那个价正好落在两帧之间、屏幕上一次都不出现。

   ★ **先扫 High 还是先扫 Low，是随机的**（用户口径：O → 随机先碰 H 或 L → 另一个 → C）。
     1× 早期跟着涨跌方向走（`up ? low : high`），于是**每根阳线的路径都一模一样**：
     先向下蹭到 low、再上到 high、最后回收盘价 —— 看久了就是同一个动作重复。
     现在与 N× 共用同一个 `side` 抽取：50/50。
     ★ `opts.firstExtreme`（'low' | 'high'）是给 **parity 工具**用的：它把顺序钉成
       legacy 那一支，于是「步数分配 / 随机游走幅度 / 撞界反弹 / 桥上收 0 / 阻尼」
       这些**没改**的部分仍然被 legacy 逐点比着；而顺序这一处是**有意不同**，
       由 orderOf() 单独自检（见 tools/check-ticks.mjs 与 tools/parity-jitter.mjs）。
       传了它就**不消耗** rnd()，两边拿到的随机流因此仍然逐位对齐。 */
  function band(count, low, high) {
    const mid = (low + high) / 2;
    const half = (high - low) * .5 * Math.min(1, count / 5);
    return { from: mid - half, to: mid + half };
  }
  const turnAt = price => [{ price, turn: true }, { price, hold: true }];
  function waypoints(bar, count, rnd, opts) {
    const { open, high, low, close } = bar;
    const forced = opts && (opts.firstExtreme === 'low' || opts.firstExtreme === 'high') ? opts.firstExtreme : null;
    const points = [{ price: open }, { price: open, hold: true }];
    if (count === 1) {
      /* 1×：先碰哪一头**随机**（规格第 2 条）。★ legacy 这一支**不抽**随机数，
         所以传了 firstExtreme 时这里也不抽 —— parity 工具正是靠这一点
         让两条随机流逐位对齐（它把顺序钉成 legacy 那一支来比其余部分）。 */
      const first = forced || (rnd() < .5 ? 'low' : 'high');
      points.push(...turnAt(first === 'low' ? low : high), ...turnAt(first === 'low' ? high : low));
    } else {
      /* N×：**无论有没有 forced 都抽一次** —— legacy 在这一支抽一次，
         不抽就会让后面「步数分配」拿到错位的一串数（那正是 parity 要抓的）。 */
      const drawn = rnd() < .5 ? 'low' : 'high';
      const first = forced || drawn;
      const b = band(count, low, high);
      const mid = (b.from + b.to) / 2, half = (b.to - b.from) / 2;
      let side = first === 'low' ? -1 : 1;
      for (let round = 0; round < count; round++) {
        if (round > 0) points.push({ price: b.from + (b.to - b.from) * rnd() });
        const reach = half * (.35 + .65 * (1 - rnd() ** 2));
        const touch = round < 2 ? (side < 0 ? low : high) : (side < 0 ? mid - reach : mid + reach);
        points.push(...turnAt(touch));
        side = -side;
      }
    }
    points.push({ price: close });
    return points;
  }

  /* 每段的步数（正整数、合计 STEPS）：步数多少就是这一段占了多长时间 */
  function splitSteps(weights, rnd) {
    const w = weights.map(v => (Number.isFinite(v) ? v : .35 + rnd() * 1.3));
    const total = w.reduce((a, v) => a + v, 0) || 1;
    const raw = w.map(v => (v / total) * STEPS);
    const steps = raw.map(v => Math.max(1, Math.floor(v)));
    let used = steps.reduce((a, v) => a + v, 0);
    const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
    for (let k = 0; used < STEPS; k = (k + 1) % w.length) { steps[order[k].i]++; used++; }
    for (let k = 0; used > STEPS && k < order.length * 4; k = (k + 1) % w.length) {
      if (steps[order[k].i] > 1) { steps[order[k].i]--; used--; }
    }
    return steps;
  }

  /* ---------- 噪声：**simplex-noise**（vendor/，MIT），不再手写 ----------
     以前这一层是「rollTable(4) 随机数表 + 一维线性插值」自己搓的慢噪声
     （valueNoise）。换成 simplex 的两个理由：
       · 同样幅度下，simplex 的高低起伏更像行情 —— 手写那一版的插值节点少（4 个），
         拐点看得出来是折线；
       · 「不重写轮子」：噪声是有标准算法与被验证实现的东西，自己写只是重复。
     ★ 种子**不从随机流里抽**，而是从这一根 K 线的形状折出来的 32 位数。
       抽一次会让后面每一处随机调用错位一格 —— 实测多抽 1 个，同一档位第二根 K 线的
       段界就从 `[0,1,223,…]` 变成 `[0,1,138,…]`，而 parity 工具正是靠「两条流逐位对齐」
       才能把骨架与段划分逐点比下去（legacy 在这一层不抽数）。
       代价：形状完全相同的两根 K 线会有同一条调制包络；逐点扰动（gauss 那层）
       仍然各抽各的，所以路径不会真的重复。 */
  const NOISE_X = 1.7;      /* 一根 K 线里大约走两段噪声（越小越平缓） */
  const NOISE_Y = 0.5;
  function seedOf(bar) {
    const key = `${bar.open}|${bar.high}|${bar.low}|${bar.close}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
    return h;
  }
  function makeNoise(bar) {
    let a = seedOf(bar) >>> 0;
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /* ★ 2.x → 4.x 的适配就这几行：v4 用 createNoise2D(rnd) 造一个 (x,y) → [-1,1] 的函数。
       **噪声的具体实现换了**，所以 parity-jitter 对噪声层用的是统计比对
       （均值 / 方差 / 自相关），不是逐点相等 —— 逐点比的是骨架与段划分，那两层一个字符没动。 */
    const noise2D = isFactory
      ? (() => { const legacy = new SimplexNoise(rnd); return (x, y) => legacy.noise2D(x, y); })()
      : SimplexNoise.createNoise2D(rnd);
    return { noise2D };
  }

  /* Box–Muller：用 rnd() 造正态。u 夹开 0 免得 log(0) = -Infinity */
  const gauss = rnd => {
    const u = Math.max(1e-12, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };

  /* ---------- 怎么走过去：真的走一遍 OU 随机游走，再在每个触点处把偏离按线性桥收 0 ----------
     直线插值 + 叠噪声怎么调都像机械臂（方向翻转太少）；随机游走该来回蹭就来回蹭，
     而触点上的价仍然分毫不差。

   ★ 幅度必须与旧教程页 game/js/market/ticks.js 的规划**同一个量级**，这一条踩过：
     这份文件刚搬过来时用的是另一套尺度（`scale = max(span, 区间×.35) × .075`、
     不带 √(2θ)），量出来偏离只有整根区间的 **0.40%**（RMS），而旧实现是 **13.12%** ——
     差 33 倍，动画实际上退化成两个触点之间的直线，正是旧注释里花大篇幅修掉的「机械臂」。
     现在逐字照旧实现（**只有噪声那一个因子换了库**，见上面 makeNoise）：
       amp   = min(max(段跨度 × .22, 区间 × .08), 区间 × .2)     每段的幅度上限
       sigma = amp × √(2θ) × (.6 + .7 × (.5 + .5 × 慢噪声))      再被慢噪声调制（simplex）
       dev  += −dev × (θ/STEPS) + sigma × gauss() × √(1/STEPS)   OU 一步
       撞到 高/低 → 反弹（不是夹平：夹平会在极值处留一段不动的直线）
       触点上按线性桥收 0，并乘「紧挨触点时收一收」的阻尼 min(1, 8f(1−f))
       「站住」那一段整段清零（否则价格只是路过触点，还在抖）
     量具在 tools/experiments/tick-feel.cjs：改这里之后回去跑一遍，
     RMS/区间 应当落在 8%～14%（1× 与 3× 都看），而不是百分之零点几。
     ★ 换噪声之后这个量具要**重跑**：simplex 的输出分布与手写那版不同，
       但映射到同一个 `[.6, 1.3]` 区间，实测仍需落在带内（读数见 docs/VENDOR.md）。 */
  function buildPlan(bar, count, rnd, opts) {
    const random = typeof rnd === 'function' ? rnd : Math.random;
    const points = waypoints(bar, count, random, opts);
    const legs = points.length - 1;
    const range = bar.high - bar.low;
    /* 「站住」那一段（同一个价连着两个点）给一个**极小**的权重：
       它的长度是 0，但时间上要占一丁点 —— 一个 STEPS 都分不到的话，
       那个价只在 u 正好等于那一刻时成立，屏幕上一帧都留不住（见 waypoints 的注释）。 */
    const weights = [];
    for (let i = 1; i < points.length; i++) weights.push(points[i].hold ? HOLD_WEIGHT * .05 : null);
    const steps = splitSteps(weights, random);
    /* cum[k] = 第 k 个触点落在第几个下标（cum[0] = 0，cum[legs] = STEPS） */
    const cum = [0];
    steps.forEach(s => cum.push(cum[cum.length - 1] + s));
    /* 每个下标上「那条路径本身」的价（不含随机偏离）：一次算好，
       逐帧只做两次查表 + 一次插值 —— 抖动是每帧都要读的，别在帧里循环。 */
    const base = new Float64Array(STEPS + 1);
    for (let k = 0; k < legs; k++) {
      const from = points[k].price, to = points[k + 1].price;
      const a = cum[k], b = cum[k + 1];
      const len = Math.max(1, b - a);
      for (let i = a; i <= b; i++) base[i] = from + ((to - from) * (i - a)) / len;
    }
    /* 每段的跨度（给随机游走的尺度用：宽段抖得凶，触点附近收着） */
    const spanAt = k => {
      for (let i = 0; i < legs; i++) if (k <= cum[i + 1]) return Math.abs(points[i + 1].price - points[i].price);
      return Math.abs(points[legs].price - points[0].price);
    };
    /* 随机游走的偏离表（逐下标） */
    const dev = new Float64Array(STEPS + 1);
    const noise = makeNoise(bar);
    let val = 0;
    for (let i = 0; i <= STEPS; i++) {
      const u = i / STEPS;
      const span = spanAt(i);
      const amp = Math.min(Math.max(span * .22, range * .08), range * .2);
      /* 慢噪声调制（波动聚集）：simplex 的输出约在 ±0.9，映射到与旧口径同一个区间
         `[.6, 1.3]`，于是幅度带（tick-feel 量的 8%～14%）不需要重新定标。 */
      const mod = .6 + .7 * (.5 + .5 * noise.noise2D(u * NOISE_X, NOISE_Y));
      const sigma = amp * Math.sqrt(2 * THETA) * mod;
      val += -val * (THETA / STEPS) + sigma * gauss(random) * Math.sqrt(1 / STEPS);
      /* 撞到上下界就**反弹**（反射，不是夹平）——夹平会在极值处留一段不动的直线 */
      const x = base[i] + val;
      if (x > bar.high) val -= 2 * (x - bar.high);
      else if (x < bar.low) val += 2 * (bar.low - x);
      dev[i] = val;
    }
    /* 「站住」的整段：偏离清零（那几步要停在触点上，不参与随机游走） */
    const holdStep = new Uint8Array(STEPS + 1);
    for (let k = 1; k < cum.length; k++) {
      if (points[k].hold) for (let i = cum[k - 1]; i <= cum[k]; i++) holdStep[i] = 1;
    }
    /* 每个触点把偏离按线性桥收 0，并乘「紧挨触点时收一收」的阻尼 */
    for (let k = 1; k < cum.length; k++) {
      const a = cum[k - 1], b = cum[k];
      const da = dev[a], db = dev[b];
      const len = Math.max(1, b - a);
      for (let i = a; i <= b; i++) {
        if (holdStep[i]) { dev[i] = 0; continue; }
        const f = (i - a) / len;
        dev[i] = (dev[i] - (da + (db - da) * f)) * Math.min(1, 8 * f * (1 - f));
      }
    }
    return { points, cum, base, dev, low: bar.low, high: bar.high, open: bar.open, close: bar.close };
  }

  /* 进度 → 价格（查表 + 段内线性插值，触点上的价分毫不差） */
  function priceAt(plan, u) {
    const t = clamp(u, 0, 1) * STEPS;
    const i = Math.min(STEPS - 1, Math.floor(t));
    const f = t - i;
    return clamp(plan.base[i] + (plan.base[i + 1] - plan.base[i]) * f
      + plan.dev[i] * (1 - f) + plan.dev[i + 1] * f, plan.low, plan.high);
  }

  /* 进度 → 第几段、段内比例。
     波纹靠它判「走到下一个折返点了没有」：走到段内八成就算摸到了那个触点。
     旧实现在 game/js/market/ticks.js 的 locate 里，逐字同一套算法。 */
  function locate(plan, u) {
    const t = clamp(u, 0, 1) * STEPS;
    const cum = plan.cum;
    let i = 0;
    while (i < cum.length - 2 && t >= cum[i + 1]) i++;
    const span = Math.max(1, cum[i + 1] - cum[i]);
    return { i, frac: clamp((t - cum[i]) / span, 0, 1) };
  }

  /* 自检用：这一轮要走到哪些价（触点表） */
  const waypointPrices = plan => plan.points.map(p => Math.round(p.price * 1e6) / 1e6);

  return { jitterPlan: { STEPS, THETA, HOLD_WEIGHT, buildPlan, priceAt, locate, waypointPrices } };
});
