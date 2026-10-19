/* ============ 时钟端口：4h K 线 / 日 / 周 / 月同一节拍（§2.1） ============
   时间以月为叙事单位、日/周为交易单位，与行情回放共用同一个 tick。
   数据集是 4h K 线，日历是 UTC 日界：**推进一天 = 揭晓 6 根 4h K 线**。
   推进顺序是硬要求，不能乱（§2.1）：
     月首 → 结算 → 新闻滴灌 → 邮件投递 → 交易 → 事件检查 → 执念阶段检查 → 结局检查
   所以时钟只负责「到点了喊一声」，谁先谁后由 story/mode.js 订阅时的注册顺序与
   显式阶段表决定，时钟自己不编排业务。

   ============ 为什么计数器是「一根 K 线」而不是「一天」============
   交易是逐根 4h K 线发生的（资金费每 8 小时一期、影线扫到强平价就结算），
   所以最小节拍必须是**一根 K 线**：推进 4 小时与推进一天的差别不是「快慢」，
   而是「结算了几次」—— 一天结算一次的话，日内那几根 K 线的影线永远扫不到强平价。

   于是内部只有一个 `barIndex` 计数器，`dayIndex` 由它整除得出（barIndex = day*6 + 日内第几根）。
   日界只做一件事：把这一天的业务（新闻滴灌、邮件投递、事件检查、月末结算）
   在**跨过 UTC 日界的那一根**上跑一次，顺序与从前逐字相同；
   日内那五根只推进行情（结算资金费 / 撮合挂单 / 判定强平）。

   两个入口，同一套循环：
     advance(days)      —— 「推进一周 / 推进一个月」按钮与页面内工具走它（一天 = 6 根）；
     advanceBars(bars)  —— 空格键那一步走它（一步 = 1 根 4h K 线）。 */
CS.define('core/engine/clock', ["core/market/marketData"], function () {
  'use strict';

  const BARS_PER_DAY = 6;   // 4h × 6
  const HOUR = 3600000;

  function create(options) {
    const opts = options || {};
    const startMs = opts.startMs != null ? opts.startMs : Date.UTC(2020, 9, 15);
    const barsPerDay = opts.barsPerDay || BARS_PER_DAY;
    const startDate = new Date(startMs);
    let startYear = startDate.getUTCFullYear();
    let startMonth = startDate.getUTCMonth();

    /* barIndex 是唯一的计数器（从历元起的第几根 4h K 线），dayIndex 是它的商。
       cursorBarOf(id) 那种逐交易日错开的上线时刻不在这里管 —— 那是 marketEngine 的事。 */
    const state = { barIndex: 0, speed: opts.speed == null ? 1 : opts.speed, running: false, paused: false };
    const dayHandlers = [];
    const weekHandlers = [];
    const monthHandlers = [];
    const tickHandlers = [];
    let advancing = false;
    const queue = [];

    const dayIndex = () => Math.floor(state.barIndex / barsPerDay);
    const slotOfDay = () => state.barIndex % barsPerDay;
    function dateOf(days) { return new Date(startMs + days * 86400000); }
    function monthIndexOf(date) { return (date.getUTCFullYear() - startYear) * 12 + (date.getUTCMonth() - startMonth); }

    function now() {
      const day = dayIndex();
      const d = dateOf(day);
      return {
        /* barIndex —— 从历元起的第几根 K 线（0 基）；slotOfDay —— 这一天里的第几根（0..5） */
        barIndex: state.barIndex,
        slotOfDay: slotOfDay(),
        barsPerDay,
        hour: slotOfDay() * (24 / barsPerDay),
        dayIndex: day,
        date: d.toISOString().slice(0, 10),
        dateObj: d,
        monthIndex: monthIndexOf(d),
        monthLabel: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
        year: d.getUTCFullYear(),
        dayOfMonth: d.getUTCDate(),
        weekIndex: Math.floor(day / 7)
      };
    }

    function reveal() {
      const t = now();
      if (CS.marketData && CS.marketData.ready) CS.marketData.setNowIndex(t.barIndex);
      return t;
    }

    function emitAll(topic, payload) {
      const list = topic === 'day' ? dayHandlers : topic === 'week' ? weekHandlers : topic === 'month' ? monthHandlers : tickHandlers;
      for (const fn of list.slice()) {
        try { fn(payload); } catch (error) {
          CS.errors.push({ message: `clock ${topic} 订阅者抛错：${error && error.message}`, stack: error && error.stack });
        }
      }
    }

    function stepOneDay() {
      const before = now();
      state.barIndex = (dayIndex() + 1) * barsPerDay;   /* 跳到下一天的同一格（= 跨过日界那一根） */
      const after = reveal();
      /* 通配的 tick 每根 bar 都响一次（图表/播放用），
         day / week / month 只在边界响（叙事用）。 */
      emitAll('tick', after);
      emitAll('day', { t: after, prev: before, crossedMonth: after.monthIndex !== before.monthIndex, crossedWeek: after.weekIndex !== before.weekIndex });
      if (after.weekIndex !== before.weekIndex) emitAll('week', after);
      if (after.monthIndex !== before.monthIndex) emitAll('month', { t: after, monthIndex: after.monthIndex });
      return after;
    }
    /* 走一根 4h K 线。**日内那一格不喊 day** —— 喊了的话新闻、邮件、事件检查
       一天要跑 6 遍（邮件的 perTick 限流当场失效、事件去重也白做）。
       日界那一根喊 day / week / month，顺序与从前逐步走一天时逐字相同。 */
    function stepOneBar() {
      const before = now();
      state.barIndex++;
      const after = reveal();
      const crossedDay = dayIndex() !== Math.floor(before.barIndex / barsPerDay);
      emitAll('tick', after);
      if (!crossedDay) return after;
      emitAll('day', { t: after, prev: before, crossedMonth: after.monthIndex !== before.monthIndex, crossedWeek: after.weekIndex !== before.weekIndex });
      if (after.weekIndex !== before.weekIndex) emitAll('week', after);
      if (after.monthIndex !== before.monthIndex) emitAll('month', { t: after, monthIndex: after.monthIndex });
      return after;
    }

    /* 一次推进 N 根 K 线（手动按一下、或自动播放的一拍）。
       让出主线程的时机：**每个跨过的日界让一次**，不是每根都让。
       每根都 sleep 的话，「推进一个月」（180 根）要花 180 × 120ms ≈ 22 秒 ——
       玩家点一下要盯着屏幕看完这段等待，而它本来只是为了让自动播放看得见逐日在走。 */
    async function advanceBars(bars) {
      const n = Math.max(1, Math.round(Number(bars) || 1));
      if (advancing) {
        /* 重入保护：自动播放与手动点「前进」撞在一起时排队，不并发推进 */
        return new Promise(resolve => queue.push({ n, resolve, bars: true }));
      }
      advancing = true;
      /* ★ 每一次「显式推进」都先把暂停标志清掉。
         早期循环里只有 `if (state.paused) break;`，而 pause() 的唯一调用方是
         story/mode.js 的 advance()，它**从不配对 resume()** —— 于是：
           第一次推进跑到一半被 pause → 循环 break → 时钟永远停在暂停态；
           之后每次点「推进一周 / 推进一个月」都立刻 break、一天都不走，
           而界面的等待循环死等不到月份变化，看起来就是**整个页面卡死**。
         暂停的语义是「停下正在进行的自动播放」，不该让用户主动点的推进变成空转。
         需要「能被打断」的调用方应当自己检查 paused 后 return，而不是依赖 advance 空转。 */
      state.paused = false;
      try {
        let last = now();
        for (let i = 0; i < n; i++) {
          last = stepOneBar();
          /* 倍速只影响观感，不影响结算顺序与结果（验收要的「跳只影响展示」） */
          if (last.slotOfDay === 0) {
            const delay = delayForSpeed(state.speed);
            if (delay > 0) await sleep(delay);
            else await sleep(0);
          }
        }
        return last;
      } finally {
        advancing = false;
        if (queue.length) {
          const job = queue.shift();
          (job.bars ? advanceBars(job.n) : advance(Math.round(job.n / barsPerDay) || 1)).then(job.resolve);
        }
      }
    }

    /* 推进一天 = 6 根（保留从前的语义：显式推进**总是**先清掉暂停标志）。
       暂停的语义是「停下正在进行的自动播放」，不该让用户主动点的推进变成空转。 */
    async function advance(days) {
      const n = Math.max(1, Math.round(Number(days) || 1));
      return advanceBars(n * barsPerDay);
    }

    function delayForSpeed(speed) {
      const s = Number(speed) || 1;
      if (s <= 0) return 0;
      return Math.max(0, Math.round(120 / s));
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    /* 目标可以是「第几天」（次数 ≤ 6 时按天算，兼容老调用），也可以是「第几根」——
       两种写法分开成 advanceTo / advanceToBar，别在一个函数里猜单位。 */
    function advanceTo(targetDayIndex) {
      const target = Math.max(0, Math.round(Number(targetDayIndex) || 0));
      const delta = target - dayIndex();
      return delta <= 0 ? Promise.resolve(now()) : advance(delta);
    }
    function advanceToBar(targetBarIndex) {
      const target = Math.max(0, Math.round(Number(targetBarIndex) || 0));
      const delta = target - state.barIndex;
      return delta <= 0 ? Promise.resolve(now()) : advanceBars(delta);
    }

    reveal();

    return {
      now, advance, advanceBars, advanceTo, advanceToBar, dateOf, monthIndexOf,
      onTick: cb => { tickHandlers.push(cb); return () => { const i = tickHandlers.indexOf(cb); if (i >= 0) tickHandlers.splice(i, 1); }; },
      onDay: cb => { dayHandlers.push(cb); return () => { const i = dayHandlers.indexOf(cb); if (i >= 0) dayHandlers.splice(i, 1); }; },
      onWeek: cb => { weekHandlers.push(cb); return () => { const i = weekHandlers.indexOf(cb); if (i >= 0) weekHandlers.splice(i, 1); }; },
      onMonth: cb => { monthHandlers.push(cb); return () => { const i = monthHandlers.indexOf(cb); if (i >= 0) monthHandlers.splice(i, 1); }; },
      speed: { get: () => state.speed, set: x => { state.speed = Number(x) || 1; return state.speed; } },
      pause() { state.paused = true; },
      resume() { state.paused = false; },
      get paused() { return state.paused; },
      get dayIndex() { return dayIndex(); },
      get barIndex() { return state.barIndex; },
      get barsPerDay() { return barsPerDay; },
      /* 一根 K 线代表多少毫秒（时间线上的刻度）：4h 数据集下就是 HOUR×4 */
      barMs: Math.round(86400000 / barsPerDay),
      /* 存档用：只存「第几根 + 速度 + 历元」，不存 Date（换时区/换机器的读档要一致）。
         ★ startMs 必须进存档：barIndex 只有在同一个历元下才能还原成同一天。
         早期只存 dayIndex，而历元是从数据集现算的（getDatasetMeta().commonStart），
         那条链一旦缺字段就会退回默认起点 —— 读档时同一个 dayIndex 被解释成完全
         不同的日期，monthIndex 与存档里的值对不上，表现是「刷新之后月份归零」。
         ★ v2 之前存的是 `dayIndex`（第几天）：读老档时乘 barsPerDay 迁到新刻度，
         否则老存档会被解释成「第 0 天的第 dayIndex 根」—— 月份直接归零。 */
      serialize: () => ({ v: 2, barIndex: state.barIndex, dayIndex: dayIndex(), speed: state.speed, startMs }),
      restore(snapshot) {
        if (!snapshot) return now();
        if (Number.isFinite(snapshot.startMs) && snapshot.startMs !== startMs) {
          /* 历元不一致 = 这条存档的日子无法按当前历元还原。这里静默接受会得到
             「看起来读档成功、其实日期全错」，所以必须显式留痕让 dev 面板与探针看得到。 */
          if (CS.errors) {
            CS.errors.push({
              message: `时钟历元与存档不一致（存档 ${snapshot.startMs} / 当前 ${startMs}）：日期与月份可能错位，已按存档历元还原`
            });
          }
          startMs = snapshot.startMs;
          const d0 = new Date(startMs);
          startYear = d0.getUTCFullYear();
          startMonth = d0.getUTCMonth();
        }
        const rawBar = Number(snapshot.barIndex);
        const rawDay = Number(snapshot.dayIndex);
        state.barIndex = Number.isFinite(rawBar) && rawBar >= 0
          ? Math.round(rawBar)
          : (Number.isFinite(rawDay) && rawDay >= 0 ? Math.round(rawDay) * barsPerDay : 0);
        if (Number.isFinite(snapshot.speed)) state.speed = snapshot.speed;
        return reveal();
      },
      reveal,
      BARS_PER_DAY: barsPerDay,
      HOUR
    };
  }

  return { clock: { create, BARS_PER_DAY } };
});
