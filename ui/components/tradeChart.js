/* ============ K 线图（两个模式的交易页共用零件） ============
   模拟模式（game/）那张图是 4600 行的自研画布栈，故事模式不能把 game/ 的脚本拉进来
   （两套 window.CS 会互相污染）。所以这里只做**真正需要**的那一张：最近 N 根 K 线 +
   持仓均价线 + 强平价线 + 现价线 + 十字光标读数。
   数据一律来自调用方从 Ports.market.loadSeries 取的那一份，因此**未来数据守卫仍然生效**。
   两层画布：主画布只在数据变化时重画；十字光标画在覆盖层上，鼠标移动不重绘 K 线。
   窄屏与高对比主题都靠 CSS 变量取色，这里不写死任何颜色。 */
CS.define('ui/components/tradeChart', ["core/base/util","lib/lodash","ui/components/bits","ui/components/chartCrosshair","ui/components/chartGeom","ui/components/chartIndicatorLayer","ui/components/chartIndicators","ui/components/chartLineDrag","ui/components/chartPlot","ui/components/chartReadout","ui/components/chartSizing","ui/components/tradeChartAnim"], function () {
  'use strict';
  const { el, clear } = CS.util;

  const PAD = { left: 8, right: 72, top: 12, bottom: 22 };
  const DEFAULT_BARS = 120;

  /* 取 CSS 变量（高对比主题跟着 --ink 等变量整体变），失败时给一个安全色 */
  function theme(el0) {
    let css = null;
    try { css = getComputedStyle(el0 || document.documentElement); } catch (_) {}
    const pick = (name, fallback) => {
      const v = css ? css.getPropertyValue(name) : '';
      return (v && v.trim()) || fallback;
    };
    return {
      up: pick('--pos', '#1f8a70'),
      down: pick('--neg', '#b4453a'),
      ink: pick('--ink', '#16302a'),
      inkSoft: pick('--ink-soft', '#4a6a62'),
      line: pick('--line', '#d3e5dc'),
      accent: pick('--accent', '#1f8a70'),
      mixed: pick('--mixed', '#9a6b12'),
      bg: pick('--card', '#ffffff')
    };
  }

  function mount(host, options) {
    const o = options || {};
    /* 文案取词走共享那一份（原先是 8 个面板各写一遍同样的包装） */
    const t = CS.uiBits.t;
    const state = { bars: [], lines: [], digits: 2, hover: -1, width: 0, height: 0, drawn: null,
      /* 「新 K 线长出来」要记的一件事：prevDrawMap —— 上一帧画过哪些根（按时间戳）。
         这一帧不在里面的就是刚进这一屏的，历史那批据此做一点点淡入。 */
      prevDrawMap: null };
    /* 盘中抖动（见 modes/story/storyAnim.js）：开着时最新那一根按帧重画。
       驱动住在一个插座里（tradeChartAnim.js）—— 契约翻译、帧订阅与退订都在那边，
       这里只读「谁在走、走到哪了」；没装或模式没给时一律当作没在播。 */
    const anim = CS.tradeChartAnim.create({ onRedraw: () => scheduleDraw(), onIdleDraw: () => draw() });
    const tickOn = () => !!(anim.tick && anim.tick.active && anim.tick.active());
    const growOn = () => !!(anim.grow && anim.grow.active && anim.grow.active());
    clear(host);
    const wrap = el('div', { class: 'st-chart' });
    const canvas = el('canvas', { class: 'st-chart-canvas', role: 'img', 'aria-label': t('st.chart.aria') });
    const overlay = el('div', { class: 'st-chart-overlay hidden' });
    const crossX = el('div', { class: 'st-cross-x' });
    const crossY = el('div', { class: 'st-cross-y' });
    const tip = el('div', { class: 'st-chart-tip hidden' });
    const loading = el('div', { class: 'st-chart-empty', text: t('st.chart.loading') });
    overlay.appendChild(crossX); overlay.appendChild(crossY);
    wrap.appendChild(canvas); wrap.appendChild(overlay); wrap.appendChild(tip); wrap.appendChild(loading);
    host.appendChild(wrap);

    /* ---------- 坐标 ----------
       几何换算是**纯计算**，单独一层（ui/components/chartGeom.js）：图上一切东西都按它
       落位，所以它偏了会一起偏。那一层不认识 DOM，可以脱离浏览器单独验；
       这里只把「当前尺寸与数据」接给它 —— 传的是函数，所以尺寸改了立刻生效。 */
    const geom = CS.chartGeom.create({
      pad: PAD,
      bars: () => state.bars,
      lines: () => state.lines,
      width: () => state.width,
      height: () => state.height,
      digits: () => state.digits
    });
    const { plot, priceRange, slotWidth, slotSize, xOf, yOf, fmt } = geom;
    /* ---------- 纵轴范围缓动 ----------
       240 根一屏，每推进一根左边就掉一根：如果掉掉的正好是这 240 根里的最高/最低，
       纵轴范围会**整块跳一下**（K 线、指标、价格线一起缩放），看起来就是「主图闪一下」。
       这里把上下界按 ~22%/帧 缓动到新的原始范围（约 10 帧、160ms 收敛），
       视觉上只是平滑缩放，不会整块重排；k 线/指标/价格线/hit-test 全部读同一个 viewRange。
       ★ 换品种、换周期时直接 resetRange()（横跨几倍的价格缓动反而像坏掉）。 */
    let viewRange = null;
    let rangeMoving = false;
    function resetRange() { viewRange = null; rangeMoving = false; }
    function rangeNow() { return viewRange || priceRange(); }
    function easeRange(raw) {
      if (!viewRange) { viewRange = { lo: raw.lo, hi: raw.hi }; return viewRange; }
      const span = Math.max(1e-9, raw.hi - raw.lo);
      const dLo = raw.lo - viewRange.lo, dHi = raw.hi - viewRange.hi;
      if (Math.abs(dLo) < span * 5e-4 && Math.abs(dHi) < span * 5e-4) {
        viewRange.lo = raw.lo; viewRange.hi = raw.hi;
        return viewRange;
      }
      viewRange.lo += dLo * 0.22;
      viewRange.hi += dHi * 0.22;
      rangeMoving = true;
      return viewRange;
    }
    /* 时间轴与浮层共用一个「MM-DD HH:MM」写法：那一份在 chartReadout 里，
       这里只是取个别名 —— 同一件事写两遍，迟早有一边改了另一边没改。 */
    const timeKey = CS.chartReadout.timeKey;

    /* ---------- 主画布 ----------
       尺寸与「ResizeObserver 成环」那三条规矩都在 ui/components/chartSizing.js 里，
       连同踩坑经过（那一份才是唯一的一份，别在这里再抄一遍）。 */
    let drawScheduled = false;
    let scheduleCount = 0;
    function scheduleDraw() {
      /* 自检读数：图表被要求重画了几次。抖动「没在跳」这类缺陷里，关键的一问就是
         「引擎每帧都在发帧事件，图表到底有没有收到」—— 它与帧事件数一比就知道断在哪一环。 */
      scheduleCount++;
      if (drawScheduled) return;
      drawScheduled = true;
      const run = () => { drawScheduled = false; draw(); };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else setTimeout(run, 0);
    }
    /* 尺寸那三条规矩在 ui/components/chartSizing.js（主图与副图共用同一套）。
       这里只声明「尺寸变了就重画」与「量哪块画布」。 */
    const sizing = CS.chartSizing.create({
      minW: 220, minH: 120,
      targets: () => [canvas],
      onResize: (w, h) => { state.width = w; state.height = h; scheduleDraw(); }
    });
    const resize = sizing.measure;

    /* ---------- 指标绘制 ----------
       图层顺序（照旧实现）：蜡烛 → **指标叠加线** → 持仓均价/强平价/现价线 → 时间轴。
       数据与图例在 chartIndicatorLayer.js：图表与指标引擎之间**唯一**的接触面。 */
    let indicatorLayer = null;
    /* 副图容器：它挂在图表宿主**外面**（主图那块 canvas 是绝对定位撑满宿主的，副图要占
       宿主下面的独立高度）。由交易页在装配时通过 setPaneHost() 递进来。 */
    let subPanes = null;
    function setPaneHost(node) {
      if (subPanes || !node || !CS.chartPanes) return;
      subPanes = CS.chartPanes.mount(node, { background: '#ffffff' });
      scheduleDraw();
    }
    function setIndicators(source) {
      indicatorLayer = source
        ? CS.chartIndicatorLayer.makeSource({
          source,
          geometry: () => { const p = plot(); return { x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1, step: slotSize().slot }; },
          yOf: value => yOf(value, rangeNow()),
          onError: error => CS.errors.push({ message: `指标这一帧没算出来（图照常画）：${error && error.message}` })
        })
        : null;
      scheduleDraw();
    }

    function draw() {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const bars = state.bars;
      const color = theme(wrap);
      const p = plot();
      ctx.clearRect(0, 0, state.width, state.height);
      loading.classList.toggle('hidden', bars.length > 0);
      if (!bars.length) return;

      rangeMoving = false;
      const range = easeRange(priceRange());
      const slot = slotSize().slot;
      const bodyW = Math.max(1, Math.min(14, slot * 0.62));
      /* ★ 正走的那一根 + 这一刻的价格线，一起现取（frameOf）—— 两者必须同源：
         线是现价的函数，取两次就会「线在后面追」。 */
      const live = frameOf();

      /* 网格与价格刻度（5 等分）。刻度数字画在 p.x1 右边的空白带里；把每条刻度的位置
         回给我们 —— 价格标签与刻度数字在同一竖带上，同高度会叠字，所以要先把那条数字擦掉。 */
      const axisTicks = CS.chartIndicatorLayer.drawGrid(ctx, {
        plot: p, range, yOf: value => yOf(value, range), width: state.width,
        line: color.line, inkSoft: color.inkSoft, fmt
      });

      /* ★ 价格线（开仓 / 强平 / 保本 / 委托 / 预览 / 两条预估强平）画在**蜡烛之前**：
         线横穿整幅、标签落在右边距的空白带里，所以压不到任何一根 K 线；先画是双保险。
         三步：算位置（不落笔）→ 擦掉同高度的刻度数字 → 再统一画线与标签 ——
         擦除必须夹在中间，反了的话会把刚画好的标签一起擦掉。
         一步全交给 chartIndicatorLayer.drawPriceLines（它顺带回一份「这一帧画了什么」）。 */
      const tags = CS.chartIndicatorLayer.layoutPriceTags(ctx, live.lines, {
        yOf: value => yOf(value, range), x1: p.x1, axisRight: state.width,
        axisTop: p.y0, axisBottom: p.y1,
        min: range.lo, max: range.hi
      });
      state.linesDrawn = CS.chartIndicatorLayer.drawPriceLines(ctx, tags, {
        x0: p.x0, x1: p.x1, axisTicks, background: color.bg,
        tick: {
          on: tickOn(),
          pulse: anim.pulse && anim.pulse.value ? anim.pulse.value() : 0,
          x: p.x1 - 1,
          color: (tags.find(t => t.live) || {}).color
        }
      });
      /* 绘图区四边 + 当前高亮的那条线：命中测试与拖动要用（见下面 lineDrag） */
      state.plot = p;
      state.lineHit = lineDrag ? lineDrag.hover : null;

      /* K 线：涨用 --pos、跌用 --neg，同时用**实体空心/实心**区分（色盲友好）。
         正在走的那一根上面已经换成动画里的那一根（live.bars）—— 与价格线同一个数。 */
      const liveIndex = tickOn() ? bars.length - 1 : -1;
      const grow = growOn() ? anim.grow.progress() : 0;   // 0 = 没在播（当缩放系数会把那根画成细线）
      /* 这一轮生长是给哪一根的：由生长驱动自己声明（tickEngine.growForT）。
         ★ 不靠「上一帧见过没有」判：推进之后图表会因为光标移动先重画一帧，
         那一帧里新那根就已经画过了，于是「刚来的」这个判据永远是假 ——
         表现是抖动在跳、实体不长大（两个动画看着只有一个在工作）。
         横坐标全程不动（第 i 格永远是同一个 x），所以这里不需要任何补间。 */
      const growFor = anim.grow && anim.grow.forBar ? anim.grow.forBar() : null;
      const newestT = bars.length ? bars[bars.length - 1].t : null;
      const freshBar = growFor !== null && newestT !== null && growFor === newestT;
      state.prevDrawMap = CS.chartPlot.drawCandles(ctx, {
        bars: live.bars, xOf, yOf: value => yOf(value, range), bodyW,
        up: color.up, down: color.down, bg: color.bg,
        liveIndex, grow, fresh: freshBar, prevMap: state.prevDrawMap,
        top: p.y0, bottom: p.y1
      });

      /* ★ 指标叠加线：压在蜡烛之上、价格线之下（先指标后价格线：开仓价/强平价永远盖在最上面）。
         ★★ 下标要对齐：frame 的 rows 是「含暖机的整串」，直接传 x => xOf(x) 会把指标按
         「暖机也算进去」的下标落位 —— 暖机越多偏得越远，表现是**指标与 K 线整体横向错开**。
         所以先把 frame 下标换算成图表下标：chartIndex = frameIndex - offset。 */
      const ind = CS.chartIndicatorLayer.indicatorFrame(indicatorLayer, bars);
      const indOffset = ind ? Math.max(0, ind.frame.rows.length - bars.length) : 0;
      if (ind) {
        try {
          CS.chartIndicators.drawOverlays(ctx, ind.geom, ind.frame, x => xOf(x - indOffset));
        } catch (error) {
          CS.errors.push({ message: `叠加线没画出来（图照常画）：${error && error.message}` });
        }
      }
      /* 时间轴：首 / 中 / 末三格（实现在 chartIndicatorLayer.drawTimeAxis） */
      CS.chartIndicatorLayer.drawTimeAxis(ctx, {
        bars, xOf, x0: p.x0, x1: p.x1, bottom: state.height, inkSoft: color.inkSoft
      });

      /* ★ 副图：主图这一帧的 frame 与几何直接喂给副图容器 ——
         副图复用主图的 left/right/step，所以竖着看每一根 K 线都对得齐。
         没开副图指标时那一块是隐藏的（chartPanes 自己收起来），不占高度。 */
      if (subPanes) {
        subPanes.setFrame(ind ? ind.frame : null, ind ? ind.geom : null, {
          /* 把**主图自己用的 x 映射**交给副图（换算成 frame 下标空间）。
             副图原来自己按 `left + step * ((i - from) + .5)` 算，少了主图的居中偏移，
             于是窗口一宽、格子一封顶就整体错开。横坐标只该有一个来源。 */
          xOf: x => xOf(x - indOffset),
          from: indOffset
        });
      }

      /* 图例画在最后：它要压在网格与指标线之上才读得清（旧实现也是放左上角） */
      const p2 = plot();
      CS.chartIndicatorLayer.drawLegend(ctx, ind ? ind.frame : null, {
        digits: state.digits, ink: color.ink, left: p2.x0 + 2, right: p2.x1
      });

      state.drawn = {
        range, slot,
        /* 画布上最新那根**实际画出来的收盘价**（抖动中逐帧在变）：没有它，
           「读数在跳、图不动」这类缺陷没法判定 —— 两个数一比才看得出来。 */
        drawnClose: live.bars.length ? live.bars[live.bars.length - 1].c : null,
        indicators: ind ? { overlays: ind.frame.overlays.length, panes: ind.frame.panes.length } : null,
        /* 价格标签落在哪 + 绘图区右边界：给对齐/遮挡自检用（标签盖住最新那根不报错、
           也不是算错，它只是画在了别人的位置上） */
        priceTags: (tags || []).map(tag => ({ label: tag.label, left: tag.chipX, right: tag.chipX + tag.chipW, y: tag.y })),
        plotRight: p.x1
      };
      /* 缓动没到终点：再排一帧。抖动期间本来每帧都会进来，这一句只是在静止
         （只 setBars 一次）时把 160ms 的过渡走完。 */
      if (rangeMoving) scheduleDraw();
    }

    /* ---------- 十字光标与读数 ----------
       实现在 ui/components/chartCrosshair.js（连注释六十多行，抽出去让这个文件守在
       当时的 400 行上限以内）；这里只把 DOM 零件与取值器递过去。 */
    const cross = CS.chartCrosshair.create({
      canvas, wrap, overlay, crossX, crossY, tip,
      bars: () => state.bars, plot, range: rangeNow,
      /* 光标反查下标：实现在 chartGeom.indexAtX（纯几何，与 x 映射同一处）。
         这里自己再写一遍同样的循环就会「光标读的数和画的对不上」。 */
      indexAtX: geom.indexAtX, xOf, digits: () => state.digits,
      onHover: payload => { if (o.onHover) o.onHover(payload); }
    });
    function hideCross() {
      cross.hide();
      state.hover = -1;
      if (o.onHover) o.onHover(null);
    }

    /* ★ 价格线优先于浮层（见 chartLineDrag 文件头）：压在线上时不显示浮层，
       改成高亮那条线 + 换指针形状；正在拖时只把线搬过去。 */
    function moveCross(event) {
      if (!state.bars.length) return;
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      if (lineDrag) {
        if (lineDrag.dragging) { lineDrag.dragTo(my); hideCross(); return; }
        const hit = lineDrag.kindAt(mx, my);
        lineDrag.setHover(hit ? hit.kind : null, canvas);
        if (hit) { hideCross(); return; }
      }
      const moved = cross.move(event);
      state.hover = moved ? cross.index : -1;
    }
    canvas.addEventListener('mousemove', moveCross);
    canvas.addEventListener('mouseleave', () => { if (lineDrag && lineDrag.dragging) return; hideCross(); lineDrag && lineDrag.setHover(null, canvas); });
    canvas.addEventListener('touchstart', event => { if (event.touches[0]) moveCross(event.touches[0]); }, { passive: true });
    canvas.addEventListener('touchmove', event => { if (event.touches[0]) moveCross(event.touches[0]); }, { passive: true });
    canvas.addEventListener('touchend', hideCross);
    /* 拖动走 pointer 事件（要 setPointerCapture），浮层走 mousemove —— 两条路分开，
       工具与测试发的 MouseEvent 也就直接命中（旧实现就是为这个这么分的）。 */
    canvas.addEventListener('pointerdown', event => {
      if (!lineDrag) return;
      const rect = canvas.getBoundingClientRect();
      if (lineDrag.begin(event.clientX - rect.left, event.clientY - rect.top, canvas, event.pointerId)) {
        hideCross();
        event.preventDefault();
      }
    });
    canvas.addEventListener('pointermove', event => {
      if (lineDrag && lineDrag.dragging) lineDrag.dragTo(event.clientY - canvas.getBoundingClientRect().top);
    });
    const finishDrag = () => { if (lineDrag) lineDrag.end(); };
    canvas.addEventListener('pointerup', finishDrag);
    canvas.addEventListener('pointercancel', finishDrag);

    let observer = null;
    /* `?noro` 是开发期的隔离开关：关掉尺寸观察器，用来判断
       「ResizeObserver loop」警告到底是这张图引起的，还是页面上别的东西引起的。
       正常使用不会带这个查询串。 */
    const noObserver = typeof location !== 'undefined' && location.search.indexOf('noro') >= 0;
    if (typeof ResizeObserver === 'function' && !noObserver) {
      observer = new ResizeObserver(() => resize());
      observer.observe(wrap);
    }
    window.addEventListener('resize', resize);
    resize();

    function setBars(bars) {
      state.bars = (bars || []).slice(-(o.maxBars || 240));
      draw();
    }
    /* 价格线两件事（合成一个入口）：`lines` 是基准那一份（锚定线只随持仓与委托变），
       `liveOf` 是「按这一刻的现价重算」的取值器 —— draw() 每帧问它一次。
       ★ 现价线与「预估强平·现价」是**现价的函数**，而现价每帧都在抖：只在每 400ms
       那一拍重算的话，K 线每帧在跳、这两条线在后面追。 */
    function setLines(lines, liveOf) {
      state.lines = lines || [];
      state.liveLines = typeof liveOf === 'function' ? liveOf : null;
      draw();
    }
    /* 这一帧画什么：正走的那一根换成动画里的那一根，价格线按同一个价现取（同源，见上）。
       没有动画时原样返回（零成本）。 */
    function frameOf() {
      const bars = state.bars;
      const noAnim = !bars.length || !tickOn() || !anim.tick || !anim.tick.displayBar;
      if (noAnim) return { bars, lines: state.lines || [] };
      const i = bars.length - 1;
      const liveBar = anim.tick.displayBar(bars[i]);
      const drawBars = liveBar && liveBar !== bars[i] ? bars.slice(0, i).concat([liveBar]) : bars;
      const spot = drawBars[drawBars.length - 1].c;
      let lines = state.lines || [];
      if (state.liveLines) { try { lines = state.liveLines(spot) || lines; } catch (_) {} }
      return { bars: drawBars, lines };
    }
    function setDigits(d) { state.digits = Number.isFinite(d) ? d : 2; }
    /* 三件动画零件（都可选，模式不给就不接；接线见 ui/components/tradeAnim.js）：
       tick 抖动 / grow 生长 / pulse 波纹。并成一个入口转给插座，而**排帧循环仍然只有
       模式那一条**（引擎的 tick.frame）—— 图表自己不开定时器。 */
    function setAnimDrivers(d) {
      const a = d || {};
      anim.set({ tick: a.tick || null, grow: a.grow || null, pulse: a.pulse || null });
    }
    /* 价格线的命中与拖动（实现在 ui/components/chartLineDrag.js）：拖动中指针优先于浮层；
       命中按**画出来的 y** 判（被夹到边缘的线也拖得动），所以几何与范围都要给。 */
    function setLineDriver(d) {
      lineDrag = d ? CS.chartLineDrag.create({
        lines: () => state.linesDrawn || [],
        plot: () => state.plot,
        range: () => rangeNow(),
        onDragTo: (price, prev) => (d.onDragTo ? d.onDragTo(price, prev) : price),
        onDrop: price => { if (d.onDrop) d.onDrop(price); },
        onPick: kind => { if (d.onPick) d.onPick(kind); },
        onHover: () => { if (d.onHover) d.onHover(); }
      }) : null;
    }
    let lineDrag = null;

    return {
      setBars, setLines, setDigits, setAnimDrivers, setLineDriver, setIndicators, setPaneHost, resize, redraw: draw, resetRange,
      /* 这一帧画布上真的画了什么（最新那根实际画出来的收盘价、价格标签位置…）。
         自检拿它与读数比 —— 「读数在跳、图不动」这类缺陷不报错，只有比数才看得出来。 */
      drawn: () => state.drawn,
      /* 图表被要求重画了几次（自检读数，见 scheduleDraw） */
      scheduleCount: () => scheduleCount,
      /* 这一帧图上的价格线（身份 / 价 / y / 是否被夹取）。
         给自检核对「该画的都画了、画布外的被夹到边缘」—— 这类缺陷不报错，只是图上看不见。 */
      linesDrawn: () => state.linesDrawn,
      dispose() {
        if (anim) anim.dispose();
        window.removeEventListener('resize', resize);
        if (observer) observer.disconnect();
        canvas.removeEventListener('mousemove', moveCross);
        canvas.removeEventListener('mouseleave', hideCross);
        /* 副图也是这一个图表的零件（它有 ResizeObserver 与 window 监听），
           漏掉就会「切一次模式漏一格」—— 与当初只回 {root,update} 不回 dispose 是同一类错。 */
        if (subPanes) { try { subPanes.dispose(); } catch (_) {} }
        clear(host);
      }
    };
  }

  return { tradeChart: { mount, DEFAULT_BARS } };
});
