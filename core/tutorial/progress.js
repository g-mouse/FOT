/* ============ 引导的进度：存档 + 成绩 + 课表指针 ============
   「走到第几课了、赢了几单、这一局从多少权益开始」—— 全是**由成绩推出来的**读数，
   加上那一份存档的读写口。搬到单独一个文件里的理由只有一个：**当时**的单文件上限是 400 行
   （core/tutorial/session.js 是状态机，它只该管「什么时候开合」，不该管「怎么记账」）。

   三条口径（都在这里，别处不再各写一份）：
     · **课表指针由已下过的单数推出来**，不单独存 —— 存了就迟早会与成绩对不上；
     · 「还在上课」= 没按过 ⏏（left）**且**课表没走完（graduated），两个开关互不影响；
     · 讲解文案的挑选**不用 Math.random**：挑选结果会进存档，
       用随机数挑就做不了逐字节回归比对（同一个 salt 永远给同一句）。 */
CS.define('core/tutorial/progress', ["core/tutorial/favor","core/tutorial/lessons"], function () {
  'use strict';

  const LESSONS = CS.tutorialLessons;
  const F = CS.tutorialFavor;

  function create() {
    let record = CS.tutorialRecord.load();

    /* 一次成绩：只记引导经手的那些单（session 对得上 id 才调它），
       真实交易的单子不混进引导的成绩里 —— 那是两本账。 */
    function pushTrade(result) {
      record.trades.push({
        side: result.side, win: !!result.win, pnl: Math.round(result.pnl * 100) / 100,
        margin: Math.round((result.margin || 0) * 100) / 100, liquidated: !!result.liquidated,
        lesson: result.lessonId || null, at: Date.now()
      });
      if (record.trades.length > CS.tutorialRecord.TRADE_LOG_MAX) {
        record.trades.splice(0, record.trades.length - CS.tutorialRecord.TRADE_LOG_MAX);
      }
    }
    const pickCopy = (list, salt) => {
      if (!list || !list.length) return undefined;
      let h = Math.imul(((Number(salt) | 0) || 0) ^ 0x9e3779b9, 0x85ebca6b);
      h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
      h ^= h >>> 16;
      return list[(h >>> 0) % list.length];
    };
    const lessonIndex = () => Math.min(LESSONS.LESSONS.length, record.trades.length);
    const lessonAt = index => (index >= 0 && index < LESSONS.LESSONS.length ? LESSONS.lessonAt(index) : null);
    /* 还在上课吗：没按过 ⏏、课表也没走完、**而且指针真的指着一课**。
       最后那一条是 2026-10-19 补的：存档若「单数做满 12、graduated 却是 false」
       （比如在 pushTrade 与 graduate 之间断电），前两条会同时成立，
       但 lesson() 已经是 null —— 界面就会进入「uiVisible 为真、却无话可画」的空转状态。 */
    const inLessons = () => !record.left && !record.graduated && lessonIndex() < LESSONS.LESSONS.length;

    return {
      get record() { return record; },
      /* 「从头再学一遍」会把存档整份清掉，所以要能从盘上重新读一份 */
      reload() { record = CS.tutorialRecord.load(); return record; },
      persist: () => CS.tutorialRecord.save(record),
      trades: () => record.trades,
      tally: () => F.tallyOf(record.trades),
      pushTrade, pickCopy,
      lessonIndex, lessonAt,
      lesson: () => lessonAt(lessonIndex()),
      totalLessons: () => LESSONS.LESSONS.length,
      lessonList: () => LESSONS.lessonList(),
      inLessons, leftForReal: () => !!record.left, graduated: () => !!record.graduated,
      startEquity: () => (Number.isFinite(record.startEquity) ? record.startEquity : 10000)
    };
  }

  return { tutorialProgress: { create } };
});
