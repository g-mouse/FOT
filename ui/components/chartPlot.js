/* ============ 画布画笔（纯画图：给映射与数据，往 ctx 上画） ============
   这一层是**指标绘制的地基**，主图叠加线与副图曲线共用同一套：
     plotSeries  按 series.type 派发（line / hist / band / tones）
     plotLine    NaN 断开（「这一段还没有值」，与 indicators/math.js 的约定一致）
     plotToned    一条线两个方向（SUPERTREND 那种），换色的那一根两边都画，接口处不断开
     plotHist     柱子从 0 轴长出去（MACD 的柱）
     plotBand     上下轨之间填一层带子（BOLL）
     paintCandle  一根 K 线（影线 + 实体，带圆角与极细宽度的退化分支）
     roundRect    圆角矩形路径

   从 game/js/chart/canvas.js 移植而来。移植时只做两件事：
     1) 颜色常量不再从 CS.config 取 —— 这里声明一份默认值，调用方可以覆盖；
     2) 去掉与本层无关的东西（补间时钟、快照、CHART_WINDOW 的访问器）。
   **画法本身逐字未改**：画错一笔在图上很难看出来，所以这一层有专门的
   tools/parity-plot.mjs 拿假 ctx 逐调用比对（见 CS/tools/lib/plot-parity.cjs）。

   约定（调用方要守）：view = { xOf(i), yOf(value), from, count, top, bottom, step }，
   其中 i 一律是**数据行号**（含左边的暖机段），from 才是可见窗口的第一行。 */
CS.define('ui/components/chartPlot', [], function () {
  'use strict';

  /* 涨跌色。与旧实现的 #089981 / #f23645 一致；调用方（主题层）可以传自己的。 */
  const UP_RGB = [8, 153, 129];
  const DOWN_RGB = [242, 54, 69];

  /* rgba 文本要按透明度淡入淡出，所以颜色留 RGB 分量 */
  function rgbaOf(rgb, alpha) {
    const c = Array.isArray(rgb) ? rgb : UP_RGB;
    return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    if (radius <= 0) { ctx.rect(x, y, w, h); return; }
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y); ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius); ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius); ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function plotLine(ctx, values, view, rgb, options) {
    const opts = options || {};
    const end = view.from + view.count;
    ctx.save();
    ctx.strokeStyle = rgbaOf(rgb, opts.alpha === undefined ? .95 : opts.alpha);
    ctx.lineWidth = opts.width || 1.4;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.setLineDash(opts.dash || []);
    ctx.beginPath();
    let drawing = false;
    for (let i = view.from; i < end; i++) {
      const value = values[i];
      if (!Number.isFinite(value)) { drawing = false; continue; }
      const x = view.xOf(i), y = view.yOf(value);
      if (drawing) ctx.lineTo(x, y); else { ctx.moveTo(x, y); drawing = true; }
    }
    ctx.stroke();
    ctx.restore();
  }

  function plotToned(ctx, values, tones, view, rgbUp, rgbDown, options) {
    const opts = options || {};
    const end = view.from + view.count;
    const run = (start, stop, up) => {
      ctx.save();
      ctx.strokeStyle = rgbaOf(up ? rgbUp : rgbDown, opts.alpha === undefined ? .95 : opts.alpha);
      ctx.lineWidth = opts.width || 1.6;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.setLineDash(opts.dash || []);
      ctx.beginPath();
      for (let i = start; i <= stop; i++) {
        const x = view.xOf(i), y = view.yOf(values[i]);
        if (i === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    };
    let start = -1, up = false;
    for (let i = view.from; i < end; i++) {
      const on = Number.isFinite(values[i]);
      if (!on) { if (start >= 0) run(start, i - 1, up); start = -1; continue; }
      const tone = tones && tones[i] < 0 ? false : true;
      if (start < 0) { start = i; up = tone; continue; }
      if (tone !== up) { run(start, i, up); start = i; up = tone; }
    }
    if (start >= 0) run(start, end - 1, up);
  }

  function plotHist(ctx, values, view, rgbUp, rgbDown, options) {
    const opts = options || {};
    const end = view.from + view.count;
    const width = opts.width || Math.max(1, Math.min(6, (view.step || 6) * .62));
    const zero = Math.max(view.top, Math.min(view.bottom, view.yOf(0)));
    ctx.save();
    for (let i = view.from; i < end; i++) {
      const value = values[i];
      if (!Number.isFinite(value)) continue;
      const y = Math.max(view.top, Math.min(view.bottom, view.yOf(value)));
      ctx.fillStyle = rgbaOf(value >= 0 ? (rgbUp || UP_RGB) : (rgbDown || DOWN_RGB), opts.alpha === undefined ? .85 : opts.alpha);
      ctx.fillRect(view.xOf(i) - width / 2, Math.min(y, zero), width, Math.max(1, Math.abs(zero - y)));
    }
    ctx.restore();
  }

  function plotBand(ctx, lower, upper, view, rgb, alpha) {
    const end = view.from + view.count;
    ctx.save();
    ctx.fillStyle = rgbaOf(rgb, alpha === undefined ? .08 : alpha);
    let start = -1;
    const flush = stop => {
      if (start < 0 || stop < start) { start = -1; return; }
      ctx.beginPath();
      for (let i = start; i <= stop; i++) {
        const x = view.xOf(i), y = view.yOf(upper[i]);
        if (i === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for (let i = stop; i >= start; i--) ctx.lineTo(view.xOf(i), view.yOf(lower[i]));
      ctx.closePath();
      ctx.fill();
      start = -1;
    };
    for (let i = view.from; i < end; i++) {
      const ok = Number.isFinite(upper[i]) && Number.isFinite(lower[i]);
      if (ok) { if (start < 0) start = i; } else flush(i - 1);
    }
    flush(end - 1);
    ctx.restore();
  }

  /* 按 series 自己的 type 派发。一张图 / 一个副图里的全部曲线都走这一个入口。 */
  function plotSeries(ctx, series, view) {
    const type = series.type || 'line';
    if (type === 'band') { plotBand(ctx, series.values, series.values2, view, series.rgb, series.alpha); return; }
    if (type === 'hist') { plotHist(ctx, series.values, view, series.rgbUp, series.rgbDown, series); return; }
    if (series.tones) { plotToned(ctx, series.values, series.tones, view, series.rgbUp || series.rgb, series.rgbDown || series.rgb, series); return; }
    plotLine(ctx, series.values, view, series.rgb, series);
  }

  /* ============ 一屏 K 线（交易页用的那个批次入口） ============
     为什么单独一个函数而不是把循环留在图表组件里：
     这一段有三个容易写错、又**都不会报错**的地方，收在一处才好一次写对 ——
       1) 横坐标按设备像素取整：不取整每帧的抗锯齿都不一样，整排会一直在闪；
       2) bodyScale 只改**实体宽度**，绝不碰 最高/最低（碰了抖动期间就看不到影线）；
       3) 「刚冒出来的那一根」才播生长，历史那批只做一点点淡入。
     opts:
       bars      这一屏的 K 线（{t,o,h,l,c}；最新那根可以已经被抖动换过 c）
       xOf(i)    第 i 格的横坐标中心
       yOf(v)    价格 → 纵坐标
       bodyW     实体满宽
       up/down   涨跌色
       bg        阳线空心用的底色
       liveIndex 正在走的那一根的下标（-1 = 没有）
       grow      生长进度（0 = 没在播，见 tickEngine.growProgress）
       prevMap   上一帧画过哪些根（按时间戳）；返回这一帧的，交给下一帧
     返回这一帧画过的那些根，调用方存下来当下一帧的 prevMap。

     ★ 「哪一根播生长」只看**它是不是最后一根**，不另设一个「窗口右端换了吗」的旗标。
     那个旗标踩过：推进之后图表会先因为光标移动重画一帧（那一帧里新那根就已经在了），
     等生长动画开始时旗标已经翻转，于是**一根都不播**——
     表现是「抖动在跳、实体不长大」，两个动画看起来只有一个在工作。
     而「最后一根 + 上一帧没见过它」本来就等价于「刚冒出来的那一根」。 */
  function drawCandles(ctx, opts) {
    const o = opts || {};
    const bars = o.bars || [];
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const snap = v => Math.round(v * dpr) / dpr;
    const bodyW = o.bodyW;
    const grow = o.grow > 0 ? o.grow : 0;
    const drawn = Object.create(null);
    /* 裁剪边界：传入的 top/bottom 用于限制 Y 坐标，防止超出画布范围的 K 线无法渲染 */
    const clipTop = o.top !== undefined ? o.top : -Infinity;
    const clipBottom = o.bottom !== undefined ? o.bottom : Infinity;
    const clamp = (y, min, max) => Math.max(min, Math.min(max, y));
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (!bar || !Number.isFinite(bar.c)) continue;
      drawn[bar.t] = 1;
      const x = snap(o.xOf(i));
      const isNew = !o.prevMap || !o.prevMap[bar.t];
      let alpha = i === o.liveIndex ? 0.92 : 1;
      let bodyScale;
      if (isNew && grow > 0) {
        /* ★ 「最后一根」优先看调用方给的 fresh（窗口右端换了另一根），
           它才是唯一可靠的口径 —— 只看 isNew 是不行的：推进之后图表会因为光标移动
           先重画一帧，那一帧里新那根就已经进了 prevMap，等生长开始时 isNew 已经是假，
           于是一根都不播（表现：抖动在跳、实体不长大）。 */
        if (i === bars.length - 1 && o.fresh !== false) bodyScale = grow;
        else alpha = 0.9 + 0.1 * grow;
      }
      const w = bodyScale === undefined ? bodyW : Math.max(0.8, bodyW * bodyScale);
      const up = bar.c >= bar.o;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = up ? o.up : o.down;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 1;
      /* 影线永远满宽：它画的本来就是这一根真实的 最高/最低，从头到尾不动
         ★ 裁剪 Y 坐标到可见范围，防止超出画布导致无法渲染 */
      const yh = clamp(o.yOf(bar.h), clipTop, clipBottom);
      const yl = clamp(o.yOf(bar.l), clipTop, clipBottom);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, yh);
      ctx.lineTo(Math.round(x) + 0.5, yl);
      ctx.stroke();
      const yo = clamp(o.yOf(bar.o), clipTop, clipBottom);
      const yc = clamp(o.yOf(bar.c), clipTop, clipBottom);
      const top = Math.min(yo, yc);
      const h = Math.max(1, Math.abs(yc - yo));
      if (w < 1.2) {
        /* 极细那一下：宽 0.5 的矩形描边只会画出一团糊，退化成一条细线 */
        ctx.lineWidth = Math.max(1, w);
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, top);
        ctx.lineTo(Math.round(x) + 0.5, top + h);
        ctx.stroke();
      } else if (up) {
        ctx.fillStyle = o.bg;
        ctx.fillRect(x - w / 2, top, w, h);
        ctx.strokeRect(x - w / 2 + 0.5, top + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
      } else {
        ctx.fillRect(x - w / 2, top, w, h);
      }
      ctx.restore();
    }
    return drawn;
  }

  /* 画一根 K 线。bodyScale 只用来把实体从极细长成正常宽度（新 K 线「长出来」的那一下）：
     它**不会**碰 最高/最低 —— 影线一画出来就是这根 K 线真实的上下界，从头到尾一动不动。
     传 undefined = 不播动画、实体就是满宽；传 0 也是合法值（第一帧就是极细那一下），
     所以判据必须是 === undefined，**不能**用真假值 —— 用 `bodyScale ? … : bodyW` 的话，
     进度刚到 0 的那一帧会被当成「没有动画」而画成满宽，看着就是「先弹满宽再收细」。
     colorUp 用来指定颜色方向（不传就按 收 ≥ 开 自己判）。
     clipTop/clipBottom 可选参数用于裁剪 Y 坐标到可见范围。 */
  function paintCandle(ctx, x, candle, yOf, bodyW, alpha, bodyScale, colorUp, clipTop, clipBottom) {
    const rgb = (colorUp === undefined ? candle.close >= candle.open : !!colorUp) ? UP_RGB : DOWN_RGB;
    const clamp = (y, min, max) => Math.max(min, Math.min(max, y));
    const hasClip = clipTop !== undefined && clipBottom !== undefined;
    const yOpen = hasClip ? clamp(yOf(candle.open), clipTop, clipBottom) : yOf(candle.open);
    const yClose = hasClip ? clamp(yOf(candle.close), clipTop, clipBottom) : yOf(candle.close);
    const yHigh = hasClip ? clamp(yOf(candle.high), clipTop, clipBottom) : yOf(candle.high);
    const yLow = hasClip ? clamp(yOf(candle.low), clipTop, clipBottom) : yOf(candle.low);
    const w = bodyScale === undefined ? bodyW : Math.max(.8, bodyW * bodyScale);
    const top = Math.min(yOpen, yClose);
    const height = Math.max(1, Math.abs(yClose - yOpen));
    if (w < 1.2) {
      ctx.strokeStyle = rgbaOf(rgb, alpha);
      ctx.beginPath(); ctx.moveTo(x, yHigh); ctx.lineTo(x, yLow); ctx.stroke();
      ctx.fillStyle = rgbaOf(rgb, alpha);
      ctx.fillRect(x - .5, top, 1, height);
      return;
    }
    ctx.strokeStyle = rgbaOf(rgb, alpha); ctx.fillStyle = rgbaOf(rgb, alpha);
    ctx.beginPath(); ctx.moveTo(x, yHigh); ctx.lineTo(x, yLow); ctx.stroke();
    roundRect(ctx, x - w / 2, top, w, height, Math.min(1.6, w / 2.4)); ctx.fill();
  }

  return {
    chartPlot: {
      /* 全部导出，**包括低层的 plotLine / plotHist / plotBand / plotToned / roundRect**。
         交易页只经 plotSeries 与 paintCandle 用它们，但 tools/parity-plot.mjs 要逐个
         与旧实现做「逐调用比对」—— 那是这套画笔唯一的验收手段。
         换句话说：它们不是「没人用的 API」，是**被测试直接调的单元**。
         上一稿把低层几个撤了导出，结果 parity-plot 立刻报 6 项不一致：
         不是实现坏了，是测试够不着被测对象了。 */
      UP_RGB, DOWN_RGB, rgbaOf, roundRect,
      plotSeries, plotLine, plotToned, plotHist, plotBand, paintCandle,
      /* 交易页用的批次入口（见上面那段说明） */
      drawCandles
    }
  };
});
