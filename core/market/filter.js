/* ============ 行情过滤（避开上线初期那一段） ============
   旧教程页的 market/playback.js 那一套（unlockBaseOf / isAvailable / unavailableReason /
   firstVisibleBase）搬过来。它解决的问题很具体：各交易对**上线初期**的波动极端
   （刚上所的几天经常一天 ±30%），拿那一段教或练都没有意义。

   两个旋钮：
     skipDays   过滤掉开头多少天（0 = 不过滤）
     alignStart 起点口径：true = 所有交易对**统一起点**（从「最晚上线的那一个」算起），
                false = 各自上线起算。统一口径的好处是同一屏上所有品种都「够老」，
                代价是上线早的那些也被砍掉一截。

   ============ 它在哪一层把关 ============
   这一层只回答三个问题（纯函数，不认识 DOM，也不认识任何模式）：
     unlockIndexOf(id)        这个品种从**全局第几根**起才可交易
     isAvailable(id, index)   光标在这一根时它可不可交易
     reasonFor(id, index)     不可交易时，一句话说清为什么
   真正的拦截在 core/engine/marketEngine（下单与挂单各拒一次）与界面层（列表标「过滤中」、
   图表不画过滤期那几根）—— 闸门只有一处判据，别处都是读它。

   ★ 默认 **过滤开头 365 天**（skipDays = 365）。上线初期那一段波动极端，
   拿来教或练都没有意义，所以默认就把它藏掉；设置里的「行情过滤」可以调小或关掉。
   注意它会**挪动存档的起点**（光标按根存，过滤一开就整体后移）。
   故事模式另有自己的起点口径（commonStart，本来就在中间）。 */
CS.define('core/market/filter', ["core/events/events","core/market/marketData","lib/lodash"], function () {
  'use strict';

  const DAY = 86400000;
  const MAX_SKIP_DAYS = 3650;
  const SKIP_PRESETS = [0, 7, 30, 90, 180, 365];

  /* 设置存在这里（一个进程一份）：两个模式共用同一套数据，
     但**是否过滤**是模式自己的事 —— 这里的初值与设置槽的 DEFAULTS.skipDays 对齐（365），
     谁都不显式设过的时候两边判据一致（否则会出现「面板显示 365、引擎按 0 判」）。
     ★ 故事模式会在进模式时把它设成 0（它的起点是 commonStart，本来就在中间）。 */
  let skipDays = 365;
  let alignStart = true;

  const clampDays = v => Math.max(0, Math.min(MAX_SKIP_DAYS, Math.round(Number(v) || 0)));

  function set(options) {
    const o = options || {};
    if (o.skipDays !== undefined) skipDays = clampDays(o.skipDays);
    if (o.alignStart !== undefined) alignStart = !!o.alignStart;
    CS.events.bus.emit('market.filter.changed', { skipDays, alignStart });
    return { skipDays, alignStart };
  }
  const snapshot = () => ({ skipDays, alignStart });

  /* 这个品种「够老」的那一根（**全局**下标）。数据没就绪 / 品种不存在时给 0：
     拿不到数据就不过滤 —— 宁可多显示几根，也不要因为一个取不到的字段把行情全灰掉。 */
  function unlockIndexOf(id) {
    try {
      const s = CS.marketData.seriesRef(id);
      const meta = CS.marketData.getDatasetMeta();
      if (!s || !meta) return 0;
      if (!skipDays) return 0;
      /* 起点口径：统一起点 = 所有品种都上线之后（commonStart 与它自己的上线时刻取晚的）；
         各自上线 = 它自己的上线时刻。`listed` 缺了就退回它的第一根。 */
      const listed = Number.isFinite(s.listed) ? s.listed : s.t0;
      const origin = alignStart && Number.isFinite(meta.commonStart) ? Math.max(meta.commonStart, listed) : listed;
      const unlock = origin + skipDays * DAY;
      return Math.max(s.off, Math.ceil((unlock - meta.start) / s.step));
    } catch (_) { return 0; }
  }
  /* 这个品种**自己的第一根**在全局第几根。数据没就绪时给 0（拿不到就不拦）。 */
  function listedIndexOf(id) {
    try {
      if (typeof CS.marketData.firstIndex === 'function') return CS.marketData.firstIndex(id) || 0;
      const s = CS.marketData.seriesRef(id);
      return s && Number.isFinite(s.off) ? s.off : 0;
    } catch (_) { return 0; }
  }
  /* 光标在这一根时可不可交易。`index` 缺省用行情层的当前下标。
     ★ 除了「行情过滤」那一段，还必须拦**还没上市**的那一段：
     数据集从第一根（2017-08-17）起跑，而 18 个品种里只有 BTC/ETH 那天存在，
     其余 16 个的 `off`（自己的第一根在全局的下标）都是正的。
     旧实现只比 `unlockIndexOf`，而它在 skipDays 为 0 时恒为 0 ——
     于是 skipDays 一关，「未上市」的品种就一路放行：列表显示 `0.00000 / +0.00%`，
     **下单按钮是亮的、真的能开出一笔**，成交价取的是该品种几年后的第一根
     （玩家在图上根本看不到这个价），而持仓浮盈按 0 算。
     判据只有这一处，界面与引擎都读它。 */
  function isAvailable(id, index) {
    const at = Number.isFinite(index) ? index : CS.marketData.nowIndex;
    if (at < listedIndexOf(id)) return false;
    return at >= unlockIndexOf(id);
  }
  /* 不可交易的原因（给界面与拒绝理由共用一句话，两处不会各说各的）。
     ★ 文案里要**点出设置的入口**：玩家看到「这一段不可交易」时的下一个问题一定是
     「那我怎么打开它」—— 只说「已按设置隐藏」等于让人去翻整个设置面板。
     ★ 未上市与「被设置隐藏」是**两件事**，含糊成一句会让玩家去翻设置却找不到开关。 */
  function reasonFor(id, index) {
    const at = Number.isFinite(index) ? index : CS.marketData.nowIndex;
    if (at < listedIndexOf(id)) return '这个交易对还没上市：它的第一根 K 线在更晚的日期，往前推进时间就会出现在列表里。';
    const days = skipDays;
    return days > 0
      ? `已按「行情过滤」隐藏各交易对开头的 ${days} 天行情：这个品种还没走到可交易的那一根（设置⚙ 的「行情过滤」里可以调小或关掉）。`
      : '这一段行情还不可交易';
  }

  return {
    marketFilter: {
      set, snapshot, unlockIndexOf, listedIndexOf, isAvailable, reasonFor,
      get skipDays() { return skipDays; },
      get alignStart() { return alignStart; },
      DAY, MAX_SKIP_DAYS, SKIP_PRESETS
    }
  };
});
