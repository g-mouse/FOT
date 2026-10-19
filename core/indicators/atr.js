/* ============ ATR：平均真实波幅（副图）============
   真实波幅 TR = max(高−低, |高−前收|, |低−前收|)，ATR 是它的 Wilder 平滑。
   它量的是「这根 K 线平均能走多远」，是仓位与止损的常用尺子（本程序强平价那一栏也是按波动设的）。
   骨架见 registry.js 的 definePane()。 */
CS.define('core/indicators/atr', ["core/indicators/kdj"], function () {
  'use strict';

  const ns = CS.open('indicators');
  const { rma, trueRange } = ns.math;

  const ATR_RGB = [45, 212, 191];

  ns.definePane({
    id: 'atr',
    name: 'ATR',
    cn: '平均真实波幅',
    desc: '真实波幅（含跳空）的 Wilder 平滑，单位与价格相同：数值越大说明最近这段行情越剧烈。常用来设止损距离与仓位大小。',
    def: 14, max: 200,
    warmup: period => period * 5,
    series: (ctx, period) => {
      const tr = trueRange(ctx.highs, ctx.lows, ctx.closes);
      const atr = rma(tr, period);
      /* 顺带给一条 ATR 自己的均线：ATR 上穿它通常意味着波动在放大 */
      const avg = rma(atr, period);
      return [
        { key: 'atr', label: `ATR${period}`, rgb: ATR_RGB, values: atr, width: 1.5 },
        { key: 'atrAvg', label: `ATR 均线 ${period}`, rgb: [148, 163, 184], values: avg, width: 1.2, dash: [4, 3] }
      ];
    }
  });
});
