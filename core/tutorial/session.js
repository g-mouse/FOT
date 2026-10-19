/* ============ 新手引导的状态机：上课 → （按下 ⏏ 之后）自由交易 ============
   这一层是引导的「大脑」：记住走到哪儿了、决定下一句话说什么、什么时候开合价格覆盖层。
   它**不认识 DOM，也不认识任何模式** —— 界面、控件锁、下单入口、时钟都由模式经 ctx 注入
   （见文件末尾把 ctx 递进来的那一段）。改界面不用动这一层，改课时不用动这一层。

   ★ 「手上这一单长什么样」（走多久 / 目标在哪 / 怎么写进价格层）在 core/tutorial/entry.js，
     这一层只管**课表走到哪儿了**：开仓 → 推进 → 平仓 → 毕业 → 离开。

   ============ 两个阶段，只有一个开关：record.left ============
     left = false（默认）「上课」：跟做 6 单（前 4 单多空，最后两课讲挂单与杠杆）。
                              那颗 ⏏ 一直露着，底部一直有一行「现在该做什么」。
     left = true        「自由交易」：按下 ⏏ 之后。**整块引导界面都收起来**，
                              但骰子与行情照顾照旧跑 —— 玩家看到的就是一个正常的模拟器。
   为什么「自由交易」之后还照顾：这就是这套设计的目的 —— 首次打开程序的人，
   在真正学会之前不会撞上真实行情。出口只有一个（⏏），所以「上课」对所有人都是默认的。
   想重新上课：设置⚙️ →「从头再学一遍」（resetProgress + start）。

   一单的生命周期（两个阶段共用同一条路）
     begin()   开仓之后：停抖动、取锚价、掷骰子（80%）、按结论算目标、铺一段行情。
     watch()   玩家点「前进」时问一句：走到该走的那一根了吗？
     settle()  平仓之后：记一笔成绩、给一句点评、推进课表（上课阶段）；
               **平仓这件事发生在账户侧**，这里是被 account.positionClosed 事件叫醒的。

   ============ 与旧实现（game/js/tutorial/guide/session.js）的三处形状差异 ============
    1) 持仓形状：新引擎是 { id, instrumentId, side:'long'|'short', entryPrice, margin, leverage,
       notional, feesPaid, fundingPaid }；引导内部仍然用 side = 1|-1（价格方向那套）。
    2) 锚价取**实际成交价**（pos.entryPrice），不取「此刻的当前价」：新引擎的市价单会叠一点滑点，
       取展示价的话锚与成交价差一点，重铺之后那一根的收就不是玩家拿到手的那个数。
    3) 时间换算问 entry 那一层（baseStepHours / timeframeHours / stepBars），不读引擎内部状态。 */
CS.define('core/tutorial/session', ["core/base/money","core/market/marketData","core/tutorial/copy","core/tutorial/entry","core/tutorial/openTrade","core/tutorial/priceHistory","core/tutorial/priceOverlay","core/tutorial/progress","core/tutorial/record","core/tutorial/sessionSettings","core/tutorial/tune","lib/lodash"], function () {
  'use strict';

  const TUNE = CS.tutorialTune.TUNE;
  const COPY = CS.tutorialCopy.COPY;
  const P = CS.tutorialPrice;
  const H = CS.tutorialPriceHistory;

  const sideOf = pos => (pos && (pos.side === 'short' || pos.side === -1) ? -1 : 1);
  const money = v => CS.money.format(Math.round(v), 'USD');
  const signed = v => (v >= 0 ? '+' : '−') + money(Math.abs(v));

  function create(ctx) {
    /* 教学进度（存档 + 成绩 + 课表指针）在 core/tutorial/progress.js；
       这一层只留「这一局此刻在干什么」的那一份会话状态。 */
    const G = CS.tutorialProgress.create();
    /* `pending` = 第五课挂出去、还没成交的那一张限价单（见 core/tutorial/openTrade.js）。
       它不是仓位：成交之后才变成 entry，所以两者分开记。 */
    const session = { active: false, entry: null, lastResult: null, pending: null };

    const account = () => ctx.account();
    const positions = () => ctx.positions();
    const cursor = () => ctx.cursor();
    const { lessonAt, lesson, lessonIndex, totalLessons, tally, pushTrade, pickCopy } = G;
    const active = () => session.active;
    const inLessons = G.inLessons;
    const leftForReal = G.leftForReal;
    const graduated = G.graduated;
    const entry = () => session.entry;
    const trades = G.trades;
    const startEquity = G.startEquity;
    const persist = G.persist;
    /* 界面只在「上课阶段」出现：没按过 ⏏、课还没上完 */
    const uiVisible = () => session.active && inLessons();
    const changed = stage => { if (ctx.onChanged) ctx.onChanged(stage); };

    /* 这一单的规格（走多久 / 目标在哪 / 怎么写进价格层）：见 core/tutorial/entry.js */
    const E = CS.tutorialEntry.create({
      cursor, baseStepHours: ctx.baseStepHours, timeframeHours: ctx.timeframeHours,
      stepBars: ctx.stepBars, fundingHours: ctx.fundingHours, nextFundingRate: ctx.nextFundingRate
    });
    const hoursPerBar = E.hoursPerBar;
    /* 挂单课预填进表单的委托价（其余课返回 0 = 不写）；仓位开着时也不写 —— 那是下一单的事 */
    const draftLimit = plan => {
      if (session.entry) return 0;
      const pair = String(ctx.instrumentId ? ctx.instrumentId() : TUNE.pair);
      return E.suggestLimitPrice(plan, ctx.priceOf ? Number(ctx.priceOf(pair)) : 0, CS.marketData.digitsOf(pair));
    };
    /* 设置那一层要知道「现在上到哪一课」与「挂单课预填多少」（课表决定锁什么、用什么倍数） */
    const settings = CS.tutorialSettings.create(ctx, { lesson: () => lesson(), draft: draftLimit });

    /* 引导经手的这一单免掉资金费：20× 下一期就顶保证金的 20%，正好压在结算点上的那一单
       会被白吃掉一大半。只免引导手里那一笔（按持仓 id 认），**按下 ⏏ 之后照旧免**。 */
    const fundingExempt = id => !!(session.active && session.entry && session.entry.id === id);
    /* 平仓时那张整页说明：引导经手的单不弹（每课弹一张没人受得了，成绩写在横幅上） */
    const silentClose = () => session.active && !!session.entry;

    /* ============ 「手上这一单」进存档（刷新之后照原样接着铺）============
       用户报的：「切 K 线周期之后直接刷新浏览器，盈亏会瞬间变成一个不一样的数」——
       刷新时那次 restore() 走的是 begin()：重新掷骰子、重新取锚价，图上那一段与盈亏
       就换了一套。把规格记进存档之后，重开页面就是照着铺。规格里的 plan 不进存档，只存 id。 */
    function rememberEntry() {
      const e = session.entry;
      G.record.entry = e ? { ...e, plan: null, lessonId: e.lessonId || (e.plan && e.plan.id) || null } : null;
      persist();
    }

    /* 「开一单」那条路（市价 / 限价、掷骰子、铺一段行情、刷新之后接着铺）在
       core/tutorial/openTrade.js；这一层只把零件递过去（它要读课表、换算规格、写存档）。 */
    const O = CS.tutorialOpen.create({
      session, G, E, ctx, account, positions, cursor,
      /* ★ 「玩家已经按下那颗 ⏏」这一位也交过去：那一层据此不再经手开仓（见 guardOpen） */
      left: leftForReal,
      rememberEntry: () => rememberEntry(),
      changed: stage => changed(stage),
      notify: message => notify(message)
    });
    const guardOpen = O.guardOpen, begin = O.begin, resume = O.resume;
    const guardLimit = O.guardLimit, onFill = O.onFill, onOrderCancelled = O.onOrderCancelled;

    /* ============ 换到这一课 ============
       ① 由 sessionSettings 写好这一课该锁的控件 / 该解锁的那一格（课表的 allow）与默认倍数；
    /* ============ 换到这一课 ============
       锁 / 解锁、默认倍数、挂单课的委托价，都由 sessionSettings 的 applyLesson 一次写完。
       ★ 按下 ⏏ 之后**一律不写**：那时 sessionRestore 已经把玩家自己那一套还原了，
         再写一次（settle 还会走到这里）会把他的下单方式与杠杆改回引导的 20× / 市价。 */
    function applyLesson() {
      if (leftForReal()) return;
      settings.applyLesson(lesson());
    }

    /* ============ 平一单 ============ */
    /* 由账户侧的「平仓完成」事件叫醒。账户那边已经把持仓删掉了，这里只处理引导自己的账。 */
    function settle(payload) {
      const spec = session.entry;
      const trade = payload && (payload.trade || payload);
      if (!session.active || !spec || !trade) return null;
      if (String(trade.instrumentId) !== String(spec.pair)) return null;
      const liquidated = trade.reason === 'liquidation';
      const pnl = Number(trade.pnl) || 0;
      const win = pnl >= 0;
      pushTrade({ side: spec.side, win, pnl, margin: spec.margin, liquidated, lessonId: spec.lessonId });
      const ratio = spec.margin > 0 ? Math.abs(pnl / spec.margin * 100).toFixed(1) : '0.0';
      session.lastResult = {
        win, liquidated, pnl, margin: spec.margin, ratio,
        text: liquidated ? COPY.result.liquidated(signed(pnl), `${ratio}%`)
          : win ? COPY.result.win(money(pnl), `${ratio}%`)
            : COPY.result.loss(signed(pnl), `${ratio}%`),
        /* 文案按「已走过的单数」挑：同一个进度永远给同一句 */
        headline: liquidated ? '这一单被强制平仓'
          : win ? pickCopy(COPY.settledWin, G.record.trades.length)
            : pickCopy(COPY.settledLoss, G.record.trades.length)
      };
      /* 这一段行情到此为止。**顺序不能反**：
         先把这一段**照玩家看到的样子**钉进快照（freeze），再把价格还给行情本身 ——
         反过来的话，clear() 会让重铺先把整段还原成原始行情，
         玩家盯了半天的那几根 K 线就在平仓那一下当场变了。 */
      H.freeze();
      /* 铺过的这一段的价进存档（刷新之后还要靠它把历史还回去） */
      G.record.frozen = H.frozenSnapshot();
      P.clear();
      session.entry = null;
      session.pending = null;
      G.record.entry = null;
      persist();
      /* 刚好做完最后一课：**只收课表，不退出教程**（见 graduate）。
         没走完就换到下一课 —— 最后两课（挂单 / 杠杆）的下单方式、倍数与解锁名单都在那一下生效。 */
      if (!G.record.graduated && lessonIndex() >= totalLessons()) graduate();
      else applyLesson();
      changed('settle');
      return session.lastResult;
    }

    /* 六课走完：收课表，**但不退出、也不弹任何东西**。
       产品口径（2026-10-04）：引导要看起来就是在主游戏里，所以课表走完这一下
       **不留痕迹** —— 原来这里弹一张「课表走完」的总结卡（带胜率与逐单明细），
       那既是一句「你在上课」，也是一次打断。现在只把状态记下来、把价格还回行情：
       record.graduated = true、record.left 仍然是 false（人还在引导里，照顾照旧），
       想真出去还是那颗 ⏏。 */
    function graduate() {
      G.record.graduated = true;
      persist();
      /* clear（不是 restore）：课表走完之后价格层不该再挂着任何一段 —— 包括
         「挂单排好的那一根」（这一单是先挂单、后平仓的时候还留着它的话，
         留着它就会每推进一根都去改那一根早已过去的 K 线）。 */
      P.clear();
      changed('graduate');
      return true;
    }
    /* 跳过一个还没开的课时（已经开着的那一单不能跳：先平掉）。
       「跳过」＝把这一课从课表上划掉：指针是由成绩推出来的，
       所以这里补一条**零额度的占位成绩** —— 不影响账户，只在成绩单上留一行「跳过」。 */
    function skipCurrentLesson() {
      if (!inLessons() || session.entry) return false;
      const plan = lesson();
      G.record.trades.push({
        side: plan ? plan.side : 1, win: true, pnl: 0, margin: 0,
        liquidated: false, lesson: plan ? plan.id : null, at: Date.now(), skipped: true
      });
      persist();
      /* 与 settle 同一条收尾：跳过最后一课就等于课表走完，别留一个「pointer 到头了、
         graduated 还是 false」的空转状态（那个状态下界面会既不画课、也不毕业）。 */
      if (lessonIndex() >= totalLessons()) graduate();
      else applyLesson();         /* 跳过之后也要换到下一课（锁 / 倍数 / 委托价） */
      return true;
    }

    /* ============ 玩家点「前进」 ============ */
    /* 走到该走的那一根了吗：'settle' 可以平仓了 / 'watch' 还要再走 / 'idle' 引导没在等这一单 */
    function watch() {
      const spec = session.entry;
      if (!session.active) return 'off';
      if (!spec) return 'idle';
      return cursor() >= spec.bar + spec.spanBars ? 'settle' : 'watch';
    }
    /* 还差几根才到该平仓的那一根 */
    function remaining() {
      const spec = session.entry;
      if (!spec) return { bars: 0, hours: 0 };
      const bars = Math.max(0, spec.bar + spec.spanBars - cursor());
      return { bars, hours: bars * hoursPerBar() };
    }
    /* 玩家点「前进 →」：一次点不动就多推几根（按这一单需要的根数补足），
       真正的推进仍然走 ctx.advance（与手动点那颗按钮是同一条路）。
       一次「前进」走的是**这一步**（ctx.stepBars 根基础线）：
       引导把步长定成与周期一致（TUNE.stepHours = 12、周期 12h），
       所以点一下正好长出一根新 K 线 —— 课上「点一下 = 长出一根」的节奏就是它。 */
    function hop() {
      if (!session.active) return 'off';
      if (ctx.modal.isBusy()) return 'paused';
      const spec = session.entry;
      if (!spec) return 'idle';
      const step = Math.max(1, Number(ctx.stepBars()) || 1);
      const target = spec.bar + spec.spanBars;
      let steps = 0;
      while (cursor() < target && steps < TUNE.maxStepsPerHop) {
        const before = cursor();
        ctx.advance(step);
        if (cursor() <= before) break;              /* 到头了 / 被挡住了 */
        steps++;
      }
      return watch();
    }
    /* 光标往前走之后调一次：过了一根还不平仓就把这一段跟着延长 */
    function extendEntry() {
      const spec = session.entry;
      if (!spec) return false;
      const pos = positions().find(p => p.id === spec.id);
      if (!pos) return false;
      return E.extendSpan(pos, spec, spec.plan || lesson(), rememberEntry);
    }
    /* ★ 原来这里还有一口 `pierceNow()`（覆盖层扎穿强平价之后叫回来判一次爆仓）。
       引导已经不再制造爆仓了（见 priceOverlay 的说明），所以整口拿掉 ——
       真正的强平判定仍然在引擎里（marketEngine 的 checkLiquidation），一行没动。 */

    /* ============ 开 / 关 / 恢复 ============ */
    /* 开始上课（设置⚙️ / 自动进入都走它） */
    function start() {
      if (session.active) return false;
      if (positions().length) { notify('当前还有未平仓的持仓：先把它们平掉，再进入新手引导。'); return false; }
      session.active = true;
      session.entry = null;
      session.pending = null;
      session.lastResult = null;
      /* 按过 ⏏ 的人再进来就是重新上课：把 left 打开、graduated 也归位。
         graduated 必须一起清 —— 只清 left 的话，课表走完的人一点「新手引导」
         会立刻又被判成「课表走完」，于是界面一闪就没了。课表进度本身不重置：
         它是由成绩推出来的，想真从头再学一遍走设置⚙️ 的「从头再学一遍」。 */
      G.record.left = false;
      G.record.graduated = false;
      if (!Number.isFinite(G.record.startEquity)) G.record.startEquity = ctx.equity();
      settings.sessionApply();
      applyLesson();
      persist();
      changed('start');
      return true;
    }
    /* 真·退出：那颗 ⏏。**唯一的出口，而且不再拦、不再问。**
       产品口径（2026-10-04）：既然屏幕上不该有任何「教程」痕迹，就不该有
       「你还有仓位 / 确定要离开吗」这类只有教程才有的拦路话 —— 那是一只看不见的手。
       所以这里**无条件放行**：按一下就走。
       ★ 只有一处例外，而且它是为了保护玩家：还开着仓时**不把行情还回去**
       （P.restore 会把铺出来的价换成真实行情，那一笔立刻要按真实价被结算甚至被扫爆）。
       留给 settle()：那一单平掉时它自己会 freeze + clear，价格照样还给行情。
       其余三件事照旧：还设置并解锁、开门禁（只写不清）、record.left = true。
       ★ 没有持仓时走 P.clear()（不是 restore）：挂单排好的那一份 spec 要**一起丢掉**，
         否则它留在这里，之后每推进一根都会回头去改那一根已经过去的 K 线。 */
    function exitForReal() {
      if (!session.active) return false;
      G.record.left = true;
      persist();
      /* coin 版：原来这里还要「开门禁」—— 写一位只写不清的标记（cs:gate:tutorialDone），
         让外壳把故事模式那颗按钮画出来。故事模式移除之后这个标记没有任何读者，
         所以整块拿掉了。这颗 ⏏ 现在的效果就是下面这三件事。 */
      /* 还挂着的那张限价单不再由引导盯：撤掉「排好的那一根」，之后它自己按真实行情成交 */
      session.pending = null;
      settings.sessionRestore();
      if (!positions().length) P.clear();   /* 还开着仓就先留着（见上面那段说明） */
      changed('exit');
      return true;
    }
    /* 从头再学一遍（设置⚙️ 里手动触发）：清掉教学进度，重新从第一课开始 */
    function resetProgress() {
      if (positions().length) { notify('先把持仓平掉，再重学一遍。'); return false; }
      CS.tutorialRecord.resetRecord();
      G.reload();
      session.entry = null;
      session.lastResult = null;
      const wasActive = session.active;
      session.active = false;
      P.release();
      /* 存档清干净了（连「铺过的历史」一起）：行情也从头长一遍 ——
         留着上一轮铺过的那几根，新的一轮就会长在一张旧图上。 */
      forgetHistory();
      if (wasActive) start();
      else changed('reset');
      return true;
    }
    /* 把引导铺进行情里的痕迹**全部**抹掉：series 回到原始数据（＝没被引导改过）。
       只给两处用：「从头再学一遍」与「账户重置」—— 它们都是「新的一局」。 */
    function forgetHistory() {
      P.release();
      H.forgetFrozen();
      G.record.frozen = null;
      G.record.entry = null;
    }
    /* 启动时进入。**所有人都要走新手教程**：
       只要还没按过那颗 ⏏（record.left 为 false），打开页面就自动进入引导。
       按下 ⏏ 之后（left = true）界面不再出现，但**照顾照旧** ——
       所以这里不对 left 早退：不这样的话，「离开之后再刷新」会把手上那一单的照顾丢掉，
       它的盈亏当场变回真实行情，还可能被真实影线扫爆。 */
    function restore() {
      if (session.active) return false;
      /* 自检/探针把整块引导关掉了（record.off）：连照顾一起都不接 ——
         交易逻辑类的探针要的是没有被引导改过的行情。注意 `left` 不是这个意思。 */
      if (G.record.off) return false;
      if (!CS.marketData.ready) return false;
      session.active = true;
      session.entry = null;
      session.pending = null;
      session.lastResult = null;
      if (!G.record.left) { settings.sessionApply(); applyLesson(); }
      else if (!Number.isFinite(G.record.startEquity)) G.record.startEquity = ctx.equity();
      /* 先把上一次铺过的那几根还回 series：图表、这一单的价格、下一单的起点都靠它 */
      H.adoptFrozen(G.record.frozen);
      /* 手上这一单：**按持仓 id 找，不能只看 positions[0]**。
         持仓是新开的那一笔排在最前面，所以玩家手里不止一单时（按下 ⏏ 之后都允许），
         positions[0] 可能**不是**引导经手的那一单 —— 按它去对 id 就对不上。 */
      const open = positions()[0];
      const tracked = G.record.entry ? positions().find(p => p.id === G.record.entry.id) : null;
      if (tracked) resume(G.record.entry, tracked);
      else if (open) begin(open, lesson());
      else if (G.record.entry) { G.record.entry = null; persist(); }
      changed('restore');
      return true;
    }
    /* 引导说话的唯一出口（界面收起来的时候一句话都不说）。
       session 里这两句只在「上课 + 开着仓」时才会走到，但仍然走同一个口子 ——
       规矩收在一处，以后加提示不会漏。 */
    function notify(message) {
      if (!uiVisible()) return false;
      ctx.notify(message, { duration: 5600 });
      return true;
    }
    /* 每一步推进之前的「先把价格铺到这一步的光标上」：
       **必须在推进之前调**（不是推进事件之后）。那一步的强平判定读的是 series 上那几根的**影线**，
       而引导是按「光标」铺价的 —— 光标还没走到、rideToBar 还没跟上的那一根，影线还是真实行情的。
       一次推进跨了不止一根基础 K 线时，中间那几根就会拿真实影线去判爆仓：
       一单被照顾着的赢单，会在一个**玩家从没见过的价**上被扫爆。 */
    function syncToCursor() {
      if (!P.active()) return false;
      const spec = P.current();
      if (spec && session.entry) {
        /* ★ 先把这一段的长度跟着光标延长，再把它铺出去。
           为什么两步都要、而且顺序不能反：
             · 只搬 rideToBar（下面那一行）不改 spanBars，则**长度**永远停在课表那几根上，
               rebuild 是"铺到光标脚下"的 —— 可一旦段长用完，玩家再多走几根，
               价格就退回**真实行情**（我们从 base 里还原出来的原始 OHLC），
               方向不受控，20× 下一根大阴线就把他打爆。
               这就是「点一下『推进一周』直接被强平」的真正原因：
               extendSpan() 这个函数**从来没有被调用过**（全库零调用点），
               所以 entry.js 里那句「时间再久也不会被强平」当场失效。
             · 只改 spanBars 不搬 rideToBar，则新长出来的那几根还是真实行情。
           两步都做，才真的"照顾到光标脚下"。 */
        extendEntry();
        /* 只许往前走：光标倒退时不把窗口往回收，免得把已经铺好的那几根露出来 */
        if (!Number.isFinite(spec.rideToBar) || cursor() > spec.rideToBar) spec.rideToBar = cursor();
      }
      P.sync();
      return true;
    }
    /* ============ 推进的许可（2026-10-04 起整块撤掉）============
       ★ 这里原来有两样东西：`advanceBlocked`（引导这一单走到该平仓那一根之后，
         一次推进超过一根就拦下来，并弹一句「先点平仓结算，再往下推」）与
         `P.setPierceHook(pierceNow)`（铺价时当场判一次爆仓）。
       两样都按产品口径拿掉了：引导要看起来就是在主游戏里，一只有不见的手
       （拦推进、替玩家扎穿强平价）比「不提示」更糟。
       现在一次推进多少根由玩家说了算，亏单也不会有人替他扎穿强平价 ——
       真正的强平判定一直在引擎里（marketEngine 的 checkLiquidation），一行没动。 */

    return {
      session, start, exitForReal, graduate, restore, resetProgress, forgetHistory,
      guardOpen, guardLimit, onFill, onOrderCancelled, settle, watch, hop, extendEntry, remaining,
      fundingExempt, silentClose, lessonHint: () => O.hint(),
      skipCurrentLesson, resume, begin, syncToCursor,
      lessonIndex, lessonAt, lessonPlan: lesson, totalLessons,
      active, entry, inLessons, leftForReal, graduated, trades, tally, startEquity,
      lessonFocus: () => { const plan = lesson(); return plan ? plan.focus : null; },
      uiVisible, settings, changed
    };
  }

  return { tutorialSession: { create } };
});
