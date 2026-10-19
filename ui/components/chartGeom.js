/* ============ 图表几何（纯计算，不碰 DOM、不碰画布） ============
   从 ui/components/tradeChart.js 拆出来（那个文件超过**当时**的单文件上限：400 行）。
   抽这一块的另一个理由更重要：**「值 → 画布坐标」是图上一切东西的共同前提** ——
   蜡烛、指标线、价格线、十字光标全都按这里的换算落位。
   它一旦偏了，所有东西一起偏，而且偏得很像样（图还是有、就是不对）。
   所以它是纯函数：给尺寸与数据，还坐标与取值范围，可以脱离浏览器单独验。

   调用方提供四个读数（都是函数，所以尺寸改了立刻生效）：
     count()  这一屏几根 K 线       width()/height()  画布 CSS 尺寸
     digits() 价格小数位            lines()  图上的价格线（开仓价/强平价/现价）
     bars()   这一屏的 K 线
   外边距与画布一致地由 options.pad 给（默认与交易页那一套相同）。 */
CS.define('ui/components/chartGeom', ["core/base/money"], function () {
  'use strict';

  const DEFAULT_PAD = { left: 8, right: 72, top: 12, bottom: 22 };
  /* 单屏最多画多少根：格子窄到看不清就没意义了，而且极窄时相邻蜡烛会糊成一片 */
  const MAX_SLOT = 26;

  function create(options) {
    const o = options || {};
    const pad = o.pad || DEFAULT_PAD;
    const bars = o.bars || (() => []);
    const lines = o.lines || (() => []);
    const width = o.width || (() => 0);
    const height = o.height || (() => 0);
    const digits = o.digits || (() => 2);

    /* 绘图区（不含右侧刻度带与底部时间轴） */
    function plot() {
      return {
        x0: pad.left,
        x1: Math.max(pad.left + 10, width() - pad.right),
        y0: pad.top,
        y1: Math.max(pad.top + 10, height() - pad.bottom)
      };
    }

    /* 纵轴范围：只看**看得见**的极值，再加上图上那几条价格线 ——
       开仓价 / 强平价常常在 K 线范围之外，不把它们算进来那几条线会画到画布外面去。
       ★ 自适应限制极端价格线：根据 K 线数量动态调整允许的偏离度，避免整张图被压缩。
       K 线越少（如 60 根），允许的偏离越大；K 线越多（如 240 根），限制越严格。 */
    function priceRange() {
      const list = bars();
      if (!list.length) return { lo: 0, hi: 1 };
      let lo = Infinity, hi = -Infinity;
      for (const b of list) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
      const barLo = lo, barHi = hi;
      const barSpan = barHi - barLo;
      const barMid = (barLo + barHi) / 2;
      /* 价格线偏离阈值：根据 K 线数量自适应调整。
         - 60 根或以下：允许偏离 150%（历史数据少，价格线可能确实需要更大范围）
         - 120 根：允许偏离 100%
         - 180 根：允许偏离 75%
         - 240 根及以上：允许偏离 50%（历史数据足够，可以更严格）
         线性插值确保平滑过渡。 */
      const barCount = list.length;
      let maxDeviation;
      if (barCount <= 60) maxDeviation = 1.5;
      else if (barCount <= 120) maxDeviation = 1.5 - (barCount - 60) / 60 * 0.5;  // 1.5 → 1.0
      else if (barCount <= 180) maxDeviation = 1.0 - (barCount - 120) / 60 * 0.25; // 1.0 → 0.75
      else if (barCount <= 240) maxDeviation = 0.75 - (barCount - 180) / 60 * 0.25; // 0.75 → 0.5
      else maxDeviation = 0.5;
      lines().forEach(line => {
        if (!Number.isFinite(line.value) || !line.value) return;
        /* barSpan = 0 时（全平行情）允许价格线自由扩大范围 */
        if (barSpan > 0) {
          const deviation = Math.abs(line.value - barMid) / barSpan;
          if (deviation > maxDeviation) return;
        }
        if (line.value < lo) lo = line.value;
        if (line.value > hi) hi = line.value;
      });
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 };
      /* 全平的行情（只有一根、或一根内没波动）会让 span 变成 0，那时给一个对称的极小范围 */
      if (hi - lo < Math.max(1e-9, hi * 1e-6)) { const mid = (hi + lo) / 2 || 1; lo = mid * 0.998; hi = mid * 1.002; }
      const padY = (hi - lo) * 0.08;
      return { lo: lo - padY, hi: hi + padY };
    }

    function slotWidth() {
      const p = plot();
      const n = bars().length;
      return n ? (p.x1 - p.x0) / n : 1;
    }

    /* 格子宽度与起始偏移。K 线少时**居中一簇**而不是从左边铺开：
       一屏三根 K 线铺满整幅图会显得像「数据坏了」。 */
    function slotSize() {
      const p = plot();
      const n = bars().length;
      if (!n) return { slot: 1, offset: p.x0 };
      const raw = (p.x1 - p.x0) / n;
      const capped = Math.min(raw, MAX_SLOT);
      const used = capped * n;
      return { slot: capped, offset: p.x0 + Math.max(0, ((p.x1 - p.x0) - used) / 2) };
    }

    function xOf(index) {
      const s = slotSize();
      return s.offset + s.slot * (index + 0.5);
    }

    function yOf(price, range) {
      const p = plot();
      const r = range || priceRange();
      const span = r.hi - r.lo || 1;
      return p.y1 - ((price - r.lo) / span) * (p.y1 - p.y0);
    }

    function fmt(price) { return CS.money.formatNumber(price, digits()); }

    /* 光标横坐标 → 第几根 K 线。用**最近的一根**，不是「按等宽格子除」：
       少数据时 K 线是居中一簇，格子除法会把左侧那一大片空白算成「第 0 根往前很远」，
       于是光标一进空白区就跳到最左边那根上。 */
    function indexAtX(mx) {
      const list = bars();
      let best = 0, bestD = Infinity;
      for (let i = 0; i < list.length; i++) {
        const d = Math.abs(xOf(i) - mx);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    return { plot, priceRange, slotWidth, slotSize, xOf, yOf, fmt, indexAtX, MAX_SLOT, pad };
  }

  /* 只出 create：外边距与格子宽度上限都是内部默认值，调用方想改就传 pad */
  return { chartGeom: { create } };
});
