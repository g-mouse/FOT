/* ============ 「图表这一屏看什么」：周期 + 根数（唯一口径） ============
   图表画蜡烛、指标算叠加线、图表右上角那行读数 —— 这三处必须看**同一批 K 线**。
   以前它们各算各的：切到 8h 之后蜡烛是 8h 的，而指标仍在 4h 上算，
   于是「图上那根 8h K 线和指标准不到一起」，而且**不报错**，只是线看着怪。

   所以取值只留这一处。它做三件事：
     1) 按基础周期（4h）取够数据 —— 一根 1 周 K 线要 42 根 4h 才够，
        所以「要 N 根大周期」就得往回要 N × 每周期几根基础 K 线，再留一点余量；
     2) 重采样成当前周期（1w / 3d 的对齐口径在 core/market/resample.js）；
     3) 顺手把「指标要的暖机」也算进来 —— 暖机是大周期的根数，
        换算成基础根数同样要乘那个倍数。

   缓存键是 (周期, 已揭晓到第几根, 池子长度)：时间推进或换数据都会变，
   所以缓存自然作废，不需要谁记得来清（旧实现靠手动清缓存，踩过「切周期图很离谱」）。 */
CS.define('ui/components/chartView', ["core/market/marketData","core/market/resample"], function () {
  'use strict';

  const BASE_HOURS = 4;
  /* 一次最多往回取多少根基础 K 线。1w × 240 根 = 10080 根，
     对「刚上线、历史很浅」的品种本来就取不满，所以这里封个顶，
     要不到就算了 —— 少画几根比卡住强。 */
  const MAX_POOL = 260 * 8;

  const barsPer = tf => Math.max(1, Math.round(tf.hours / BASE_HOURS));

  /* opts = { barsOf(id, count), id, want, tfId, warmup } */
  function viewFor(opts) {
    const o = opts || {};
    const tf = CS.resample.tfOf(o.tfId);
    const want = Math.max(1, Math.round(Number(o.want) || 120));
    const warmup = Math.max(0, Math.round(Number(o.warmup) || 0));
    /* 大周期总根数 = 看得见的 + 指标暖机；换成基础根数要乘倍数，再多给一根兜住
       「最右边那根还没走完」时落在桶边界上的情况。 */
    const need = (want + warmup) * barsPer(tf) + barsPer(tf);
    const pool = o.barsOf(o.id, Math.min(MAX_POOL, need)) || [];
    if (!pool.length) return { bars: [], pool: [], from: 0, count: 0, tf, warmupBars: 0 };
    if (tf.id === CS.resample.DEFAULT_TF) {
      const bars = pool.slice(-want);
      return { bars, pool, from: Math.max(0, pool.length - bars.length), count: bars.length, tf, warmupBars: Math.min(warmup, Math.max(0, pool.length - bars.length)) };
    }
    /* ★ 缓存键里**必须**带上 priceVersion（价格被就地改写的次数）。
       调用方传的 version 是「已揭晓到第几根」，它在同一根 K 线之内不会变 ——
       而教程引导会在原地重写这一段的 OHLC（core/tutorial/priceOverlay）。
       少了这一项，改写之后聚合缓存仍然命中旧值：图上是改写前的蜡烛、
       账户读的是改写后的价（不报错，只是对不上）。合成放在这一层而不是各个调用方，
       以后新增调用点也不会漏。 */
    const version = `${o.version == null ? '' : o.version}|${CS.marketData.priceVersion || 0}|${pool.length}`;
    const frame = CS.resample.frameOf(pool, tf.id, version);
    const bars = frame.bars.slice(-want);
    const from = Math.max(0, frame.count - bars.length);
    return {
      bars, pool, from, count: bars.length, tf, resampled: true,
      /* 暖机在大周期上的起点（指标算的时候要知道从哪一行开始才是可见窗口） */
      warmupBars: Math.min(warmup, from)
    };
  }

  /* 指标要的「这一帧的输入」：可见窗口之前再垫上暖机那几根大周期 K 线。
     返回 { rows, from }：rows 是含暖机的整串，from 是可见窗口的起点行号。
     字段名要转一次 —— 行情给 {o,h,l,c,t}，指标引擎的 ctx 要 {open,high,low,close}
     （不转的话引擎读到的全是 undefined，每个指标都算成 NaN，而且不报错）。 */
  function indicatorInput(view, opts) {
    const o = opts || {};
    const warm = Math.max(0, Number(o.warmup) || 0);
    if (!view || !view.bars.length) return null;
    const tf = view.tf;
    let all = view.bars;
    if (warm > 0) {
      /* 暖机根数在大周期上，所以往回多要 warm 根大周期 = warm × 倍数 根基础 */
      const wider = viewFor({
        barsOf: o.barsOf, id: o.id, tfId: tf.id,
        want: view.bars.length + warm, warmup: 0, version: o.version
      });
      all = wider.bars;
    }
    if (!all.length) return null;
    const from = Math.max(0, all.length - view.bars.length);
    const rows = all.map(b => ({ open: b.o, high: b.h, low: b.l, close: b.c, t: b.t, bucketT: b.t, forming: false }));
    return { rows, from, tf };
  }

  /* 只出 viewFor 与 indicatorInput：barsPer / MAX_POOL / BASE_HOURS 是本文件内部
     的实现细节（换算比例与上限），外面不需要知道它们。 */
  return { chartView: { viewFor, indicatorInput } };
});
