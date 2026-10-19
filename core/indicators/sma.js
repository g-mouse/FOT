/* ============ SMA：简单移动平均线（主图叠加，最多 5 条）============
   收盘价的 N 根算术平均。每条线各有一套自己的周期参数，
   面板上的「第 n 条」与图上的第 n 条颜色一一对应（颜色取注册表里的 PALETTE）。
   骨架（5 条线、参数区间、颜色、标签）在 registry.js 的 defineMA() 里，这里只写数学与文案。 */
CS.define('core/indicators/sma', ["core/indicators/math"], function () {
  'use strict';

  const ns = CS.open('indicators');
  const { sma } = ns.math;

  ns.defineMA({
    id: 'sma',
    name: 'SMA',
    cn: '简单移动平均线',
    desc: '收盘价的 N 根算术平均线。周期越短越贴近价格、越长越平滑；最多同时显示 5 条，每条可单独开关。',
    /* 滚动和只需要 period 根历史，多给几根保险 */
    warmup: period => period + 5,
    values: (ctx, period) => sma(ctx.closes, period)
  });
});
