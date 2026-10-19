/* ============ 指标画出来：主图叠加 + 副图（两个模式共用） ============
   这一层只做「把 CS.indicators 算好的 frame 画到画布上」，不碰 DOM 结构、
   不建画布、不管指标栏那块界面（那是 tradeIndicators.js 的事）。

   从 game/js/chart/overlays.js 与 panes.js 移植而来，画法逐字保留：
     · 主图叠加：先铺带子（BOLL 上下轨之间）再把线压上去 —— 反过来的话带子会盖住中轨；
     · 副图：网格 + 右轴三档刻度 + 0 轴 + 参考线（虚线小字）+ 带子/柱/线，
       线画完在**最新那一点**点一个小圆（一眼看出「现在在哪」）；
     · 副图横坐标**直接复用主图的几何**（left / right / step）：两块画布 CSS 宽度相同、
       格子数也相同（同一个可见窗口），所以竖着看每一根 K 线都对得齐；
       副图只自己算纵轴（RSI 是 0–100、ATR 是价格、CCI 能到 ±300，差得很远）。

   副图纵轴：定义里写了 range 就是固定轴，否则按可见值自适应；
   有柱子的（MACD）一定把 0 轴包进来，否则柱子会从画布外面长出来。

   由 tools/parity-panes.mjs 逐调用比对（见 tools/lib/pane-parity.cjs）。 */
CS.define('ui/components/chartIndicators', ["core/indicators/indicatorColors","core/indicators/indicatorState","core/indicators/registry","ui/components/chartPlot"], function () {
  'use strict';
  const PLOT = () => CS.chartPlot;
  /* 网格 / 轴文字 / 参考线的颜色与旧实现一致，主题可以覆盖 */
  const THEME = { grid: '#eef0f4', axis: '#8B90A0', zero: '#dfe3ea', guide: 'rgba(148,163,184,.55)', guideText: '#b3bac6', bg: '#ffffff' };

  /* 副图上的数字不是价格（RSI 是比值、ATR 是价格、CCI 是偏离度），所以不按交易对的小数位写，
     统一按大小取 0–2 位小数 —— 否则 DOGE 那种 5 位小数的交易对会把刻度写成 54.32154。
     ★ 这一格**试过换成库，被读数挡回来了**，所以留在这里（是判断，不是漏换）：
        · 旧版用 d3-format（ISC）—— 按 js-mod 的纯 MIT 口径它进不了池子（池子里没有 d3-*）；
        · 候选是 numbro（MIT，池子里有）。实测 4014 个价格样本：**421 个对不上**（定种子，可复现），
          而且不是边缘情况 —— 整数档（|x| ≥ 1000）numbro 的 '0' 不做定长舍入
          （4005.36 原样吐出），改成 '0,0' 又会插千分位；两位档上 numbro 走十进制半进位
          （2.675 → "2.68"），toFixed 走二进制表示（2.675 → "2.67"）—— 在逐字可比的位置上
          这是实打实的分歧。平台的 Intl.NumberFormat 同属 halfExpand 口径，同一条分歧。
          复现：node tools/experiments/why-no-numbro.mjs
        结论：刻度文本的口径就是 `toFixed(0|1|2)`，**它本身就是规格**，不是「没找到库」。
        两处必须保留的适配（都在 parity-indicator-draw 的射程内）：
          1) 负号取 ASCII 连字符（d3 原来给的是 U+2212 数学减号，这里是逐字可比的位置）；
          2) `-0` 要归一：`(-0).toFixed(2)` 是 "-0.00"，刻度上要 "0.00"。
        已知的唯一一处**有意分歧**：|x| ≥ 1e21 时 toFixed 会退化成指数写法（"1e+21"）。
        副图刻度到不了那个量级（RSI 0–100、ATR 是价格、CCI 到 ±300），
        而 parity 工具覆盖的是真实指标数据 —— 所以这里不为它加一条分支。
        自我核对：node tools/parity-indicator-draw.mjs。 */
  const NUM_DIGITS = { 0: 0, 1: 1, 2: 2 };
  const tickText = value => {
    const abs = Math.abs(value);
    const text = value.toFixed(NUM_DIGITS[abs >= 1000 ? 0 : abs >= 100 ? 1 : 2]);
    return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
  };

  /* 这一屏的纵轴范围：[lo, hi]。全 NaN（还在暖机）时返回 null，调用方只画网格。 */
  function paneRange(item, from, end, math) {
    let lo = Infinity, hi = -Infinity, hasHist = false;
    item.series.forEach(series => {
      if ((series.type || 'line') === 'band') return;
      if (series.type === 'hist') hasHist = true;
      const mm = math.minMax(series.values, from, end);   /* 极值扫描只有 math.js 那一份 */
      if (!mm) return;
      lo = Math.min(lo, mm[0]);
      hi = Math.max(hi, mm[1]);
    });
    if (!Number.isFinite(lo)) return null;
    if (item.range) {
      /* 固定轴（RSI 的 0–100）：数据越界时让轴跟着扩，但不缩 —— 轴线乱跳比越界更难看 */
      lo = Math.min(lo, item.range[0]);
      hi = Math.max(hi, item.range[1]);
      return [lo, hi];
    }
    if (hasHist || lo < 0) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const pad = (hi - lo) * .12 || Math.abs(hi) * .05 || 1;
    return [lo - pad, hi + pad];
  }

  /* 主图叠加线。位置在**蜡烛之后、价格线之前**：叠加线要压在 K 线上，
     但开仓价 / 强平价 / 现价那几条线仍要在最上面（它们与下单直接相关）。 */
  function drawOverlays(ctx, geom, frame, xOf) {
    if (!geom || !frame || !frame.overlays || !frame.overlays.length) return;
    const count = frame.rows.length - frame.from;
    if (count <= 0) return;
    const view = { from: frame.from, count, xOf, yOf: v => geom.yOf(v), top: geom.top, bottom: geom.bottom, step: geom.step };
    ctx.save();
    frame.overlays.forEach(item => {
      item.series.forEach(series => { if ((series.type || 'line') === 'band') PLOT().plotSeries(ctx, series, view); });
      item.series.forEach(series => { if ((series.type || 'line') !== 'band') PLOT().plotSeries(ctx, series, view); });
    });
    ctx.restore();
  }

  /* 主图图例：现在开着哪几条线、最新值是多少。左上角原本是空的（K 线从最左边那格开始画），
     所以图例放那里不挡东西。返回数据，摆放交给调用方（它知道字号与行高）。 */
  function overlayLegendItems(frame, math) {
    if (!frame || !frame.overlays) return [];
    const items = [];
    frame.overlays.forEach(entry => {
      entry.series.forEach(series => {
        if ((series.type || 'line') === 'band' || !series.label) return;
        items.push({ label: series.label, rgb: series.rgb, last: math.lastFinite(series.values) });
      });
    });
    return items;
  }

  /* 画一格副图。几何由主图给（left / right / step）；frame.panes[slot] 是这一格要画的指标。
     ctx 与尺寸由调用方准备好（它负责 dpr 缩放与清屏）。 */
  function drawPane(ctx, slot, geom, frame, size, xOfFn) {
    const item = frame && frame.panes && frame.panes[slot];
    const width = size && size.width, height = size && size.height;
    if (!item || !geom || !geom.ready || !item.series.length || !width || !height) return null;
    const from = frame.from, count = frame.rows.length - frame.from, end = from + count;
    if (count <= 0) return null;
    const top = 8, bottom = height - 6;
    const math = CS.indicators.math;
    const range = paneRange(item, from, end, math);
    if (!range) return null;
    const [lo, hi] = range;
    const span = hi - lo || 1;
    const yOf = value => top + (hi - value) / span * (bottom - top);
    /* ★ x 映射**不再自己算**：由调用方（chartPanes）传进来，而且传的就是主图画蜡烛用的那一个。
       这里原来写的是 `geom.left + geom.step * ((i - from) + .5)` —— 看着与主图的
       `offset + slot * (index + .5)` 一样，其实少了主图的**居中偏移**：
       主图在格子宽度被 MAX_SLOT 封顶时会把整组 K 线居中（少数据时是一簇 K 线），
       而副图按「从 left 铺满」算 —— 于是窗口一宽、格子一封顶，两块就整体错开。
       横坐标只该有一个来源，所以公式留在主图那一份，这里收函数。
       兜底：没给函数时（例如单独测这一层）退回旧算法。 */
    const xOf = typeof xOfFn === 'function' ? xOfFn : (i => geom.left + geom.step * ((i - from) + .5));
    const view = { from, count, xOf, yOf, top, bottom, step: geom.step };

    /* 横向网格 + 右轴刻度（三档：上、中、下），与主图一样贴在右边 */
    ctx.lineWidth = 1; ctx.font = '10px DM Mono, monospace';
    for (let i = 0; i < 3; i++) {
      const value = hi - i * span / 2;
      const y = Math.round(top + i * (bottom - top) / 2) + .5;
      ctx.strokeStyle = THEME.grid; ctx.beginPath(); ctx.moveTo(geom.left, y); ctx.lineTo(geom.right, y); ctx.stroke();
      ctx.fillStyle = THEME.axis; ctx.textAlign = 'left';
      ctx.fillText(tickText(value), geom.right + 8, y + 3);
    }
    /* 0 轴（柱子与摆动指标的正负分界）：比网格重一点 */
    if (lo < 0 && hi > 0) {
      const y = Math.round(yOf(0)) + .5;
      ctx.strokeStyle = THEME.zero; ctx.beginPath(); ctx.moveTo(geom.left, y); ctx.lineTo(geom.right, y); ctx.stroke();
    }
    /* 参考线（超买 / 超卖 / ±100）：虚线 + 小字标签，压在曲线上但很淡 */
    (item.guides || []).forEach(guide => {
      const value = Number(guide.value);
      if (!Number.isFinite(value) || value < lo || value > hi) return;
      const y = Math.round(yOf(value)) + .5;
      ctx.save();
      ctx.setLineDash([3, 4]); ctx.strokeStyle = THEME.guide;
      ctx.beginPath(); ctx.moveTo(geom.left, y); ctx.lineTo(geom.right, y); ctx.stroke();
      ctx.restore();
      if (guide.label) {
        ctx.fillStyle = THEME.guideText; ctx.textAlign = 'left';
        ctx.fillText(guide.label, geom.left + 3, y - 2.5);
      }
    });
    /* 曲线：带子铺底、柱子居中、线压在最上面 */
    item.series.forEach(series => { if ((series.type || 'line') === 'band') PLOT().plotSeries(ctx, series, view); });
    item.series.forEach(series => { if (series.type === 'hist') PLOT().plotSeries(ctx, series, view); });
    item.series.forEach(series => {
      const type = series.type || 'line';
      if (type === 'band' || type === 'hist') return;
      PLOT().plotSeries(ctx, series, view);
      /* 最新那一点上点一个小圆：一眼看出「现在在哪」 */
      for (let i = end - 1; i >= from; i--) {
        if (!Number.isFinite(series.values[i])) continue;
        ctx.fillStyle = PLOT().rgbaOf(series.rgb, .95);
        ctx.beginPath(); ctx.arc(xOf(i), yOf(series.values[i]), 2.2, 0, Math.PI * 2); ctx.fill();
        break;
      }
    });
    return { slot, id: item.id, lo, hi, from, count };
  }

  /* 注意：这里**没有** drawPanes(槽位循环那一版)。
     它原来在（循环 MAX_PANES 次、逐个调 drawPane），但实际装配副图的是
     ui/components/chartPanes.js —— 它自己按 DOM 里真实存在的画布循环
     （格子数是动态的，不是常量 3），顺带负责建画布、清屏、单独 try/catch。
     两个循环做同一件事只会让人以为「调用点在那边」，所以循环只留一处。
     drawPane 仍然是这一层出的：chartPanes.js 每格调它一次。 */
  return {
    chartIndicators: { drawOverlays, drawPane, paneRange, paneTickText: tickText, overlayLegendItems, THEME }
  };
});
