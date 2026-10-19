/* ============ 副图容器（MACD / RSI / KDJ / ATR / CCI 各占一格） ============
   `chartIndicators.drawPane()` 早就能把一个副图画出来了（而且与旧教程页逐调用一致），
   但**一直没人调它** —— 所以开了 MACD 也只在指标栏里打个勾，图上什么都不出现。
   这一层就是那根缺失的接线：建画布、维持尺寸、把 frame.panes 逐格画出来。

   ★ 尺寸这一段与主图踩过同一个坑（见 tradeChart.js 里那段长注释）：
     画布的固有尺寸会参与布局，所以「写位图 → 元素尺寸变 → 容器变宽 → 再写位图」
     会成环，浏览器一路报 ResizeObserver loop。三条规矩照旧：
       1) 画布**绝对定位**（对布局的贡献恒为零），尺寸量 canvas.clientWidth/Height；
       2) 尺寸由**父容器**的 CSS 高度决定（.st-subchart 给死高度），不靠自己撑；
       3) 观察器回调里只记目标尺寸，真正的写入推到下一帧；差不到 1px 就不写。

   ★ 横坐标**复用主图那一帧的几何**（left / right / step）：这一层的画布宽度与主图
     完全相同、可见窗口也相同，所以竖着看每一根 K 线都对得齐（这是旧实现的做法）。
     纵轴各算各的（RSI 是 0–100、ATR 是价格、CCI 能到 ±300）。 */
CS.define('ui/components/chartPanes', ["core/base/util","core/indicators/indicatorColors","core/indicators/indicatorState","core/indicators/registry","lib/lodash","ui/components/chartIndicators","ui/components/chartSizing"], function () {
  'use strict';
  const { el, clear } = CS.util;
  const MAX = () => CS.indicators.MAX_PANES;

  function mount(host, options) {
    const o = options || {};
    const root = el('div', { class: 'st-subcharts' });
    const slots = [];
    const state = { width: 0, height: 0, frame: null, geom: null, xOf: null };
    let drawScheduled = false;

    function ensureSlots(n) {
      while (slots.length < n) {
        const canvas = el('canvas', { class: 'st-subchart-canvas', role: 'img', 'aria-label': 'indicator pane' });
        /* 鼠标停在副图上时露出来的那一张小卡片：指标名、参数、光标那一根上每条线的读数。
           2026-10-19 用户口径：「鼠标在副图上方显示详细副图参数」。
           它 pointer-events:none，不挡任何点击；内容只从 frame 里抄，不自己算指标。 */
        const tip = buildTip();
        const box = el('div', { class: 'st-subchart' }, [canvas, tip.root]);
        root.appendChild(box);
        const slot = { box, canvas, tip };
        box.addEventListener('mousemove', event => showTip(slot, event));
        box.addEventListener('mouseleave', () => hideTip(slot));
        slots.push(slot);
      }
      /* 多余的格子藏起来（不删：删了再开会重建画布、丢尺寸） */
      slots.forEach((slot, i) => slot.box.classList.toggle('hidden', i >= n));
    }

    /* 一张小卡片：头（指标名 + 参数）+ 最多四条序列读数。建一次、之后只改文本 ——
       每帧 mousemove 都重建 DOM 会让副图自己卡住。 */
    function buildTip() {
      const head = el('div', { class: 'st-pane-tip-head' });
      const params = el('div', { class: 'st-pane-tip-params' });
      const rows = [];
      for (let i = 0; i < 4; i++) {
        const sw = el('i', { class: 'st-pane-tip-sw' });
        const k = el('span', { class: 'st-pane-tip-k' });
        const v = el('span', { class: 'st-pane-tip-v' });
        const row = el('div', { class: 'st-tip-row' }, [sw, k, v]);
        rows.push({ row, sw, k, v });
      }
      const root = el('div', { class: 'st-subchart-tip hidden' }, [head, params].concat(rows.map(r => r.row)));
      return { root, head, params, rows };
    }
    const fmtValue = value => (Number.isFinite(value) ? value.toFixed(2) : '—');
    /* 光标 x → frame 下标：用**同一份** xOf 反查（不能按等宽格子除：
       少数据时主图会把 K 线居中一簇，格子除法会整体偏）。 */
    function frameIndexAt(mx) {
      const frame = state.frame;
      if (!frame || typeof state.xOf !== 'function') return -1;
      const from = frame.from;
      const end = frame.rows.length;
      let best = -1, bestD = Infinity;
      for (let i = from; i < end; i++) {
        const d = Math.abs(state.xOf(i) - mx);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    function paramText(pane) {
      const specs = (pane.def && pane.def.params) || [];
      const values = pane.params || {};
      const parts = specs.map(spec => {
        const value = values[spec.key];
        return value == null ? '' : `${spec.label || spec.key} ${value}`;
      }).filter(Boolean);
      return parts.join(' · ');
    }
    function showTip(slot, event) {
      const frame = state.frame;
      if (!frame || !state.geom) return;
      const index = slots.indexOf(slot);
      const pane = frame.panes && frame.panes[index];
      if (!pane) { hideTip(slot); return; }
      const rect = slot.box.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const idx = frameIndexAt(mx);
      if (idx < 0) { hideTip(slot); return; }
      const tip = slot.tip;
      const headText = `${(pane.def && pane.def.name) || pane.id}${pane.def && pane.def.cn ? ' · ' + pane.def.cn : ''}`;
      if (tip.head.textContent !== headText) tip.head.textContent = headText;
      const pText = paramText(pane);
      if (tip.params.textContent !== pText) tip.params.textContent = pText;
      tip.params.classList.toggle('hidden', !pText);
      tip.rows.forEach((row, i) => {
        const series = pane.series[i];
        if (!series) { row.row.classList.add('hidden'); return; }
        row.row.classList.remove('hidden');
        const label = series.label || series.key || '';
        if (row.k.textContent !== label) row.k.textContent = label;
        row.v.textContent = fmtValue(series.values[idx]);
        const rgb = series.rgb;
        row.sw.style.background = (Array.isArray(rgb) && rgb.length >= 3) ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : 'var(--line)';
      });
      tip.root.classList.remove('hidden');
      /* 贴着光标右上角；靠近右边缘时往左翻，别把卡片挤出副图 */
      const width = Math.max(150, Math.min(220, rect.width - 16));
      tip.root.style.width = width + 'px';
      tip.root.style.left = Math.max(6, Math.min(rect.width - width - 6, mx + 12)) + 'px';
      tip.root.style.top = '6px';
    }
    function hideTip(slot) {
      if (slot && slot.tip) slot.tip.root.classList.add('hidden');
    }

    function schedule(fn) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
      else setTimeout(fn, 0);
    }
    function scheduleDraw() {
      if (drawScheduled) return;
      drawScheduled = true;
      schedule(() => { drawScheduled = false; draw(); });
    }

    /* 尺寸那三条规矩（量 canvas 自己 / 回调只记 / 1px 死区）在 ui/components/chartSizing.js。
       ★ 这里原先又内联写了一遍 measure + applySize —— 明明刚把主图那一份抽成公用模块，
       转头在副图里抄了第二份。两处都靠「人手记得同步」，而尺寸这种每帧都跑的东西，
       两边一旦不一致就是主图与副图对不齐，且不报错。所以现在只留一份实现。 */
    const sizing = CS.chartSizing.create({
      minW: 120, minH: 60,
      targets: () => slots.map(s => s.canvas),
      onResize: (w, h) => { state.width = w; state.height = h; scheduleDraw(); }
    });
    const resize = () => { sizing.measure(); state.width = sizing.width; state.height = sizing.height; };

    function draw() {
      const frame = state.frame;
      const geom = state.geom;
      const panes = (frame && frame.panes) || [];
      ensureSlots(Math.min(MAX(), Math.max(panes.length, 1)));
      slots.forEach((slot, i) => {
        const ctx = slot.canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, state.width, state.height);
        if (i >= panes.length || !geom) return;
        /* 底色：副图不设底色的话，主图的网格会透出来像重影 */
        ctx.fillStyle = o.background || '#ffffff';
        ctx.fillRect(0, 0, state.width, state.height);
        try {
          /* 第 6 个参数是**主图自己用的 x 映射**（见 chartIndicators.drawPane 的说明）：
             副图自己算 x 会漏掉主图的居中偏移，窗口一宽就整体错开。 */
          CS.chartIndicators.drawPane(ctx, i, geom, frame, { width: state.width, height: state.height }, state.xOf);
        } catch (error) {
          CS.errors.push({ message: `副图没画出来（其余照常）：${error && error.message}` });
        }
      });
      /* 一格都没开时整块收起来，别在图下面留一条空白 */
      root.classList.toggle('hidden', panes.length === 0);
    }

    host.appendChild(root);
    ensureSlots(1);
    root.classList.add('hidden');

    let observer = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => resize());
      observer.observe(root);
    }
    window.addEventListener('resize', resize);

    return {
      root,
      /* 每帧由主图那边喂进来：frame 是指标算好的那一帧，geom 是主图的几何，
         x 是主图**画蜡烛用的那个 x 映射**（含居中偏移）。
         明确要求 x：少了它副图就会与主图横向错开，而那种错开不报错、只是看着不对。 */
      setFrame(frame, geom, x) {
        state.frame = frame || null;
        state.geom = geom || null;
        if (x && typeof x.xOf === 'function') state.xOf = x.xOf;
        const n = (frame && frame.panes ? frame.panes.length : 0);
        ensureSlots(Math.min(MAX(), Math.max(n, 1)));
        root.classList.toggle('hidden', n === 0);
        resize();
        scheduleDraw();
      },
      resize, redraw: draw,
      dispose() {
        if (observer) { try { observer.disconnect(); } catch (_) {} }
        window.removeEventListener('resize', resize);
        clear(root);
      }
    };
  }

  return { chartPanes: { mount } };
});
