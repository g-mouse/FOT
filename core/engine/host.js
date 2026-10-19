/* ============ 宿主装配：把四个端口接起来（§0.2） ============
   market  ← core/marketData（仓库内唯一固定的数据集）+ core/marketEngine（撮合与失真）
   account ← core/accountEngine（唯一改钱入口）
   clock   ← core/clock（日/周/月同一节拍）
   storage ← localStorage 的命名空间视图（每个模式/角色一块）

   这一层是「宿主」与「模式」之间唯一的接缝：模式只拿到 Ports 这个对象，
   拿不到 document、拿不到引擎内部引用、更拿不到全量行情序列
   （[R18] 验收第 19 条：newsEngine / debtEngine / 所有面板不得持有全量序列引用）。 */
CS.define('core/engine/host', ["core/base/contentLoader","core/engine/accountEngine","core/engine/clock","core/engine/marketEngine","core/engine/ports","core/market/marketData"], function () {
  'use strict';

  const DATASET_SCRIPT = './data/market/bundle.js';

  /* 行情包 9.6MB，只加载一次；classic 模式在 iframe 里自己有一份，互不影响 */
  let datasetPromise = null;
  function ensureDataset() {
    if (window.__MARKET_BUNDLE__ && CS.marketData.ready) return Promise.resolve(true);
    if (window.__MARKET_BUNDLE__) return Promise.resolve(CS.marketData.init());
    if (!datasetPromise) {
      datasetPromise = CS.contentLoader.injectScript(DATASET_SCRIPT, 30000)
        .then(() => CS.marketData.init())
        .catch(error => {
          CS.errors.push({ message: `行情包载入失败：${error && error.message}` });
          return false;
        });
    }
    return datasetPromise;
  }

  /* 一次性建好整套宿主。options:
       initialCash  初始现金（内部单位）
       startMs      故事起点（毫秒时间戳）；缺省用数据集 commonStart
       storageNs    存档命名空间，例如 'story.'
       limitsOf     交易限制（来自 buff 汇总），引擎不直接读 buff，由调用方注入 */
  function create(options) {
    const opts = options || {};
    const ready = CS.marketData.ready || CS.marketData.init();
    const dataset = CS.marketData.getDatasetMeta();
    const startMs = opts.startMs != null ? opts.startMs : (dataset.commonStart != null ? dataset.commonStart : dataset.start);

    const clock = CS.clock.create({ startMs, barsPerDay: CS.clock.BARS_PER_DAY });
    const account = CS.accountEngine.create({ initialCash: opts.initialCash == null ? 0 : opts.initialCash, currency: opts.currency || 'USD' });
    const market = CS.marketEngine.create({
      market: CS.marketData,
      account,
      clockNow: () => ({ dayIndex: clock.now().dayIndex, barIndex: clock.now().barIndex, ts: CS.marketData.timeAt(opts.instrumentId || dataset.symbols[0], clock.now().barIndex) }),
      limitsOf: opts.limitsOf || (() => ({})),
      digitsOf: id => CS.marketData.digitsOf(id)
    });

    const ports = CS.ports.create({
      market: {
        listInstruments: () => CS.marketData.listInstruments(),
        loadSeries: (id, range) => CS.marketData.loadSeries(id, range),
        getDatasetMeta: () => CS.marketData.getDatasetMeta(),
        getFullSeries: (id, reason) => CS.marketData.getFullSeries(id, reason),
        submitOrder: order => market.submitOrder(order),
        /* 限价委托与「还挂着什么」：撮合在 marketEngine.settleStep（每根 K 线一次），
           这一层只做转发。交易页的「限价委托」按钮读的就是 placeLimit 在不在。 */
        placeLimit: order => market.placeLimit(order),
        listOrders: () => market.listOrders(),
        cancelOrder: id => market.cancelOrder(id),
        subscribe: cb => market.subscribe(cb)
      },
      account: {
        getSnapshot: () => account.getSnapshot(id => (market.barOf(id) ? market.barOf(id).c : NaN)),
        applyDelta: delta => account.applyDelta(delta),
        getEquityCurve: () => account.getEquityCurve(),
        reset: initial => account.reset(initial),
        metrics: () => account.metrics()
      },
      /* ★ 时钟端口必须把 core/clock 的**全套**能力透出去。
         故事模式拿到的唯一时钟句柄就是它（mode.js 里 ns.clock = host.ports.clock），
         而它要用 pause / resume / serialize / restore / advanceTo：
           · 少了 pause()     → advance() 一开头就抛 → 「推进一个月」按钮完全无效
           · 少了 serialize() → saveNow() 抛错 → 第一份存档根本写不出来
           · 少了 restore()   → restoreFrom() 抛错 → 读档失败、静默新开一局
         （早期这里手写了 now/advance/onTick/speed 四项，绕过了 core/engine/ports.js 里那份
          完整的端口定义，于是上面三条在真实浏览器里全部成立，而 headless 逻辑测试
          自己造 clock 传给引擎上下文，完全覆盖不到这条线。） */
      clock: {
        now: () => clock.now(),
        advance: days => clock.advance(days),
        /* ★ 一根 K 线这一档也在契约里（故事模式空格键 = 推进 4 小时）。
           这个适配器是**手写白名单**，漏一个方法就是「端口上没有它」：
           core/engine/ports.js 会给一个 advanceBars 的兜底（退化成走一天），
           于是「按一下空格走了一整天」—— 不报错，只是完全不对。 */
        advanceBars: bars => clock.advanceBars(bars),
        onTick: cb => clock.onTick(cb),
        speed: { get: () => clock.speed.get(), set: x => clock.speed.set(x) },
        pause: () => clock.pause(),
        resume: () => clock.resume(),
        paused: () => clock.paused,
        advanceTo: days => clock.advanceTo(days),
        /* 时间刻度：界面与键位拿它换算（一天几根、一根多少毫秒），
           抄成常量会在换数据集粒度时错一天。 */
        barMs: clock.barMs,
        barsPerDay: clock.barsPerDay,
        serialize: () => clock.serialize(),
        restore: snapshot => clock.restore(snapshot),
        reveal: () => clock.reveal()
      },
      storage: CS.ports.localStore(opts.storageNs || 'cs:')
    });

    return {
      ports, clock, account, market,
      dataset,
      ready,
      /* 每推进一根 K 线要做的事：撮合挂单 → 强平 → 资金费 → 记账权益曲线 */
      step() { return market.settleStep(); },
      dispose() { ports.market.dispose(); }
    };
  }

  return { host: { create, ensureDataset, DATASET_SCRIPT } };
});
