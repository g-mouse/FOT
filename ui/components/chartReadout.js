/* ============ 图表读数：光标那根 K 线的那几行 ============
   从 ui/components/tradeChart.js 拆出来（那个文件一度 433 行，超过**当时**的单文件上限：400 行）。
   拆的理由不只是行数：**这几行是纯计算**（一根 K 线 + 一个光标价 → 若干 [标签, 值]），
   不碰 DOM、不碰画布，所以它可以被单独测，也不会把「画图」与「写文案」搅在一起。

   格式化统一走 CS.money，所以小数位永远与交易对声明的一致
   （DOGE 那种 5 位小数的交易对不会在这里被写成两位）。 */
CS.define('ui/components/chartReadout', ["core/base/money","core/base/util"], function () {
  'use strict';

  /* 光标处那根 K 线的读数行。bar 是行情 bar（{o,h,l,c,t}，短名）。
     t 传进来而不是在这里引 i18n：调用方已经有一份本地化的 t（它还要用在别处），
     这里再取一次会出现「同一个词在两个地方各翻一遍」的漂移。 */
  function crosshairRows(opts) {
    const o = opts || {};
    const bar = o.bar;
    const t = o.t || (key => key);
    if (!bar) return [];
    const digits = Number.isFinite(o.digits) ? o.digits : 2;
    const fmt = price => CS.money.formatNumber(price, digits);
    const change = bar.o ? ((bar.c / bar.o) - 1) * 100 : 0;
    const rows = [
      [t('st.chart.time'), timeKey(bar.t)],
      [t('st.chart.open'), fmt(bar.o)],
      [t('st.chart.high'), fmt(bar.h)],
      [t('st.chart.low'), fmt(bar.l)],
      [t('st.chart.close'), fmt(bar.c)],
      [t('st.chart.change'), `${change.toFixed(2)}%`]
    ];
    /* 光标那一行只有在真的给了价格时才出现（触屏没有纵向光标位置，不该写一个 0） */
    if (Number.isFinite(o.cursorPrice)) rows.push([t('st.chart.cursor'), fmt(o.cursorPrice)]);
    return rows;
  }

  /* 时间戳 → 「MM-DD HH:MM」。用本地时区，与 util.dateKey / 时间线页签同一口径。 */
  function timeKey(ms) {
    const d = new Date(ms);
    return `${CS.util.pad2(d.getMonth() + 1)}-${CS.util.pad2(d.getDate())} `
      + `${CS.util.pad2(d.getHours())}:${CS.util.pad2(d.getMinutes())}`;
  }

  /* 读数浮层摆在哪：默认贴在光标右下方，但不能越出图表。
     ★ 夹取用**实测**的浮层尺寸，不用魔法常数：写死 176/150 时，
     字号放大到 160% 后浮层实际有 208px 高，底部几行（开/高/低/收/涨跌/光标）
     会被 .st-chart 的 overflow:hidden 裁掉 —— 而那几行正是这个浮层存在的意义。
     调用方要先去掉浮层的 hidden，尺寸才是真的。 */
  function tipPlacement(opts) {
    const o = opts || {};
    const mx = Number(o.mouseX) || 0;
    const my = Number(o.mouseY) || 0;
    const boxW = Number(o.boxWidth) || 0;
    const boxH = Number(o.boxHeight) || 0;
    const tipW = Number(o.tipWidth) || 176;
    const tipH = Number(o.tipHeight) || 150;
    return {
      left: Math.max(0, Math.min(mx + 16, boxW - tipW - 2)),
      top: Math.max(0, Math.min(my - 10, boxH - tipH - 2))
    };
  }

  return { chartReadout: { crosshairRows, tipPlacement, timeKey } };
});
