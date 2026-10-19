/* ============ 撮合引擎与交易所侧失真（§2.6 [R12] 第 2 类） ============
   短线玩家最容易被「高夏普」骗到，因为纸面回测里没有这些东西：
     滑点、隔夜跳空、手续费分层、借券费（资金费）、强平穿仓。
   这一层把它们全部实现，而且全部**确定性**（吃具名流或不含随机的公式），
   否则同一存档读两次会得到不同的成交价。

   ★ 四处**已经去掉**的机制（产品决定，别再往回加）：
     · **成交量的深度上限**：原来按「一根 K 线的名义成交 × 12 × 波动倍率」算一个可吃深度，
       超出部分被切碎（`partial_fill`）并把保证金按比例缩小。去掉之后**下单即全额成交**，
       不会再出现「我只开了 500，实际只成交了 53」这种事。
     · **熔断**：原来「单根位移 > 18%」或「panic 且波动分位 > 0.985」会禁掉开新仓
       （`circuit_breaker` 拒绝码）。现在这条没有分支了。
     · **停牌**：原来「这一根 o=h=l=c」会被判成 `suspended` 并拒绝成交。
       现在整块删掉 —— 数据里那些「一根不动」的时段照常可以按收盘价成交。
     · **流动性/深度这个数**：原来有一个 depthRef（深度参考值），
       既当过「这一单最多吃多少」，也当过滑点的分母。成交量上限与它一起去掉之后，
       滑点改成**只看波动率**（见 spreadOf）—— 盘口读数与成交冲击用的是同一个公式，
       不再有任何「深度」这个中间量。

   滑点模型：数据包**没有成交量**（原始 K 线是 [t,o,h,l,c]），
   所以不许编造成交量。可用的真实信息是波动率与价格 —— 滑点与它们正相关：
     波动越大 → 冲击成本越高
   这不是「模拟得像」，而是把「真实数据里能推出来的那一部分」用上，
   并且 DatasetMeta.volumeAvailable 如实写 false。 */
CS.define('core/engine/marketEngine', ["core/engine/accountEngine","core/events/events","core/market/filter","core/market/regime","lib/lodash"], function () {
  'use strict';

  /* 手续费分层：杠杆越高，开仓手续费越高（与 game/index.html 的 order-note 同口径） */
  const FEE_TIERS = [
    { maxLeverage: 5, rate: 0.0004 },
    { maxLeverage: 20, rate: 0.0006 },
    { maxLeverage: 50, rate: 0.0010 },
    { maxLeverage: 100, rate: 0.0015 }
  ];
  function feeRateFor(leverage, modifiers) {
    const lev = Math.max(1, Number(leverage) || 1);
    const tier = FEE_TIERS.find(t => lev <= t.maxLeverage) || FEE_TIERS[FEE_TIERS.length - 1];
    const m = modifiers || {};
    let rate = tier.rate * (m.feeRateMul == null ? 1 : m.feeRateMul);
    if (m.feeRate != null) rate = m.feeRate;
    return rate;
  }

  function create(options) {
    const opts = options || {};
    const market = opts.market;                 // core/marketData
    const account = opts.account;               // core/accountEngine
    const clockNow = opts.clockNow || (() => ({ dayIndex: 0, barIndex: 0 }));
    const limitsOf = opts.limitsOf || (() => ({}));   // 由 buff 汇总出来的交易限制
    const digitsOf = opts.digitsOf || (() => 2);

    const subscribers = [];
    const rejects = [];
    let pending = [];
    let lastQuote = {};
    /* 资金费豁免：**按持仓 id** 问一句「这一笔要不要收资金费」。默认一个都不豁免。
       为什么要有这一个口子：新手引导的练习单是**教学道具** —— 课表把「赚/亏多少保证金」
       与资金费估算都写进了课文，收它 8 小时一次的资金费会让课上的数字慢慢跑偏
       （实测：一笔练习单持有 400 根 4h K 线被收了 166 万，占 500 万保证金的 33%；
       而 core/tutorial/entry.js 那句注释写的是「引导的练习单**不收**」）。
       装不上它的时候行为与以前逐字相同（null = 谁都不豁免）。 */
    let fundingExempt = null;

    function now() { return clockNow(); }

    function barOf(instrumentId) {
      const s = market.seriesRef(instrumentId);
      if (!s) return null;
      const i = Math.min(s.count - 1, Math.max(0, now().barIndex));
      return s.bars[i] || null;
    }
    function prevBarOf(instrumentId) {
      const s = market.seriesRef(instrumentId);
      if (!s) return null;
      const i = Math.min(s.count - 1, Math.max(0, now().barIndex - 1));
      return s.bars[i] || null;
    }

    /* ---------- 市场状态（只用来定滑点档位） ---------- */
    function regimeOf(instrumentId) {
      const s = market.seriesRef(instrumentId);
      if (!s) return null;
      /* ★ 取价下标**不许越过光标**。这里早先写的是 Math.max(20, now().barIndex)：
         开局前 20 根（头 3 天多）一律按第 20 根分类，而那 20 根的波动玩家还没看到 ——
         于是开头的成交价与滑点全是「未来波动」的函数，
         正是 [R18]「执行期只能看到已揭晓的 bar」要挡的那件事。
         regime.classify 自己就能处理历史不足（短历史返回 null 均线、分位默认 0.5）。 */
      const i = Math.min(s.count - 1, Math.max(0, now().barIndex));
      return CS.regime.classify(s.bars, i);
    }
    /* ---------- 滑点：波动越大，冲击成本越高 ----------
       ★ 这里原来还有一个「深度参考值」（depthRef）—— 先是当成交量上限，
       上限去掉之后只剩「给滑点当分母」这一个用途。现在连它也去掉了：
       滑点只看波动率，不再有任何「流动性/深度」的中间量。
       于是图上的价差读数与成交时的冲击成本是**同一个公式、同一个结果** ——
       玩家看到的那个数，就是他下单时会吃到的那一份滑点。 */
    function spreadOf(instrumentId) {
      const bar = barOf(instrumentId);
      if (!bar) return 0;
      const tick = Math.pow(10, -digitsOf(instrumentId));
      const reg = regimeOf(instrumentId);
      const vol = reg ? Math.max(0.004, reg.vol20 || 0.02) : 0.02;
      /* 0.03 是「冲击占这一档波动多远」的系数：比原来参与率那一套更直白 ——
         波动 2% 的品种，一手成交的冲击成本 ≈ 万分之六。 */
      return Math.max(tick, bar.c * vol * 0.03);
    }

    /* ---------- 下单 ---------- */
    function submitOrder(order) {
      const o = order || {};
      const instrumentId = o.instrumentId;
      const reject = (code, why, extra) => {
        const item = Object.assign({ code, why, instrumentId, ts: now() }, extra || {});
        rejects.push(item);
        CS.events.bus.emit('market.reject', item);
        return { ok: false, filledQty: 0, avgPrice: 0, fee: 0, ts: now(), rejects: [item] };
      };

      if (!instrumentId) return reject('missing_instrument', '没有指定交易对');
      /* 行情过滤：被设置隐藏的那一段不许下单（与旧引擎同一道闸门）。
         判据只有一处（core/market/filter.js），这里只负责把拒绝说清楚 ——
         界面上的「过滤中」与这一句用的是同一个 reasonFor。 */
      if (CS.marketFilter && !CS.marketFilter.isAvailable(instrumentId, now().barIndex)) {
        return reject('not_listed_yet', CS.marketFilter.reasonFor(instrumentId));
      }
      const bar = barOf(instrumentId);
      if (!bar) return reject('no_data', '这一根 K 线还没揭晓（未来数据守卫）');

      const limit = limitsOf();
      const side = o.side === 'short' ? 'short' : 'long';
      let leverage = Math.max(1, Number(o.leverage) || 1);
      if (limit.leverageCap && leverage > limit.leverageCap) return reject('leverage_cap', `当前杠杆上限 ${limit.leverageCap}×（受 buff/debuff 限制）`, { cap: limit.leverageCap });
      if (limit.instrumentWhitelist && limit.instrumentWhitelist.length && limit.instrumentWhitelist.indexOf(instrumentId) < 0) {
        return reject('instrument_not_allowed', `${instrumentId} 不在可交易品种白名单里`);
      }
      if (limit.instrumentBlacklist && limit.instrumentBlacklist.indexOf(instrumentId) >= 0) {
        return reject('instrument_blocked', `${instrumentId} 被禁止交易（合规或风控原因）`);
      }

      /* ★ `positionCap` 是**单笔保证金上限**（自有资金投入上限），不是名义仓位上限。
         旧写法是 `notional = Math.min(margin * leverage, positionCap)` ——
         后果是：撞上这个上限之后**再往上拉杠杆名义仓位一动不动**
         （现场缺陷：用户报的「杠杆调大了跟没调一样 / 名义仓位被卡在总资产那儿」）。
         现在改成先把**保证金**夹到上限里，再按杠杆折名义仓位：
         设计意图（不让你重仓）保留，杠杆也回到它该有的作用上。
         口径与界面同源，见 ui/components/tradeModel.js 的 preview() / maxMarginInternal()。 */
      const marginInput = Math.round(Number(o.margin) || 0);
      const effectiveMargin = limit.positionCap ? Math.min(marginInput, Math.floor(limit.positionCap)) : marginInput;

      /* ★ 不按深度切碎了：下单多少就成交多少。
         原来这里算 fillRatio / partial / filledNotional，深度不够时只成交一部分、
         保证金也按比例缩小 —— 玩家点了 500 保证金却只开出几十块的仓，而且
         成交回报里那两条「深度只吃下 xx%」解释不了「我的钱去哪了」。
         现在 fillRatio 恒为 1、partial 恒为 false，两个字段留在成交回报里
         只是为了让订阅者的形状不变（见 ui/components/tradePanel.js 的播报）。 */
      const fillRatio = 1;
      const partial = false;
      /* 名义仓位 = **保证金 × 杠杆**（保证金已经先被 positionCap 夹过）。
         全引擎只此一处算它，开仓时原样记进持仓（accountEngine.openPosition）。 */
      const notional = Math.round(effectiveMargin * leverage);
      const filledNotional = notional;

      /* 隔夜跳空：这一根的开盘价与上一根收盘价之间的缺口，就是市价单的真实成交起点 */
      const prev = prevBarOf(instrumentId);
      const gap = prev ? bar.o - prev.c : 0;
      const slip = spreadOf(instrumentId);
      const basePrice = o.type === 'limit' && Number.isFinite(o.price) ? Number(o.price) : bar.c;
      const fillPrice = o.type === 'limit' && Number.isFinite(o.price)
        ? (side === 'long' ? Math.min(o.price, basePrice + slip) : Math.max(o.price, basePrice - slip))
        : basePrice + (side === 'long' ? slip : -slip);

      const feeRate = feeRateFor(leverage, limit);
      const fee = Math.round(filledNotional * feeRate);
      if (effectiveMargin + fee > account.cash) {
        return reject('insufficient_cash', `需要 ${effectiveMargin + fee}，可用 ${account.cash}`, { need: effectiveMargin + fee, have: account.cash });
      }

      const result = account.openPosition({
        instrumentId, side, margin: effectiveMargin, leverage, notional: filledNotional,
        price: fillPrice, fee, ts: now().ts || now().barIndex, fills: 1
      });
      if (!result.ok) return reject(result.rejects[0] ? result.rejects[0].code : 'rejected', (result.rejects[0] && result.rejects[0].why) || '被拒绝');

      const fill = {
        ok: true, instrumentId, side, requestedNotional: notional, filledNotional,
        /* type 让订阅者分得清「我刚点的市价单」与「推进时间时被撮合的限价单」：
           两者都发 market.fill，而界面要播报的话术不一样
           （见 ui/components/tradePanel.js 的 tradePanelFill）。 */
        type: o.type === 'limit' ? 'limit' : 'market',
        filledQty: filledNotional / fillPrice, avgPrice: fillPrice, fee, ts: now(),
        slippage: slip, gap, partial, fillRatio,
        /* 成交回报里不再有「被切碎」的说明：深度已经不限制成交量了 */
        rejects: []
      };
      lastQuote[instrumentId] = fillPrice;
      subscribers.forEach(cb => { try { cb({ kind: 'fill', fill }); } catch (_) {} });
      CS.events.bus.emit('market.fill', fill);
      return fill;
    }

    /* 限价单：挂在 pending 上，由 advance 时逐根判定是否触及 */
    /* ★ 委托 id 必须来自**只增不减**的计数器，不能拿队列长度凑。
       早先写的是 `ord${pending.length + 1}_${barIndex}`：撤掉一笔之后队列变短，
       同一根 K 线里再挂一笔就会**复用**刚被撤掉那个 id
       （挂 A→ord1、挂 B→ord2、撤 A、再挂 C→又是 ord2），
       于是两行委托共用一个 id，cancelOrder 的 findIndex 命中的是第一笔 ——
       点「撤单」撤掉的是另一笔，克隆那笔还留在账上。 */
    let orderSeq = 0;
    function placeLimit(order) {
      const o = Object.assign({}, order, { type: 'limit' });
      if (!Number.isFinite(Number(o.price))) return { ok: false, why: '限价单需要一个价格' };
      /* 与市价那条路同一道闸门：被过滤掉的品种也不许挂单（挂上去也永远不会成交） */
      if (CS.marketFilter && !CS.marketFilter.isAvailable(o.instrumentId, now().barIndex)) {
        return { ok: false, why: CS.marketFilter.reasonFor(o.instrumentId) };
      }
      orderSeq++;
      /* ★ 委托行要显示「冻结了多少、成交后会挂在哪个强平价上、离成交还差多少」——
         前两项必须在**挂单这一刻**算出来并记在委托上：
         杠杆与保证金此后可以被玩家改（改下单表单不影响已挂的单），
         事后拿面板此刻的读数去算，结算记录里那一行就会与当时挂的不是一笔账。
         ★ positionCap 与市价那条路同一个口径（夹**保证金**，不夹名义仓位）：
         两条路不一致的话，「市价能开 20 万、同样参数挂限价只能开 2 万」——
         玩家对着同一个表单按出来的两个数会对不上。 */
      const limitOf = limitsOf();
      const marginInput = Math.round(Number(o.margin) || 0);
      const margin = limitOf.positionCap ? Math.min(marginInput, Math.floor(limitOf.positionCap)) : marginInput;
      const leverage = Math.max(1, Number(o.leverage) || 1);
      const limit = Number(o.price);
      o.margin = margin;
      o.leverage = leverage;
      o.notional = Math.round(margin * leverage);
      o.fee = Math.round(o.notional * feeRateFor(leverage, limitOf));
      o.liquidationPrice = limit * (1 - (o.side === 'short' ? -1 : 1) * (1 / leverage - CS.accountEngine.MAINTENANCE_MARGIN_RATE));
      const item = {
        id: `ord${orderSeq}_${now().barIndex}`, order: o, placedAt: now(), status: 'pending',
        /* 挂单那一根不算（与旧实现的 placedBase 同一条守卫）：
           判定从**下一根**开始，挂完停在原地不会自己成交。 */
        placedBarIndex: now().barIndex
      };
      pending.push(item);
      CS.events.bus.emit('market.orderPlaced', item);
      return { ok: true, orderId: item.id };
    }
    function cancelOrder(orderId) {
      const at = pending.findIndex(p => p.id === orderId);
      if (at < 0) return { ok: false };
      pending.splice(at, 1);
      CS.events.bus.emit('market.orderCancelled', { orderId });
      return { ok: true };
    }
    /* 每推进一根：先判定挂单是否触及，再判定强平，最后结算资金费 */
    function settleStep() {
      const fills = [];
      for (const item of pending.slice()) {
        const bar = barOf(item.order.instrumentId);
        if (!bar) continue;
        const want = Number(item.order.price);
        const touched = item.order.side === 'short' ? bar.h >= want : bar.l <= want;
        if (!touched) continue;
        /* allowHalt 原本是给「熔断时段挂单仍可成交」留的口子，熔断与停牌都删掉之后
           这一层不再需要任何交易状态判断：挂单触摸到就成交。 */
        const result = submitOrder(Object.assign({}, item.order, { type: 'limit' }));
        if (result.ok) { fills.push(result); cancelOrder(item.id); }
      }
      /* ★ 顺序：先量风险（这一根的影线最深亏到保证金的几成）、再判强平、最后结资金费。
         量风险必须**抢在强平之前**：被扫爆的那一笔，玩家该先看到的是「追保提醒」，
         而不是「它已经没了」—— 反过来的话提醒永远不会为真正危险的那一根响。 */
      const risky = account.trackRisk(id => barOf(id));
      if (risky.length) {
        CS.events.bus.emit('market.risk', {
          positions: risky.map(p => ({
            id: p.id, instrumentId: p.instrumentId, side: p.side,
            worstRatio: Number(p.worstRatio) || 0, margin: p.margin
          }))
        });
      }
      const liquidated = account.checkLiquidation(id => barOf(id));
      const ts = now().ts || now().barIndex;
      const funding = account.settleFunding((id, pos) => {
        /* 豁免的持仓：回一个「不是有限数」→ settleFunding 那条 `continue` 会跳过它。
           这一格只影响**资金费**：强平判定、手续费、盈亏都不看它。 */
        if (fundingExempt && pos && fundingExempt(pos.id)) return undefined;
        const s = market.seriesRef(id);
        if (!s) return undefined;
        return market.fundingRateAt(id, Math.min(s.count - 1, Math.max(0, now().barIndex)));
      }, ts);
      account.mark(id => (barOf(id) ? barOf(id).c : NaN), ts);
      if (liquidated.length) CS.events.bus.emit('market.liquidated', { trades: liquidated });
      return { fills, liquidated, funding };
    }

    function subscribe(cb) {
      subscribers.push(cb);
      return () => { const i = subscribers.indexOf(cb); if (i >= 0) subscribers.splice(i, 1); };
    }
    function quote(instrumentId) {
      const bar = barOf(instrumentId);
      if (!bar) return null;
      /* 报价里既没有 `liquidityCap` 也没有深度：那个数早就不代表任何限制，现在连算法都去掉了。
         spread 与成交时的滑点是**同一个** spreadOf() —— 图上的读数就是会吃到的那一份。 */
      return { instrumentId, price: bar.c, t: bar.t, spread: spreadOf(instrumentId) };
    }

    return {
      submitOrder, placeLimit, cancelOrder, subscribe, quote, settleStep,
      spreadOf, feeRateFor, barOf, prevBarOf,
      /* 当前挂单的**只读快照**（界面读它画「当前挂单」）。
         拷贝两层：调用方拿到的对象怎么改都不会动到引擎里那份 pending，
         而引擎自己的引用也不外泄。 */
      listOrders: () => pending.map(item => Object.assign({}, item, { order: Object.assign({}, item.order) })),
      get pending() { return pending.slice(); },
      get rejects() { return rejects.slice(-200); },
      restorePending(list) { pending = (list || []).slice(); },
      /* 资金费豁免（按持仓 id 问一句）。传 null / 不传 = 恢复「谁都不豁免」。
         装上它的只有新手引导（见 modes/classic/tutorial.js 的 wrapMarket）。 */
      setFundingExempt(fn) { fundingExempt = typeof fn === 'function' ? fn : null; },
      serializePending: () => pending.map(p => ({ id: p.id, order: p.order, placedAt: p.placedAt })),
      FEE_TIERS
    };
  }

  return { marketEngine: { create, feeRateFor, FEE_TIERS } };
});
