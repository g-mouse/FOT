/* ============ EMA：指数移动平均线（主图叠加，最多 5 条）============
   与 SMA 的区别只在权重：越新的收盘价权重越大（α = 2/(N+1)），所以转向更快、更贴价。
   递推指标要吃更长的历史才收敛，暖机取周期的 5 倍（骨架见 registry.js 的 defineMA）。 */
CS.define('core/indicators/ema', ["core/indicators/sma"], function () {
  'use strict';

  const ns = CS.open('indicators');
  const { ema } = ns.math;

  ns.defineMA({
    id: 'ema',
    name: 'EMA',
    cn: '指数移动平均线',
    desc: '按近期权重加权的移动平均线（α = 2/(N+1)）。比同周期的 SMA 更贴近价格、转向更快；最多 5 条，每条可单独开关。',
    /* 递推值要跑一段才收敛到「真实」的 EMA：暖机给周期的 5 倍 */
    warmup: period => period * 5,
    values: (ctx, period) => ema(ctx.closes, period)
  });
});
