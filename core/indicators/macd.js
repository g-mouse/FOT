/* ============ MACD：指数平滑异同移动平均（副图）============
   DIF = EMA(快) − EMA(慢)，DEA = DIF 的 EMA(信号)，柱 = (DIF − DEA) × 2（国内软件的画法，
   柱子的正负与长度就是「两条线张得有多开」）。柱子按正负分别用涨/跌色。 */
CS.define('core/indicators/macd', ["core/indicators/supertrend"], function () {
  'use strict';

  const ns = CS.open('indicators');
  const { ema } = ns.math;

  const DIF_RGB = [56, 189, 248], DEA_RGB = [245, 158, 11];

  ns.register({
    id: 'macd',
    name: 'MACD',
    cn: '指数平滑异同移动平均',
    kind: 'pane',
    desc: 'DIF = EMA(快) − EMA(慢)，DEA = DIF 的信号线，柱 = (DIF − DEA) × 2。柱子由负转正、DIF 上穿 DEA 常看作多头信号。',
    params: [
      { key: 'fast', label: '快线周期', min: 2, max: 100, step: 1, def: 12, int: true },
      { key: 'slow', label: '慢线周期', min: 3, max: 200, step: 1, def: 26, int: true },
      { key: 'signal', label: '信号线周期', min: 2, max: 100, step: 1, def: 9, int: true }
    ],
    defaults: [{ fast: 12, slow: 26, signal: 9 }],
    /* 两条 EMA 串联，暖机给慢线的 5 倍再加信号线 */
    warmup: params => (params.slow || 26) * 5 + (params.signal || 9),
    guides: [{ value: 0 }],
    compute(ctx) {
      const fast = ctx.params.fast, slow = ctx.params.slow, signal = ctx.params.signal;
      const n = ctx.rows.length;
      const fastEma = ema(ctx.closes, fast), slowEma = ema(ctx.closes, slow);
      const dif = new Float64Array(n).fill(NaN);
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(fastEma[i]) && Number.isFinite(slowEma[i])) dif[i] = fastEma[i] - slowEma[i];
      }
      /* DEA 是 DIF 的 EMA：把 NaN 段跳过，从 DIF 有值的第一根起算 */
      const start = dif.findIndex(Number.isFinite);
      const dea = new Float64Array(n).fill(NaN);
      if (start >= 0) {
        const tail = ema(dif.slice(start), signal);
        for (let i = 0; i < tail.length; i++) dea[start + i] = tail[i];
      }
      const hist = new Float64Array(n).fill(NaN);
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(dif[i]) && Number.isFinite(dea[i])) hist[i] = (dif[i] - dea[i]) * 2;
      }
      return {
        series: [
          /* 柱子不给固定色：正负分别用涨/跌色（plotSeries 的默认口径），一眼看出多空。
             keepTone: true —— 让「按线改色」那一层**跳过**这条 series（见 indicatorColors.tintSeries）：
             柱子的正绿负红本身就是数据，被统一盖成线条色之后就只剩长度可看了。
             图例上的小色块仍然要有颜色，所以这里给一个中间灰，不再留空。 */
          { key: 'hist', label: 'MACD 柱', type: 'hist', keepTone: true, rgb: [148, 163, 184], values: hist },
          { key: 'dif', label: `DIF ${fast},${slow}`, rgb: DIF_RGB, values: dif, width: 1.3 },
          { key: 'dea', label: `DEA ${signal}`, rgb: DEA_RGB, values: dea, width: 1.3 }
        ]
      };
    }
  });
});
