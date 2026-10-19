/* ============ 图表的「指标层」：这一帧的指标数据 + 主图图例 ============
   从 ui/components/tradeChart.js 拆出来的一层（原来那份 467 行，超过**当时**的单文件上限：400 行）。
   拆的这条缝是天然的：**指标层不认识画布几何以外的东西** ——

     indicatorFrame()  向调用方要「这一帧的指标」，把几何换算成 chartIndicators 认识的形状；
                       拿不到数据、或者引擎算崩了，都返回 null（图照常画其余部分）。
     drawLegend()      主图左上角的图例：开着哪几条线、最新值多少。

   为什么这一段值得单独一层：它是「图表」与「指标引擎」之间**唯一**的接触面。
   图表不认识 CS.indicators 是怎么算的，引擎也不认识画布 —— 两边都只认这一层。
   顺带把容错收在一处：指标出问题只影响指标，不会让整张图画不出来。 */
CS.define('ui/components/chartIndicatorLayer', ["core/base/money","core/base/util","core/indicators/indicatorColors","core/indicators/indicatorState","core/indicators/registry","lib/lodash","ui/components/chartIndicators","ui/components/chartPlot"], function () {
  'use strict';

  /* 把图表的内部几何换算成 chartIndicators 要的形状（left/right/top/bottom/step/yOf）。
     两边的名字本来就不一样：图表里叫 p.x0 / p.x1 / p.y0 / p.y1，指标那边叫 left/right/top/bottom。 */
  function makeSource(opts) {
    const o = opts || {};
    return {
      /* source 由交易页注入：source.frame() 给 CS.indicators 算好的这一帧 */
      source: o.source || null,
      /* geometry() 给 { x0, x1, y0, y1, step }，yOf(value) 把价格换成画布 y */
      geometry: o.geometry,
      yOf: o.yOf,
      onError: o.onError || (() => {})
    };
  }

  function indicatorFrame(layer, bars) {
    if (!layer || !layer.source || !bars || !bars.length) return null;
    try {
      const frame = layer.source.frame ? layer.source.frame() : null;
      if (!frame || !frame.rows || !frame.rows.length) return null;
      const g = layer.geometry();
      if (!g) return null;
      const geom = {
        ready: true,
        left: g.x0, right: g.x1, top: g.y0, bottom: g.y1,
        step: g.step, yOf: value => layer.yOf(value)
      };
      return { frame, geom };
    } catch (error) {
      /* 指标画不出来不该让整张图不画：记一条、返回 null，调用方跳过这一层 */
      layer.onError(error);
      return null;
    }
  }

  /* 主图图例：左上角（K 线从格子中间开始画，那里本来是空的，所以不挡东西）。
     一行放不下就另起一行，最多 3 行 —— 与旧教程页一致。 */
  function drawLegend(ctx, frame, opts) {
    const o = opts || {};
    if (!frame || !ctx || !CS.chartIndicators) return false;
    const items = CS.chartIndicators.overlayLegendItems(frame, CS.indicators.math);
    if (!items.length) return false;
    const digits = Number.isFinite(o.digits) ? o.digits : 2;
    const left = Number.isFinite(o.left) ? o.left : 10;
    const right = Number.isFinite(o.right) ? o.right : left + 200;
    const width = Math.max(40, right - left);
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let x = left, y = 14, lines = 1;
    items.forEach(item => {
      const text = `${item.label} ${Number.isFinite(item.last) ? CS.money.formatNumber(item.last, digits) : '—'}`;
      ctx.font = '600 10px "DM Mono", ui-monospace, monospace';
      const tw = ctx.measureText(text).width;
      if (x + tw > left + width && lines < 3) { x = left; y += 13; lines++; }
      if (lines > 3 || x + tw > left + width) return;
      ctx.fillStyle = CS.chartPlot.rgbaOf(item.rgb, .95);
      ctx.fillRect(x, y - 1.5, 8, 3);
      ctx.fillStyle = o.ink || '#111827';
      ctx.fillText(text, x + 11, y);
      x += tw + 22;
    });
    ctx.restore();
    return true;
  }

  /* 网格与价格刻度（5 等分）。刻度数字靠左排在 p.x1 右边的空白带里。
     返回每条刻度的 { y, x, w } —— 调用方拿它把「和价格标签同高度的那条数字」擦掉，
     不然两者会在同一条竖带上叠字（价格标签也在右边距里）。 */
  function drawGrid(ctx, opts) {
    const o = opts || {};
    if (!ctx) return [];
    const p = o.plot || {};
    const range = o.range || { lo: 0, hi: 1 };
    const yOf = o.yOf || (() => 0);
    const width = Number.isFinite(o.width) ? o.width : p.x1;
    const ticks = [];
    ctx.save();
    ctx.font = '500 10px "DM Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const price = range.lo + ((range.hi - range.lo) * i) / 4;
      const y = Math.round(yOf(price)) + 0.5;
      ctx.strokeStyle = o.line || '#e3e6ee';
      ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(p.x0, y); ctx.lineTo(p.x1, y); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = o.inkSoft || '#8a93a6';
      ctx.textAlign = 'left';
      ctx.fillText(o.fmt ? o.fmt(price) : String(price), p.x1 + 6, y);
      ticks.push({ y, x: p.x1 + 2, w: Math.max(0, width - p.x1 - 2) });
    }
    ctx.restore();
    return ticks;
  }

  /* 擦掉右边距里与价格标签同高度的刻度数字。
     只擦空白带那一条横条，不碰绘图区 —— 擦宽了会在 K 线上留下白疤。 */
  function eraseAxisTicks(ctx, ticks, tags, opts) {
    const o = opts || {};
    if (!ctx || !Array.isArray(ticks) || !Array.isArray(tags) || !tags.length) return;
    const bg = o.background || '#ffffff';
    tags.forEach(tag => {
      ticks.forEach(tick => {
        if (Math.abs(tick.y - tag.y) > 8) return;
        ctx.save();
        ctx.fillStyle = bg;
        ctx.fillRect(tick.x, tick.y - 6, tick.w, 12);
        ctx.restore();
      });
    });
  }

  /* 时间轴：只标首 / 中 / 末三格（密集标注在窄图上会糊成一条）。
     首尾两格贴边对齐、中间那格居中 —— 否则首尾的日期会被裁掉半个字。
     只取 MM-DD：年份在这张图上的作用不大，而它要占掉四个字符。 */
  function drawTimeAxis(ctx, opts) {
    const o = opts || {};
    const bars = o.bars || [];
    if (!ctx || !bars.length) return;
    const xOf = o.xOf || (() => 0);
    const x0 = Number.isFinite(o.x0) ? o.x0 : 0;
    const x1 = Number.isFinite(o.x1) ? o.x1 : 0;
    const y = Number.isFinite(o.bottom) ? o.bottom - 8 : 0;
    const idx = [0, Math.floor((bars.length - 1) / 2), bars.length - 1]
      .filter((v, i, arr) => arr.indexOf(v) === i);
    ctx.save();
    ctx.fillStyle = o.inkSoft || '#8a93a6';
    ctx.font = '500 10px "DM Mono", ui-monospace, monospace';
    ctx.textBaseline = 'alphabetic';
    idx.forEach(i => {
      const node = bars[i];
      if (!node) return;
      const text = CS.util.dateKey(new Date(node.t));
      ctx.textAlign = i === 0 ? 'left' : i === bars.length - 1 ? 'right' : 'center';
      ctx.fillText(text.slice(5), Math.max(x0, Math.min(x1, xOf(i))), y);
    });
    ctx.restore();
  }

  /* 算出价格线该画在哪 —— **不落笔**。
     分两步（先算后画）是为了让调用方能先处理「标签与刻度数字在同一竖带上」这件事：
     两者都在 p.x1 右边那条空白带里，同高度会叠字，所以调用方要先擦掉那条刻度。
     若在这里把标签画了，调用方随后的擦除就会把标签也擦掉。

     ★ 画布外的线**夹到边缘**、标签写成「夹取价（超出图表 …）」：
       纵轴范围是 K 线自己的事（见 chartGeom.priceRange），不该因为一条远方的委托线就整排缩放
       —— 那是本末倒置。夹取用 min + ratio*span（ratio 0 = 下界、1 = 上界）：
       不能写 1 - ratio，纵轴是反的（y 用 1-ratio，价格不能用）。
     返回每条 { y, label, value, color, dashed, live, clipped, textW, chipX, chipW, chipY, chipH }。 */
  function layoutPriceTags(ctx, lines, opts) {
    const o = opts || {};
    if (!Array.isArray(lines) || !lines.length || !ctx) return [];
    const yOf = o.yOf;
    const x1 = Number.isFinite(o.x1) ? o.x1 : 0;
    /* 画布右边界；没给就退回 x1 + 64（那时标签会留在图内，但至少不溢出画布） */
    const axisRight = Number.isFinite(o.axisRight) ? o.axisRight : x1 + 64;
    const min = Number.isFinite(o.min) ? o.min : null;
    const max = Number.isFinite(o.max) ? o.max : null;
    const out = [];
    ctx.font = '700 10px "DM Mono", ui-monospace, monospace';
    lines.forEach(line => {
      if (!line || !Number.isFinite(line.price) || !line.price) return;
      const span = (min !== null && max !== null) ? (max - min) : 0;
      /* 夹取：位置 ratio 与价格同向（纵轴是反的，见上面那段说明） */
      const raw = span > 0 ? (line.price - min) / span : 0.5;
      const ratio = Math.max(0, Math.min(1, raw));
      const clipped = raw < 0 || raw > 1;
      const value = clipped && span > 0 ? min + ratio * span : line.price;
      /* 悬停提示（画布上没有原生 tooltip，调用方拿这份文本自己画一条） */
      const text = `${line.label}`.trim();
      const textW = ctx.measureText(text).width;
      const chipX = Math.round(x1) + 2;
      const room = Math.max(24, axisRight - chipX - 1);
      /* 右侧刻度带只有 72px：长标签（预估强平·多 + 价格）一行放不下，
         原来会被 canvas 右边界裁掉后半句。拆成「身份 / 价格」两行，
         价格留在图上，文字也不会压到边框上。 */
      const cut = text.lastIndexOf(' ');
      const head = cut > 0 ? text.slice(0, cut) : text;
      const tail = cut > 0 ? text.slice(cut + 1) : '';
      const headW = cut > 0 ? ctx.measureText(head).width : textW;
      const tailW = cut > 0 ? ctx.measureText(tail).width : 0;
      const twoLines = !!tail && textW + 9 > room;
      const widest = twoLines ? Math.max(headW, tailW) : textW;
      const lines = twoLines ? [head, tail] : [text];
      const chipW = Math.max(24, Math.min(room, widest + 9));
      out.push({
        y: Math.round(yOf(value)) + 0.5,
        label: text, lines, value, realValue: line.price, color: line.color, dashed: !!line.dash,
        dash: line.dash || [], kind: line.kind, title: line.title || '', hover: line.hover || '',
        /* live = 这一条是「此刻的现价」：调用方据此在它那一点上画小圆点与波纹 */
        live: !!line.live, clipped, rawRatio: raw,
        textW, chipX, chipW, chipY: 0, chipH: twoLines ? 26 : 15
      });
    });
    /* 同一高度上的多条线（开仓价正好等于保本价）要错开，否则标签叠成一团。
       旧实现是一行一行往下让半行（`while (used.some(t => Math.abs(t - top) < 14)) top += 15`），
       这里保持同一个做法 —— 换一种排法会让「哪条标签对应哪条线」变得难认。
       两行标签更高，碰撞判断按各自实际高度算。 */
    out.sort((a, b) => a.y - b.y);
    for (let i = 0; i < out.length; i++) {
      let y = out[i].y - Math.round(out[i].chipH / 2);
      if (i > 0) {
        let guard = 0;
        while (guard++ < out.length + 2 && out.slice(0, i).some(prev =>
          y < prev.chipY + prev.chipH + 2 && y + out[i].chipH + 2 > prev.chipY)) y += 15;
      }
      /* 两行标签比一行高 11px；价格线贴近绘图区顶/底时，往上/下让出
         chipH，避免文字被画布边缘切掉（尤其是开仓价落在最底部那一格）。 */
      const top = Number.isFinite(o.axisTop) ? o.axisTop : -Infinity;
      const bottom = Number.isFinite(o.axisBottom) ? o.axisBottom : Infinity;
      if (Number.isFinite(top) || Number.isFinite(bottom)) {
        y = Math.max(top, Math.min(bottom - out[i].chipH, y));
      }
      out[i].chipY = y;
    }
    return out;
  }

  /* 现价那一点上的小圆点与波纹（可选）。
     on 为真时画一个小圆点；pulse > 0 时再从它扩散一圈。
     为什么非要有：窄幅 K 线（刚开出来的那一根）抖动的位移不到一个像素，
     纵轴上根本看不出线在动 —— 这圈波纹是「价格在盘中跳」唯一看得见的证据
     （旧实现 game/js/chart/frames.js 的 drawLivePrice 就是这么做的）。 */
  function drawLiveDot(ctx, tag, opts) {
    const o = opts || {};
    if (!o.on || !tag || !Number.isFinite(tag.y)) return;
    const x = Number.isFinite(o.x) ? o.x : 0;
    const rgb = o.color || tag.color;
    const r = o.pulse > 0 ? 3.4 : 2.6;
    ctx.save();
    if (o.pulse > 0) {
      ctx.globalAlpha = 0.1 + 0.42 * o.pulse;
      ctx.strokeStyle = rgb;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(x, tag.y, 3 + (4 + (1 - o.pulse) * 16), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = rgb;
    ctx.beginPath(); ctx.arc(x, tag.y, r, 0, Math.PI * 2); ctx.fill();
    /* 白描边：深色 K 线穿过它的时候也认得出来那是「当前价」那一点 */
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(x, tag.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  /* 画价格线：一条横线贯穿绘图区 + 右边距里的一枚标签。
     tags 由 layoutPriceTags 给（颜色 / y / 标签 / 位置都算好了）。

     opts.axisTicks + opts.background：**先擦掉与标签同高度的刻度数字**再落笔。
     这两件事的先后是有语义的（擦除会连带擦掉已经画好的标签），所以收在这里做，
     不让调用方分三步自己去排 —— 排错了只是「刻度数字压着标签」，
     不会报错，只有盯着图看才发现。
     opts.tick 见上面 drawLiveDot。
     返回这一帧画了哪些线（给自检读：身份 / 价 / y / 有没有被夹取）。 */
  function drawPriceLines(ctx, tags, opts) {
    const o = opts || {};
    if (!Array.isArray(tags) || !tags.length || !ctx) return [];
    const x0 = Number.isFinite(o.x0) ? o.x0 : 0;
    const x1 = Number.isFinite(o.x1) ? o.x1 : 0;
    if (Array.isArray(o.axisTicks) && o.axisTicks.length) {
      eraseAxisTicks(ctx, o.axisTicks, tags, { background: o.background });
    }
    tags.forEach(tag => {
      /* 1) 横线：贯穿绘图区（那才是「一条价格线」的意思） */
      ctx.save();
      ctx.strokeStyle = tag.color;
      ctx.setLineDash(tag.dashed ? [5, 4] : []);
      ctx.globalAlpha = 0.95;
      ctx.beginPath(); ctx.moveTo(x0, tag.y); ctx.lineTo(x1, tag.y); ctx.stroke();
      ctx.restore();
      /* 2) 标签：整块落在 x1 右边，压在蜡烛之外。
            现价那一枚按「此刻的价 vs 上一根已收盘的收盘价」上色（tag.color 已由
            调用方按那个基准算好）—— 于是标签的颜色和它写出来的数字永远一致。 */
      const { chipX, chipW, chipY, chipH } = tag;
      ctx.save();
      ctx.fillStyle = tag.color;
      ctx.globalAlpha = 0.95;
      const r = 3;
      ctx.beginPath();
      ctx.moveTo(chipX + r, chipY);
      ctx.lineTo(chipX + chipW - r, chipY); ctx.quadraticCurveTo(chipX + chipW, chipY, chipX + chipW, chipY + r);
      ctx.lineTo(chipX + chipW, chipY + chipH - r); ctx.quadraticCurveTo(chipX + chipW, chipY + chipH, chipX + chipW - r, chipY + chipH);
      ctx.lineTo(chipX + r, chipY + chipH); ctx.quadraticCurveTo(chipX, chipY + chipH, chipX, chipY + chipH - r);
      ctx.lineTo(chipX, chipY + r); ctx.quadraticCurveTo(chipX, chipY, chipX + r, chipY);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const lines = Array.isArray(tag.lines) && tag.lines.length ? tag.lines : [tag.label];
      if (lines.length === 1) {
        ctx.fillText(lines[0], chipX + 4.5, chipY + chipH / 2 + 0.5);
      } else {
        lines.forEach((line, i) => ctx.fillText(line, chipX + 4.5, chipY + 8 + i * 11));
      }
      ctx.restore();
    });
    /* 3) 现价那一点（+ 波纹）：画在最后，压在所有的线之上 */
    const live = tags.find(t => t.live);
    if (live) drawLiveDot(ctx, live, o.tick);
    return tags.map(tag => ({
      kind: tag.kind, price: tag.realValue, drawnPrice: tag.value, y: tag.y,
      clipped: tag.clipped, live: tag.live, label: tag.label
    }));
  }

  /* 动画驱动（可选，由模式通过 ctx.ticks 注入）：图表按它逐帧重画最新那一根。
     从 tradeChart.js 拆出来，顺带把「驱动可能返回不了退订函数」这条兜底收在一处。
     约定：driver.onFrame(cb) 返回一个退订函数（可以不返回 —— 那就没有退订）；
     driver.active() 说「现在有没有动画在走」—— 不在走时直接重画一帧（省掉排帧）。
     ★ 一个「帧事件」同时喂给抖动与生长两段动画（core/animation/tickEngine 的 tick.frame
       带 u 与 grow 两个进度）：任一在走就重画。只按抖动判的话，
       **抖动关掉时新 K 线就不长了** —— 长出来那一段整段消失。
       所以这里的回调不自己判，把判断留给驱动（它知道自己在不在走）。 */
  function createTickDriver(opts) {
    const o = opts || {};
    let off = null;
    return {
      set(driver) {
        if (off) { try { off(); } catch (_) {} off = null; }
        if (!driver || typeof driver.onFrame !== 'function') { o.onIdle && o.onIdle(); return null; }
        off = driver.onFrame(payload => {
          if (!payload) return;
          const busy = payload.done ? false : (typeof driver.active === 'function' ? driver.active() : true);
          if (!busy) { if (o.onIdle) o.onIdle(); else if (o.onDraw) o.onDraw(); return; }
          if (o.onDraw) o.onDraw();
        });
        return driver;
      },
      dispose() { if (off) { try { off(); } catch (_) {} off = null; } }
    };
  }

  return {
    chartIndicatorLayer: {
      makeSource, indicatorFrame, drawLegend,
      drawGrid, drawTimeAxis, eraseAxisTicks, layoutPriceTags, drawPriceLines, drawLiveDot,
      createTickDriver
    }
  };
});
