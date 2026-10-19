/* ============ RSI：相对强弱指标（副图）============
   一段时间里涨幅与跌幅的比值，0–100。70 以上常看作超买、30 以下超卖（参考线画在副图上）。
   纵轴固定 0–100 —— 它是比值，不需要按数据自适应。骨架见 registry.js 的 definePane()。 */
CS.define('core/indicators/rsi', ["core/indicators/macd"], function () {
  'use strict';

  const ns = CS.open('indicators');
  const { rsi } = ns.math;

  const RSI_RGB = [167, 139, 250];

  ns.definePane({
    id: 'rsi',
    name: 'RSI',
    cn: '相对强弱指标',
    desc: 'N 根里平均涨幅与平均跌幅的比值，0–100。70 以上常看作超买、30 以下超卖；50 是多空分界。',
    def: 14, max: 200,
    warmup: period => period * 5,
    range: [0, 100],
    guides: [{ value: 30, label: '超卖' }, { value: 50 }, { value: 70, label: '超买' }],
    series: (ctx, period) => [
      { key: 'rsi', label: `RSI${period}`, rgb: RSI_RGB, values: rsi(ctx.closes, period), width: 1.5 }
    ]
  });
});
