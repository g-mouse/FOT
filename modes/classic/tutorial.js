/* ============ 模拟模式里的新手引导（装配层） ============
   把 core/tutorial 那几层接到这一局的宿主上：状态机、价格覆盖层、
   界面（ui/components/tutorialGuide），外加四条接线。
   ★ 这一层是**唯一**知道「引导 + 模拟模式 + 交易页」三件事的地方：
   core/tutorial 不认识 DOM，交易页不认识引导 —— 所以换界面、换日程都不用动引擎。

   ============ 这一层负责的「外部世界」============
   1) **时间**：「前进 →」走 replay.nextStep（与空格、那颗按钮同一条路）；
      而铺价必须抢在每一根结算之前 —— 那一条挂在 replay.js 的推进循环里（syncToCursor）。
   2) **开仓入口**：面板最后调到 ctx.market.submitOrder，这一层包一层，
      引导开着时先过 session.guardOpen（限方向、停抖动、接管这一段行情）。
   3) **那几个开关**：交易对 / 周期 / 下单方式 / 杠杆 / 保证金 引导期间固定，直接置灰。
   4) **那一局的方向盘**：引导临时改掉的设置**不落盘**，退出时逐项还原（见 sessionSettings）。 */
CS.define('modes/classic/tutorial', ["core/base/money","core/base/util","core/events/events","core/market/marketData","core/market/resample","core/tutorial/copy","core/tutorial/lockControls","core/tutorial/session","core/tutorial/tune","modes/classic/settings","ui/components/bits","ui/components/modal","ui/components/tutorialGuide","ui/shell"], function () {
  'use strict';

  const TUNE = CS.tutorialTune.TUNE;
  const HOUR = 3600000;

  function create(deps) {
    /* ★ 界面与状态**分开**：session（进度、那一局的方向盘、价格覆盖层）在模式活着的
       整段时间里只有一份，而界面每次挂交易页时重建一次（切模式会把 modeHost 清空）。
       不这么分的话，切出去再切回来会**再抄一份「原始设置」**—— 而那时抄到的已经是
       引导改过的那一套，退出引导时就再也还原不回去了。 */
    let guide = null;
    let session = null;
    let offClose = null;
    /* 界面没挂上时用这个空壳顶着：下面每一步都能照跑（只是什么都不画）。
       session 的规则是「界面收起来时一句话都不说」，空壳正好就是那个状态 ——
       不用在十几个地方各写一遍 `if (guide)`。 */
    const NO_UI = {
      show() {}, showExit() {}, speak() {}, progress() {}, showFlash() {}, hideFlash() {},
      showHint() {}, focus() {}, setSnapshot() {}, setLastResult() {}, handlers() {}, dispose() {},
      lastResult: () => null, snapshot: () => null
    };
    guide = NO_UI;
    let uiHost = null;
    /* 上课期间锁住那几个开关：搬到 core/tutorial/lockControls.js（这个文件压不住**当时**的 400 行上限了） */
    const lock = CS.tutorialLock.create();

    const account = () => deps.account();
    const positions = () => account().getSnapshot().positions;
    const baseStepHours = () => {
      const meta = CS.marketData.getDatasetMeta();
      return Math.max(1, Math.round((Number(meta.stepMs) || 4 * HOUR) / HOUR));
    };
    /* 引导的步长（一次「前进」走几根基础线）：课表按小时写（12 小时一步），而行情按 4 小时的根走 ——
       换算在 replay.stepBars 里只有一处，这里直接问它（引导把 stepHours 写进设置槽，它就按 12 小时算）。 */
    const stepBars = () => (deps.replay().stepBars ? deps.replay().stepBars() : 1);
    const currentBar = id => {
      const s = CS.marketData.seriesRef(id);
      if (!s) return null;
      const j = CS.marketData.nowIndex - s.off;
      return (j >= 0 && j < s.bars.length) ? s.bars[j] : null;
    };
    /* 下一个资金费结算点的费率（真实历史数据）：从光标往前找第一个有值的下标。
       找不到（合约还没上线 / 这一段没有数据）就返回 undefined，界面写「—」。 */
    function nextFundingRate(id) {
      const step = baseStepHours();
      const perPeriod = Math.max(1, Math.round((CS.tutorialCopy.COPY && 8) / step));
      for (let i = 1; i <= perPeriod * 2 + 1; i++) {
        const rate = CS.marketData.fundingRateAt(id, CS.marketData.nowIndex + i);
        if (Number.isFinite(rate)) return rate;
      }
      return undefined;
    }

    /* ============ 界面 ============ */
    /* 快照：把这一局此刻该说的话、该指的地方算出来（界面层只照画） */
    function buildSnapshot() {
      if (!session || !session.active()) return null;
      const plan = session.lessonPlan();
      const remain = session.remaining();
      const spec = session.entry();
      const stats = session.tally();
      const metrics = account().metrics();
      const snap = account().getSnapshot();
      return {
        lessonIndex: session.lessonIndex(), total: session.totalLessons(),
        lessonTitle: plan ? plan.title : '',
        focus: plan && session.inLessons() ? plan.focus : null,
        stats: { count: stats.count, wins: stats.wins, losses: stats.losses, rate: stats.rate, trades: session.trades().length },
        equity: metrics.equity, cash: snap.cash,
        active: spec ? { win: spec.win, fundingEstimate: spec.fundingEstimate } : null,
        remain: remain,
        due: session.watch() === 'settle',
        /* 底部那一行（每一课都可能有字）与「挂单还没成交」这一位：探针与自检要读得到 */
        hint: session.lessonHint(),
        pending: !!session.session.pending
      };
    }
    /* ★ 原来这里有一个 focusNode(snap)：算出「该指哪颗按钮」，交给聚光框画一圈呼吸的框。
       聚光框按产品口径不画了（那是屏幕上最明显的「有人在牵你」），所以整块删掉 ——
       连带 `.st-trade-btn.long/.short`、`[data-tut-next]` 这几处 DOM 查询一起没了。 */
    /* ★ 2026-10-04：老师的话、进度条、聚光框**都不画了**（产品口径：引导要看起来
       就是在主游戏里）。所以这一层现在只剩三件事：开关那颗 ⏏、把结算数字交给横幅、
       以及底部那一行说明。2026-10-19 起那一行对**每一课**都画（目标 / 持有中旁白；
       最后两课（挂单 / 杠杆）仍是挂单 / 杠杆那两句）—— 原来只有后两课有，前四课屏幕上什么都没有，
       看起来就是「教程没有渲染出来」（见 ui/components/tutorialGuide.js 的 showHint）。 */
    function render() {
      if (!session || !guide) return;
      const inside = session.active() && !session.leftForReal();
      guide.showExit(inside);
      if (!session.uiVisible()) { guide.show(false); return; }
      guide.setSnapshot(buildSnapshot());
      guide.showHint(session.lessonHint());
      guide.show(true);
    }

    /* ★ 原来这里有一个 speak(snap)：按「没开仓 / 开着仓 / 该平了 / 刚结算」四种状态
       拼老师的话（第几课、本课目标、该点哪颗按钮、还需往前走几小时）。整块删掉了 ——
       产品口径是引导不该在屏幕上留下任何「你在上课」的痕迹。
       ⚠ 它顺带承担的**提示**职责现在没有了：玩家不会被告知「该平仓了」。
       这是有意的（配套改动：亏单不再扎穿强平价、批量推进也不再被拦），
       所以「不提示」不会让谁在毫无预告的情况下被拉爆 —— 见 session.js 与 priceOverlay.js
       里那两处说明。 */

    /* 状态机只喊 stage，界面在这里统一重画（开仓 / 平仓 / 推进 / 开关都走它） */
    function onChanged(stage) {
      if (!session) return;
      if (stage === 'settle') {
        const result = session.session.lastResult;
        guide.setLastResult(result);
        if (result && session.uiVisible()) guide.showFlash(result);
      }
      if (stage === 'reset') { guide.show(false); guide.showExit(false); guide.setLastResult(null); return; }
      if (stage === 'open') guide.setLastResult(null);
      render();
      CS.events.bus.emit('trade.render', {});
    }
    /* ★ 原来这里有 act()（老师条那颗「前进 →」）、skip()（「跳过这一课」）、
       repeat()（「重讲一遍」）三个处理函数 —— 它们都是老师条上的按钮，而老师条不画了。
       整块删掉：玩家要推进时间就用交易页**自己那颗**「前进」（或空格），
       那条路一直通到 replay.advanceBars，与这里无关。
       ⚠ 顺带说明一件事：`skipCurrentLesson()` 也就没有入口了（它只服务「跳过这一课」）。
       留着它是因为它还在 session 的导出面上（自检与探针会调）。 */
    /* **唯一的出口**：那颗 ⏏。
       ★ 2026-10-04：原来这里弹一张确认单（「要离开新手引导吗？」+ 还剩几课 + 胜率），
       还开了「你还有未平仓的持仓」那张拦路单。两张都删掉了 ——
       产品口径是屏幕上不该有任何「教程」痕迹，那种弹窗正是最响的一句。
       现在按一下就走：不确认、不提示、也不拦住有持仓的人（exitForReal 里那一段说明）。 */
    function requestLeave() {
      if (!session.active() || session.leftForReal()) return;
      leaveNow();
    }
    function leaveNow() {
      if (!session.exitForReal()) return false;
      if (guide) { guide.setLastResult(null); guide.show(false); guide.showExit(false); }
      touchTopExit();
      /* ★ 不再弹那句「已交回给你…」。玩家按的是自己找到的那颗 ⏏，
         屏幕上不该因此冒出一条解释「你刚才在教程里」的 toast。 */
      return true;
    }
    /* 按下 ⏏ 之后让模式那一排重画一次。
        coin 版里那一排只有模拟模式一颗按钮，重画它什么都不会变 —— 仍然留着这一句，
       是因为 buildModeButtons() 是壳层唯一的「重画入口」，少了它，
        将来任何一处模式可见性的变化都得在这里另开一条路。 */
    const touchTopExit = () => { if (CS.shell && CS.shell.buildModeButtons) CS.shell.buildModeButtons(); };

    /* ============ 锁住那几个开关 ============
       实现搬到 core/tutorial/lockControls.js（那一段只认识 DOM 与一组选择器）。
       这里只留一行接线：session 的 sessionApply / applyLesson / sessionRestore 会喊它。
       ★ 参数要**原样转发**：第二个是「这一课解锁哪几格」（课表的 allow，第五课是
         orderType、第六课是 leverage）。原来这里写成 `on => lock.set(on)`，
         多出来的那个名单被悄悄丢掉 —— 表现是「讲挂单的那一课，下单方式还是灰的」。 */
    const lockControls = (on, allow) => (on ? lock.apply(allow) : lock.set(false));

    /* ============ 那一局的方向盘 ============
       两处住所：交易对/保证金/杠杆/下单方式在交易页的界面状态；步长/一屏根数/周期在设置槽
       （偏好，刷新之后还要在）。名单只有一处（sessionSettings 的 KEYS），这里只做接线。 */
    /* ★ 名单里的键要接到**它真正的住所**上：confirmOpen 与步长/根数/周期住在设置槽里
       （交易页读的是槽，写到面板 ui 上等于没写 —— 引导期间那张二次确认单会照样弹出来，
       而课表里每一单都要玩家亲手点）；交易对/保证金/杠杆/下单方式在面板的界面状态里。 */
    const slot = () => CS.classicSettings;
    const SLOT_KEYS = {
      confirmOpen: 'confirmOpen', stepHours: 'stepHours', timeframe: 'timeframe', chartWindow: 'bars'
    };
    const settings = {
      read(key) {
        if (key === 'jitter' || key === 'playMs') return deps.anim()[key];
        if (SLOT_KEYS[key]) return slot().get(SLOT_KEYS[key]);
        return deps.uiState()[key];
      },
      /* ★ 全部带 {persist:false}：引导期间临时改掉的设置**不落盘**（sessionSettings 的两条规矩之一）。
         少了它，课上关掉的抖动与改成 700ms 的间隔会被写进玩家偏好 —— 中途刷新一次就永久留下了。 */
      write(key, value) {
        if (key === 'jitter' || key === 'playMs') { deps.setAnim({ [key]: value }, { persist: false }); return; }
        if (SLOT_KEYS[key]) { slot().set(SLOT_KEYS[key], value, { persist: false }); return; }
        deps.setUi({ [key]: value });
      },
      afterApply() { CS.events.bus.emit('trade.render', {}); }
    };

    /* ============ 装配 ============ */
    function init() {
      const meta = CS.marketData.getDatasetMeta();
      session = CS.tutorialSession.create({
        account, positions,
        cursor: () => CS.marketData.nowIndex,
        advance: bars => deps.replay().advanceBars(bars),
        stepBars, baseStepHours,
        timeframeHours: () => CS.resample.tfOf(deps.uiState().timeframe).hours,
        /* ★ 这里原来还有一口 `stopTick`（开仓那一下把抖动停掉），2026-10-04 连同它的
           调用点一起删了：市价成交价取的是那一根 K 线的收盘价（marketEngine.js:167），
           抖动只是显示层、改不了钱，而停它换来的是「一开仓最新那根就不动了」。
           详见 core/tutorial/openTrade.js 的 guardOpen 里那段说明。 */
        /* 扎穿强平价之后由平台真实的强平判定收尾（覆盖层只负责画那根影线） */
        checkLiquidation: () => {
          const bar = currentBar(deps.instrumentId());
          if (bar) account().checkLiquidation(id => (id === deps.instrumentId() ? bar : currentBar(id)));
        },
        equity: () => account().metrics().equity,
        nextFundingRate,
        fundingHours: () => Number(meta.fundingIntervalHours) || 8,
        /* 当前交易对与它这一根的收：挂单课要拿它算「委托价填多少」与「排哪一根」 */
        instrumentId: () => deps.instrumentId(),
        priceOf: id => { const b = currentBar(id); return b ? b.c : 0; },
        notify: (message, opts) => CS.uiBits.toast(message, '', (opts && opts.duration) || 5600),
        modal: {
          open: options => CS.uiModal.open(options),
          close: () => CS.uiModal.close(),
          isOpen: () => CS.uiModal.isOpen,
          isBusy: () => CS.uiModal.isBusy()
        },
        onChanged, onLockControls: lockControls,
        settings,
        stopAutoPlay: () => deps.replay().setAutoPlay(false)
      });
      /* 平仓：账户侧喊一声，引导侧记账、收价、更新进度条。
         顺序很要紧 —— 这几件事都必须在**重画之前**做完，否则图上会是旧价、进度条会是旧成绩。 */
      offClose = CS.events.bus.onKey('account.positionClosed', 'classicGuide', trade => session.settle({ trade }));
      /* 每一根推进之后重铺一次并重画：光标动了，铺价窗口得跟着走。
         （**结算之前**那一次重铺在 replay.js 的推进循环里调 session.syncToCursor，
           那一条才是保命的：判定读的是刚推进到的那一根的影线。） */
      CS.events.bus.onKey('classic.stepped', 'classicGuideSync', () => {
        if (!session.active()) return;
        session.syncToCursor();
        render();
      });
      /* ★ 限价单（第五课）：引擎撮合成交时只发一个市场事件，没有「开仓入口」可包 ——
         市价单那条路由 wrapMarket 的 submitOrder 现场接住，限价单必须在这里接。
         撤单同理（把排好的那一根影线撤掉；成交之后引擎也会发一条，那时已经对不上 id）。 */
      CS.events.bus.onKey('market.fill', 'classicGuideFill', fill => session.onFill(fill));
      CS.events.bus.onKey('market.orderCancelled', 'classicGuideCancel', payload => session.onOrderCancelled(payload));
      return session;
    }
    /* 接管开仓入口：面板最后会调到 ctx.market.submitOrder，这里包一层。
       引导没开着时是**原样透传**（一个多算的判断都不做）。 */
    function wrapMarket(market) {
      /* ★ 资金费豁免：引导的练习单**不收**资金费 —— 这是课表早就写明的口径
         （core/tutorial/entry.js 的 fundingDrag 注释：「引导的练习单不收，所以这个数
         只用来在进度条上写一句」），而 session.fundingExempt 一直**没有任何调用点**：
         于是练习单照收，8 小时一次，长持下去把保证金额度啃掉一大块
         （实测：持有 400 根 4h K 线被收 166 万，占 500 万保证金的 33%；
         3000 根时是 742 万 = 148%，而课上的盈亏是按保证金算死的，账就这么漂了）。
         装在这里是因为 wrapMarket 是这一层**唯一**拿得到引擎实例的地方。
         判定本身用 session.fundingExempt（只有「当前这一单 + 引导开着」才免）。 */
      if (typeof market.setFundingExempt === 'function') {
        market.setFundingExempt(id => !!(session && session.fundingExempt(id)));
      }
      const wrapped = {
        ...market,
        submitOrder(order) {
          if (!session || !session.active()) return market.submitOrder(order);
          const side = order.side === 'short' ? -1 : 1;
          return session.guardOpen(side, s => market.submitOrder({ ...order, side: s === -1 ? 'short' : 'long' }));
        }
      };
      /* 限价委托（第五课）：引擎有 placeLimit 才包 —— 没有的时候**不能**凭空造一个，
         面板的 orderTypes() 就是看「这个函数在不在」来决定那颗按钮亮不亮的。 */
      if (typeof market.placeLimit === 'function') {
        wrapped.placeLimit = order => {
          if (!session || !session.active()) return market.placeLimit(order);
          return session.guardLimit(order, o => market.placeLimit(o));
        };
      }
      return wrapped;
    }
    /* ★ 原来这里有一块 buildSettings()：设置面板里的「新手引导进行中…」+「从头再学一遍」
       +「离开新手引导」三件套。2026-10-04 按口径**从面板里撤掉了**（屏幕上不该出现「引导」
       二字），于是它没有任何调用点 —— 整块删掉，连同导出。
       代价是明确的、也写在 settingsPanel 那边：现在没有入口能重学一遍，
       唯一的出口是顶栏那颗 ⏏（`requestLeave` / `leaveNow` 仍然有人用，见 mountUi）。
       `session.resetProgress()` 因此也没有界面入口了，但它还在 session 的导出面上
       （自检与探针会调），所以留着。
       ★ 2026-10-19 补回一个**最小**入口：设置面板底部那颗「从头再学一遍」调 restart()。
         它不摆「新手引导进行中」那类字，只做一件事 —— 把教学进度清掉、回到第一课。
         为什么补：用户报「教程没有渲染出来」，而按过 ⏏（left）的人没有任何办法回到课表。 */
    function restart() {
      if (!session) return false;
      /* 挂着的限价单没有仓位可查，单独拦一下：不拦的话它之后按真实行情成交，
         那一笔就绕过了引导（不掷骰子、不铺价、也不记成绩）。 */
      if (positions().length || session.session.pending) {
        CS.uiBits.toast('先把持仓平掉、把挂着的单撤掉，再从头开始。', 'neg', 5000);
        return false;
      }
      const ok = session.resetProgress();
      if (ok && !session.active()) session.start();
      render();
      return ok;
    }

    /* 挂界面：每次挂交易页时叫一次（切模式会把 modeHost 清空，界面跟着走）。
       状态机与「那一局的方向盘」不重建 —— 见 create 顶上那一段。 */
    function mountUi(host) {
      if (guide !== NO_UI) guide.dispose();
      uiHost = host;
      /* ★ 界面挂到 **document.body**，不是 modeHost 里面 —— 这一层是 position: fixed 的浮层，
         而 #modeHost 的祖先带 transform/contain（壳为了动画加的），
         在那个上下文里 fixed 会退化成「相对那个容器定位」：
         实测 .tut-layer 只有 741×488（容器那么大），老师条 left 落到 -8（半个条子跑出屏幕外），
         聚光标记算出来在 2400px 之下根本看不见。挂到 body 上才是真正的视口坐标。
         回收由 unmountUi 负责（挂新的之前先把旧的 dispose）。 */
      guide = CS.tutorialGuide.mount(document.body);
      /* ★ 只交 leave：老师条上那三颗按钮（前进 → / 跳过这一课 / 重讲一遍）连同它们的
         处理函数一起删掉了（见上面那两处说明），留着 act/skip/repeat 这三个名字会**当场
         ReferenceError** —— 而它发生在 mountUi 里，把下面那句 session.restore() 一起带走：
         表现是「引导永远不启动」（界面上一切正常，只是 ⏏ 不出来、照顾也不生效）。 */
      guide.handlers({ leave: requestLeave });
      /* ★ 启动时进入：**所有人都要走新手教程** —— 只要还没按过那颗 ⏏，进这个模式就在引导里。
         放在这里（面板挂上之后）而不是 init 里：引导的课程设置要写进面板的界面状态
         （交易对 / 周期 / 一单多少保证金 / 杠杆 / 下单方式），
         而那份状态在面板挂上之前还不存在 —— 早一步做，那几个设置会**静默丢掉**，
         于是引导开着、保证金却是 0，玩家一点「做多」只得到一句「请先填写保证金」。
         restore() 自己是幂等的（已经 active 就直接返回 false），重复挂载不会重来一遍。 */
      if (session) session.restore();
      render();
      return guide;
    }
    function unmountUi() {
      if (guide !== NO_UI) guide.dispose();
      guide = NO_UI;
      uiHost = null;
    }

    return {
      get session() { return session; },
      init, render, wrapMarket, leaveNow, requestLeave, restart, mountUi, unmountUi,
      isActive: () => !!(session && session.active()),
      /* 模式在合适的时候调它：切进这个模式、推进一步之后都该重画一次 */
      refresh: render
    };
  }

  return { classicTutorial: { create } };
});
