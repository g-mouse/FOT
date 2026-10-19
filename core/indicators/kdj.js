/* ============ KDJ：随机指标（副图）============
   先算 RSV（收盘价在最近 N 根 最低~最高 里的位置，0–100），再各自做一次 SMA 平滑得到 K 与 D，
   J = 3K − 2D（比 K/D 更敏感，会跑到 0–100 之外，所以纵轴按数据自适应）。
   参考线画在 20 / 80。三条线的平滑周期（m1 / m2）都可以单独改。 */
CS.define('core/indicators/kdj', ["core/indicators/rsi"], function () {
  'use strict';

  const ns = CS.open('indicators');
  const { highest, lowest } = ns.math;

  const K_RGB = [56, 189, 248], D_RGB = [245, 158, 11], J_RGB = [244, 114, 182];

  ns.register({
    id: 'kdj',
    name: 'KDJ',
    cn: '随机指标',
    kind: 'pane',
    desc: 'RSV 是收盘价在最近 N 根 最低~最高 里的位置；K、D 各做一次平滑，J = 3K − 2D。80 以上超买、20 以下超卖，K 上穿 D 为多头信号。',
    params: [
      { key: 'period', label: 'RSV 周期', min: 2, max: 200, step: 1, def: 9, int: true },
      { key: 'm1', label: 'K 平滑', min: 1, max: 20, step: 1, def: 3, int: true },
      { key: 'm2', label: 'D 平滑', min: 1, max: 20, step: 1, def: 3, int: true }
    ],
    defaults: [{ period: 9, m1: 3, m2: 3 }],
    warmup: params => (params.period || 9) + (params.m1 || 3) * 4 + (params.m2 || 3) * 4,
    guides: [{ value: 20, label: '超卖' }, { value: 50 }, { value: 80, label: '超买' }],
    compute(ctx) {
      const period = ctx.params.period, m1 = ctx.params.m1, m2 = ctx.params.m2;
      const n = ctx.rows.length;
      const high = highest(ctx.highs, period), low = lowest(ctx.lows, period);
      const rsv = new Float64Array(n).fill(NaN);
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(high[i]) || !Number.isFinite(low[i])) continue;
        const span = high[i] - low[i];
        rsv[i] = span === 0 ? 50 : (ctx.closes[i] - low[i]) / span * 100;
      }
      /* K、D 的递推从 RSV 第一次有值那根开始（之前的 K / D 没有意义，保持 NaN = 不画） */
      const start = rsv.findIndex(Number.isFinite);
      const begin = start < 0 ? n : start;
      const k = new Float64Array(n).fill(NaN), d = new Float64Array(n).fill(NaN), j = new Float64Array(n).fill(NaN);
      let prevK = 50, prevD = 50;
      for (let i = begin; i < n; i++) {
        prevK = ((m1 - 1) * prevK + rsv[i]) / m1;
        prevD = ((m2 - 1) * prevD + prevK) / m2;
        k[i] = prevK; d[i] = prevD; j[i] = 3 * prevK - 2 * prevD;
      }
      return {
        series: [
          { key: 'k', label: `K ${period},${m1}`, rgb: K_RGB, values: k, width: 1.4 },
          { key: 'd', label: `D ${m2}`, rgb: D_RGB, values: d, width: 1.4 },
          { key: 'j', label: 'J', rgb: J_RGB, values: j, width: 1.2, dash: [4, 3] }
        ]
      };
    }
  });
});
