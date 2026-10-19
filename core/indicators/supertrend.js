/* ============ SUPERTREND：超级趋势（主图叠加，只显示一组）============
   ATR 通道 + 趋势方向：上涨段画在价格下方（支撑、绿），下跌段画在价格上方（压力、红），
   趋势翻转时这条线换边换色。一条线两个方向，所以输出的是一条带 tones 的曲线
   （tones[i] = +1 涨势 / -1 跌势，画线时按它取 rgbUp / rgbDown）。

   算法与 TradingView 的 ta.supertrend 一致：
     上轨 = (高+低)/2 + K·ATR，只在「更靠内」或「已被收盘价突破」时才更新，否则沿用上一根；
     下轨同理；趋势由「收盘价有没有站到对面那条轨的外侧」翻转。 */
CS.define('core/indicators/supertrend', ["core/indicators/boll"], function () {
  'use strict';

  const ns = CS.open('indicators');
  const { rma, trueRange } = ns.math;

  const UP_RGB = [8, 153, 129], DOWN_RGB = [242, 54, 69];

  ns.register({
    id: 'supertrend',
    name: 'SUPERTREND',
    cn: '超级趋势',
    kind: 'overlay',
    lines: 1,                                    /* 只支持一组（用户要求：super 只支持显示一个） */
    desc: 'ATR 通道给出的趋势线：涨势时画在价格下方（绿），跌势时画在上方（红），收盘价穿越通道即翻转。只能显示一组。',
    params: [
      { key: 'period', label: 'ATR 周期', min: 2, max: 100, step: 1, def: 10, int: true },
      { key: 'mult', label: 'ATR 倍数', min: .5, max: 10, step: .1, def: 3 }
    ],
    defaults: [{ period: 10, mult: 3 }],
    warmup: params => (params.period || 10) * 6,
    compute(ctx) {
      const period = ctx.params.period, mult = ctx.params.mult;
      const n = ctx.rows.length;
      const atr = rma(trueRange(ctx.highs, ctx.lows, ctx.closes), period);
      const values = new Float64Array(n).fill(NaN);
      const tones = new Int8Array(n);
      let prevUpper = NaN, prevLower = NaN, prevDir = 0, dir = 1;   /* prevDir 0 = 还没有上一根 */
      for (let i = 0; i < n; i++) {
        const atrNow = atr[i];
        if (!Number.isFinite(atrNow)) continue;              /* 暖机段：ATR 还没出来 */
        const prevClose = i > 0 ? ctx.closes[i - 1] : ctx.closes[i];
        const half = (ctx.highs[i] + ctx.lows[i]) / 2;
        let upper = half + mult * atrNow, lower = half - mult * atrNow;
        /* 通道只往「更靠内」的方向移动，除非收盘价已经跑到它外面 —— 这样趋势线不会来回抖 */
        if (Number.isFinite(prevUpper)) upper = (upper < prevUpper || prevClose > prevUpper) ? upper : prevUpper;
        if (Number.isFinite(prevLower)) lower = (lower > prevLower || prevClose < prevLower) ? lower : prevLower;
        /* 「上一根画在哪条轨上」用上一轮算出来的方向直接判，**不要**拿 prevLine === prevUpper 去反推：
           ATR 为 0 的连续几根会让上下轨相等，那时浮点相等恰好成立就会把方向判反（线换边）。
           第一根（prevDir 还在 0）固定从上轨起步，与原实现一致。 */
        if (!prevDir) dir = 1;
        else if (prevDir === 1) dir = ctx.closes[i] > upper ? -1 : 1;
        else dir = ctx.closes[i] < lower ? 1 : -1;
        values[i] = dir === -1 ? lower : upper;
        tones[i] = dir === -1 ? 1 : -1;                       /* +1 涨势（线在下方）、-1 跌势（线在上方） */
        prevUpper = upper; prevLower = lower; prevDir = dir;
      }
      return {
        series: [{
          key: 'supertrend', label: `SUPERTREND ${period},${mult}`,
          rgb: UP_RGB, rgbUp: UP_RGB, rgbDown: DOWN_RGB, tones, values, width: 1.6,
          /* ★ 这一条线的颜色是**数据**（多头绿 / 空头红），不是「第几条线的配色」：
             computed 之后 registry 会调 indicatorColors.tintSeries 把每条 series 盖成
             该线的颜色（默认调色板 / 玩家自定义色），rgbUp/rgbDown 一起被盖掉 ——
             表现就是「多头空头都是同一个颜色」。keepTone 让这一层跳过它（与 MACD 柱同一机制）。 */
          keepTone: true
        }]
      };
    }
  });
});
