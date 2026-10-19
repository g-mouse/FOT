/* ============ 交易页的两块「问一句 / 提个醒」（装配在一个文件里） ============
   它们都是「面板之外的界面」：一个在成交之前拦一下（开仓二次确认），
   一个在风险与爆仓时说话（追保提示 / 强平说明）。共同点：
     · 都只读交易页的读数（tradeModel）与设置槽（ctx.settings），不自己算钱；
     · 都要在面板 dispose 时退订 —— 退不干净的话，切一次模式就多一条订阅，
       下一次爆仓会弹两遍、三遍。
   所以装配与拆卸收在这里，tradePanel 只留两行（挂上 / 摘掉）。
   tradePanel 本身顶在当时的 400 行上限上，这几行也是它让出来的。 */
CS.define('ui/components/tradeHooks', ["lib/lodash","ui/components/tradeConfirm","ui/components/tradeRisk"], function () {
  'use strict';

  /* d = tradeModel 实例（读数）；ctx = 模式的钩子；ui = 面板的界面状态 */
  function attach(d, ctx, ui, hooks) {
    const h = hooks || {};
    const offs = [];

    /* ---------- 开仓二次确认 ----------
       把它接到意图层的 h.confirm 上：那边决定**什么时候**问（参数校验都过了之后），
       这里只决定**长什么样**（市价与限价两张单的字段不一样）。 */
    function confirmOpen(side, kind, go) {
      if (kind === 'limit') CS.tradeConfirm.limit(d, ui, side, go);
      else CS.tradeConfirm.market(d, ui, side, go);
    }

    /* ---------- 追保提示 / 强平说明 ----------
       判定在引擎侧（marketEngine.settleStep → account.trackRisk → market.risk 事件），
       这一层只负责怎么说。'onChanged' 让面板在弹完之后重画一次（保证金变了）。 */
    const risk = CS.tradeRisk.attach(d, ctx, { onChanged: () => { if (h.afterChange) h.afterChange(); } });

    return {
      confirmOpen,
      dispose() {
        try { risk.dispose(); } catch (_) {}
        offs.forEach(off => { try { off(); } catch (_) {} });
      }
    };
  }

  return { tradeHooks: { attach } };
});
