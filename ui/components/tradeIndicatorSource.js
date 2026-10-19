/* ============ 图表要的「这一帧算出来的指标」（唯一的一处接线） ============
   图表只管问，不管怎么算 —— 它不认识 CS.indicators，也不认识行情是从哪来的。
   这一层就是那两者之间**唯一**的接触面：把「当前品种 + 当前周期 + 一屏几根」折成
   指标引擎要的那一份 rows，再把结果交给图表。

   两条纪律（都是踩过的）：
     · 周期与根数走 chartView 那**唯一**一个口径（与蜡烛同一批数据）——
       否则切到 8h 之后蜡烛是 8h 的、指标还在 4h 上算，不报错，只是线对不上；
     · 字段名转换在 chartView.indicatorInput 里做（行情 {o,h,l,c} → 引擎 {open,high,low,close}），
       自己转一遍迟早会漏一个字段，而漏了会让指标全算成 NaN。

   为什么单独一个文件：ui/components/tradePanel.js 顶在**当时**的 400 行上限上，
   而这一段是它里面**最自成一块**的零件（只有它一个读者是图表）。 */
CS.define('ui/components/tradeIndicatorSource', ["core/indicators/indicatorColors","core/indicators/indicatorState","core/indicators/registry","core/market/marketData","ui/components/chartView"], function () {
  'use strict';

  /* 返回 null = 这一局没有指标引擎（或引擎没装上），图表整段跳过 */
  function build(d, ui, bag) {
    if (!bag || !CS.indicators) return null;
    return {
      frame() {
        const id = d.currentInstrumentId();
        if (!id) return null;
        const view = CS.chartView.viewFor({
          barsOf: d.barsOf, id, want: ui.bars, tfId: ui.timeframe,
          version: CS.marketData.nowIndex
        });
        if (!view.bars.length) return null;
        const input = CS.chartView.indicatorInput(view, {
          barsOf: d.barsOf, id, warmup: CS.indicators.warmupBars(), version: CS.marketData.nowIndex
        });
        if (!input) return null;
        /* tag 里带上周期：不然切周期时帧备忘的键不变，会拿回上一个周期的结果 */
        return CS.indicators.computeFrame(input.rows, input.from, `${id}|${input.tf.id}`, d.digitsOf(id));
      }
    };
  }

  return { tradeIndicatorSource: { build } };
});
