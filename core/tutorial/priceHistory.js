/* ============ 「已经钉进历史的那几根」：冻结、回接、随存档走 ============
   从这里往下都是**收尾那一半**：一段行情走完（玩家平仓）之后怎么把它留在图上，
   以及刷新页面之后怎么把它还回去。铺价那一半在 core/tutorial/priceOverlay.js。

   用户报的：「教程模式里面……一旦平仓图表就会变」。以前只冻结**平仓那一根**，
   而且顺序还是反的：先撤 spec（重铺立刻把整段还原成原始行情），再冻结那一根 ——
   读到的已经是被还原之后的价，等于什么都没留下。于是平仓那一下，
   玩家盯了半天的那几根 K 线**当场变回真实行情**：方向、颜色、影线全变了，
   而他刚刚才按着图上的价成交（结算记录里那个平仓价在图上再也找不到了 —— 图在说谎）。

   ============ 两件事，顺序不能反 ============
   一、freeze()  把这一段铺过的每一根都抄进快照（就是重铺刚刚写下去的那些数，含影线）——
       抄完再撤 spec，重铺用空 spec 算出来的结果与刚才**逐根相同**，平仓那一刻图上不动；
   二、bridge()  段尾**回接**：把「冻结下来的收」与「原始行情在那儿的价」之间的差摊到后面几根上。
       不回接的话，下一根的真实价还是老行情的价，与冻结下来的收差出百分之几就是图上一道跳空。

   ============ 为什么要存进引导存档（record.frozen）============
   冻结写进的是内存里的一份快照，刷新页面就没了：引导铺过的那几根会变回真实行情，
   图会变、下一单的起点也会变。所以这里把「改过哪几根」记成区间，交给 session 存进引导存档，
   重开页面时再**还回** series（adoptFrozen）。为什么不连快照一起存：那是整条序列（两万根），
   存不下 —— 只存改过的那几根。 */
CS.define('core/tutorial/priceHistory', ["core/market/marketData","core/tutorial/favorMath","core/tutorial/priceOverlay"], function () {
  'use strict';

  const P = CS.tutorialPrice;
  const M = CS.tutorialFavorMath;
  const { num } = M;

  /* 账本按**交易对**分开记（pair → [{ from, to }]，绝对下标，按写入顺序合并）。
     为什么要按 pair 分：一份存档只能装一个交易对的几根（快照里带着 pair），
     而账本是**跨单累积**的 —— 铺过 A 又去铺 B 时，A 的下标会被当成 B 的下标读出来
     （写进快照的就是另一个交易对的价）。分开之后，快照只交 base.pair 那一段的账。 */
  const frozenRanges = new Map();
  const FROZEN_KEEP = 600;         /* 存档里最多留几根（与 record.js 的 FROZEN_MAX 对齐） */

  const live = pair => (pair ? CS.marketData.seriesRef(pair) : null);
  const seriesIndex = (s, globalIndex) => globalIndex - s.off;

  const rangesOf = (pair, create) => {
    if (!pair) return [];
    let list = frozenRanges.get(pair);
    if (!list && create) { list = []; frozenRanges.set(pair, list); }
    return list || [];
  };
  /* 一段并进账本：挨着/重叠的并成一段（段的边界每走一根就变一次，不合并会碎成几千段） */
  function pushFrozen(list, from, to) {
    const last = list[list.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else list.push({ from, to });
  }
  /* 只留最近的 FROZEN_KEEP 根：从最早的那一段开始丢，丢完为止。
     新铺的与「从存档还回来的」两处都走它 —— 上限只写一次。

     **一段长历史也要裁**：引导一路铺下去时相邻的区间会**并成一段**（每一单的段尾回接
     正好接上下一单的起点），于是它迟早变成孤零零的一段、比上限还长，裁剪一次都不发生。
     后果不是「多存了几根」那么轻：record.js 的 cleanFrozen 见到长度 > 600 就把
     **整份历史判废**，玩家看过的所有铺价在下次刷新时一次全没。 */
  function trimFrozen(list) {
    let total = list.reduce((sum, r) => sum + (r.to - r.from + 1), 0);
    while (total > FROZEN_KEEP && list.length) {
      const first = list[0];
      const drop = Math.min(total - FROZEN_KEEP, first.to - first.from + 1);
      first.from += drop; total -= drop;
      if (first.from > first.to) list.shift();
    }
  }
  function markFrozen(from, to) {
    const base = P.internals.base();
    if (!base.pair) return false;           /* 还没抄过行情（没有快照）时没有账可记 */
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return false;
    const list = rangesOf(base.pair, true);
    pushFrozen(list, from, to);
    trimFrozen(list);
    return true;
  }

  /* ============ 段尾的回接 ============
     把冻结价与原始行情之间的差**摊到后面几根**上，走几根就回到原来的路径。
     为什么不用「整段平移」：那会把后面所有 K 线的绝对价位一起改掉（它们本来就该沿自己的路走）。
     回接要走多少根**看差多少**：1% 的差走 8 根（约 32 小时，每根 0.12%），
     差到 10% 就走满 48 根（8 天，每根 0.2%）—— 不然一个骑了十来天的仓位
     会在两天里硬生生窜回真实价位，那比一条跳空还像假的。 */
  const BRIDGE_BARS = 8, BRIDGE_MAX = 48, BRIDGE_UNIT = 0.01;
  const bridgeBarsOf = diff => Math.max(BRIDGE_BARS, Math.min(BRIDGE_MAX, Math.round(BRIDGE_BARS * diff / BRIDGE_UNIT)));
  function bridge(exit, engineClose) {
    const base = P.internals.base();
    /* ★ 回接改的是**快照**（base.store），不是 series —— 这一条是搬的时候踩过的：
       旧实现里 `bridge` 动的是 `base.s`，而 live 上的那一段要到调用方 `priceSet(null)`
       触发重铺时才从快照抄回去。写成「直接改 live」的话，紧接着的那次重铺会把 live
       整段盖回快照里的旧值 —— 回接白白丢掉，段尾仍然是一道跳空（而且不报错）。
       所以顺序是：freeze 把 live 抄进快照 → bridge 就地改快照 → 调用方 clear() 重铺回 live。 */
    const store = base.store;
    if (!store) return false;
    const frozen = store.c[exit];
    if (!(engineClose > 0) || !(frozen > 0)) return false;
    const factor = frozen / engineClose;
    if (Math.abs(factor - 1) < 1e-6) return false;
    const bars = bridgeBarsOf(Math.abs(factor - 1));
    for (let m = 1; m <= bars; m++) {
      const i = exit + m;
      if (i >= store.c.length) break;
      const weight = 1 - M.smooth(m / (bars + 1));              /* 1 → 0：越走越接近原始行情 */
      const r = 1 + (factor - 1) * weight;
      store.o[i] *= r; store.h[i] *= r; store.l[i] *= r; store.c[i] *= r;
      /* 缩放之后重接一次开盘价：价格连续（每一根的开 = 上一根的收），影线跟着夹一下 */
      const open = store.c[i - 1];
      store.o[i] = open;
      store.h[i] = Math.max(store.h[i], open, store.c[i]);
      store.l[i] = Math.min(store.l[i], open, store.c[i]);
    }
    markFrozen(exit + 1, Math.min(store.c.length - 1, exit + bars));
    return true;
  }

  /* ============ 冻结：把这一段照玩家看到的样子留在图上 ============
     只冻结**光标走到的那一根为止**（不是 lastOf 那么多）：玩家的这一段到这儿就结束了，
     后面那几根（如果这一段还没铺满）该还给行情本身 ——
     不然「保护」会跟着一单延续到他没参与的未来。 */
  function freeze() {
    const P0 = P.internals;
    const spec = P0.spec();
    const base = P0.base();
    const store = base.store;
    const s = live(base.pair);
    if (!spec || !store || !s) return false;
    const B = s.bars;
    if (B.length !== store.c.length) return false;
    const e = spec.index - s.off;
    if (e < 0 || e >= B.length) return false;
    const reached = Math.max(0, Math.round(P0.writeEndOf(spec) - spec.index));
    const last = Math.min(P0.lastOf(spec), reached, B.length - 1 - e);
    const exit = e + last;
    const engineClose = store.c[exit];              /* 回接的基准：本来该是那个价 */
    for (let k = 0; k <= last; k++) {
      const i = e + k;
      store.o[i] = B[i].o; store.h[i] = B[i].h; store.l[i] = B[i].l; store.c[i] = B[i].c;
    }
    markFrozen(spec.index, spec.index + last);
    bridge(exit, engineClose);
    return true;
  }

  /* 存档用的一份（区间展平成逐根）：快照里存的就是「玩家看到的那几个价」，直接抄 */
  function frozenSnapshot() {
    const base = P.internals.base();
    const store = base.store;
    const list = rangesOf(base.pair);
    if (!store || !list.length) return null;
    const from = [], o = [], h = [], l = [], c = [];
    list.forEach(range => {
      for (let g = range.from; g <= range.to; g++) {
        const i = g - store.off;
        if (i < 0 || i >= store.c.length) continue;
        from.push(g); o.push(store.o[i]); h.push(store.h[i]); l.push(store.l[i]); c.push(store.c[i]);
      }
    });
    return from.length ? { pair: base.pair, from, o, h, l, c } : null;
  }

  /* 重开页面时把上一次铺过的历史还回 series（在价格层第一次 capture 之前调）。
     还回去之后它就与「行情本身」一样，重铺与 capture 都会原样保留它。

     **还回来的这几根必须一起记进账本** —— 这是用户报的「刷新之后 K 线也是完全不一样」的根：
     账本是「这份快照里有哪些根被引导改过」的账，frozenSnapshot() 只照它交出快照。
     原来这里只把价写回 series、不记账，于是**这一页上再平一单**时，
     存档里就只剩下「本页新标记的那几根」：上一次还回来的那一段被静默丢掉。
     注意它**不是「只在教程里」的问题**：按下那颗 ⏏ 之后照顾照旧，
     所以教程结束之后开的单同样会走这条路。 */
  function adoptFrozen(saved) {
    if (!saved || !saved.pair || !Array.isArray(saved.from)) return false;
    const s = live(saved.pair);
    if (!s) return false;
    const B = s.bars;
    const adopted = [];                    /* 真的写回去的那几根（绝对下标，按存档里的顺序） */
    for (let k = 0; k < saved.from.length; k++) {
      const g = Math.round(num(saved.from[k], -1));
      const i = seriesIndex(s, g);
      if (i < 0 || i >= B.length) continue;
      if (!(saved.o[k] > 0) || !(saved.h[k] > 0) || !(saved.l[k] > 0) || !(saved.c[k] > 0)) continue;
      B[i].o = saved.o[k]; B[i].h = saved.h[k]; B[i].l = saved.l[k]; B[i].c = saved.c[k];
      adopted.push(g);
    }
    if (!adopted.length) return false;
    /* 账本整份换成「存档里这一份」：存档只带一个交易对的一段历史，其余的一律作废 */
    frozenRanges.clear();
    const list = rangesOf(saved.pair, true);
    adopted.forEach(g => pushFrozen(list, g, g));      /* 挨着的自动并成一段 */
    trimFrozen(list);
    P.invalidate();
    return true;
  }
  /* 忘掉铺过的历史（账户重置 / 从头再学一遍用）：把 series 从原始数据重新长一遍 */
  const forgetFrozen = () => { frozenRanges.clear(); };
  /* 只给自检用：账本此刻记着几根 */
  const frozenCount = () => {
    let total = 0;
    frozenRanges.forEach(list => list.forEach(r => { total += r.to - r.from + 1; }));
    return total;
  };

  return {
    tutorialPriceHistory: {
      freeze, bridge, frozenSnapshot, adoptFrozen, forgetFrozen, markFrozen, trimFrozen,
      FROZEN_KEEP, frozenCount
    }
  };
});
