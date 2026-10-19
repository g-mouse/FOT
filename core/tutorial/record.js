/* ============ 新手引导的存档（教学进度，与「钱」分开存） ============
   不进账户存档：账户存档是「钱」，引导进度是「教学进度」，
   「账户重置」应该清空钱、但不该把「学过没学过」改回「没学过」；
   两者混在一份里，迟早会出现「重置账户之后又被拉回去上第一课」。

   形状：
     { v: 4,
       syllabus: 'six-v1',            课表签名（对不上 = 课表改过版 → 从头教一遍）
       off: false,                     **关掉整块引导**（连「照顾」一起）—— 只给自检/探针用
       left: false,                    真的离开过吗（只有那颗 ⏏ 能把它改成 true）
       graduated: false,               课表走完了吗（由「单数 ≥ 课表长度」推出来，见 load）
       trades: [{ side, win, pnl, margin, liquidated, lesson, at }],   最近若干单
       startEquity: 10000,             进入引导那一刻的账户权益（进度条上的权益曲线以它为起点）
       entry: {…} | null,             **手上这一单**的规格（骰子结论、锚价、段长、目标、波动）
       frozen: {…} | null }           **已经钉进历史的那几根** K 线（铺过、又已经结算掉的）

   三个状态，两个开关（都是单向的，谁也不会把谁顺手改掉）：
     left=false, graduated=false   上课：底部那一行说明 + 那颗 ⏏（老师条 / 进度条 2026-10-04 起不画了）
     left=false, graduated=true    自由交易：界面收起来，但课程设置仍生效、行情照样照顾；
                                   想真出去还是按那颗 ⏏
     left=true                     离开：设置解锁还原、行情解锁，只有照顾还留着

    ★ 「毕业」按**当前这份课表**判，不是按当时那一份：
      `graduated` 直接由「已下过的单数 ≥ 课表长度」推出来（见下面 load 里的 done/total）。
      2026-10-19 课表从 10 课长到 12 课、又砍到 6 课：加课时停在旧课数的人不能算毕业；
      减课 / 重排时旧的「第几课」已经对不上，由 syllabus 签名把教学进度整块作废（见 SYLLABUS）。

   `off` 是**第四个开关，只给自检用**：它让整块引导（界面、骰子、价格覆盖层）都不接 ——
   交易逻辑类的探针要的是**没有被引导改过的行情**。注意 `left` 做不到这件事：
   按下 ⏏ 之后照顾是**照旧**的（刻意留的设计），所以「离开」不等于「关掉」。

   两个派生量（不单独存：存了就迟早会与 trades 对不上）：
     · 课表进度 = 已经下过的单数（min 到课数上限）；
     · 「课表走完」也可以由 trades.length 推出来，但显式存一个 graduated 更省事。

   ============ 为什么要存 entry 与 frozen ============
   「切 K 线周期之后直接刷新浏览器，盈亏会瞬间变成一个不一样的数」——
   因为刷新时那次 restore() 是**重新开一段**：重新掷骰子（赢单可能变亏单）、
   重新取锚价（取到的是真实行情在那里的价），于是图上那一段与手上这一单的盈亏都换了一套
   （实测：刷新前 +167.05，刷新后 +317.74）。把这两样存下来之后，
   重开页面就是**照着原样接着铺**：骰子不重掷、锚价不重取、铺过的历史还在 —— 盈亏一个数都不变。 */
CS.define('core/tutorial/record', ["core/tutorial/lessons","lib/lodash"], function () {
  'use strict';

  /* 键名从旧教程页那一套（coinsim-guide-v4）搬过来，仍然认老键并**迁过来**：
     学过的人的进度不该因为换了一版程序就归零。 */
  const KEY = 'cs:tutorial:progress';
  const OLD_KEYS = ['coinsim-guide-v4', 'coinsim-guide-v3', 'coinsim-guide-v2'];
  const TRADE_LOG_MAX = 60;
  const FROZEN_MAX = 600;                 /* 存档里最多留几根铺过的 K 线（够覆盖最近几单） */
  /* ★ 课表签名：课表一改（2026-10-19 从 12 课砍到 6 课）就换一个值。
     旧存档的「第几课」是按**单数**推出来的，课表重排之后那个数对不上新课表：
     10 单在新课表里已经是「全上完」，可那 10 单里根本没做过挂单 / 杠杆。
     所以签名对不上就**从头教一遍**（只保留「离开」与期初权益，见 load 里的迁移）；
     不这样的话，旧玩家会被判成毕业、新的两课永远看不到。 */
  const SYLLABUS = 'six-v1';

  const lessons = () => (CS.tutorialLessons ? CS.tutorialLessons.LESSONS : []) || [];
  const blank = () => ({
    v: 4, syllabus: SYLLABUS, off: false, left: false, graduated: false,
    trades: [], startEquity: 10000, entry: null, frozen: null
  });
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  /* 「手上这一单」的规格：每个数都要能对上价格层要的那几个（见 session 的 begin / applySpec）。
     认不出来的整条丢掉 —— 宁可重新铺一段（老行为），也不要拿半条坏数据去铺价。 */
  function cleanEntry(raw) {
    if (!raw || typeof raw !== 'object' || !raw.id || !Number.isFinite(Number(raw.bar))) return null;
    const entry = {
      id: String(raw.id), pair: String(raw.pair || ''), side: raw.side === -1 ? -1 : 1,
      win: raw.win !== false,
      margin: Math.max(0, num(raw.margin, 0)), leverage: Math.max(1, num(raw.leverage, 1)),
      entry: num(raw.entry, 0), anchor: num(raw.anchor, 0), breakEven: num(raw.breakEven, 0),
      breakEvenGap: num(raw.breakEvenGap, 0), targetRatio: num(raw.targetRatio, 1),
      notional: Math.max(0, num(raw.notional, 0)),
      baseSpan: Math.max(2, Math.round(num(raw.baseSpan, 3))),
      spanBars: Math.max(2, Math.round(num(raw.spanBars, 3))),
      bar: Math.round(num(raw.bar, 0)),
      lessonId: raw.lessonId == null ? null : String(raw.lessonId),
      fundingEstimate: num(raw.fundingEstimate, 0),
      /* 这一段行情当时的市场波动与「图上的 K 线有几根基础线」（段外那条路的步长与尺度）：
         也要照存档来，否则刷新之后重算出来的曲线不同 → 盈亏又变了。
         两个都**保留「存档里没有」这一档**（0 = 没存过），不能填一个看似合理的默认值：
         candleBars 的合理默认是 1，而 1 正好是一个**真的取值**（4h 图就是 1）——
         填了 1 就再也分不出「老存档缺这一项」与「本来就是 1」，刷新时补不回来。
         补的动作在 session 的 resume：按开仓那一刻同一套办法重量一次。 */
      vol: Math.max(0, num(raw.vol, 0)),
      candleBars: Number(raw.candleBars) > 0 ? Math.max(1, Math.round(Number(raw.candleBars))) : 0
    };
    if (!(entry.anchor > 0) || !(entry.targetRatio > 0)) return null;
    return entry;
  }
  /* 已经钉进历史的那几根：绝对下标 + 四个价，逐根对齐（长度对不上就整条丢掉） */
  function cleanFrozen(raw) {
    if (!raw || typeof raw !== 'object' || !raw.pair || !Array.isArray(raw.from)) return null;
    const len = raw.from.length;
    if (!len || len > FROZEN_MAX) return null;
    const list = key => {
      const source = raw[key];
      if (!Array.isArray(source) || source.length !== len) return null;
      const out = source.map(v => num(v, 0));
      return out.every(v => v > 0) ? out : null;
    };
    const o = list('o'), h = list('h'), l = list('l'), c = list('c');
    if (!o || !h || !l || !c) return null;
    return { pair: String(raw.pair), from: raw.from.map(v => Math.round(num(v, -1))), o, h, l, c };
  }

  /* 读存档。任何一处对不上（被手改、半路断电写坏）就当成一份干净的记录 ——
     引导进度坏掉不该让页面起不来，最坏的结果是「再教一遍」。
     老版本一律迁成 left:false：那时候「退出教程」是个假出口，读老档的人其实从没真正离开过。 */
  function load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!saved) {
        for (const old of OLD_KEYS) {
          const raw = localStorage.getItem(old);
          if (!raw) continue;
          const prev = JSON.parse(raw);
          if (prev && typeof prev === 'object') saved = prev;
          break;
        }
      }
    } catch (_) { saved = null; }
    if (!saved || typeof saved !== 'object') return blank();
    /* 课表改版：旧进度是按旧课表的单数推的，在新课表上没有意义 —— 从头教一遍。
       只保留两个跟「课表」无关的开关：left（明确离开的人不该被拉回来）与 off（自检）。
       期初权益也保留：它是账户口径，不是教学进度。 */
    if (saved.syllabus !== SYLLABUS) {
      const fresh = blank();
      fresh.left = saved.v === 4 ? !!saved.left : false;
      fresh.off = !!saved.off;
      const equity = Number(saved.startEquity);
      if (Number.isFinite(equity) && equity > 0) fresh.startEquity = equity;
      /* 立刻落盘：不写回去的话，下一次 load 还会从旧档再迁一遍（结果一样，但旧成绩一直留着） */
      try { localStorage.setItem(KEY, JSON.stringify(fresh)); } catch (_) {}
      return fresh;
    }
    const trades = Array.isArray(saved.trades)
      ? saved.trades.filter(t => t && (t.side === 1 || t.side === -1) && Number.isFinite(Number(t.pnl)))
        .map(t => ({
          side: t.side === -1 ? -1 : 1, win: !!t.win, pnl: Number(t.pnl) || 0,
          margin: Math.max(0, Number(t.margin) || 0), liquidated: !!t.liquidated,
          lesson: t.lesson == null ? null : String(t.lesson), at: Number(t.at) || 0
        })).slice(-TRADE_LOG_MAX)
      : [];
    const startEquity = Number(saved.startEquity);
    /* 「毕业」= 已经把**当前这份课表**的单数都做完（由单数推，不单独信任存档里那一位）。
       这样课表加课之后，停在旧课数的人不会被当成毕业；减课之后，做超了的人也不会被拉回课表。
       2026-10-19 的两轮改课（10 → 12 → 6）各有一条回归：见 docs/FIXES_2026-10-19.md 第九、十节。 */
    const done = trades.length;
    const total = lessons().length;
    return {
      v: 4, syllabus: SYLLABUS,
      /* 旧档（v2/v3）没有真正离开过：一律迁成 left:false；只有 v4 的 left 才认 */
      left: saved.v === 4 ? !!saved.left : false,
      off: !!saved.off,
      graduated: done >= total,
      trades, startEquity: Number.isFinite(startEquity) && startEquity > 0 ? startEquity : 10000,
      entry: cleanEntry(saved.entry), frozen: cleanFrozen(saved.frozen)
    };
  }
  function save(record) {
    try {
      const payload = { ...record, trades: record.trades.slice(-TRADE_LOG_MAX) };
      /* 存档写不下（配额）时先丢「铺过的历史」再试一次：进度与这一单的规格要紧得多 */
      try { localStorage.setItem(KEY, JSON.stringify(payload)); }
      catch (_) { localStorage.setItem(KEY, JSON.stringify({ ...payload, frozen: null })); }
    } catch (_) {}
  }
  /* 只给「从头再学一遍」与自检用：把引导进度彻底忘掉（＝当作从没学过）。
     会连老档一起清掉 —— 留着它下次会被迁回来，等于没清。 */
  function resetRecord() {
    try { localStorage.removeItem(KEY); OLD_KEYS.forEach(k => localStorage.removeItem(k)); } catch (_) {}
  }

  return {
    tutorialRecord: { KEY, OLD_KEYS, TRADE_LOG_MAX, FROZEN_MAX, blank, load, save, resetRecord, cleanEntry, cleanFrozen }
  };
});
