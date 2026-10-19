/* ============ 账户引擎（Ports.account 的实现，零 DOM） ============
   记账口径：内部一律整数最小单位（money.SCALE = 1e-4 USD）。
   **唯一改钱入口是 applyDelta** —— 面板、邮件选项、新闻效果全都只能通过它，
   于是「为什么这个月少了 4,120」可以展开到每一笔的来源与去向（§2.6 [R13]）。
   故事模式的债务与 buff 都作用在这一层上，但它们不许直接改 cash。

   持仓模型（与 game/ 的永续合约同一套语义，便于两边读数一致）：
     一笔仓位 = { 方向, 数量, 开仓价, 杠杆, 保证金 }，名义仓位 = 保证金 × 杠杆
     强平价按「保证金亏光」倒推，做多/做空分别减/加维持保证金率
     同一个交易对同一方向只有一个仓位，重复开仓按数量加权合并（与 game 的 mergeInto 同口径）
   ============================================================ */
CS.define('core/engine/accountEngine', ["core/base/util","core/events/events"], function () {
  'use strict';
  const { fingerprint } = CS.util;

  const MAINTENANCE_MARGIN_RATE = 0.005;   // 维持保证金率 0.5%
  const MAX_CURVE_POINTS = 4000;
  /* 平仓手续费的默认费率（名义仓位的 0.05%）。与 closePosition 里那个缺省值同一处来源：
     保本价要把它算进去，两处若各写一个数，「保本」就会与结算对不上。 */
  const DEFAULT_CLOSE_FEE_RATE = 0.0005;
  /* 强平费：**只有被强制平仓才收**，按名义仓位的 0.5%。主动平仓一分不收 ——
     这条差异是教学的一部分（「为什么爆仓比你自己平掉更贵」）。
     口径与旧教程页一致（game/js/config/account.js 的 LIQ_FEE_RATE）。 */
  const LIQ_FEE_RATE = 0.005;
  /* 追保线：浮亏达到保证金的 60% 就该提醒了（强平在 100% 附近，中间留一根影线的余地）。
     与旧教程页的 WARN_RATIO 同一个数。 */
  const WARN_RATIO = 0.6;

  function create(options) {
    const opts = options || {};
    const currency = opts.currency || 'USD';
    let initialCash = Math.round(opts.initialCash || 0);
    let cash = initialCash;
    let realized = 0;
    let feesPaid = 0;
    let fundingPaid = 0;
    let liqFeesPaid = 0;
    let positions = [];
    let closedTrades = [];
    let pendingOrders = [];
    let equityCurve = [];
    let seq = 0;
    let lastMark = { equity: initialCash, unrealized: 0, ts: 0 };
    /* 最近一次 mark() 用的价格取值器：metrics() 靠它算实时权益（见 metrics 里的说明）。
       reset / 读档之后为 null，那时 metrics() 退回 lastMark —— 与旧行为一致。 */
    let lastPriceOf = null;

    const round = n => Math.round(Number(n) || 0);

    function positionValue(pos, price) {
      const diff = pos.side === 'long' ? (price - pos.entryPrice) : (pos.entryPrice - price);
      return round(diff * pos.qty);
    }
    function unrealizedAt(priceOf) {
      return positions.reduce((sum, pos) => {
        const price = priceOf(pos.instrumentId);
        return sum + (Number.isFinite(price) ? positionValue(pos, price) : 0);
      }, 0);
    }
    function marginUsed() { return positions.reduce((a, p) => a + p.margin, 0); }
    function equityAt(priceOf) { return cash + marginUsed() + unrealizedAt(priceOf); }

    /* ---------- 快照 ---------- */
    function getSnapshot(priceOf) {
      const price = priceOf || (() => NaN);
      const unrealized = unrealizedAt(price);
      const used = marginUsed();
      return {
        cash, equity: cash + used + unrealized, marginUsed: used,
        /* 可用余额 = 内部余额 + 已占用保证金。`cash` 本身是**扣过保证金**的数
           （见 openPosition 的 cash -= margin），所以直接把它当 available 会低估购买力 ——
           一个 10,000 现金、6,000 保证金在跑的账户会报 available: 4000 而不是 10000。
           现在这个字段还没有读者，但把它留成错的比删掉更危险。 */
        available: cash + used,
        realized, unrealized, currency, feesPaid, fundingPaid, liqFeesPaid,
        positions: positions.map(p => Object.assign({}, p, { unrealized: Number.isFinite(price(p.instrumentId)) ? positionValue(p, price(p.instrumentId)) : 0 })),
        pendingOrders: pendingOrders.map(o => Object.assign({}, o))
      };
    }

    /* ---------- 唯一改钱入口 ---------- */
    function applyDelta(delta) {
      const d = delta || {};
      const amount = round(d.amount);
      if (!amount) return { ok: true, cash, equity: cash + marginUsed(), amount: 0 };
      const before = cash;
      cash += amount;
      if (amount < 0 && cash < 0) {
        /* 允许负余额（爆仓穿仓会产生负余额，这是真实存在的），
           但要把「已穿仓」这件事记下来，催收/追偿链由故事层接。 */
        cash = cash;
        CS.events.bus.emit('account.negative', { cash, amount, reasonKey: d.reasonKey || '' });
      }
      CS.events.bus.emit('account.changed', { before, after: cash, amount, reasonKey: d.reasonKey || '', category: d.category || 'other' });
      return { ok: true, cash, equity: cash + marginUsed(), amount };
    }

    /* ---------- 持仓 ---------- */
    function nextId(prefix) { seq++; return `${prefix}${String(seq).padStart(4, '0')}`; }

    function openPosition(order) {
      const o = order || {};
      const instrumentId = o.instrumentId;
      const side = o.side === 'short' ? 'short' : 'long';
      const margin = round(o.margin);
      const leverage = Math.max(1, Number(o.leverage) || 1);
      const notional = round(o.notional != null ? o.notional : margin * leverage);
      const price = Number(o.price);
      if (!instrumentId || !(margin > 0) || !Number.isFinite(price) || price <= 0) {
        return { ok: false, rejects: [{ code: 'invalid_order', why: '参数不合法' }] };
      }
      if (margin > cash) return { ok: false, rejects: [{ code: 'insufficient_cash', why: '可用余额不足', need: margin, have: cash }] };
      const fee = round(o.fee || 0);
      const qty = notional / price;
      const existing = positions.find(p => p.instrumentId === instrumentId && p.side === side);
      if (existing) {
        /* 合并：开仓价按数量加权、保证金相加、强平价按总保证金重算 */
        const totalQty = existing.qty + qty;
        existing.entryPrice = (existing.entryPrice * existing.qty + price * qty) / totalQty;
        existing.qty = totalQty;
        existing.margin += margin;
        /* ★ 先把杠杆抬到新的上限，再按它折算名义仓位。
           这两行写反过：notional 用的是**旧的** leverage，而 liquidationPriceOf()
           立刻用**新的** leverage 去算强平价 —— 同一笔仓位于是有两个互相矛盾的口径
           （名义仓位按 5× 记、强平价按 20× 算），价格还没跌到该有的位置就先被强平。
           名义仓位与强平价必须出自同一个 leverage。 */
        existing.leverage = Math.max(existing.leverage, leverage);
        existing.notional = round(existing.margin * existing.leverage);
        existing.liquidationPrice = liquidationPriceOf(existing);
        existing.updatedAt = o.ts || 0;
      } else {
        const pos = {
          id: nextId('pos'), instrumentId, side, qty, entryPrice: price, leverage, margin, notional,
          openedAt: o.ts || 0, updatedAt: o.ts || 0, feesPaid: fee, fundingPaid: 0, fills: o.fills || 1
        };
        pos.liquidationPrice = liquidationPriceOf(pos);
        positions.push(pos);
      }
      cash -= margin;
      if (fee) { cash -= fee; feesPaid += fee; }
      CS.events.bus.emit('account.positionOpened', { instrumentId, side, qty, price, margin, leverage, fee });
      return { ok: true, position: positions.find(p => p.instrumentId === instrumentId && p.side === side) };
    }

    /* 一笔仓位的名义价值：**全引擎只此一处**。
       以前 closePosition 用 pos.notional、settleFunding 用 entryPrice × qty，
       两把尺子量同一笔仓位 —— 部分成交（marketEngine 传进来的是 filledNotional）
       与合并加仓之后两个数并不相等，于是同一笔仓位的「手续费」与「资金费」
       基于不同的本金，moneyTrace 里那一行自己跟自己都对不上。
       口径取 pos.notional（开仓时记下的真实成交名义额），缺了才回退折算。 */
    function notionalOf(pos) {
      const n = Number(pos && pos.notional);
      if (Number.isFinite(n) && n > 0) return n;
      const byMargin = (Number(pos && pos.margin) || 0) * (Number(pos && pos.leverage) || 1);
      if (byMargin > 0) return byMargin;
      return (Number(pos && pos.entryPrice) || 0) * (Number(pos && pos.qty) || 0);
    }
    /* 平仓要收的手续费（按名义仓位与这一档的费率）。
       保本价要把它算进去 —— 只算开仓那一笔的话，标出来的「保本」其实还差一笔平仓费，
       玩家按它挂单会发现自己「保本价卖掉了却少了一点钱」。 */
    function closeFeeOf(pos, feeRate) {
      const rate = Number.isFinite(feeRate) ? feeRate : DEFAULT_CLOSE_FEE_RATE;
      return round(notionalOf(pos) * rate);
    }
    /* 损益两平价：把**开仓手续费 + 平仓再收一次 + 已结算资金费**摊进开仓价。
       旧的 game/js/account/positions.js:149-154 就是这么算的，逐字同一套：
         cost = 开仓费 + 平仓费 + 已结算资金费（正数 = 净支出）
         保本价 = 开仓价 × (1 + cost / 名义仓位 × 方向)
       所以它永远落在开仓价的**有利一侧**：做多在上方、做空在下方。
       收取的资金费多于手续费时它甚至可能落回开仓价之内 —— 那是对的，
       说明这笔仓位开出来就已经把成本收回来了。
       名义仓位缺了（早期存档）时退回开仓价，不编一个数出来。 */
    function breakEvenOf(pos, feeRate) {
      if (!pos) return NaN;
      const notional = notionalOf(pos);
      if (!(notional > 0)) return pos.entryPrice;
      const dir = pos.side === 'long' ? 1 : -1;
      const cost = (Number(pos.feesPaid) || 0) + closeFeeOf(pos, feeRate) + (Number(pos.fundingPaid) || 0);
      return pos.entryPrice * (1 + cost / notional * dir);
    }

    /* 强平价：保证金亏光的位置。做多：entry × (1 − 1/lev + mmr)，做空：entry × (1 + 1/lev − mmr) */
    function liquidationPriceOf(pos) {
      const dir = pos.side === 'long' ? 1 : -1;
      const ratio = 1 / Math.max(1, pos.leverage) - MAINTENANCE_MARGIN_RATE;
      return Math.max(0, pos.entryPrice * (1 - dir * ratio));
    }

    function closePosition(positionId, price, reason) {
      const at = positions.findIndex(p => p.id === positionId);
      if (at < 0) return { ok: false, why: '没有这笔仓位' };
      const pos = positions[at];
      const pnl = positionValue(pos, price);
      const feeRate = reason && reason.feeRate != null ? reason.feeRate : DEFAULT_CLOSE_FEE_RATE;
      const fee = round(notionalOf(pos) * feeRate);
      /* 强平费只在这一条路上收（reason.kind === 'liquidation'）。
         它和平仓手续费是两笔：手续费是「成交的成本」，强平费是「被平台接管的罚金」——
         合成一笔的话，强平那一下的账单就再也说不清哪一部分是为什么付的。 */
      const liqFee = (reason && reason.kind === 'liquidation') ? round(notionalOf(pos) * LIQ_FEE_RATE) : 0;
      const returned = pos.margin + pnl - fee - liqFee;
      cash += returned;
      realized += pnl;
      feesPaid += fee;
      liqFeesPaid += liqFee;
      positions.splice(at, 1);
      const trade = {
        id: nextId('trd'), instrumentId: pos.instrumentId, side: pos.side,
        /* ★ 这笔成交来自哪一笔持仓。结算记录、强平说明与新手引导都按持仓 id 认单 ——
           少了它就没法回答「刚被扫爆的是不是我手上那一单」：
           引导开着的时候玩家也可能自己下一单，而引导只该认**自己经手的那一笔**。 */
        positionId: pos.id,
        entryPrice: pos.entryPrice, exitPrice: price, qty: pos.qty,
        pnl, fee, liqFee, reason: (reason && reason.kind) || 'manual',
        /* 这一笔仓位到平仓为止**已经付过的资金费**（正数 = 净支出）。
           结算记录要能一次说清「这一单的成本 = 手续费 + 资金费 + 强平费」，
           少了这一格，弹窗与结算记录里的对账行就只能写个 0。 */
        funding: Number(pos.fundingPaid) || 0,
        openedAt: pos.openedAt, closedAt: (reason && reason.ts) || 0
      };
      closedTrades.push(trade);
      CS.events.bus.emit('account.positionClosed', trade);
      return { ok: true, trade, returned };
    }

    /* ============ 追保与追加保证金 ============
       「最差浮亏记多少、到点提醒谁、往仓位里补保证金」这三件事在 core/engine/marginOps.js ——
       它们要读仓位、也要能改 cash，但**不是记账本身**，所以拆出去，
       这里只把几个口子递进去。常量仍然只有这一处（WARN_RATIO / LIQ_FEE_RATE）。 */
    const risk = CS.marginOps.create({
      positions: () => positions,
      cash: () => cash,
      spend: amount => { cash -= amount; },
      round, notionalOf, positionValue, liquidationPriceOf,
      warnRatio: WARN_RATIO
    });
    const trackRisk = risk.trackRisk, clearRisk = risk.clearRisk, addMargin = risk.addMargin;

    /* 强平检查：bar 的最低/最高价穿过强平价即判定。
       跳空会穿过强平线形成负余额 —— 这是真实存在的（order-note 里也这么写）。 */
    function checkLiquidation(barOf) {
      const liquidated = [];
      for (const pos of positions.slice()) {
        const bar = barOf(pos.instrumentId);
        if (!bar) continue;
        const hit = pos.side === 'long' ? bar.l <= pos.liquidationPrice : bar.h >= pos.liquidationPrice;
        if (!hit) continue;
        /* ★ 结算价取**这一根真正成交到的更差那个价**，而不是强平价本身。
           文件头与 marketEngine 都承诺「行情跳空可能穿过爆仓线并形成负余额」，
           而按强平价结算是算不出缺口的：returned = margin + pnl − fee
           = notional × mmr − fee，任何杠杆下都是正数 —— 于是
             · 跳空穿仓永远不亏缺口，account.negative 这条事件从强平侧永远不可达；
             · 一根直接砸穿强平价的恐慌 K 线，10× 的仓位只亏掉约 95.5% 保证金，
               还被倒找一笔 notional×mmr 回来。
           多单取 min(强平价, 最低价)、空单取 max(强平价, 最高价)：
           没跳空时最低价就是强平价附近，与从前逐字一致；跳空时才真的吃到缺口。 */
        const settle = pos.side === 'long'
          ? Math.min(pos.liquidationPrice, bar.l)
          : Math.max(pos.liquidationPrice, bar.h);
        const result = closePosition(pos.id, settle, { kind: 'liquidation', ts: bar.t, feeRate: 0.0005 });
        liquidated.push(result.trade);
      }
      return liquidated;
    }

    /* 资金费：每 8 小时结算一次，做多付正值费率、做空收 —— 持仓不是免费的。
       rateOf(id, pos)：**把持仓也递出去**，调用方才有机会按持仓豁免（引导的练习单就不收，
       见 marketEngine 的 fundingExempt）。只认第一个参数的调用方行为逐字不变。 */
    function settleFunding(rateOf, ts) {
      let total = 0;
      for (const pos of positions) {
        const rate = rateOf(pos.instrumentId, pos);
        if (!Number.isFinite(rate)) continue;
        const notional = notionalOf(pos);
        const payment = round(notional * rate * (pos.side === 'long' ? -1 : 1));
        if (!payment) continue;
        cash += payment;
        pos.fundingPaid = (pos.fundingPaid || 0) + payment;
        fundingPaid += payment;
        total += payment;
      }
      if (total) CS.events.bus.emit('account.funding', { total, ts });
      return total;
    }

    function mark(priceOf, ts) {
      const unrealized = unrealizedAt(priceOf);
      /* ★ 记住这一次的价格取值器：`metrics()` 要用它算**实时**权益（见那边的说明）。
         不记的话，只改现金的动作（回信、结算、手续费）之后权益读数会停在上一根 K 线上。 */
      if (typeof priceOf === 'function') lastPriceOf = priceOf;
      let equity = cash + marginUsed() + unrealized;
      /* 权益曲线是评分的唯一输入，也是会落盘的：一个 NaN 进去就会被 JSON.stringify
         写成 null，之后永远读不回来（score.returnsFrom 只会 Number.isFinite 静默过滤，
         样本数肉眼不可见地变少）。宁可用上一笔权益。 */
      if (!Number.isFinite(equity)) {
        CS.errors.push({ message: `权益算出非有限数（cash=${cash} / unrealized=${unrealized}），已沿用上一笔 ${lastMark.equity}` });
        equity = lastMark.equity;
      }
      lastMark = { equity, unrealized, ts: ts || 0 };
      if (equityCurve.length >= MAX_CURVE_POINTS) equityCurve.shift();
      equityCurve.push({ t: ts || 0, equity });
      return lastMark;
    }

    function reset(initial) {
      initialCash = round(initial == null ? initialCash : initial);
      cash = initialCash; realized = 0; feesPaid = 0; fundingPaid = 0; liqFeesPaid = 0;
      positions = []; closedTrades = []; pendingOrders = []; equityCurve = [];
      lastMark = { equity: initialCash, unrealized: 0, ts: 0 };
      lastPriceOf = null;
      seq = 0;
      return getSnapshot();
    }

    function metrics() {
      const curve = equityCurve.map(p => p.equity);
      const peakOf = list => {
        let peak = list[0] || 0, dd = 0;
        for (const v of list) { if (v > peak) peak = v; dd = Math.max(dd, peak > 0 ? 1 - v / peak : 0); }
        return dd;
      };
      const wins = closedTrades.filter(t => t.pnl > 0).length;
      /* ★ 权益与浮盈要**当场算**，不能返回上一次 mark 的值。
         `lastMark` 只在 mark() 里更新，而 mark() 由行情每走一根调一次；
         `applyDelta`（回信、月度结算、手续费）只改 cash、不动 lastMark ——
         于是「只改现金、不走行情」的动作之后，总览条读到的还是上一根 K 线的权益：
         实测回信花掉 €194.40 之后，cash 已经是 73,498,932，
         而 metrics().equity 还是 75,442,932，界面照旧显示 €7,544.29。
         storyEvents.checkMonthly 也是读这里（判 ev.big_win / ev.big_loss），
         所以陈旧值还会影响事件判定。
         价格取值器是 mark() 那一次传进来的，存下来在这里复用（拿不到就退回 lastMark）。 */
      const live = (typeof lastPriceOf === 'function')
        ? (() => { const u = unrealizedAt(lastPriceOf); return { unrealized: u, equity: cash + marginUsed() + u }; })()
        : { unrealized: lastMark.unrealized, equity: lastMark.equity };
      return {
        initialCash, cash, realized, feesPaid, fundingPaid, liqFeesPaid,
        marginUsed: marginUsed(),
        equity: Number.isFinite(live.equity) ? live.equity : lastMark.equity,
        unrealized: Number.isFinite(live.unrealized) ? live.unrealized : lastMark.unrealized,
        nTrades: closedTrades.length,
        winRate: closedTrades.length ? wins / closedTrades.length : 0,
        maxDrawdown: curve.length ? peakOf(curve) : 0,
        fingerprint: fingerprint(positions.map(p => [p.instrumentId, p.side, Math.round(p.qty * 1e6), Math.round(p.entryPrice * 100)]))
      };
    }

    /* 存档：只存「本局怎么来的」，不存派生量 */
    function serialize() {
      return {
        currency, initialCash, cash, realized, feesPaid, fundingPaid, liqFeesPaid,
        positions: positions.map(p => Object.assign({}, p)),
        closedTrades: closedTrades.slice(-500),
        /* ★ 落盘要覆盖内存里保留的**整个**窗口。
           内存窗口是 MAX_CURVE_POINTS（4000 根 ≈ 666 天），这里早先只存 -1200（≈200 天）：
           任何超过 200 天的局，读档回来的曲线比存档前短一截，而 score.compute 把
           「曲线的第一个点」当成期初权益、按 t 的跨度算年数 ——
           于是**刷新一次就能把 Y 从正变负、把评分档位与结局一起换掉**，
           正是 savePayload 那段注释里写明了必须避免的那件事。
           两个窗口从此同一个常量，读数不再随读档漂移。 */
        equityCurve: equityCurve.slice(-MAX_CURVE_POINTS),
        seq
      };
    }
    /* 存档里的仓位与曲线是**外部输入**：形状不对就丢掉，绝不让它变成 NaN
       再被 JSON 写成 null 落盘。另外 lastMark 必须从曲线重建 —— 它原本不参与
       序列化，于是读档后 metrics().equity 会报出与 cash 矛盾的陈旧值。 */
    const asArray = v => (Array.isArray(v) ? v : []);
    function restore(data) {
      if (!data) return getSnapshot();
      initialCash = round(data.initialCash); cash = round(data.cash);
      realized = round(data.realized); feesPaid = round(data.feesPaid); fundingPaid = round(data.fundingPaid);
      liqFeesPaid = round(data.liqFeesPaid);
      positions = asArray(data.positions).filter(p => p && typeof p === 'object').map(p => Object.assign({}, p));
      closedTrades = asArray(data.closedTrades).filter(t => t && typeof t === 'object').slice();
      equityCurve = asArray(data.equityCurve).filter(p => p && Number.isFinite(p.equity)).slice();
      const last = equityCurve[equityCurve.length - 1];
      lastMark = last ? { equity: last.equity, unrealized: 0, ts: last.t || 0 } : { equity: cash + marginUsed(), unrealized: 0, ts: 0 };
      lastPriceOf = null;
      seq = Number.isFinite(data.seq) ? data.seq : 0;
      return getSnapshot();
    }

    return {
      CURRENCY: currency,
      getSnapshot, applyDelta, getEquityCurve: () => equityCurve.slice(), reset, metrics,
      openPosition, closePosition, checkLiquidation, settleFunding, mark, liquidationPriceOf,
      /* 追保那一路：把最差浮亏记在仓位上、到点报出来、玩家处理完之后清零；
         以及「追加保证金」这个动作本身（它是**唯一**能把强平价推远的入口）。 */
      trackRisk, clearRisk, addMargin,
      /* 保本价与它用到的两个零件：图表那条「损益两平价」线与持仓行都读它。
         口径与旧的 game/js/account/positions.js 逐字同一套（见 breakEvenOf 的说明）。 */
      breakEvenOf, closeFeeOf, notionalOf,
      serialize, restore,
      get cash() { return cash; },
      get realized() { return realized; },
      get positions() { return positions.slice(); },
      get closedTrades() { return closedTrades.slice(); },
      MAINTENANCE_MARGIN_RATE, LIQ_FEE_RATE, WARN_RATIO
    };
  }

  return { accountEngine: { create, MAINTENANCE_MARGIN_RATE, LIQ_FEE_RATE, WARN_RATIO } };
});
