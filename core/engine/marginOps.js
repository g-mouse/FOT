/* ============ 追保与追加保证金（账户引擎的一个零件，零 DOM） ============
   「这一根里最深亏到过保证金的几成」（worstRatio）与「往一笔仓位里补保证金」这两件事，
   都要读账户的仓位并且要能改 cash —— 但它们**不是记账本身**，所以拆出来，
   由 core/engine/accountEngine.js 把几个口子递进来（positions / cash / spend / 几个算价的函数）。

   旧实现在 game/js/playback/risk.js 与 game/js/account/trade.js 的 addMarginToPosition，
   两条口径逐条搬过来：

   一、最差浮亏用**影线**量，不用收盘价
     做多看这一根的最低价、做空看最高价 —— 与强平判定同一侧。
       · **只增不减**：光标退回去也不会把已经发生过的最差情形抹掉；
       · 读一次就清零（clearRisk），于是「提醒过一次」不会每根都重来 ——
         留着的话，一根影线扫过之后就再也不会为下一段行情提醒了。

   二、追加保证金要**跟着重算有效杠杆**
     强平价是从 notional / margin 这个比值推出来的。只加 margin 不改 leverage 的话，
     强平价一动不动，「追加保证金」这个动作等于白做 ——
     旧引擎的 liqPriceAt 收的正是 notional/margin，两边口径在这一处对齐。

   常量放在 accountEngine（WARN_RATIO / LIQ_FEE_RATE），这一层从它读 —— 一个数只有一处。 */
CS.define('core/engine/marginOps', ["core/events/events"], function () {
  'use strict';

  /* deps = {
       positions()          活的那份仓位数组（只读遍历；改由下面的口子做）
       cash()               可用余额（内部最小单位）
       spend(amount)        从可用余额里扣掉（accountEngine 内部改 cash 的唯一入口）
       round(n)
       notionalOf(pos)      名义仓位
       positionValue(pos, price)
       liquidationPriceOf(pos)
       warnRatio            追保线（默认 0.6）
     } */
  function create(deps) {
    const WARN = () => {
      const v = Number(deps.warnRatio);
      return Number.isFinite(v) && v > 0 ? v : 0.6;
    };

    /* 这一根的最差浮亏 → 记进仓位；返回**该提醒且还没提醒过**的那几笔 */
    function trackRisk(barOf) {
      const risky = [];
      for (const pos of deps.positions()) {
        const bar = barOf(pos.instrumentId);
        if (!bar) continue;
        const worst = pos.side === 'long' ? bar.l : bar.h;
        if (!Number.isFinite(worst)) continue;
        const ratio = pos.margin > 0 ? Math.max(0, -deps.positionValue(pos, worst) / pos.margin) : 0;
        if (ratio > (Number(pos.worstRatio) || 0)) pos.worstRatio = ratio;
        if ((Number(pos.worstRatio) || 0) >= WARN() && !pos.warned) risky.push(pos);
      }
      return risky;
    }
    /* 提醒过了（或玩家处理过了）：把这一轮的量法归零，下一段行情重新算 */
    function clearRisk(positionId) {
      const pos = deps.positions().find(p => p.id === positionId);
      if (!pos) return false;
      pos.worstRatio = 0;
      pos.warned = true;
      return true;
    }
    /* 追加保证金：把可用余额挪进这一笔仓位的保证金里，强平价因此被推远 */
    function addMargin(positionId, amount) {
      const pos = deps.positions().find(p => p.id === positionId);
      const add = deps.round(amount);
      if (!pos) return { ok: false, why: '没有这笔仓位' };
      if (!(add > 0)) return { ok: false, why: '金额不合法' };
      if (add > deps.cash()) return { ok: false, why: '可用余额不足' };
      deps.spend(add);
      pos.margin += add;
      /* ★ 有效杠杆跟着重算（notional / margin）—— 见文件头第二节 */
      pos.leverage = Math.max(1, deps.notionalOf(pos) / pos.margin);
      pos.liquidationPrice = deps.liquidationPriceOf(pos);
      /* 加了保证金就是玩家**已经处理过**的信号：不重置的话下一根又会拿旧的最差值来提醒 */
      pos.warned = false;
      pos.worstRatio = 0;
      CS.events.bus.emit('account.marginAdded', { positionId, amount: add });
      return { ok: true, position: Object.assign({}, pos) };
    }

    return { trackRisk, clearRisk, addMargin, WARN_RATIO: WARN };
  }

  return { marginOps: { create } };
});
