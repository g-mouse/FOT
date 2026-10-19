/* ============ 图上的价格线：命中测试与拖动（两个模式共用） ============
   鼠标在图上做两件事，优先级固定（**手上正在做的那件事优先**）：
     1. 按着订单预览线拖 —— 拖动中不显示 K 线浮层，只把那条线搬到光标所在的价格；
     2. 普通移动 —— 显示「这一根」的浮层与十字线；
        光标压在别的价格线上时不显示浮层，改成把那条线高亮、指针换成能拖的样子。
   这一条优先级是旧实现写明的（game/js/control/pointer.js 的文件头）：
   不这么做的话，浮层会盖住那条线，玩家一边拖一边被浮层挡着。

   ★ 命中测试按**画出来的 y** 判，不按价格重新算：
     被夹到边缘的线（价在画布外、线贴在边上）如果按价格算 y，会在画布外命中不到，
     玩家看得见一条线却拖不动它。所以调用方在画的时候把 y 一起交出来。

   颜色与身份不在这里判 —— 这里只回答「指着哪一条、在拖哪一条」。 */
CS.define('ui/components/chartLineDrag', ["lib/lodash"], function () {
  'use strict';

  const HIT_PX = 7;              /* 鼠标离线多近算「指着它」（旧实现同一个值） */

  function create(opts) {
    const o = opts || {};
    /* lines()    这一帧画出来的线（含 y，见 chartIndicatorLayer.drawPriceLines 的返回）
       plot()     { x0, x1, y0, y1 }：绘图区四边（判「在不在图上」用）
       range()    { lo, hi }：纵轴范围（y → 价格）
       onDragTo(price)  拖动中：把这个价交给模式（它会落到预览线并重画）
       onDrop()         松手：把这一下的结果告诉玩家（或落盘）
       onPick(kind)     点在一条非预览线上：模式自己决定做什么（旧实现是切限价并聚焦输入框）
       onHover(kind)    悬停反馈变了（高亮哪条线）：给需要重画的调用方 */
    const state = { hit: null, dragging: false, price: 0 };
    let hover = null;

    const plot = () => (o.plot ? o.plot() : null);
    const lines = () => (o.lines ? (o.lines() || []) : []);
    const range = () => (o.range ? o.range() : null);

    /* 指针指着哪一条线（只判价格线；横坐标也要在绘图区内） */
    function kindAt(mx, my) {
      const p = plot();
      if (!p) return null;
      if (mx < p.x0 || mx > p.x1 || my < p.y0 - 6 || my > p.y1 + 6) return null;
      let best = null, bestD = Infinity;
      lines().forEach(line => {
        if (!Number.isFinite(line.y)) return;
        const d = Math.abs(line.y - my);
        if (d <= HIT_PX && d < bestD) { bestD = d; best = line; }
      });
      return best;
    }
    /* 拖动中：把画布上的 y 换成价格。
       纵轴是反的（价越高 y 越小），所以这里必须用 1 − ratio ——
       写成 ratio 的话，往上拖价格反而变低（一拖就看得出来，但很容易写错）。 */
    function yToPrice(my) {
      const p = plot(), r = range();
      if (!p || !r) return NaN;
      const h = Math.max(1, p.y1 - p.y0);
      const ratio = Math.max(0, Math.min(1, (my - p.y0) / h));
      return r.lo + (1 - ratio) * (r.hi - r.lo);
    }
    /* 指针形状：可拖的那条用 ns-resize，别的线用 pointer，其余交回 CSS 的 crosshair */
    function cursorFor(kind) {
      if (kind === 'preview') return 'ns-resize';
      return kind ? 'pointer' : '';
    }
    function setHover(kind, el) {
      state.hit = kind || null;
      if (kind === hover) return false;
      hover = kind || null;
      if (el) el.style.cursor = cursorFor(hover);
      if (o.onHover) { try { o.onHover(hover); } catch (_) {} }
      return true;
    }

    function begin(mx, my, el, pointerId) {
      const line = kindAt(mx, my);
      if (!line) return false;
      if (line.kind !== 'preview') {
        /* 点别的线：交给模式（旧实现是切到限价委托并聚焦委托价输入框） */
        if (o.onPick) { try { o.onPick(line.kind, line); } catch (_) {} }
        return false;
      }
      state.dragging = true;
      state.price = line.price;
      try { if (el && el.setPointerCapture) el.setPointerCapture(pointerId); } catch (_) {}
      return true;
    }
    function dragTo(my) {
      if (!state.dragging) return null;
      const raw = yToPrice(my);
      if (!Number.isFinite(raw)) return null;
      const next = o.onDragTo ? o.onDragTo(raw, state.price) : raw;
      if (Number.isFinite(next)) state.price = next;
      return state.price;
    }
    function end() {
      if (!state.dragging) return false;
      state.dragging = false;
      if (o.onDrop) { try { o.onDrop(state.price); } catch (_) {} }
      return true;
    }

    return {
      HIT_PX,
      kindAt, yToPrice, cursorFor, setHover, begin, dragTo, end,
      get dragging() { return state.dragging; },
      get hit() { return state.hit; },
      get hover() { return hover; },
      price: () => state.price
    };
  }

  return { chartLineDrag: { create, HIT_PX } };
});
