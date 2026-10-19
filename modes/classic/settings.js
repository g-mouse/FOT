/* ============ 模拟模式的设置槽（一局的方向盘） ============
   旧教程页把 20 多个设置项混在**账户存档**里（`coinsim-save-v3` 就是整份 state），
   于是「重置账户」一不小心就把偏好也清了，而「换一局」又必须把它们留着。
   新引擎把这两件事分开：账户存档只放钱，**偏好放这里**（跟着模拟模式的存档走）。

   这一格管的是「界面要不要多问一句、多看一层、图上看几条线」，以及看图的两个旋钮
   （一屏几根、步长）—— **一个结算口径都不改**。所以它不参与对账，也不进权益曲线。

   读法只有两个口：
     · `bag()`            拿整份（设置面板用它画勾选框）
     · `get(key)`         拿一项（交易页的 ctx.settings 用它——线开关就是这么传的）
   写法一个：`set(key, value)` —— 它负责夹取、落盘、并广播一条 `classic.settings.changed`，
   于是「改完立刻生效」不用每个读者各写一遍。

   ★ `riskPaused` 是**运行期**的一格（不落盘）：追保弹窗弹出来时置上，
   推进（nextBar / 自动播放）被它挡住，关掉弹窗才解开。
   旧实现把这个标志放在 config.flags 里，理由一样：它描述的是「这一刻」，不是「这一局」。 */
CS.define('modes/classic/settings', ["core/events/events","core/market/filter","core/market/randomWalk","core/market/resample"], function () {
  'use strict';

  const ns = CS.open('classic');
  const KEY_OK = v => v === true;

  /* 默认值：与旧教程页那一份逐条对齐（config/constants.js 的 DEFAULT_*）。
     只有「预估强平·委托价」是默认关的 —— 它在市价模式下本来就不该露面。 */
  const DEFAULTS = {
    /* 交易设置三项：都只影响「界面要不要多问一句」，不改结算 */
    confirmOpen: true,          // 开仓二次确认（市价与限价都走它）
    liqNotice: true,            // 强制平仓弹正式说明（关掉只出一条气泡）
    marginCallNotice: true,     // 追保弹正式提示（关掉只出一条气泡）
    /* 图上那六条线的开关（名字与 tradePriceLines 的 flag 键逐字一致） */
    showBreakEven: true, showLiqLine: true, showPendingLine: true, showPreviewLine: true,
    showLiqPreviewLine: true, showLiqPreviewOrder: false,
    /* 看图的两个旋钮 */
    bars: 240,                  // 一屏几根（20–240）
    timeframe: '4h',            // 图表周期
    stepHours: 4,               // 一次「前进」走几小时；0 = 跟随图表周期
    /* 下单的「仓位比例」：滑块按可用余额自动算保证金，记住上一次拖到的百分比。
       默认 5% ≈ 原来的 500 USD（10,000 本金、5× 杠杆下 MAX 约 9,900）。 */
    marginPct: 5,
    /* 行情过滤：隐藏每个交易对开头的这一段（上线初期波动极端）。
       默认 365 天 = 过滤掉开头的整年 —— 上线初期的极端波动不适合拿来练。
       注意它会**挪动每一份存档的起点**（光标按根存，过滤一开就整体后移）。 */
    skipDays: 365,
    alignStart: true,           // 起点口径：true = 所有交易对统一起点，false = 各自上线
    /* 高级模式：随机波动（在真实历史 K 线上再叠一层随机行情，每次回放都不一样）。
       默认**开** —— 叠加了它每一局的行情都不一样；关掉就是纯币安真实历史。
       ★ 它作用于**两个模式**：这份设置按当前值改写那一份共用的行情，
       所以故事模式的新闻排片、市场状态、账户估值也读改写后的序列
       （见 modes/story/mode.js 的 applyMarketScope）。 */
    randomOn: true,
    sigma: 0.005,               // 波动系数 σ：每根 4h 的对数收益标准差
    vov: 0.5,                   // 二阶波动率：波动率自己的波动率
    randBand: 1,                // 偏离带：随机价能离真实路径多远（单位 σ）
    randSeed: 1                 // 随机种子：「重新掷一次」就是把它加一
    /* 2026-10-19：floatOn（交易悬浮窗）随悬浮窗一起删了。 */
  };
  const CLAMPS = {
    bars: v => Math.max(20, Math.min(240, Math.round(Number(v) || DEFAULTS.bars))),
    timeframe: v => CS.resample.tfOf(v).id,
    stepHours: v => Math.max(0, Math.round(Number(v) || 0)),
    marginPct: v => Math.max(1, Math.min(100, Math.round(Number(v) || DEFAULTS.marginPct))),
    skipDays: v => Math.max(0, Math.min(3650, Math.round(Number(v) || 0))),
    /* σ / VoV 的上下限只有一处（core/market/randomWalk.js），这里转发过去 */
    sigma: v => (CS.randomWalk ? CS.randomWalk.clampSigma(v) : DEFAULTS.sigma),
    vov: v => (CS.randomWalk ? CS.randomWalk.clampVov(v) : DEFAULTS.vov),
    randBand: v => Math.max(0, Math.min(6, Math.round(Number(v) || 0))),
    randSeed: v => Math.max(1, Math.round(Number(v) || 1))
  };
  const RANDOM_KEYS = ['randomOn', 'sigma', 'vov', 'randBand', 'randSeed'];
  const KEYS = Object.keys(DEFAULTS);

  const bag = Object.assign({}, DEFAULTS);
  /* 运行期的那一格：不落盘、不参与对账 */
  let riskPaused = false;

  /* 读档：整份交给这里归一 —— 旧档（没有这一格）、坏档（填了 9999）都不会把界面读崩。
     只认名单里的键，名单外的键**一律不收**（存档是外部输入，多一个键就是一个新入口）。 */
  function normalize(raw) {
    const out = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== 'object') return out;
    KEYS.forEach(key => {
      const value = raw[key];
      if (value === undefined || value === null) return;
      if (typeof DEFAULTS[key] === 'boolean') out[key] = KEY_OK(value) ? true : (value === false ? false : DEFAULTS[key]);
      else out[key] = CLAMPS[key] ? CLAMPS[key](value) : value;
    });
    return out;
  }
  function restore(raw) {
    Object.assign(bag, normalize(raw));
    reapply();
    CS.events.bus.emit('classic.settings.changed', Object.assign({}, bag));
    return Object.assign({}, bag);
  }
  const serialize = () => Object.assign({}, bag);
  /* 过滤那两个旋钮的真正读者是 core/market/filter.js（引擎与图表都从那儿读）——
     设置槽只负责存，改完推给它一次。缺了这一步，设置面板上勾了「过滤 365 天」，
     下单却照样能成交（判据那一层没收到）。 */
  function applyFilter() {
    if (CS.marketFilter) CS.marketFilter.set({ skipDays: bag.skipDays, alignStart: bag.alignStart });
  }
  /* 随机波动同理：真正的改写与还原在 core/market/randomWalk.js。
     ★ 这一口是「按当前设置把随机波动推给引擎」的**唯一**实现：参数名映射
     （bag.randBand → band、bag.randSeed → seed）只在这里有一份，别处要叠随机波动
     都调它（故事模式也调，见 modes/story/mode.js）—— 再写一份映射的代价是
     「同样的设置，两个模式掷出不同的世界」，而且不报错。
     ★ 与 applyFilter 分开正是因为两个旋钮的**适用模式不同**：
     随机波动两个模式都要（就地改写那一份共用行情），行情过滤只是模拟模式自己的事
     （故事模式从 commonStart 起步，本来就已经过了上线初期）。 */
  function applyRandom() {
    if (!CS.randomWalk) return;
    if (bag.randomOn) {
      CS.randomWalk.activate({ sigma: bag.sigma, vov: bag.vov, band: bag.randBand, seed: bag.randSeed });
    } else {
      CS.randomWalk.deactivate();
    }
  }
  /* 把「存在槽里、但要推给引擎」的那几项重新推一遍（两项一起，模拟模式进模式时用）。 */
  function reapply() { applyFilter(); applyRandom(); }

  /* set(key, value, opts)
     ★ opts.persist === false 是**引导**要的那一档：引导期间临时改掉的设置**不落盘**
     （见 core/tutorial/sessionSettings.js 的两条规矩 —— 玩家在引导里关掉页面，
     下次打开看到的应该是他自己那一套，而不是课上被改过的那一套）。
     少了这个开关，「课上把抖动关掉」会被写进存档，而那之后引导一旦没有正常退出
     （刷新、探针把整块引导关掉），玩家就再也拿不回自己的设置了 —— 而且不报错。 */
  function set(key, value, opts) {
    if (KEYS.indexOf(key) < 0) return undefined;
    const next = CLAMPS[key] ? CLAMPS[key](value) : (typeof DEFAULTS[key] === 'boolean' ? !!value : value);
    if (bag[key] === next) return next;
    bag[key] = next;
    if (key === 'skipDays' || key === 'alignStart') applyFilter();
    if (RANDOM_KEYS.indexOf(key) >= 0) applyRandom();
    if (!(opts && opts.persist === false) && ns.replay && ns.replay.save) ns.replay.save();
    CS.events.bus.emit('classic.settings.changed', Object.assign({}, bag));
    return next;
  }

  ns.settings = {
    DEFAULTS, KEYS,
    bag: () => Object.assign({}, bag),
    get: key => bag[key],
    set, normalize, restore, serialize, reapply,
    /* 两个旋钮各自的推送口（reapply 是两个一起）。分开导出是给「只该用其中一个」的一方：
       故事模式要随机波动，但不要模拟模式那份行情过滤（见两个函数上面的说明）。 */
    applyFilter, applyRandom,
    /* 运行期的「这一刻不能推进」：追保弹窗开着时置上 */
    paused: () => riskPaused,
    setPaused(on) {
      const next = !!on;
      if (riskPaused === next) return next;
      riskPaused = next;
      CS.events.bus.emit('classic.settings.changed', Object.assign({}, bag));
      return next;
    }
  };
  return { classicSettings: ns.settings };
});
