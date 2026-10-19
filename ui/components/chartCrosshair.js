/* ============ 十字光标与「这一根」的浮层（两个模式共用） ============
   鼠标在图上移动时显示：一根竖线对齐光标指到的那一格、一根横线跟着鼠标，
   以及一个浮层写「光标那根 K 线 + 光标位置反算的价格」。

   从 ui/components/tradeChart.js 抽出来（那一段连注释六十多行，而它挨着
   当时「单文件 ≤ 400 行」那条硬约束）。抽出来也让它单独好读：
   这一层只做「摆位置 + 填内容」，不碰账户、不碰委托，也不知道价格线该怎么命中。

   ★ 两处容易写错的地方，都留在这一层里：
     1) 浮层夹取用**实测**尺寸（tip.offsetWidth/offsetHeight），不用魔法常数 ——
        写死 176/150 时，字号放大到 160% 后浮层实际有 208px 高，
        底部那几行（开/高/低/收/涨跌/光标）被 .st-chart 的 overflow:hidden 裁掉，
        而那几行正是这个浮层存在的意义（实测踩过）。
     2) 读数行由 chartReadout 生成（纯字符串、不碰 DOM）：那几行是
        「光标那根 + 反算价格」的函数，与画布无关，单独一层更好测。

   ★ 摆位现在是**两层**（都在这一个函数里，别在别处再摆一次）：
     第一层 chartReadout.tipPlacement —— 纯数学的夹取，同步执行，也是 Node 侧（无 DOM、无 vendor）唯一的路径；
     第二层 @floating-ui/dom —— 浏览器里再按 flip + shift 修正：
       光标贴近右边界时它把浮层**翻到左边**，而夹取只会把浮层压在光标底下（挡住你正在看的那根 K 线）。
       它返回 Promise，但只 await 一次 rect 读取 —— 落在同一个任务之后的微任务里，
       浏览器还没绘制，所以不会看到「先错后对」的一帧；库缺失或抛错就保持第一层的位置。 */
CS.define('ui/components/chartCrosshair', ["core/base/util","lib/floating-ui-dom","lib/lodash","ui/components/bits","ui/components/chartReadout"], function () {
  'use strict';
  const { el, clear } = CS.util;
  const floatUI = window.FloatingUIDOM || null;

  /* 两层摆位（见文件头）。box 与 tip 的尺寸都是**实测**的：
     调用方刚把内容填进去，这里读到的是这一帧真实的宽高。 */
  function placeTip(o, mx, my) {
    const box = o.wrap.getBoundingClientRect();
    const place = CS.chartReadout.tipPlacement({
      mouseX: mx, mouseY: my,
      boxWidth: box.width, boxHeight: box.height,
      tipWidth: o.tip.offsetWidth, tipHeight: o.tip.offsetHeight
    });
    o.tip.style.left = place.left + 'px';
    o.tip.style.top = place.top + 'px';
    if (!floatUI || typeof floatUI.computePosition !== 'function') return;
    /* 虚拟参考元素：光标那一点（没有真节点，只有 rect） */
    const reference = {
      getBoundingClientRect: () => ({ x: mx, y: my, width: 0, height: 0, top: my, left: mx, right: mx, bottom: my })
    };
    try {
      floatUI.computePosition(reference, o.tip, {
        placement: 'right-start',
        strategy: 'absolute',
        middleware: [
          floatUI.flip({ padding: 4 }),
          floatUI.shift({ padding: 2, boundary: o.wrap })
        ]
      }).then(pos => {
        /* 等这一跳回来时鼠标可能已经移开（hide() 加了 hidden）：那就别把它摆回来 */
        if (!pos || o.tip.classList.contains('hidden')) return;
        o.tip.style.left = Math.round(pos.x) + 'px';
        o.tip.style.top = Math.round(pos.y) + 'px';
      }).catch(() => { /* 摆位失败保持第一层的结果，不打扰玩家 */ });
    } catch (_) { /* 同上 */ }
  }

  /* opts:
       canvas / wrap / overlay / crossX / crossY / tip     DOM 零件（由调用方建好）
       bars()       这一屏的 K 线
       plot()       { x0, x1, y0, y1 }
       range()      { lo, hi }
       indexAtX(mx) 横坐标 → 这一屏的下标
       xOf(index)   下标 → 横坐标
       digits()     价格精度
       onHover(payload)  可选：调用方要跟着做点什么（例：报出光标价）
     返回 { move(event), hide(), index } */
  function create(opts) {
    const o = opts || {};
    let index = -1;

    function hide() {
      index = -1;
      o.overlay.classList.add('hidden');
      o.tip.classList.add('hidden');
    }

    function move(event) {
      const bars = o.bars ? o.bars() : [];
      if (!bars.length) { hide(); return false; }
      const canvas = o.canvas;
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const p = o.plot ? o.plot() : null;
      if (!p) { hide(); return false; }
      if (mx < p.x0 - 4 || mx > p.x1 + 4) { hide(); return false; }
      const at = o.indexAtX ? o.indexAtX(mx) : Math.round(mx);
      const bar = bars[at];
      if (!bar) { hide(); return false; }
      index = at;
      const x = Math.round(o.xOf(at));
      const y = Math.round(Math.max(p.y0, Math.min(p.y1, my)));
      o.overlay.classList.remove('hidden');
      o.crossX.style.left = x + 'px';
      o.crossY.style.top = y + 'px';

      /* 纵轴读数：光标位置反算价格 */
      const range = o.range();
      const price = range.hi - ((y - p.y0) / Math.max(1, p.y1 - p.y0)) * (range.hi - range.lo);
      o.tip.classList.remove('hidden');
      clear(o.tip);
      const rows = CS.chartReadout.crosshairRows({
        bar, cursorPrice: price, digits: o.digits ? o.digits() : 2, t: CS.uiBits.t
      });
      rows.forEach(([k, v], i) => {
        o.tip.appendChild(el('div', { class: `st-tip-row ${i === 0 ? 'head' : ''}`.trim() }, [
          el('span', { class: 'st-tip-k', text: k }),
          el('span', { class: 'st-tip-v mono', text: v })
        ]));
      });
      /* 摆哪儿：第一层夹取在 chartReadout.tipPlacement，第二层由 floating-ui 修正（见文件头） */
      placeTip(o, mx, my);
      if (o.onHover) { try { o.onHover({ index: at, bar, price }); } catch (_) {} }
      return true;
    }

    return { move, hide, get index() { return index; } };
  }

  return { chartCrosshair: { create } };
});
