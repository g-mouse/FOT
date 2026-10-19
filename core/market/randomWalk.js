/* ============ 随机波动（高级模式）：在真实历史 K 线上再叠一层随机行情 ============
   旧教程页的 market/random.js + config/random.js 搬过来，**算法逐行照搬**，
   改的只有数据形状（新的是一组 bar 对象）与「谁来开关它」。

   模型（与旧实现逐字同一套）：
     vol_t = σ · exp(VoV · w_t)          w 是对数波动率的 AR(1)，ρ = VOV_PERSISTENCE = .94
     dev_t = dev_(t−1) + (−λ·dev_(t−1) + vol_t·z)      λ = 1/(2·band²)
     c_t   = 真实收盘价_t · exp(dev_t)    开盘价接上一根的收盘（价格连续，不跳空）
     h/l   各掷一条半正态影线，长度 = vol_t · RANDOM_WICK
   再对冲击序列**就地归一**（均值 0、标准差 1），去掉有限长抽样的整体漂移。

   ============ 与故事模式的关系（新引擎独有的一条约束）============
   旧教程页与故事模式是**两个文档**，各自一份行情，所以那边开随机波动不会碰到这边。
   新引擎只有一份 marketData —— 随机波动是**就地改写** series 的，
   于是「模拟模式开了随机波动」会连故事模式的行情一起改掉（它的新闻排片、市场状态、
   账户市值全读同一份序列）。所以这一层多了两个入口：

     activate(cfg)   进模式（或设置变化）时叫：先抄一份 pristine，再按参数生成
     deactivate()    把开关关掉时叫：**把 pristine 原样抄回去**

   三条纪律：
     · **两个模式都用它**：模拟模式与故事模式都在进模式时按设置叠上（故事模式见
       modes/story/mode.js 的 applyMarketScope）—— 故事模式的新闻排片、市场状态、
       账户估值读的是同一份序列，所以它们跟着改写后的行情一起算；
     · 参数名映射只有一份（modes/classic/settings.js 的 applyRandom），别处要叠就调它；
     · deactivate 必须**逐字节还原**（还原之后再 bumpPrices，让图表缓存作废）。
       工具 tools/check-random-walk.mjs 专门验这一条：开→关之后与原始数据逐根相同。
       ★ 会调 deactivate 的只有「把开关关掉」这一条路（applyRandom 的 else 分支）：
       切换模式**不**还原 —— 还原了故事模式就拿回真实历史，与这个开关的语义相反。

   默认**开**（enabled=true，见下面 cfg 的初值）。这与设置槽的 DEFAULTS.randomOn（也是 true）
   是**同一个默认**：没人显式调过 activate / deactivate 时，两边说的是同一件事
   —— 而不是「一个说开、一个说关，谁先答就是谁的默认」。 */
CS.define('core/market/randomWalk', ["core/events/events","core/market/marketData"], function () {
  'use strict';

  const RANDOM_WICK = 0.5;
  const VOV_PERSISTENCE = 0.94;
  const DEV_PERSISTENCE = 0.98;
  const DEFAULT_SIGMA = 0.002, MIN_SIGMA = 0.001, MAX_SIGMA = 0.03;
  const DEFAULT_VOV = 0.3, MIN_VOV = 0, MAX_VOV = 0.5;
  const DEFAULT_BAND = 1, MAX_BAND = 6;
  const SIGMA_PRESETS = [0.001, 0.005, 0.01, 0.02, 0.03];
  const VOV_PRESETS = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
  const BAND_PRESETS = [0, 1, 3, 6];

  const clampSigma = v => {
    const n = Number(v);
    return Math.max(MIN_SIGMA, Math.min(MAX_SIGMA, Number.isFinite(n) ? n : DEFAULT_SIGMA));
  };
  const clampVov = v => {
    const n = Number(v);
    return Math.max(MIN_VOV, Math.min(MAX_VOV, Number.isFinite(n) ? n : DEFAULT_VOV));
  };

  /* 当前生效的那一套参数（enabled=false 时价格就是行情本身）。
     ★ enabled 的初值与设置槽的 DEFAULTS.randomOn 对齐（true）：没人显式调过
     activate / deactivate 时两边也一致。真正的开关仍是 activate / deactivate。 */
  const cfg = { enabled: true, sigma: DEFAULT_SIGMA, vov: DEFAULT_VOV, band: DEFAULT_BAND, seed: 1, persistence: VOV_PERSISTENCE, phi: DEV_PERSISTENCE };
  let version = 0;
  let signature = '';
  /* 原始（币安真实历史）那一份：**第一次激活时**才抄 —— 不开这个功能就一个字节也不占 */
  const pristine = new Map();
  const noise = new Map();
  let captured = false;

  /* ---------- 计数器式随机流：同一个 (种子, 交易对, 全局下标) 永远同一串数，与调用顺序无关 ---------- */
  function hash32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function streamOf(id, index, seed) {
    let state = (hash32(id) ^ Math.imul((index + 1) >>> 0, 0x9e3779b1) ^ Math.imul(seed >>> 0, 0x85ebca6b)) >>> 0;
    return function next() {
      state = (state + 0x9e3779b9) >>> 0;
      let z = state;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
    };
  }
  function gauss(next) {
    const u = Math.max(1e-12, next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  }
  const flowAt = (id, index) => streamOf(id, index, cfg.seed);

  /* ---------- pristine：抄一份原始 OHLC（局部下标对齐 series.bars） ---------- */
  function capture() {
    if (captured) return;
    CS.marketData.listInstruments().forEach(info => {
      const s = CS.marketData.seriesRef(info.id);
      if (!s || !s.bars) return;
      const n = s.bars.length;
      const o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
      for (let i = 0; i < n; i++) { o[i] = s.bars[i].o; h[i] = s.bars[i].h; l[i] = s.bars[i].l; c[i] = s.bars[i].c; }
      pristine.set(info.id, { o, h, l, c });
    });
    captured = true;
  }

  /* ---------- 噪声：只由 (id, off, n, 参数) 决定，不读价格 ---------- */
  function computeNoise(id, off, n) {
    const logFactor = new Float64Array(n);
    const volAt = new Float32Array(n);
    const { sigma, vov, persistence, phi, band } = cfg;
    const sqrtRho = Math.sqrt(Math.max(0, 1 - persistence * persistence));
    const lambda = band > 0 ? 1 / (2 * band * band) : 0;
    let w = 0, dev = 0;
    for (let i = 0; i < n; i++) {
      const next = flowAt(id, off + i);
      w = persistence * w + sqrtRho * gauss(next);
      const vol = sigma * Math.exp(vov * w);
      volAt[i] = vol;
      if (i > 0) dev += -lambda * dev + vol * gauss(next);
      logFactor[i] = dev;
    }
    /* 去掉抽样漂移：把冲击序列就地归一（均值 0、标准差 1）。不这么做的话，
       两万根连乘下来整条序列会整体偏高或偏低（实测某一颗种子末根是真实价的 148 倍）。 */
    if (n > 2 && sigma > 0) {
      let sum = 0, sumsq = 0;
      for (let i = 1; i < n; i++) {
        const shock = (logFactor[i] - logFactor[i - 1] + lambda * logFactor[i - 1]) / sigma;
        sum += shock; sumsq += shock * shock;
      }
      const count = n - 1;
      const mean = sum / count;
      const sd = Math.sqrt(Math.max(1e-12, sumsq / count - mean * mean));
      let nextDev = 0;
      for (let i = 0; i < n; i++) {
        if (i > 0) {
          const shock = (logFactor[i] - logFactor[i - 1] + lambda * logFactor[i - 1]) / sigma;
          nextDev += -lambda * nextDev + sigma * ((shock - mean) / sd);
        }
        logFactor[i] = nextDev;
      }
    }
    noise.set(id, { logFactor, volAt, devShock: lambda });
  }

  /* ---------- 就地改写（或还原）一个交易对的 OHLC ---------- */
  function materialize(id) {
    const s = CS.marketData.seriesRef(id);
    const p = pristine.get(id);
    if (!s || !p) return;
    const B = s.bars;
    /* 关掉、σ=0、或没有噪声 → 把原始那一份抄回去 */
    const off = !cfg.enabled || !(cfg.sigma > 0);
    const ns = noise.get(id);
    if (off || !ns) {
      for (let i = 0; i < B.length; i++) { B[i].o = p.o[i]; B[i].h = p.h[i]; B[i].l = p.l[i]; B[i].c = p.c[i]; }
      noise.delete(id);
      return;
    }
    const { logFactor, volAt } = ns;
    for (let i = 0; i < B.length; i++) {
      const next = flowAt(id, s.off + i);
      gauss(next); gauss(next);                       /* 第 1 个给波动率、第 2 个给冲击（已折进 logFactor） */
      const up = Math.abs(gauss(next));               /* 第 3 个：上影线 */
      const down = Math.abs(gauss(next));             /* 第 4 个：下影线 */
      const vol = volAt[i] || cfg.sigma;
      const close = p.c[i] * Math.exp(logFactor[i]);
      const open = i > 0 ? B[i - 1].c : p.o[0];
      const top = Math.max(open, close) * (1 + vol * RANDOM_WICK * up);
      const bottom = Math.min(open, close) * (1 - vol * RANDOM_WICK * down);
      B[i].c = close;
      B[i].o = open;
      B[i].h = top;
      B[i].l = bottom > 0 ? bottom : Math.min(open, close) * 0.5;
    }
  }

  const signatureOf = () => [cfg.enabled ? 1 : 0, cfg.sigma, cfg.vov, cfg.persistence, cfg.band, cfg.seed].join('|');

  /* 按当前设置重新生成全部交易对。**结束时一定 bumpPrices** ——
     重采样缓存是按价格版本号失效的，不 bump 的话图上画的还是改写前的蜡烛。 */
  function regenerate(force) {
    if (!CS.marketData.ready) return false;
    capture();
    const sig = signatureOf();
    if (!force && sig === signature) return false;
    signature = sig;
    CS.marketData.listInstruments().forEach(info => {
      const s = CS.marketData.seriesRef(info.id);
      if (!s || !s.bars) return;
      if (cfg.enabled && cfg.sigma > 0) computeNoise(info.id, s.off, s.bars.length);
      materialize(info.id);
    });
    version++;
    CS.marketData.bumpPrices();
    CS.events.bus.emit('market.random.changed', snapshot());
    return true;
  }

  /* 进这一局时叫：抄 pristine、按参数生成。cfg 里没给的键保持默认 */
  function activate(options) {
    applyConfig(options);
    cfg.enabled = true;
    return regenerate(true);
  }
  /* 离开时叫：**逐字节还原**。还原之后价格就是币安历史本身 ——
     故事模式读的就是这一份，所以这一步不能省、也不能只还原「被改过的那几根」。
     ★ 没什么可还原的时候（本来就没开过 / 已经还原过）**直接返回、不碰版本号**：
     bumpPrices 会让图表与重采样缓存整批作废，「模式切来切去」每次白重算一遍图，
     而玩家的观感是「切一次模式图闪一下」。 */
  function deactivate() {
    if (!captured || !noise.size) { cfg.enabled = false; return false; }
    cfg.enabled = false;
    CS.marketData.listInstruments().forEach(info => materialize(info.id));
    noise.clear();
    signature = signatureOf();
    version++;
    CS.marketData.bumpPrices();
    CS.events.bus.emit('market.random.changed', snapshot());
    return true;
  }
  /* 参数变了（σ / VoV / 偏离带 / 种子 / 开关）：只有开着的时候才真的重算 */
  function applyConfig(options) {
    const o = options || {};
    if (typeof o.enabled === 'boolean') cfg.enabled = o.enabled;
    if (o.sigma != null) cfg.sigma = clampSigma(o.sigma);
    if (o.vov != null) cfg.vov = clampVov(o.vov);
    if (o.band != null) cfg.band = Math.max(0, Math.min(MAX_BAND, Number(o.band) || 0));
    if (o.seed != null) cfg.seed = Math.max(1, Math.round(Number(o.seed) || 1));
    cfg.phi = DEV_PERSISTENCE;
    return snapshot();
  }
  /* 面板改参数走它：改完立刻重算（参数没变就什么都不做，见 regenerate 的签名） */
  function set(options) {
    applyConfig(options);
    if (!cfg.enabled) return snapshot();
    regenerate(false);
    return snapshot();
  }
  /* 「重新掷一次」：种子加一，换一条命运 */
  const reroll = () => set({ seed: cfg.seed + 1 });

  const snapshot = () => ({
    enabled: cfg.enabled, sigma: cfg.sigma, vov: cfg.vov, band: cfg.band,
    seed: cfg.seed, persistence: cfg.persistence, phi: cfg.phi, version,
    pristine: captured
  });
  /* 原始那一根（真实历史）：用于「随机模式到底改了多少」的核对与面板显示 */
  const realPriceAt = (id, index) => {
    const s = CS.marketData.seriesRef(id);
    const p = pristine.get(id);
    if (!s || !p) return NaN;
    const i = index - s.off;
    return (i >= 0 && i < p.c.length) ? p.c[i] : NaN;
  };

  return {
    randomWalk: {
      activate, deactivate, set, regenerate, reroll, snapshot, realPriceAt, applyConfig,
      isOn: () => cfg.enabled && cfg.sigma > 0,
      get version() { return version; },
      DEFAULT_SIGMA, DEFAULT_VOV, DEFAULT_BAND, MAX_BAND,
      SIGMA_PRESETS, VOV_PRESETS, BAND_PRESETS, clampSigma, clampVov
    }
  };
});
