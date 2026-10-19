/* ============ 画布尺寸（主图与副图共用一套） ============
   这一小段被踩过三次，所以抽出来只留一处，不再各写一遍。

   现象：进交易页之后浏览器每帧报一条
     `ResizeObserver loop completed with undelivered notifications.`
   （CS.errors 一次刷二十多条）。实测：容器宽度每帧 +2px，从 719 一路涨到 788 才停 ——
   宽度是 `minmax(360px, 1fr) + auto` 列，画布**位图**尺寸一变，行内尺寸就跟着变，
   于是「观察 → 写画布 → 布局变 → 观察」成环。

   三条规矩，一条都不能省：
     1) 尺寸量 **canvas 自己**（clientWidth/clientHeight，由 CSS 决定），
        不量带边框的外层，也**永不写 canvas.style**。
        量外层会把 1px 边框算进去、让画布比容器大 2px —— 那是环的第一版。
     2) 观察器回调里**只记目标尺寸**，真正的写入推到下一帧。
        回调里不碰 DOM，就不可能「在回调里又改布局」。
     3) 死区 1px：目标与已应用的尺寸差不到 1px 就不写。
        即便布局每帧抖 1px，也不会变成每帧重设位图。
   rAF 还会把一帧内的多次回调合并成一次。

   用法：create({ targets: () => [canvas…], minW, minH, fallback: () => ({w,h}), onResize })
     · targets() 每次现取（画布可能被重建，别在创建时固化成数组）
     · onResize() 在**尺寸真的变了**之后调一次，用来重画 */
CS.define('ui/components/chartSizing', [], function () {
  'use strict';

  function create(options) {
    const o = options || {};
    const minW = o.minW || 120;
    const minH = o.minH || 60;
    const targets = o.targets || (() => []);
    let width = 0, height = 0;
    let applyScheduled = false;
    let targetW = 0, targetH = 0;

    function schedule(fn) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
      else setTimeout(fn, 0);
    }

    /* 观察器回调只调它：只量、只记 */
    function measure() {
      const list = targets().filter(Boolean);
      if (!list.length) return;
      const first = list[0];
      targetW = Math.max(minW, Math.round(first.clientWidth || 0));
      targetH = Math.max(minH, Math.round(first.clientHeight || 0));
      if (applyScheduled) return;
      applyScheduled = true;
      schedule(() => { applyScheduled = false; apply(); });
    }

    function apply() {
      const w = targetW || width;
      const h = targetH || height;
      if (Math.abs(w - width) < 1 && Math.abs(h - height) < 1) return;
      width = w; height = h;
      const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      targets().forEach(node => {
        if (!node) return;
        node.width = Math.round(w * dpr);
        node.height = Math.round(h * dpr);
        const ctx = node.getContext && node.getContext('2d');
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      });
      if (o.onResize) o.onResize(width, height);
    }

    return {
      measure, apply,
      get width() { return width; },
      get height() { return height; },
      /* 值不值得现在写：调用方拿它决定要不要走一次重画 */
      changed() {
        return Math.abs((targetW || width) - width) >= 1 || Math.abs((targetH || height) - height) >= 1;
      }
    };
  }

  return { chartSizing: { create } };
});
