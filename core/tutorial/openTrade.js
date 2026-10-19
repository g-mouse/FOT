/* ============ 「开一单」那条路：接管开仓 → 掷骰子 → 铺一段行情 ============
   引导期间真正开仓的入口（面板那两颗按钮最后都会落到这里）：
   先判断「这一单该不该由引导经手」，再交给正常开仓，最后把价格接管过来。
   刷新页面之后「接着铺」也走这里（resume）。

   为什么单独一个文件：core/tutorial/session.js 管的是**课表走到哪儿了**，
   而这一段管的是**这一单怎么被安排**（方向、骰子、锚价、目标、波动）。
   两件事混在一起单文件就压不住**当时**的 400 行上限了。

   ============ 两种下单方式，一条收尾 ============
   市价单：guardOpen（开仓那一下就把段铺起来，锚 = 成交价）。
   限价单（第五课）：guardLimit（挂上时只排「成交那一根」的影线，还没有仓位）
     → 引擎每根 settleStep 判一次 → onFill（成交了才 begin，与市价单同一条路）。
   撤单：onOrderCancelled（把排好的那一根撤掉）。
   这一层同时管着「这一课露在屏幕上的那一句话」（hint）—— 它要知道挂单排没排上，
   而那个状态就在 session.pending 里。

   deps = { session, G, E, ctx, account, positions, cursor, rememberEntry, changed, notify }
     session        会话状态（entry / pending / lastResult 就写在它上面）
     G              教学进度（core/tutorial/progress.js）—— 骰子要看已下过的单
     E              这一单的规格换算（core/tutorial/entry.js）
     rememberEntry  把这一单写进存档（session 那边定义，这一段不认识存档格式）
     changed        状态机只喊 stage，界面自己去重画 */
CS.define('core/tutorial/openTrade', ["core/tutorial/favor","core/tutorial/priceOverlay"], function () {
  'use strict';

  const F = CS.tutorialFavor;
  const P = CS.tutorialPrice;
  const sideOf = pos => (pos && (pos.side === 'short' || pos.side === -1) ? -1 : 1);
  /* 走反了的那一句：课表里的旁白不预告涨跌（骰子有 20% 是亏单），
     所以一笔反向的行情只能由这一句来解释 —— 不然就是「教程说会跌、图上却在涨」。
     不写「第几课 / 教程」，仍然是主游戏里的一句提示。 */
  const LOSS_HINT = '这一单走反了：浮亏在扩大。点「前进 →」继续走，或者现在点「平仓」止损。';

  function create(deps) {
    const { session, G, E, ctx } = deps;
    const account = deps.account;
    const positions = deps.positions;
    const cursor = deps.cursor;

    /* 引导期间真正开仓的入口。open(side) 是「真正去开仓」那一下（面板的市价下单）。
       ★ 只在**教程还开着**的时候经手 —— 判据是 `session.active && !leftForReal()`：
         · 没在教程里（故事模式、或者从没进过教程）：**原样透传**，一个多算的判断都不做；
         · 按下那颗 ⏏ 之后：`leftForReal()` 为真，**也原样透传** ——
           这是 2026-10-04 用户口径的关键一条：「只有教程模式才会 80%/20% 输，
           模拟模式和故事模式都不会主动迎合开仓方向」。
           原来这里只判 `session.active`，而 active 在 ⏏ 之后**仍然是 true**（session 还留着记账），
           于是离开教程之后开的每一单照样被掷骰子（80% 赢）并按仓位方向铺价 ——
           模拟模式名义上已经不是教程了，行情却在迎合玩家的方向。漏点就在这里。
         · 所以下面那个 `plan` 也就只可能是课表上的课（不会是 null 了），
           但它仍然允许为 null（课表走完那一档 lesson() 会给 null），铺价那段自己会兜。 */
    function guardOpen(side, open) {
      if (!session.active || deps.left()) return open(side);
      const plan = G.lesson();
      /* ★ 这里原来有一句 `ctx.stopTick()` —— **2026-10-04 删掉了**。
         它当年的理由是「抖动是按帧给价的动画，点下去的那一帧读到哪个价、成交价就是哪个价」。
         这条理由**现在不成立**：
           · 市价成交价是 core/engine/marketEngine.js:167 的 `bar.c`（那一根 K 线的收盘价），
             不是任何逐帧变动的显示价；
           · 面板的下单预览 / 手续费 / 强平价一律用 settle（见 tradeModel 里那段说明），
             所以抖动**只是显示层，改不了钱**。
         它真正的影响是：抖动一轮只跑「推进之后约 playMs×0.9」那么久（见 tick.js 的 begin
         与 autoPlay 的节拍），而**开仓正好是玩家开始盯价的那一刻** —— 在这段窗口里按下做多，
         这一轮就被当场掐断（自动播放时每一拍都有窗口，所以很容易撞上）。
         量具：tools/playtest-tutorial.mjs 的「开仓时这一轮抖动有没有被掐断」那一条。
         ⚠ 别把「开着仓、不推进时静止」当成本条的证据：那是**设计如此**
         （抖动是每推进一根起一轮，不是常驻动画）。 */
      const before = new Set(positions().map(p => p.id));
      const opened = open(side);
      if (!opened) return null;
      const fresh = positions().find(p => !before.has(p.id)) || positions()[0];
      /* 接手这一单：铺行情那一步出错也**不能拖垮开仓**（仓已经成交了，钱已经扣了）。
         出错就退回「不照顾」——玩家照样有一笔正常的持仓，只是这一段没被安排。 */
      if (fresh && fresh.id) {
        try { begin(fresh, plan); }
        catch (error) {
          console.warn('[tutorial] 这一段行情没铺成：', error);
          session.entry = null;
          P.clear();
        }
      }
      return opened;
    }

    /* ============ 限价委托（第五课）============
       挂上单的那一刻**还没有仓位**，所以这里不能像 guardOpen 那样去 begin()：
       只把「这一单是引导盯着的」记下来，并请价格层把**成交那一根**的影线排到委托价上
       （core/tutorial/entry.js 的 pendingSpec → priceOverlay.js 的 writePending）。
       真成交之后由 onFill 接住，再走与市价单同一条 begin() —— 骰子、目标、段长全一样。
       ★ 离得太远就不排（pendingSpec 返回 null）：课上改成提醒玩家把委托价挪近
         （lessons.js 的 hintFar），而不是画一根 −30% 的巨阴线替他成交。 */
    function guardLimit(order, place) {
      if (!session.active || deps.left()) return place(order);
      const before = new Set(positions().map(p => p.id));
      const placed = place(order);
      if (!placed || !placed.ok) return placed;
      /* 手上已经有一单：价格层只能同时铺一段，这一笔就让它自己等行情（不排、也不接管） */
      if (session.entry) return placed;
      const plan = G.lesson();
      const pair = String(order.instrumentId);
      const side = order.side === 'short' ? -1 : 1;
      const spec = E.pendingSpec({
        pair, side, price: Number(order.price), anchor: Number(ctx.priceOf(pair)) || 0,
        bar: cursor() + 1, vol: E.measureVol(pair, cursor()), candleBars: E.barsPerCandle()
      });
      session.pending = { id: placed.orderId, pair, side, plan, before, arrange: !!spec };
      if (spec) P.set(spec);
      deps.changed('limit');
      return placed;
    }
    /* 限价单成交了（引擎的 market.fill，type === 'limit'）：找到新开出来的那一笔仓位接进来。
       市价单的成交不从这里走 —— 它由 guardOpen 在 submitOrder 返回之后自己 begin()。 */
    function onFill(fill) {
      if (!session.active || deps.left()) return false;
      if (!fill || fill.type !== 'limit') return false;
      const pending = session.pending;
      session.pending = null;
      if (session.entry) return false;                   /* 手上已经有一单：这一笔不接管 */
      const pair = String(fill.instrumentId || (pending && pending.pair) || '');
      const side = sideOf(fill);
      /* 找「这一笔刚开出来的」仓位：**先用挂单那一刻记下的 id 快照**，
         拿不到（刷新之后 pending 已经丢了）才退回「同品种 + 同方向的最后一笔」。
         ★ 不能取同品种 + 同方向的第一笔：accountEngine 的 positions 是**追加**的
         （openPosition 里 push），第一笔是同向的老仓位，接上去就把老仓位当成这一单了。 */
      const fresh = pending && pending.before ? positions().find(p => !pending.before.has(p.id)) : null;
      const same = positions().filter(p => String(p.instrumentId) === pair && sideOf(p) === side);
      const pos = fresh || (same.length ? same[same.length - 1] : null);
      if (!pos) return false;
      try { begin(pos, (pending && pending.plan) || G.lesson()); }
      catch (error) {
        console.warn('[tutorial] 挂单成交之后这一段没铺成：', error);
        session.entry = null;
        P.clear();
      }
      return true;
    }
    /* 撤单：把排好的那一根影线撤掉（价格层恢复成行情本身）。
       注意引擎在**成交之后**也会发一条 orderCancelled —— 那时 session.pending 已经被
       onFill 清掉了，所以这里按 id 对不上、什么都不做。 */
    function onOrderCancelled(payload) {
      const pending = session.pending;
      if (!pending) return false;
      if (payload && payload.orderId && String(payload.orderId) !== String(pending.id)) return false;
      session.pending = null;
      if (!session.entry) P.clear();
      deps.changed('cancel');
      return true;
    }
    /* 这一课露在屏幕上的那一句话（见 lessons.js 的文件头与 ui/components/tutorialGuide.js）。
       空串 = 不画那一行。按「优先级从具体到笼统」排：
         · 挂单还没成交：这一课专门写的那两句（已经排上成交 / 委托价太远）；
         · 第五课成交之后：hintFilled（成交价 = 委托价，下一步推进 / 平仓）——
           原来这里给空串，玩家挂上单、成交之后屏幕上**一个字都没有**，
           看起来就是「挂单教程后面没有渲染出来」；
         · 第六课开着仓：课表里的持有中旁白（杠杆放大两边）；
         · 前四课开着仓：**赢了**给课表旁白，**走反了**给亏单那一句 ——
           旁白不预告涨跌，所以不能拿它去解释一笔反向的行情；
         · 还没开仓：这一课的目标（短句，含「点哪颗按钮」）。
       这些句子都不含「第几课 / 教程 / 引导」这类字，所以「看起来像主游戏」那条口径还在。 */
    function hint() {
      const plan = G.lesson();
      if (!plan) return '';
      const pending = session.pending;
      if (pending) return pending.arrange ? (plan.hintPlaced || '') : (plan.hintFar || '');
      if (session.entry) {
        if (plan.hint) return plan.hintFilled || (plan.script && plan.script.hold) || '';
        if (!session.entry.win) return LOSS_HINT;
        return (plan.script && plan.script.hold) || '';
      }
      return plan.hint || plan.goal || '';
    }

    /* 开仓之后立刻做的事：取锚价 → 掷骰子 → 算目标 → 铺一段行情 */
    function begin(pos, plan) {
      /* 这一单已经接住了：挂单那一份（如果还留着）到此为止 —— 价格层马上换成仓位这一份 */
      session.pending = null;
      const side = sideOf(pos);
      const entryPrice = Number(pos.entryPrice);
      /* ★ 锚 = **实际成交价**（新引擎的市价单叠了滑点，展示价与成交价差一点点；
         取展示价的话，重铺之后那一根的收就不是玩家拿到手的那个数）。 */
      const base = entryPrice > 0 ? entryPrice : Number(ctx.priceOf(pos.instrumentId));
      if (!(base > 0)) return false;
      /* 这一单是赢是亏：80% 的骰子（favor.js），一单只掷一次 */
      const win = F.roll(G.trades());
      /* 保本价：真正的手续费（开仓 + 平仓）算出来的那个价。赢单的地板就架在它上面一点点，
         所以赢单的浮盈自始至终是绿的，也不会被影线扫爆。 */
      const breakEven = account().breakEvenOf(pos);
      const gap = Number.isFinite(breakEven) && entryPrice > 0 ? (breakEven / entryPrice - 1) * side : 0;
      const baseSpan = E.spanOf(plan, 0);
      const notional = Number(pos.notional) > 0 ? Number(pos.notional) : pos.margin * pos.leverage;
      /* 赢单的净额是**按目标价平掉**算的：目标价要越过保本价，否则「赢」的这一单
         扣完手续费反而变成小亏。给出的目标比例还要按中间价与成交价的差补一点点。 */
      const rawTarget = F.targetRatioOf(notional, pos.margin, side, win);
      const safeTarget = win
        ? (side === 1 ? Math.max(rawTarget, 1 + gap * 1.35) : Math.min(rawTarget, 1 - gap * 1.35))
        : rawTarget;
      session.entry = {
        id: pos.id, pair: pos.instrumentId, side, win, margin: pos.margin, leverage: pos.leverage,
        entry: entryPrice, anchor: base, breakEven, breakEvenGap: gap, targetRatio: safeTarget,
        notional, baseSpan, spanBars: baseSpan, bar: cursor(), lessonId: plan ? plan.id : null,
        /* 这一课的那份计划（延长时要用它的 holdHours；课表指针会往前走，不能到时候再读） */
        plan: plan || null,
        /* 只给界面看的一个估算：真实交易里这一单要付多少资金费 */
        fundingEstimate: E.fundingDrag(pos, baseSpan, side),
        /* 这一刻的市场波动与「图上的 K 线有几根基础线」：段外那条路的步长与尺度按它们定。
           两者都在开仓那一刻定下来（切周期不重画）—— 「同一单刷新之后还是同一个数」的前提。 */
        vol: E.measureVol(pos.instrumentId, cursor()),
        candleBars: E.barsPerCandle()
      };
      session.lastResult = null;
      E.applySpec(session.entry);
      deps.rememberEntry();
      deps.changed('open');
      return true;
    }

    /* 把这一单的规格写回会话（刷新之后走这条路）。
       骰子结论、锚价、段长、目标、波动**一律照存档** —— 它们决定图上那一段长什么样，
       改一个数，玩家手上的浮盈就会跟着变。
       与持仓现况对得上的那几个数（保证金 / 杠杆 / 成交价 / 名义仓位）从持仓现读。 */
    function resume(saved, pos) {
      const plan = saved.lessonId ? (G.lessonList().find(l => l.id === saved.lessonId) || null) : null;
      const repaired = !(Number(saved.vol) > 0) || !(Number(saved.candleBars) > 0);
      session.entry = {
        ...saved,
        margin: Math.max(0, Number(pos.margin) || saved.margin),
        leverage: Math.max(1, Number(pos.leverage) || saved.leverage),
        entry: Number(pos.entryPrice) > 0 ? Number(pos.entryPrice) : saved.entry,
        notional: Number(pos.notional) > 0 ? Number(pos.notional) : saved.notional,
        vol: Number(saved.vol) > 0 ? Number(saved.vol) : E.measureVol(saved.pair, Math.round(Number(saved.bar) || 0)),
        candleBars: Number(saved.candleBars) > 0 ? Math.round(Number(saved.candleBars)) : E.barsPerCandle(),
        plan
      };
      session.lastResult = null;
      E.applySpec(session.entry);
      /* 补过的字段立刻写回存档：不然这一单每刷新一次就要靠「重新量」兜一次，
         而重新量出来的数不一定与开仓那一刻完全一样。 */
      if (repaired) deps.rememberEntry();
      deps.changed('restore');
      return true;
    }

    return { guardOpen, guardLimit, onFill, onOrderCancelled, hint, begin, resume };
  }

  return { tutorialOpen: { create } };
});
