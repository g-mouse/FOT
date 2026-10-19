/* ============ 引导价格照顾的公共数学 ============
纯函数、零 DOM、零引擎：编号决定一切的噪声、均值回复漫步、形状与步长。
   ★ 由 core/tutorial/favor.js 按行区间**逐字搬来**（只换命名空间与文件头，
   算法一个字符没动）。搬家的理由：**当时**的单文件上限是 400 行 —— 旧实现 482 行。
   ★ 唯一的**有意改动**在噪声层：手写的哈希噪声换成了 **simplex-noise**（vendor，MIT），
   理由与做法与 core/animation/jitterPlan.js 那一次完全相同（见下面 noiseAt 那一段）。
   对照旧实现的工具是 tools/parity-guide-favor.mjs（改了这里就回去跑一遍）。 */

CS.define('core/tutorial/favorMath', ["core/tutorial/tune","lib/simplex-noise"], function () {
'use strict';

  const TUNE = CS.tutorialTune.TUNE;


  const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);

  const easeOut = (t) => 1 - (1 - t) * (1 - t);
  const smooth = (t) => t * t * (3 - 2 * t);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const moveOf = (target) => Math.abs(target - 1);            /* 这一段该走多远（比例） */
  const dirOf = (target) => (target >= 1 ? 1 : -1);           /* 这一段朝哪个方向走：做多赢往上、做多亏往下 */

  /* 单根乘性抖动：范围 [0,1)，同一个 (index, salt) 永远同一个值。 */
  function jitter(index, salt) {
    let x = Math.imul((index + 1) >>> 0, 0x9e3779b1) ^ Math.imul((salt + 1) >>> 0, 0x85ebca6b);
    x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d); x ^= x >>> 12; x = Math.imul(x, 0x297a2d39); x ^= x >>> 15;
    return (x >>> 0) / 4294967296;
  }
  /* ---------- 噪声：**simplex-noise**（vendor/，MIT），不再手写 ----------
     以前这一层是「(index, salt) 折一个 32 位哈希当均匀分布」，再用「两个均匀分布相减 ×1.6」
     凑出近似正态的形状。换成 simplex 的两个理由，与 core/animation/jitterPlan.js 那一次相同：
       · 同样幅度下，simplex 的高低起伏**更像行情**：哈希那一版逐根之间是白的（实测自相关 ≈ 0），
         二阶差分比 mean|Δ²|/mean|Δ| = 1.73（比白噪声的 ~1.5 还毛躁）—— 拐点全是折线，
         所以旧代码只能再叠一层 AR(1) 去造趋势；
       · 「不重写轮子」：噪声是有标准算法与被验证实现的东西，自己写只是重复。
     ★ 幅度必须**保持不变**：下游所有公式（ride.js 的 NOISE_SD、favor.js 的 amp×0.35、
       priceOverlay 的影线 toss）都是按「noiseAt 的标准差 ≈ 0.653」定的。换噪声源不该顺手
       把整段行情放大或缩小，所以标准差**现采样量出来**再除回去，而不是写死一个常数 ——
       simplex-noise 2.x 与 4.x 的输出尺度略有差别，写死会在另一版上悄悄改掉幅度（不报错）。 */
  const SD_TARGET = 0.653;          /* 手写那一版的实测标准差（旧注释里写的 0.653，实测 0.656） */
  const noise2D = (() => {
    const NS = window.SimplexNoise;
    if (!NS) {
      throw new Error('vendor 没装齐：core/tutorial/favorMath.js 需要 window.SimplexNoise（simplex-noise）。见 index.html 的 vendor 段与 tools/build-vendor.mjs');
    }
    /* ★ 固定种子：噪声必须是 (index, salt) 的**纯函数** —— 铺价每推进一根就把整段重铺一遍，
       还要求刷新页面看到同一张图。种子不从任何随机流里抽，所以与调用顺序无关。 */
    let a = 0x9e3779b9;
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /* 2.x → 4.x 的适配（与 jitterPlan 同一套）：4.x 挂的是命名空间对象（createNoise2D），
       2.x 是可 new 的构造函数。 */
    const isFactory = typeof NS.createNoise2D === 'function';
    return isFactory
      ? NS.createNoise2D(rnd)
      : (() => { const legacy = new NS(rnd); return (x, y) => legacy.noise2D(x, y); })();
  })();
  /* (index, salt) → (x, y)：index 走 x 轴、salt 折到 y 轴。
     NX = 1.7 与 jitterPlan 的 NOISE_X 同一个口径（「一格大约走两段噪声」）：
     相邻下标的噪声只留一点相关性 —— 曲线圆润，而「趋势」仍旧交给 rideMomentum 那条 AR(1)，
     不在这里偷偷加惯性（两处都加就会把行情糊平，那是用户报过的那种「太平了」）。 */
  const NX = 1.7, NY = 0.37;
  const raw = (index, salt) => noise2D(index * NX, salt * NY);
  const SD_MEASURED = (() => {
    const N = 4096;
    let s = 0, q = 0;
    for (let i = 0; i < N; i++) {
      const v = raw(i * 0.5171, (i % 89) * 0.31);
      s += v; q += v * v;
    }
    const mean = s / N;
    return Math.sqrt(Math.max(1e-12, q / N - mean * mean));
  })();
  const GAIN = SD_TARGET / SD_MEASURED;
  /* 逐根的**有符号**噪声，标准差与旧实现一致（≈ 0.653）、范围约 ±1。 */
  function noiseAt(index, salt) { return raw(index, salt) * GAIN; }
  /* 幅度（相对「这一段该走多远」的比例）——**现在只当兜底**：
     段内与段外的幅度都改由 rideBand 的 amp 给（跟着市场当时的波动与这一档周期的 K 线尺度走，
     见 rideBand 那一段说明）。这两个数只在**拿不到市场波动**时还起作用
     （老存档 / 自检里少传一个 vol），那时退回「与用户看着没问题的那个手感一致」的老口径。 */
  const waveAmp = () => num(TUNE.rideWave, 0.25);
  const rippleAmp = () => num(TUNE.rideRipple, 0.12);
  const halfLife = () => Math.max(1, num(TUNE.rideHalfLife, 3));

  /* 一条漫步路径（相对包络的偏离，单位 = 「这一段该走多远」）：
       dev ← dev·(1−θ) + 噪声·θ，θ = 1/(半衰期+1) —— 有惯性、会回撤，是行情的样子。
     同一条路径只算一次（按 world + 跨度 + 长度缓存）：一次重铺要铺几十根，缓存省掉重复计算。 */
  const paths = new Map();
  function walkPath(world, span, len) {
    const key = world + '|' + span + '|' + len;
    const hit = paths.get(key);
    if (hit) return hit;
    const theta = 1 / (halfLife() + 1);
    const half = Math.max(1, span * 0.8);
    const out = new Float64Array(len);
    let dev = 0;
    for (let k = 0; k < len; k++) {
      dev = dev * (1 - theta) + noiseAt(world + k * 7919, 131) * theta;
      /* 收尾那一根前后收到 0：那一根的收盘必须是骰子定的那个数 */
      out[k] = dev * smooth(Math.min(1, Math.abs(k - span) / half));
    }
    if (paths.size > 64) paths.clear();
    paths.set(key, out);
    return out;
  }

  const stepOf = (vol, move) => {
    const fromVol = (Number.isFinite(vol) && vol > 0) ? vol / move : 0;
    return clamp(fromVol > 0 ? fromVol : 0.16, 0.06, Math.max(0.06, num(TUNE.rideStepCap, 0.8)));
  };

  const rawStepOf = (vol, move) => {
    const fromVol = (Number.isFinite(vol) && vol > 0) ? vol / move : 0;
    return Math.max(0.06, fromVol > 0 ? fromVol : 0.16);
  };

  const candleBarsOf = (limits) => Math.max(1, Math.round(num(limits && limits.candleBars, 1)));

  /* 噪声的幅度：noiseAt 的标准差（= SD_TARGET，换噪声源之后由采样校准保住的那一个数）。
     下面要把某一条漫步**归一化**到标准差 1（幅度用「这一根走多远」来量），所以除它。 */
  const NOISE_SD = 0.653;

  /* 那条**硬边界**离成交价多远（价格比例）：赢单 = 保本价那条地板、亏单 = 45% 保证金那条线。
     价格层已经算好了（limits.floor），两处口径只留一处；拿不到（自检少传一个数）就按老口径估。
     limits.lev = 这一单实际的杠杆（缺省仍是引导的默认倍数）。 */
  function deepOf(limits, win, dir, move) {
    if (limits && Number.isFinite(limits.floor)) return Math.abs(limits.floor - 1);
    return (Number.isFinite(TUNE.lossOfMargin) ? TUNE.lossOfMargin : 0.5)
      * (Number.isFinite(TUNE.lossPeak) ? TUNE.lossPeak : 0.9)
      / Math.max(1, num(limits && limits.lev, TUNE.guidedLeverage || 20));
  }

  return {
    tutorialFavorMath: {
      num, clamp, easeOut, smooth, moveOf, dirOf, jitter, noiseAt,
      waveAmp, rippleAmp, halfLife, walkPath, stepOf, rawStepOf, candleBarsOf, NOISE_SD, deepOf
    }
  };
});
