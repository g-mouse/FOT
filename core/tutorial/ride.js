/* ============ 段外那一条路：有趋势的随机行情 ============
过了「该平仓的那一根」之后价格怎么走 —— 一条有惯性的价格过程，夹在保护带里。
   ★ 由 core/tutorial/favor.js 按行区间**逐字搬来**（只换命名空间与文件头，
   算法一个字符没动）。搬家的理由：**当时**的单文件上限是 400 行 —— 旧实现 482 行。
   对照旧实现的工具是 tools/parity-guide-favor.mjs（改了这里就回去跑一遍）。 */

CS.define('core/tutorial/ride', ["core/tutorial/favorMath","core/tutorial/tune"], function () {
'use strict';

  const TUNE = CS.tutorialTune.TUNE;
  const M = CS.tutorialFavorMath;
  const { num, clamp, smooth, moveOf, dirOf, noiseAt, stepOf, rawStepOf, candleBarsOf, NOISE_SD } = M;

  /* 段外的**保护带**（水平，单位同上）。
       deep  那条硬边界（价格层算好的 floor）在水平轴上的位置 —— 永远是「不越过」的那一头；
       far   更有利的那一头：赢单 = 目标之外 max(rideTrend, 步长 × 5, **这一档周期的一个波段**)；
             亏单 = 回收 lossRecover 为止（比包络更浅就等于白捡，那会让「亏单」的账面变成赚的）。

      「这一档周期的一个波段」= 步长 × √(swing × candleBars) × rideBandShare ——
      市场在这一档周期上走 swing 根 K 线大概能走多远（随机漫步的 √t 尺度）。
      为什么上沿必须跟着周期放大（用户报的第二版「1 周的趋势还是不够明显」）：
      20× 下这一段行情一共只有 1.25% 的价格（＝赚保证金的两成半），
      而周线一根 K 线的正常振幅是 8~9% —— 带子只有 3% 的话，
      周线上铺出来的那几根就是贴在一起的一排小蜡烛，一眼就看得出是画的（截图实测过）。
      粗周期上把上沿放宽到「这一档周期的一个波段」，铺出来的 K 线才与旁边那几根一个量级；
      下沿**一动不动**（还是保本价那条地板）：放宽的只是「能多赚多少」，不是「会不会亏」。 */
  function rideBand(win, target, limits) {
    const move = Math.max(1e-9, moveOf(target));
    const dir = dirOf(target);
    const deep = limits && Number.isFinite(limits.floor)
      ? (limits.floor - target) / (dir * move)         /* 价格层那条线，换算成水平 */
      : (win ? -0.8 : -0.1);                           /* 拿不到就按老口径估一个 */
    const step = stepOf(limits && limits.vol, move);
    const raw = rawStepOf(limits && limits.vol, move);
    const cand = candleBarsOf(limits);
    const swing = Math.max(2, num(TUNE.rideSwingCandles, 3));
    /* 这一档周期「一个波段」大概有多远（价格比例 → 换成水平）：随机漫步的 √t 尺度。
       用**市场自己的步长**（raw，不设上限）：带子的宽度跟着行情野不野走（见 rawStepOf）。 */
    const swingMove = raw * Math.sqrt(swing * cand) * Math.max(0, num(TUNE.rideBandShare, 1));
    const far = win
      ? clamp(Math.max(num(TUNE.rideTrend, 0.6), step * 5, swingMove), 0.15, Math.max(0.3, num(TUNE.rideCap, 8)))
      : -clamp(Math.max(num(TUNE.lossRecover, 0.5), step * 5), 0.2, 1);
    /* 下沿离那条硬边界留出余量（贴着它走会被夹住 / 撞边，那几根又成了一条横线）。
       余量取「带子的一成」与 ridePullback 里**小的那个**：带子变宽之后（粗周期上能宽到十来段）
       一成的余量会把整条下沿抬到目标价**之上**——那样段外就再也回不到目标附近，
       图上只剩一根筋往上爬（而 ridePullback 本来就是「最多回撤到目标之下多远」的旋钮）。 */
    const gap = Math.min(Math.max(0, far - deep) * 0.1, Math.abs(num(TUNE.ridePullback, 0.55)));
    let near = deep + gap;
    if (win) near = Math.max(near, -Math.max(Math.abs(num(TUNE.ridePullback, 0.55)), step * 3));
    const lo = Math.min(near, far), hi = Math.max(near, far);
    /* 一根**图上的 K 线**走多远（水平单位）＝ 带子有多宽 ÷ 一波走几根 —— 段内与段外**共用这一个数**。
       两个口径都要顾到：
         · 市场这一档周期大概走多少（step × 这一根有几根基础线）；
         · 带子有多宽：一波行情正好走 rideSwingCandles 根 K 线（0.8 是「有惯性的噪声」每一根的
           平均绝对值：按它折算，一波才是真的走完带子，而不是算了半天走出六成）。
       用户报的「开仓后波动幅度跟原来不同」的另一半就在这个数上：以前段内是固定的一小截
       （rideWave × 这一段），段外是按带子算的 —— 两边差好几倍，图上在「该平仓那一根」上
       看得出一道台阶。现在两边同源，接缝没了。 */
    const waveFrac = clamp(num(TUNE.rideCandleWave, 0.45), 0, 0.8);
    const width = Math.max(1e-6, hi - lo);
    const amp = Math.max(1e-6, Math.min(step * cand, width / (swing * 0.8 + waveFrac * 2)));
    /* 市场在这一档周期上**一根 K 线**大概走多远（水平单位，同样不设上限）：
       价格层画影线要用它 —— 铺得安静的那几根也要有影线（见 price.js 的 writeBar）。 */
    const mkt = Math.max(1e-6, raw * Math.sqrt(cand));
    /* ★ 朝**有利方向**的漂移（用户口径：「K 线要跟着你的仓位方向走，但要有波动、不能让人看出是演的」）。
       只给赢单：亏单那 20% 本来就该逆着你走 —— 给它漂移就等于不可能亏，而它的带子只有
       「45% 线 ~ 成交价」那么窄，一加漂移就会顶在带上被压成一条横线。
       量：mom 是 AR(1)，稳态均值 = 入项均值 / (1−ρ)，所以入项乘 (1−ρ) 之后
       **每一根 K 线的期望位移 = amp × rideDrift，而噪声仍是 amp×1** ——
       「每根位移的标准差」因此没变（波动没被换掉），变的只是它有了方向。
       旧实现是 0：实测顺方向比例 50%、40 根趋势效率 0.02（真行情约 0.47），
       段外看起来完全没有「跟着仓位走」。 */
    const drift = win ? Math.max(0, num(TUNE.rideDrift, 0)) : 0;
    return { lo, hi, deep, far, step, raw, cand, swing, waveFrac, amp, mkt, drift };
  }

  /* 撞到带子的边上要**掉头**，不能夹住不动：
     夹住会在边上压出一条横线 —— 用户报的正是「在一条水平线上抖」，只是从目标那条线换到了带子边
     （自检里抓过「一格都不动」的横线）。所以撞上之后把驱动噪声反向（留一点能量 bounceEnergy），
     靠 rideMomentum 的惯性，后面几根会**连着朝反方向走** ——
     走势上就是「冲到顶、被压回来、再回踩」，一眼看去是行情。 */
  const bounceEnergy = 0.6;     /* 撞边之后反向的噪声还留多少 */

  /* 段外那一条路径：out[j] = 走过该平仓那一根之后第 j 根的水平（j = 0 就是那一根本身）。
     锚是**收尾那一根的绝对下标**（anchor = 这一根的绝对下标 − j），键里没有 span ——
     段长被延长时曲线不重画（见文件头「与『该平仓的那一根』无关」那一节）。
     缓存按需加长：同一个键重算出来的值与短的那一份逐项相同（递推是**从 j = 0 顺着走的**，
     与数组多长无关，所以加长不会改动已经算出来的那几根）。 */
  const rides = new Map();
  function ridePath(anchor, band, start, need) {
    const { lo, hi, amp, waveFrac, cand, drift } = band;
    /* 缓存键 = 影响这条路的一切（锚 + 带子 + 起点 + 一根走多远 + 一根 K 线几根基础线）。
       少写一个就会出现「同样的输入、不一样的曲线」——那正是刷新前后盈亏会对不上的根源。 */
    const key = anchor + '|' + lo.toFixed(4) + '|' + hi.toFixed(4) + '|' + start.toFixed(4)
      + '|' + amp.toFixed(4) + '|' + waveFrac.toFixed(3) + '|' + cand + '|' + drift.toFixed(3);
    const hit = rides.get(key);
    if (hit && hit.length >= need) return hit;
    const len = Math.max(64, Math.ceil(need / 64) * 64);
    const wave = amp * waveFrac;
    /* K 线内部的来回要留在带子里，所以「芯」（每一根的收盘）夹在 [bot, top]。
       但**起点必须留在里面**：段外是从段内收尾那一根接过来的（赢单在目标价上），
       起点要是被夹出去，第一根就跳一下（图上是一道缝）。所以两头都不许夹过起点。 */
    const s0 = clamp(start, lo, hi);
    const bot = Math.min(lo + wave, s0), top = Math.max(Math.max(bot, hi - wave), s0);
    /* 方向惯性：噪声黏住之后，位置会**连着好几根 K 线**朝同一个方向走（一段趋势），再掉头回撤。
       驱动噪声归一化到标准差 1（除以 NOISE_SD）—— 这样「一根 K 线走多远」就是上面那个 amp，
       而不是它的六成（不归一化的话，行情会比算出来的那个尺度安静四成，周线上就成了小碎步）。 */
    const rho = clamp(num(TUNE.rideMomentum, 0.6), 0, 0.95);
    const keepZ = Math.sqrt(Math.max(0, 1 - rho * rho)) / NOISE_SD;
    /* K 线内部的碎步：半衰期 = 这一根 K 线的八分之一（越粗的周期，内部走得越慢） */
    const subTheta = 1 / (Math.max(1, Math.round(cand / 8)) + 1);
    const subGain = Math.sqrt((2 - subTheta) / subTheta) / NOISE_SD;      /* 归一化到标准差 1 */
    const out = new Float64Array(len);
    /* 带子的可用宽度：漂移要按「走到带子的哪个位置」衰减（见下面 filled） */
    const bandSpan = Math.max(1e-9, hi - lo);
    let level = s0, mom = 0, sub = 0, j = 0;
    while (j < len) {
      const from = level;
      /* ★ 漂移**越靠近有利那一侧的边越弱**（1 − filled）。
         不衰减的话，长持时这条会被一路顶到带上沿并**停在那儿来回**：
           · 观感上就是「一条横线」（旧注释里专门警告过的那一种，只是从目标线换到了带子边）；
           · 更要紧的是价位离真实行情越来越远 —— 实测持有 60 根时铺出来的收 58552 而
             真实收 48203（差 21%），于是平仓之后 priceHistory 的 bridge() 得用
             **48 根**把价差摊回去，那 8 天里图上的价都不是真行情（用户报的「K 线对不上」）。
         衰减之后路径停在带子中上部：方向仍然看得出来，而离真实价位近得多。 */
      const filled = clamp((from - lo) / bandSpan, 0, 1);
      mom = rho * mom + keepZ * noiseAt(anchor + Math.floor(j / cand) * 7919, 421) + (1 - rho) * drift * (1 - filled);
      let next = from + amp * mom;
      if (next > top || next < bot) {
        /* 撞到带子的边：把驱动噪声反向（留一点能量 bounceEnergy），并**当场**按反向走这一根。
           为什么不是「停在边上、下一根再回头」：停在边上会让连着两根收在同一个数上 ——
           自检里量到过「一格都不动」的那一根，而那正是用户报的「在一条水平线上抖」的雏形。
           顺手把反向后的目标再夹一次（带子很窄、反向幅度仍可能越界）。 */
        mom = -mom * bounceEnergy;
        next = clamp(from + amp * mom, bot, top);
      }
      for (let i = 0; i < cand && j < len; i++, j++) {
        const t = (i + 1) / cand;
        sub = sub * (1 - subTheta) + subTheta * subGain * noiseAt(anchor + j * 7919, 761);
        const env = Math.sin(Math.PI * t);        /* 两头收住：这一根 K 线收在 next 上 */
        /* K 线**里面**那几十根基础线：从 from 走到 next，路上来回一点（env 的包络）。
           夹两道，但**只夹「不利」的那一侧**（下沿 lo = 保本价那条线那一头）：
           有利那一侧伸出去只是这一根 K 线的影（赢单做多 = 更高的价、做空 = 更低的价），
           它不进账面（账面读的是收盘），也不会被扫爆 —— 而真行情的 K 线本来就有长影
           （周线上影线差不多与实体一样长）。上沿放宽一个 wave，免得影线长得不像话。 */
        out[j] = Math.min(Math.max(from + (next - from) * smooth(t) + wave * env * sub, lo), hi + wave);
      }
      level = next;
    }
    if (rides.size > 24) rides.clear();
    rides.set(key, out);
    return out;
  }

  /* 段外第 j 根（j = k − span，≥ 1）的收盘比例。
     起点接过段内的收尾：赢单在目标上（水平 0），亏单在那条 45% 线上（水平 = deep）。 */
  function rideAt(j, index, target, win, limits) {
    const move = Math.max(1e-9, moveOf(target));
    const dir = dirOf(target);
    const band = rideBand(win, target, limits);
    const start = win ? 0 : band.deep;
    const path = ridePath(index - j, band, start, j + 1);
    return target + dir * move * clamp(path[j], band.lo, band.hi);
  }

  /* 市场在**这一档周期**上一根 K 线大概走多远（价格比例）：
       市场自己的步长 × √(这一根有几根基础线) × 这一段该走多远。
     给价格层画影线用 —— 铺得安静的那几根也要有影线：真行情里没有「一根又短又没影线的横线」，
     而影线只按实体长度散开的话，安静的那几根就正好被画成那样（见 price.js 的 writeBar）。 */
  function marketCandleMove(target, limits) {
    const move = Math.max(1e-9, moveOf(target));
    return Math.max(0, rawStepOf(limits && limits.vol, move) * Math.sqrt(candleBarsOf(limits)) * move);
  }

  return { tutorialRide: { rideBand, ridePath, rideAt, marketCandleMove } };
});
