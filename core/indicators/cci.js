/* ============ CCI：顺势指标（副图）============
   典型价（高+低+收）/3 偏离它自己 N 根均值的程度，再除以平均绝对偏差。
   ±100 是常用的两条线：站上 +100 常看作强势启动、跌破 −100 看作弱势。
   —— 这个指标是照「再加一个指标要动多少」的样板写的：**只多这一个文件**（外加 index.html 里一行
      <script>），面板、参数控件、副图、快照全部自动跟上（骨架见 registry.js 的 definePane）。 */
CS.define('core/indicators/cci', ["core/indicators/atr"], function () {
  'use strict';

  const ns = CS.open('indicators');
  const { cci } = ns.math;

  const CCI_RGB = [251, 146, 60];

  ns.definePane({
    id: 'cci',
    name: 'CCI',
    cn: '顺势指标',
    desc: '典型价偏离其 N 根均值的程度（除以平均绝对偏差）。+100 以上常看作强势、−100 以下看作弱势。',
    def: 20, max: 200,
    warmup: period => period * 2 + 10,
    guides: [{ value: -100 }, { value: 0 }, { value: 100 }],
    series: (ctx, period) => [
      { key: 'cci', label: `CCI${period}`, rgb: CCI_RGB, values: cci(ctx.highs, ctx.lows, ctx.closes, period), width: 1.5 }
    ]
  });
});
