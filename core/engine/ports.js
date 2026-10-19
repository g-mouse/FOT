/* ============ Ports：宿主与模式之间的唯一契约面（§0.2） ============
   四个端口：market / account / clock / storage。
   故事模式的债务与 buff 全都作用在 account 上，所以「唯一改钱入口」这条必须由这里强制：
   面板与邮件选项**禁止**直接改 cash，只能 applyDelta；每一笔都进 ledger，
   于是「为什么这个月少了 4,120」可以展开到来源与去向（§2.6 拟真边界 [R13]）。

   create(impl) 不只是打包，还负责把三条硬性不变量焊上去：
     1) 记账唯一入口：applyDelta 之外拿不到改钱的路
     2) 未来数据守卫：market.loadSeries 越界即抛（[R18] 验收 19）
     3) 时钟推进必然回调 onTick：advance 之后不响就是缺陷 */
CS.define('core/engine/ports', ["core/events/events","lib/lodash"], function () {
  'use strict';

  const LEDGER_LIMIT = 6000;

  function create(impl) {
    const raw = impl || {};
    if (!raw.market) throw new Error('Ports 需要 market 端口');
    if (!raw.account) throw new Error('Ports 需要 account 端口');
    if (!raw.clock) throw new Error('Ports 需要 clock 端口');
    if (!raw.storage) throw new Error('Ports 需要 storage 端口');

    const ledger = [];
    let ledgerSeq = 0;

    /* ---------- market ---------- */
    let unsubscribers = [];
    const market = {
      listInstruments: () => raw.market.listInstruments(),
      loadSeries: (id, range) => raw.market.loadSeries(id, range),
      getDatasetMeta: () => raw.market.getDatasetMeta(),
      /* ★ 只在校准期调用。执行期持有它的引用是缺陷。 */
      getFullSeries: (id, reason) => raw.market.getFullSeries(id, reason || 'unspecified'),
      submitOrder: order => raw.market.submitOrder(order),
      /* 限价委托：挂上去不成交，等 K 线走到委托价才成交（由 marketEngine.settleStep
         在每根 K 线上撮合）。两个模式的交易页共用这一条路 —— 页面上那颗
         「限价委托」按钮能不能点，判据就是这里有没这个方法。 */
      placeLimit: order => raw.market.placeLimit(order),
      /* 还挂着哪些委托（未成交的）。面板的「当前挂单」读的就是它；
         找不到这个方法时宿主给空数组，界面画「暂无挂单」而不是报错。 */
      listOrders: () => (typeof raw.market.listOrders === 'function' ? raw.market.listOrders() : []),
      cancelOrder: orderId => raw.market.cancelOrder(orderId),
      subscribe(cb) {
        const off = raw.market.subscribe(cb);
        unsubscribers.push(off);
        return off;
      },
      dispose() { unsubscribers.forEach(off => { try { off(); } catch (_) {} }); unsubscribers = []; }
    };

    /* ---------- account ---------- */
    const account = {
      getSnapshot: () => raw.account.getSnapshot(),
      /* delta: { amount, reason, reasonKey, category, meta } —— amount 是内部货币单位 */
      applyDelta(delta) {
        const d = delta || {};
        if (d.amount === undefined || d.amount === null) throw new Error('applyDelta 需要 amount');
        const amount = Math.round(Number(d.amount) || 0);
        const result = raw.account.applyDelta(Object.assign({}, d, { amount }));
        ledgerSeq++;
        if (ledger.length < LEDGER_LIMIT) {
          ledger.push({
            seq: ledgerSeq, at: raw.clock.now(), amount,
            reasonKey: d.reasonKey || d.reason || '', category: d.category || 'other',
            balanceAfter: result && Number.isFinite(result.cash) ? result.cash : null,
            meta: d.meta || null
          });
        }
        if (CS.events) CS.events.bus.emit('account.delta', { amount, reasonKey: d.reasonKey || d.reason || '', category: d.category || 'other', result });
        return result;
      },
      getEquityCurve: () => raw.account.getEquityCurve(),
      reset: initialCash => { ledger.length = 0; ledgerSeq = 0; return raw.account.reset(initialCash); },
      /* 只读派生量：故事模式的债务、buff 汇总都读它 */
      metrics: () => (raw.account.metrics ? raw.account.metrics() : {})
    };

    /* ---------- clock ----------
       ★ 这个端口是**故事模式唯一的时钟句柄**（mode.js 里 ns.clock = host.ports.clock），
       所以它必须覆盖 mode.js 实际用到的每一个方法。早期这里只有 now/advance/onTick/speed，
       于是四个调用点在真实浏览器里全是 TypeError：
         · ns.clock.pause()      → advance() 一开头就抛 → 「推进一个月」按钮完全无效
                                   （时间永远停在第一天，玩家以为游戏坏了）
         · ns.clock.serialize()  → saveNow() 抛错 → 第一份存档根本写不出来
         · ns.clock.restore()    → restoreFrom() 抛错 → 读档失败，静默退回新开一局
                                   （表现就是「刷新之后进度没了」）
         · ns.clock.resume()     → 恢复播放时抛错
       垫片测试自己造 clock 传给引擎上下文，所以这条线一直没被覆盖到。 */
    const clock = {
      now: () => raw.clock.now(),
      async advance(days) {
        const before = raw.clock.now();
        const result = await raw.clock.advance(days);
        const after = raw.clock.now();
        if (after.dayIndex === before.dayIndex) {
          CS.errors.push({ message: 'clock.advance 没有推进时间：宿主实现有缺陷' });
        }
        return result;
      },
      /* 一小格 = 一根 4h K 线（故事模式空格键那一步）。
         判据与 advance 不同：**日界不一定要跨**，所以查的是 barIndex 有没有往前走。
         宿主没给这个能力时退化成 advance（一天）—— 那至少还是往前走的。 */
      async advanceBars(bars) {
        if (typeof raw.clock.advanceBars !== 'function') return clock.advance(1);
        const before = raw.clock.now();
        const result = await raw.clock.advanceBars(bars);
        const after = raw.clock.now();
        if (!(after.barIndex > before.barIndex)) {
          CS.errors.push({ message: 'clock.advanceBars 没有推进时间：宿主实现有缺陷' });
        }
        return result;
      },
      onTick: cb => raw.clock.onTick(cb),
      speed: { get: () => raw.clock.speed.get(), set: x => raw.clock.speed.set(x) },
      /* 下面这些是可选能力：宿主没给就退化成安全空操作，绝不让调用方抛错。
         但 core/engine/host.js 的实现给了全套（见 core/engine/clock.js）。 */
      pause: () => { if (typeof raw.clock.pause === 'function') raw.clock.pause(); },
      resume: () => { if (typeof raw.clock.resume === 'function') raw.clock.resume(); },
      paused: () => (typeof raw.clock.paused === 'boolean' ? raw.clock.paused : false),
      advanceTo: days => (typeof raw.clock.advanceTo === 'function' ? raw.clock.advanceTo(days) : clock.advance(days)),
      /* 一根 K 线代表多少毫秒与「一天几根」：界面与键位要拿它换算，
         宿主没给就按 4h × 6 兜底（仓库内唯一的数据集就是 4h）。 */
      barMs: () => (Number.isFinite(raw.clock.barMs) ? raw.clock.barMs : 4 * 3600000),
      barsPerDay: () => (Number.isFinite(raw.clock.barsPerDay) ? raw.clock.barsPerDay : 6),
      serialize: () => (typeof raw.clock.serialize === 'function' ? raw.clock.serialize() : { dayIndex: raw.clock.now().dayIndex }),
      restore: snapshot => (typeof raw.clock.restore === 'function' ? raw.clock.restore(snapshot) : raw.clock.now()),
      reveal: () => (typeof raw.clock.reveal === 'function' ? raw.clock.reveal() : raw.clock.now())
    };

    /* ---------- storage ---------- */
    const storage = {
      get: key => raw.storage.get(key),
      set: (key, value) => raw.storage.set(key, value),
      remove: key => raw.storage.remove(key),
      namespaced: prefix => raw.storage.namespaced(prefix)
    };

    return {
      market, account, clock, storage,
      /* 「钱从哪来、去哪了」：面板按 category / reasonKey 分组展开 */
      ledger: () => ledger.slice(),
      ledgerSince: seq => ledger.filter(e => e.seq > seq),
      lastLedgerSeq: () => ledgerSeq,
      /* 完整性自检：tools/run-tests.ps1 与 dev 面板用 */
      verify() {
        const problems = [];
        if (typeof market.getDatasetMeta !== 'function') problems.push('market.getDatasetMeta 缺失');
        if (typeof account.applyDelta !== 'function') problems.push('account.applyDelta 缺失');
        if (typeof clock.advance !== 'function') problems.push('clock.advance 缺失');
        if (typeof storage.namespaced !== 'function') problems.push('storage.namespaced 缺失');
        return { ok: problems.length === 0, problems };
      }
    };
  }

  /* ---------- storage 端口的三个现成实现 ---------- */
  function memoryStorage() {
    const map = new Map();
    const make = prefix => ({
      get: key => { const v = map.get(prefix + key); return v === undefined ? null : JSON.parse(v); },
      set: (key, value) => { map.set(prefix + key, JSON.stringify(value)); return true; },
      remove: key => { map.delete(prefix + key); },
      keys: () => Array.from(map.keys()).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
    });
    return {
      get: key => { const v = map.get(key); return v === undefined ? null : JSON.parse(v); },
      set: (key, value) => { map.set(key, JSON.stringify(value)); return true; },
      remove: key => { map.delete(key); },
      namespaced: make,
      _map: map
    };
  }

  function localStore(fallbackPrefix) {
    const prefix = fallbackPrefix || 'cs:';
    const safe = fn => { try { return fn(); } catch (_) { return null; } };
    const make = ns => ({
      get: key => safe(() => { const raw = localStorage.getItem(prefix + ns + key); return raw == null ? null : JSON.parse(raw); }),
      set: (key, value) => safe(() => { localStorage.setItem(prefix + ns + key, JSON.stringify(value)); return true; }) || false,
      remove: key => safe(() => { localStorage.removeItem(prefix + ns + key); }),
      keys: () => safe(() => Object.keys(localStorage).filter(k => k.startsWith(prefix + ns)).map(k => k.slice(prefix.length + ns.length))) || []
    });
    return {
      get: key => safe(() => { const raw = localStorage.getItem(prefix + key); return raw == null ? null : JSON.parse(raw); }),
      set: (key, value) => safe(() => { localStorage.setItem(prefix + key, JSON.stringify(value)); return true; }) || false,
      remove: key => safe(() => { localStorage.removeItem(prefix + key); }),
      namespaced: make
    };
  }

  return { ports: { create, memoryStorage, localStore } };
});
