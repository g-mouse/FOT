/* ============ 基础周期 → 图表周期的重采样（两个模式共用） ============
   行情数据只有一种基础周期（4h）。交易页上能切 4h / 8h / 12h / 1d / 3d / 1w，
   靠的就是这一层：把基础 K 线按周期分组，每组聚成一根大周期 K 线。

   从 game/js/market/resample.js 移植而来，**分组口径逐字保留**：
     · 1 周  对齐到 **周一 00:00 UTC**（不是「每 7 天从数据开头算起」——
             后者会让周线与真实日历错开，玩家看到「这周」其实横跨周三到下周二）；
     · 3 天  对齐到 UTC 整日的三倍分组；
     · 其余  按小时对齐（4h / 8h / 12h / 1d 都是整日的约数，按小时对齐天然对齐到 UTC 零点）。
   聚合口径：一根大周期 K 线的 开 = 组内第一根的开、收 = 组内最后一根的收、
             高 = 组内最高的高、低 = 组内最低的低。
   这四条是 K 线的定义，不是实现细节 —— 任何一个换掉，图上的形态就变了。

   与旧实现的两处差异（都是为了让它在现代壳里能用，不改口径）：
     1) 旧的数据是「大数组 + 偏移」（series[id] = {o[],h[],l[],c[],off}），
        新的是「一组 bar 对象」（{o,h,l,c,t}）。分组逻辑一样，取值方式跟着形状走。
     2) 旧实现把缓存挂在全局 market.frames 上、靠 applyRandom 手动清；
        这里改成**按 (周期, 数据版本) 缓存**：数据一变版本号就变，缓存自然作废。
        旧实现那套「清了缓存但指针还指着旧数组」的坑（用户报过「切周期图很离谱」）
        在这里不可能出现 —— 缓存键里有版本号，拿到的一定是对应这一版数据的聚合。

   由 tools/parity-resample.mjs 与旧实现逐点比对（分桶边界 + 四价）。 */
CS.define('core/market/resample', [], function () {
  'use strict';

  const DAY = 86400000;
  const HOUR = 3600000;

  /* 图表周期表。hours 是这一档大周期的小时数；intraday 表示「日内」（用于界面分组显示）。
     tutorial: false 的两档是旧教程页**故意不给**的（那两档波动太慢，教学里看不出东西）——
     这里保留这个标记，交易页按它决定要不要摆出来。 */
  const TIMEFRAMES = [
    { id: '4h', label: '4小时', short: '4H', hours: 4, intraday: true },
    { id: '8h', label: '8小时', short: '8H', hours: 8, intraday: true },
    { id: '12h', label: '12小时', short: '12H', hours: 12, intraday: true },
    { id: '1d', label: '1天', short: '1D', hours: 24, intraday: false },
    { id: '3d', label: '3天', short: '3D', hours: 72, intraday: false, tutorial: false },
    { id: '1w', label: '1周', short: '1W', hours: 168, intraday: false, tutorial: false }
  ];
  const DEFAULT_TF = '4h';

  const byId = Object.create(null);
  TIMEFRAMES.forEach(tf => { byId[tf.id] = tf; });
  const tfOf = id => byId[id] || byId[DEFAULT_TF];

  /* 一根 K 线属于哪个桶（返回桶的起点时间戳）。
     1w 的那一行：`(day - 4) % 7` 里的 4 是 **1970-01-01 是星期四** 换来的偏移，
     减去它再取模就落到周一。写成 `% 7` 之后再 +7 再 %7 是为了让负数取模也正确
     （1970 年之前的日期、以及某些时区算出来的负数天）。 */
  function bucketStart(time, tf) {
    if (tf.id === '1w') {
      const day = Math.floor(time / DAY);
      return (day - (((day - 4) % 7) + 7) % 7) * DAY;
    }
    if (tf.id === '3d') {
      const day = Math.floor(time / DAY);
      return Math.floor(day / 3) * 3 * DAY;
    }
    const span = tf.hours * HOUR;
    return Math.floor(time / span) * span;
  }

  /* 把一串基础 K 线聚合成某个周期。
     bars 必须是**按时间升序**的基础 K 线（{o,h,l,c,t}），只喂已揭晓的那些 ——
     这一层不认识「未来数据」这回事，闸门在 core/marketData 那边（[R18]）。
     返回 { tf, bars:[{o,h,l,c,t}], count, bucketOfBar }：
       bucketOfBar[i] 是第 i 根基础 K 线所属的桶下标（图表要用它把光标位置换回大周期那根）。 */
  function resample(bars, tfId) {
    const tf = tfOf(tfId);
    const list = Array.isArray(bars) ? bars : [];
    const n = list.length;
    const out = { tf, bars: [], count: 0, bucketOfBar: new Int32Array(n) };
    if (!n) return out;
    /* 已经是基础周期：不需要聚合，原样返回（但桶是一根一个，所以下标是恒等映射）。
       这一条要保留：4h 那一档是热路径（默认档），别为了「统一」多绕一圈。 */
    const buckets = [];
    const firstBar = [];
    const lastBar = [];
    for (let i = 0; i < n; i++) {
      const b = bucketStart(list[i].t, tf);
      if (!buckets.length || buckets[buckets.length - 1] !== b) { buckets.push(b); firstBar.push(i); }
      lastBar[buckets.length - 1] = i;
      out.bucketOfBar[i] = buckets.length - 1;
    }
    for (let k = 0; k < buckets.length; k++) {
      const a = firstBar[k], z = lastBar[k];
      let hi = -Infinity, lo = Infinity;
      for (let i = a; i <= z; i++) {
        if (list[i].h > hi) hi = list[i].h;
        if (list[i].l < lo) lo = list[i].l;
      }
      out.bars.push({ t: buckets[k], o: list[a].o, h: hi, l: lo, c: list[z].c });
    }
    out.count = out.bars.length;
    return out;
  }

  /* 按 (周期, 数据版本) 缓存。version 由调用方给（行情层的数据版本号）：
     价格被改写、时间推进都会让它变，于是缓存自然作废 —— 不需要谁记得来清。 */
  const cache = { key: '', value: null };
  function frameOf(bars, tfId, version) {
    const key = `${tfId}|${Number(version) || 0}|${Array.isArray(bars) ? bars.length : 0}`;
    if (cache.key === key && cache.value) return cache.value;
    cache.key = key;
    cache.value = resample(bars, tfId);
    return cache.value;
  }

  /* 一根大周期 K 线「走完了没有」：桶的终点 ≤ 最新基础 K 线的时间就是已收盘。
     图上要靠它决定最右那根要不要按「正在走」画（宽度没长满、收盘价跟着抖）。 */
  const isClosed = (bucketT, tf, lastBarT) => Number.isFinite(lastBarT) && bucketT + tf.hours * HOUR <= lastBarT;

  /* 基础 K 线 → 日线（按 UTC 整日分组）。
     聚合口径与 resample() 一模一样：开 = 当日第一根的开、收 = 当日最后一根的收、
     高/低 = 当日最高/最低；桶边界取 UTC 零点。

     为什么要在这里放一份：这个循环原本在两个地方**各写了一遍**
     （core/market/marketData.js 的 dailyBars、modes/story/cycle.js 的 dailyFromBars），
     两份唯一实质差别是前者多带 firstIndex/lastIndex。聚合逻辑复制两份，
     迟早有一边被改动而另一边没跟上 —— 而日线同时喂着「市场状态」与「新闻排片」，
     两边不一致就是个很难查的偏。所以口径只留这一处，多的那两个下标由调用方自己补。 */
  function daily(bars) {
    const list = Array.isArray(bars) ? bars : [];
    const out = [];
    let cur = null;
    for (const b of list) {
      const day = Math.floor(b.t / DAY);
      if (!cur || cur.day !== day) {
        if (cur) out.push(cur.bar);
        cur = { day, bar: { t: day * DAY, o: b.o, h: b.h, l: b.l, c: b.c, v: 0 } };
      } else {
        cur.bar.h = Math.max(cur.bar.h, b.h);
        cur.bar.l = Math.min(cur.bar.l, b.l);
        cur.bar.c = b.c;
      }
    }
    if (cur) out.push(cur.bar);
    return out;
  }

  return {
    /* 导出只留**外面真的会用**的：bucketStart / isClosed / DAY / HOUR 目前只在
       这一份内部用（外部读周期表走 TIMEFRAMES，聚合走 daily / frameOf）。
       留着它们当「公共 API」是自欺 —— 没人调的导出只会让人以为有人在调。 */
    resample: { TIMEFRAMES, DEFAULT_TF, tfOf, resample, frameOf, daily }
  };
});
