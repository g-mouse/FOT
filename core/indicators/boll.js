/* ============ BOLL：布林带（主图叠加，只显示一组）============
   中轨 = N 根简单平均；上下轨 = 中轨 ± K 倍标准差。
   三条线是**同一次计算**的三条输出（上轨 / 中轨 / 下轨），中间那条与下轨之间填一层很淡的带子，
   一眼能看出「波动放大 / 收窄」。参数就两个：周期与标准差倍数。 */
CS.define('core/indicators/boll', ["core/indicators/ema"], function () {
  'use strict';

  const ns = CS.open('indicators');
  const { sma, stdev } = ns.math;

  const UP_RGB = [96, 165, 250], MID_RGB = [250, 204, 21], DOWN_RGB = [96, 165, 250];

  ns.register({
    id: 'boll',
    name: 'BOLL',
    cn: '布林带',
    kind: 'overlay',
    lines: 1,                                    /* 只支持一组（用户要求：boll 只支持显示一个） */
    desc: '中轨是 N 根简单平均，上下轨是中轨 ± K 倍标准差。带宽随波动放大、收窄；只能显示一组。',
    params: [
      { key: 'period', label: '周期', min: 2, max: 200, step: 1, def: 20, int: true },
      { key: 'mult', label: '标准差倍数', min: .5, max: 5, step: .1, def: 2 }
    ],
    defaults: [{ period: 20, mult: 2 }],
    warmup: params => (params.period || 20) + 5,
    compute(ctx) {
      const period = ctx.params.period, mult = ctx.params.mult;
      const mid = sma(ctx.closes, period);
      const dev = stdev(ctx.closes, period);
      const upper = new Float64Array(mid.length), lower = new Float64Array(mid.length);
      for (let i = 0; i < mid.length; i++) {
        upper[i] = mid[i] + mult * dev[i];
        lower[i] = mid[i] - mult * dev[i];
      }
      return {
        series: [
          { key: 'bollUpper', label: `BOLL 上轨 ${period}`, rgb: UP_RGB, values: upper, dash: [5, 3], width: 1.2 },
          { key: 'bollMid', label: `BOLL 中轨 ${period}`, rgb: MID_RGB, values: mid, width: 1.4 },
          { key: 'bollLower', label: `BOLL 下轨 ${period}`, rgb: DOWN_RGB, values: lower, dash: [5, 3], width: 1.2 },
          /* 带子：values 是下轨、values2 是上轨，画成半透明的填充 */
          { key: 'bollBand', label: '', type: 'band', values: lower, values2: upper, rgb: UP_RGB, alpha: .07 }
        ]
      };
    }
  });
});
