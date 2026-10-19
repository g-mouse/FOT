/* ============ 模拟模式 · 回放控制（推进时间 / 自动播放 / 存档 / 键位） ============
   玩法就是「虚拟资金 + 历史行情回放」：**时间不走，账就不会变**。所以这一层是模拟模式唯一的
   时钟驱动，口径与故事模式逐条对齐（见 modes/story/mode.js 的 advanceBars 与 modes/story/keys.js）：
     一格 = 一根 4h K 线（故事模式空格键也是这一格）· 一天 = 6 根（barsPerDay 走端口，不抄常量）·
     一周 = 7 天 · 自动播放 = 每 playMs 毫秒走一格，再按一次停。

   每走一根都要 settleStep()：撮合挂单 → 判定强平 → 结算资金费 → 记账权益曲线。少这一步，
   挂单永远不会成交、强平永远不发生 —— 那不是「慢一点」，是玩法没了。
   ★ 揭晓之后还得等这一轮的抖动**走完**（走到过 H/L）才允许下一根继续 —— 见 emitStepped / waitSettled。

   为什么存档也在这里：账户与时钟是「这一局」的全部状态，两者必须一起落盘、一起还原；
   只存一个就会出现「钱回来了、时间没回来」这种对不上账的档。落盘时机 = 每个日界一次 +
   交易成交（面板发 trade.changed 之后去抖），不每一根都写盘。 */
CS.define('modes/classic/replay', ["core/animation/tickEngine","core/base/autoPlay","core/base/keyDispatch","core/base/util","core/events/events","core/indicators/indicatorColors","core/indicators/indicatorState","core/indicators/registry","core/market/filter","core/market/marketData","core/market/resample","core/text/i18n","core/tutorial/copy","lib/lodash","modes/classic/loan","modes/classic/previewLine","ui/components/bits","ui/components/tradeModel"], function () {
  'use strict';
  const ns = CS.open('classic');

  const SAVE_KEY = 'cs:classic:slot1';
  /* 默认播放间隔：与 tickEngine 的 DEFAULTS.playMs **同一个数**（500 = 面板上的「500ms」）。
     曾经这里是 1400、而 tickEngine 的 DEFAULTS 是 1500 —— 同一个设置两个默认值：
     退出引导时还原成这一层读到的那个数，于是「默认是多少」取决于是谁问的。
     改动这一格时**必须同时改 tickEngine.DEFAULTS.playMs**（反之亦然）。 */
  const DEFAULT_PLAY_MS = 500;
  /* ★ on / timer 不再住在这里 —— 自动播放的状态与定时器归 core/base/autoPlay.js。
     同一份状态两个地方各存一份，迟早会出现「按钮显示在播、实际停了」（或反过来）。 */
  const play = { busy: false, speed: 1, playMs: DEFAULT_PLAY_MS };
  /* 动画设置（播放间隔 / 抖动开关 / 抖动档位）：**显示偏好**，与指标设置同一类，
     跟着这一局的存档走，刷新之后还在。它住在这一层是因为「谁存档谁负责它」——
     写在别处就会出现「存的时候有、读的时候没人恢复」的漂移，而漂移不报错，
     只表现为刷新一次设置就没了。起效与接线在 modes/classic/tick.js。 */
  /* 抖动档位默认 3×、开关默认开 —— 与 tickEngine.DEFAULTS 逐字一致（面板要能选中那一颗按钮） */
  const anim = { jitter: true, jitterCount: 3, playMs: DEFAULT_PLAY_MS };
  /* 注：订单预览线的价与下单面板的「委托价格」是**同一个数**（拖线与填数字互相同步），那一格连同它的两条夹取规则已搬到 modes/classic/previewLine.js。 */

  const ready = () => !!(ns.host && ns.ports && CS.marketData && CS.marketData.ready);
  /* 一根基础 K 线几小时（4）：周转借款的利息按根累加，换算只在这一处 */
  const baseStepHours = () => {
    try {
      const meta = CS.marketData.getDatasetMeta();
      return Math.max(1, Math.round((Number(meta.stepMs) || 4 * 3600000) / 3600000));
    } catch (_) { return 4; }
  };
  const barsPerDay = () => (ready() && typeof ns.ports.clock.barsPerDay === 'function' ? ns.ports.clock.barsPerDay() : 6);
  const now = () => (ready() ? ns.ports.clock.now() : null);
  /* 走到最后一根之后就别再推了：时间在走、行情不动（「按了一百次什么都没发生」）且权益曲线会被同一根价格记上一百个点。 */
  function atEnd() {
    if (!ready()) return true;
    const t = now();
    const count = CS.marketData.countOf(ns.instrumentId);
    return Number.isFinite(count) && count > 0 && t.barIndex >= count - 1;
  }
  function refresh() { CS.events.bus.emit('trade.render', {}); }

  /* ★ 一根揭晓了就发一次：它的意思是「去抖**这一根**」，不是「这批推完了」—— 一次推进 N 根就发 N 次，
     每根都要抖自己那一轮（早先只有最后那根抖，前面 N-1 根一帧都没动过，那正是要修的缺口）。
     为什么另发一个、而不复用 classic.playback.changed：那一个是「播放开关变了」的意思（autoPlay 自己发），
     **手动推进不发它** —— 早先靠它起抖动，于是空格/「前进 →」推进时抖动根本不启动，只有自动播放是好的
     （两种推进不一致，最难查的那一类）。订阅者只有 tick.js 与 tutorial.js（按光标铺价，幂等）：
     抖动层排在本文件之后（加载期这里看不见它，只能靠事件找它），铺价幂等 —— 多发几次都安全。 */
  const emitStepped = () => CS.events.bus.emit('classic.stepped', { barIndex: ready() ? now().barIndex : null });

  /* 等这一轮抖动**走完**（进度到 1，而路径规划保证那时 H 与 L 都走过）再揭下一根：★ 不等的话，
     下一轮 beginTick 会把还没走完的这一轮直接盖掉 —— 那根一帧都没摸到极值，而 H 与 L 是玩家读影线的
     唯一依据，等于给他看了一根假影线。接口在 tick.js 上（它排在本文件之后），拿不到就当「不等」；
     一次动画等不到也不该把推进打挂，所以整段兜住异常、只记 CS.errors 不抛。 */
  async function waitSettled() {
    try { return ns.tick && typeof ns.tick.settled === 'function' ? await ns.tick.settled() : false; }
    catch (error) { CS.errors.push({ message: `等待抖动走完失败：${error && error.message}` }); return false; }
  }

  async function advanceBars(bars, opts) {
    if (!ready() || play.busy) return false;
    /* ★ 追保弹窗开着时**不许推进**（与旧引擎的 flags.riskPaused 同一规矩）：那一下的结算
       已经发生、玩家正在读说明，再推一根就是在弹窗背后继续亏钱。解药只有关掉那张弹窗。
       ★ 2026-10-19：这里原来每拍都弹一句「追保弹窗还开着」—— 自动播放时会一直刷屏。
         弹窗本身就是提示，这里不再 toast；同时把自动播放停掉，否则它每一拍都回来撞这道门。 */
    if (ns.settings && ns.settings.paused()) {
      if (auto.isOn()) auto.setAutoPlay(false);
      return false;
    }
    const count = Math.max(1, Math.round(Number(bars) || 1));
    /* ★ 一次只走 1 根才逐根等抖动；一次走 N 根（「推进一天/一周」、跳转）是**快进**，
       逐根等就是 N×(0.9×playMs)，一周 180 根能挂上四分钟 —— 那不是动画，是卡死。 */
    const animate = !(opts && opts.animate === false) && count === 1;
    /* ★ 引导这一单走到「该平仓」那一根之后，**一次推进不许跨过它**：那一根是课上留给玩家点「平仓」的位置，
       而亏单的收尾正好在这一根扎穿强平价 —— 放它过去，玩家按一下「推进一周」，这一单就在他还没机会平仓
       时被结算掉了。只挡批量（一次多根）；「前进 →」/空格一次一根，不受限。
       ⚠ 必须取 ns.tutorial.session：这一段原来写 `ns.guide`，而它**全库没有赋值点**，于是这次拦截与
       下面那次 syncToCursor **从未执行过** —— 铺价跟不上光标，20× 下一根大阴线就能把这一单爆掉。 */
    /* ★ 原来这里有一道「引导这一单走到该平仓那一根之后，一次推进不许跨过它」的拦截
       （guideSession.advanceBlocked）。2026-10-04 按产品口径拿掉了：引导要看起来就是主游戏，
       而它是一只看不见的手 —— 拦下来只弹一句「先点平仓结算」，老师条撤掉之后那句话
       也没地方讲，玩家只会觉得按钮失灵。现在一次推进多少根由玩家说了算，
       亏单也不再有人替他扎穿强平价（见 core/tutorial/priceOverlay.js 的说明）。 */
    if (atEnd()) {
      if (auto.isOn()) auto.setAutoPlay(false);
      CS.uiBits.toast(CS.i18n.t('classic.progressEnd', { bar: now().barIndex + 1 }), '', 5200);
      return false;
    }
    play.busy = true;
    try {
      for (let i = 0; i < count; i++) {
        const before = now();
        await ns.ports.clock.advanceBars(1);
        /* ★ 引导铺价必须抢在**结算之前**（见 session.syncToCursor）：那一步的强平判定
           读的是刚推进到的那一根的影线，而引导按光标铺价 —— 铺不到的那一根还是真实影线，
           一单被照顾着的赢单会在玩家从没见过的价上被扫爆。
           ⚠ 原来读 `ns.guide`（全库无赋值点）→ 这句恒为假、从未执行。 */
        if (ns.tutorial && ns.tutorial.session) ns.tutorial.session.syncToCursor();
        ns.host.step();
        /* 周转借款按**这一根的小时数**计息（不推进就不计息：时间只在这里往前走）。
           放在结算之后：这一根的强平与资金费先落地，利息再滚进去 ——
           顺序反过来的话，利息可能刚好把余额压到爆仓线下，而那一根却按「没爆」结算了。 */
        if (ns.loan) ns.loan.accrue(baseStepHours());
        if (now().dayIndex !== before.dayIndex) save();
        /* ★ 先把**这一根的图**换掉，再起抖动：
           抖动驱动的第一帧比 400ms 那一拍早，图表若还拿着上一根的 bars，
           第一帧就会把「上一根」当成最新一根去抖（看起来就是一条别的 K 线闪一下再回去）。
           换图之前还要先 beginGrow(这一根)：否则新 bars 会先按满宽画一帧，
           下一帧才开始长 —— 同样是一条「闪一下」。
           单根推进/自动播放才走这一下；批量推进（一周）每根都全量重画会把快进拖慢。 */
        if (animate) {
          try {
            if (ns.tick && ns.tick.beginGrow) {
              const bar = ns.tick.liveBar ? ns.tick.liveBar() : null;
              ns.tick.beginGrow(bar ? bar.t : null);
            }
          } catch (_) {}
          refresh();
        }
        emitStepped();                       /* 这一根揭晓了：起一轮抖动（语义见上面 emitStepped） */
        if (animate) await waitSettled();    /* 等它走完（扫过 H 与 L）再揭下一根 —— 这就是那道闸门 */
        if (atEnd()) break;
      }
    } catch (error) {
      CS.errors.push({ message: `推进时间失败：${error && error.message}`, stack: error && error.stack });
    } finally {
      play.busy = false;
    }
    refresh();
    return true;
  }
  /* 推进 N 天：一天 = barsPerDay 根，按根走（见上面那段口径） */
  const advanceDays = (days, opts) => advanceBars(Math.max(1, Math.round(Number(days) || 1)) * barsPerDay(), opts);

  /* 一次「前进」走几根基础线 —— 由设置槽的 stepHours 决定（旧教程页的 STEP_OPTIONS 同一套）：
       0 = 跟随图表周期（4h 图走 1 根、12h 图走 3 根）· 其它值 = 按小时数折算（12 小时 → 3 根 4h）
     ★ 它同时是引导的节奏：引导把步长定成与周期一致（12h/12h），于是「点一下 = 长出一根新 K 线」；
     步长比周期小时，最右那根就成了整格的聚合，一次「前进」只走完它的一部分，课上那个节奏就没了。 */
  function stepBars() {
    const meta = CS.marketData.getDatasetMeta();
    const baseHours = Math.max(1, Math.round((Number(meta.stepMs) || 4 * 3600000) / 3600000));
    const chosen = Number(ns.settings ? ns.settings.get('stepHours') : 0) || 0;
    const tfHours = chosen > 0 ? chosen : CS.resample.tfOf(ns.settings ? ns.settings.get('timeframe') : '4h').hours;
    return Math.max(1, Math.round(tfHours / baseHours));
  }
  /* 「前进 →」：把这一步走掉。**按钮、空格、引导的 hop 都走它**，于是一次点动的幅度只有一处定义 */
  const nextStep = opts => advanceBars(stepBars(), opts);

  /* 自动播放的两个函数（schedule / setAutoPlay）已搬到 core/base/autoPlay.js，与故事模式共用同一份实现。 */

  function setSpeed(x) {
    const s = Math.max(0, Math.min(8, Number(x) || 1));
    play.speed = s;
    if (ready()) ns.ports.clock.speed.set(s);
    return s;
  }
  function stop() { auto.setAutoPlay(false); }

  /* ================= 订单预览线（图上唯一可拖的那条） =================
     整段在 modes/classic/previewLine.js（这个文件压不住**当时**的 400 行上限了）。 */
  const preview = CS.classicPreviewLine.create({ ready, now, instrumentId: () => ns.instrumentId });
  const clampPreview = preview.clamp, previewPrice = preview.price, setPreviewPrice = preview.set;

  /* ================= 动画设置 =================
     改一处就落盘、并让新间隔立刻生效（重排自动播放），否则玩家会以为没生效；
     抖动那一层的重起由 tick.js 负责（它拿 configure 重起一轮）。

     ★ opts.persist === false 是**引导**要的那一档：课上把抖动关掉、把间隔改成 700 都是临时状态，
     **不该写进玩家的偏好**（见 settings.js 的 set 说明）—— 否则引导一旦没有正常退出（刷新页面、
     探针把整块引导关掉），玩家就再也拿不回自己那一套动画设置，而且一条错都不报。 */
  function setAnim(patch, opts) {
    const next = CS.tickEngine.normalizeAnim(Object.assign({}, anim, patch || {}));
    anim.jitter = next.jitter;
    anim.jitterCount = next.jitterCount;
    anim.playMs = next.playMs;
    play.playMs = next.playMs;
    auto.reschedule();                    /* 播放中改间隔要立刻生效 */
    if (!(opts && opts.persist === false)) save();
    /* ★ 通知抖动层按新设置重起一轮（关掉就停、档位变了当场重抖）。
       为什么走事件而不是直接调 ns.tick：tick.js 排在本文件之后，加载期这里看不见它。
       少了这一行，表现是玩家把开关关掉了、价格还在跳（实测踩过）。 */
    CS.events.bus.emit('classic.anim.changed', Object.assign({}, anim));
    return Object.assign({}, anim);
  }

  /* ================= 存档 ================= 存的是「这一局怎么来的」：时钟（第几根 + 速度 + 历元）与
     账户（现金 / 持仓 / 结算记录 / 权益曲线 / 挂单序号）。派生量一律不存，读档时重算。 */
  function save() {
    if (!ready()) return false;
    try {
      const payload = {
        v: 1, mode: 'classic',
        clock: ns.ports.clock.serialize(),
        account: ns.host.account.serialize(),
        /* 还挂着的限价委托也要落盘：不存的话，刷新一次页面挂单就凭空消失了，
           而玩家记得自己挂着单（引擎的 pending 不在 account 里，是另一本账）。 */
        orders: ns.host.market.serializePending(),
        /* 指标设置（开了哪几个、参数、颜色）也落盘。
           它是**显示偏好**而不是这一局的账：不存的话刷新一次全没了，
           而玩家刚在指标栏里调好的参数会莫名其妙回到默认 —— 那看起来像 bug。
           存的是**状态本身**（state()），不是 snapshot()：
           后者是给调试面板与自动化看的读数（含这一帧算出来的值），存它没意义。
           故事模式那边不用这一格：它跟着 state 走（见 story/state.js）。 */
        indicators: (CS.indicators && CS.indicators.state) ? CS.indicators.state() : null,
        /* 动画设置（间隔 / 抖动开关 / 档位）：与指标同一类，是显示偏好而不是这一局的账 */
        anim: { jitter: anim.jitter, jitterCount: anim.jitterCount, playMs: anim.playMs },
        /* 设置槽（三个交易开关、六条价格线开关、一屏根数、步长、悬浮窗）：
           同样是显示偏好，**不参与对账**，所以单独一格、也不跟着「重置账户」被清掉。 */
        settings: ns.settings ? ns.settings.serialize() : null,
        /* 周转借款那一本账：它是**这一局的欠款**（不是偏好），所以跟着账户一起进出 */
        loan: ns.loan ? ns.loan.serialize() : null,
        /* 订单预览线的价：与动画设置同一类（都是「玩家挑过的数」），刷新之后要还在 */
        preview: { price: preview.stored },
        ui: { instrumentId: ns.instrumentId, speed: play.speed, playMs: play.playMs }
      };
      /* ★ 落盘之前过一遍引导的 patchForSave：引导改过的那几格（抖动 / 播放间隔 /
         二次确认 / 一屏根数 / 周期 / 步长 / 交易对）换成**玩家自己那一份**。
         少了这一步，课上随手成交一单就把引导的临时值永久写进偏好 ——
         退出引导时内存还原了，刷新一次又被读档覆盖回去（实测踩过，见 sessionSettings 的文件头）。 */
      const persist = (ns.tutorial && ns.tutorial.session && ns.tutorial.session.settings
        && ns.tutorial.session.settings.patchForSave)
        ? ns.tutorial.session.settings.patchForSave(payload) : payload;
      localStorage.setItem(SAVE_KEY, JSON.stringify(persist));
      return true;
    } catch (error) {
      CS.errors.push({ message: `模拟模式存档失败：${error && error.message}` });
      return false;
    }
  }
  function readSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return data && data.mode === 'classic' ? data : null;
    } catch (error) {
      CS.errors.push({ message: `模拟模式存档读不出来（已当作新开一局）：${error && error.message}` });
      return null;
    }
  }
  /* 读档**不许**把模式打挂：形状不对就当新开一局，并把原因留在 CS.errors 里 */
  function restore(data) {
    if (!ready() || !data) return false;
    try {
      ns.host.account.restore(data.account);
      ns.host.market.restorePending(Array.isArray(data.orders) ? data.orders : []);
      ns.ports.clock.restore(data.clock);
      /* 指标设置回填：整份交给引擎，它下次 state() 会自己归一与夹取 ——
         所以旧档（没有这一格）与形状不合的档都不会把它读崩，不需要在这里校验。 */
      if (data.indicators && typeof data.indicators === 'object') indicatorBag.indicators = data.indicators;
      /* 设置槽：整份交给它归一（旧档没有这一格、或手改坏了都读得回来） */
      if (ns.settings) ns.settings.restore(data.settings);
      /* 周转借款：同样整份交给它归一（老存档没有这一格 → 当作没借过） */
      if (ns.loan) ns.loan.restore(data.loan);
      const ui = data.ui || {};
      play.speed = Number(ui.speed) || 1;
      play.playMs = Number(ui.playMs) || DEFAULT_PLAY_MS;
      /* 动画设置回填：整份交给引擎归一（旧档没有这一格、或填了 9999 都夹回来），
         所以这里不必自己校验 —— 归一规则只有一份，在 tickEngine.normalizeAnim。 */
      const restoredAnim = CS.tickEngine.normalizeAnim(
        Object.assign({}, data.anim || {}, { playMs: (data.anim && data.anim.playMs) || play.playMs })
      );
      anim.jitter = restoredAnim.jitter;
      anim.jitterCount = restoredAnim.jitterCount;
      anim.playMs = restoredAnim.playMs;
      play.playMs = restoredAnim.playMs;
      /* 预览价：读档回来照旧走 clamp（离现价太远就落回现价），
         所以旧档、坏档都不会让那条线跑到画布外去 */
      preview.restore(data.preview && data.preview.price);
      /* ★ 这一格是「读档回来那个交易对还算不算数」。判据必须与界面**同一份口径**
         （CS.tradeModel.listInstruments = 此刻真的能交易的那些）：
         原来读的是 CS.marketData 的原始名单，于是存着一个「还没上市」的交易对也能过关，
         读档之后图上直接是「未上市」，而列表里根本没有它。 */
      if (ui.instrumentId && CS.tradeModel.listInstruments().some(i => i.id === ui.instrumentId)) {
        ns.instrumentId = ui.instrumentId;
      }
      ns.ports.clock.speed.set(play.speed);
      ns.ports.clock.reveal();
      return true;
    } catch (error) {
      CS.errors.push({ message: `模拟模式读档失败（已新开一局）：${error && error.message}`, stack: error && error.stack });
      return false;
    }
  }
  /* 过滤改完之后把光标**拉到可交易区里、而且这一屏是填满的**那一根上
     （旧引擎的 afterFilterChange 同一件事，只是落点往里挪了一屏）。
     不拉的话：开着过滤、光标还停在开头那一段，图上什么都没有（被过滤掉了）、
     下单全被拒 —— 玩家看到的是一个「坏掉的界面」，其实是设置与光标不在同一个位置上。
     ★ 落点不是 floor 本身，而是 floor 再往里**一屏**：图表**不画**被隐藏的那一段
     （见 ui/components/tradeModel.js 的 barsFor），所以停在 floor 上时那一屏只剩 1 根 K 线
     （被过滤的那些天正好都在光标左边）。而过滤的初衷是「更接近有历史的行情」——
     落点就得让它左边真的有一屏历史；否则默认的 365 天过滤一进游戏就是一根孤零零的蜡烛。
     一屏几根读设置里的 bars：它与面板的 ui.bars 同源（modes/classic/mode.js 的 panel.setUi），
     所以这里算出来的一屏与图上真正要画的那一屏是同一个数。
     只前进不后退：光标本来就在可交易区里时什么都不做。 */
  function syncFilterCursor() {
    if (!ready() || !CS.marketFilter) return false;
    const floor = CS.marketFilter.unlockIndexOf(ns.instrumentId);
    if (!floor) return false;
    const bars = ns.ports.clock.now();
    if (bars.barIndex >= floor) return false;
    /* 一屏几根：设置槽是唯一真源。取不到就退回 1（= 旧行为：停在 floor 上），
       不至于因为一个读不到的设置把光标推到没边的地方。 */
    const screen = ns.settings ? Math.max(1, Math.round(Number(ns.settings.get('bars')) || 1)) : 1;
    /* 别推到这只交易对还没走到的地方（它自己的最后一根）：
       过滤把起点往后挪了，短历史的品种可能真的没有一屏可看。 */
    const series = CS.marketData.seriesRef ? CS.marketData.seriesRef(ns.instrumentId) : null;
    const last = series && Number.isFinite(series.count) ? series.off + series.count - 1 : Infinity;
    const target = Math.min(floor + screen - 1, last);
    ns.ports.clock.restore({ v: 2, barIndex: target, speed: play.speed });
    /* reveal 是**时钟端口**上的方法（它把 marketData.nowIndex 拨到时钟这一格） */
    ns.ports.clock.reveal();
    refresh();
    save();
    return true;
  }

  /* 重置：账户回到初始资金、时钟回到第一根，并把新状态立刻落盘 */
  function reset() {
    if (!ready()) return false;
    auto.setAutoPlay(false);
    ns.host.account.reset(ns.initialCash);
    ns.host.market.restorePending([]);      // 挂单也跟着清掉：清了账却留着单，那单迟早会用自己的钱成交
    /* 欠款也是这一局的账：账户重置要把它一起清掉（留着一笔旧债，新的一局一开局就是负的） */
    if (ns.loan) ns.loan.reset();
    ns.ports.clock.restore({ v: 2, barIndex: 0, speed: play.speed });
    /* ★ 「回到第一根」在开着行情过滤时指**可交易区的第一根**：不拉的话，重置之后
       光标停在 2017（过滤要藏掉的那一段），图上一根 K 线都画不出来、下单全被拒 ——
       玩家按的是「重置账户」，看到的却像「这局坏了」。与 onEnter 那一处同一个判据。 */
    syncFilterCursor();
    refresh();
    save();
    return true;
  }

  /* ================= 键位 =================
     与故事模式**同一套操作**（同一个交易界面，键位不该是另一套）：
     空格 = 前进一根、A = 自动播放、↑↓ = 换交易对。
     键位只在模拟模式当前台时接管：这一层是全局 keydown，少了那道判断，
     在故事模式里按空格会推进模拟模式的回放。 */
  /* 键名归一与让路判据都住在 core/base/util.js 里，**与故事模式共用那一份** ——
     两套各写一遍已经漂移过（这一份少了 Digit 分支与几个别名）。 */
  const { keyOf, normalizeKey, keyLabelOf: labelOf } = CS.util;

  /* ---------------- 换交易对（顺序 = 交易页左侧列表此刻列出来的那一批） ----------------
     ★ 「当前是哪一个」不能去读 ns.instrumentId —— 那一格只在开局 / 读档时被写过，交易页里换品种
     **不会**回写它（品种选择是交易页的私有 ui：tradePanel.js 的 ui.instrumentId）。用它的后果是
     逐帧试玩抓到的这一条：连按 ↓ → 第一次从 ns.instrumentId 算出「下一个」发出去、界面换了；
     第二次又从**同一个** ns.instrumentId 算出同一个目标，而面板的 selectInstrument 有
     `id === ui.instrumentId` 的早退 → 界面收下、状态不动，看上去就是「方向键只灵一次」；
     按 ↑ 则会一次跳到第 17 个（因为 panel 的 ui 已经走到别处，而这里的基准还停在 BTCUSDT）。
     品种选择对外的**唯一**通道就是 trade.select 事件 —— 这里订阅它、把值记在自己这一格
     （与故事模式 modes/story/keys.js 的 storyKeysPair 同一套做法，那一边早就这么写了）。
     初始值取开局时定的那个品种。 */
  let currentInstrumentId = null;
  if (CS.events && CS.events.bus) {
    CS.events.bus.onKey('trade.select', 'classicKeysPair', payload => {
      if (payload && payload.instrumentId) {
        currentInstrumentId = payload.instrumentId;
        /* ★ 同时把模式手里那一格跟上：save() 的 ui.instrumentId 写的就是它。
           不跟的话，用方向键换过品种之后存档里记的还是开局那个 —— 刷新一次
           光标回到 BTCUSDT，而玩家以为自己一直在看另一个品种。 */
        ns.instrumentId = payload.instrumentId;
      }
    });
  }
  function switchPair(step) {
    const list = (CS.tradeModel && CS.tradeModel.listInstruments) ? CS.tradeModel.listInstruments() : [];
    const ids = list.map(x => x.id);
    if (!ids.length) return false;
    const current = currentInstrumentId || ns.instrumentId;
    const at = ids.indexOf(current);
    const index = at < 0 ? (step > 0 ? 0 : ids.length - 1) : (at + step + ids.length) % ids.length;
    currentInstrumentId = ids[index];
    ns.instrumentId = ids[index];
    CS.events.bus.emit('trade.select', { instrumentId: ids[index] });
    return true;
  }

  /* 自动播放走共用那一份（core/base/autoPlay.js）：一拍一根、自己排下一拍、
     走到数据末尾自动停 —— 与故事模式逐字同源，只有间隔来源与停止判据不同。 */
  const auto = CS.autoPlay.create({
    intervalOf: () => play.playMs,
    step: () => { nextStep(); },
    shouldStop: () => atEnd(),
    event: 'classic.playback.changed'
  });
  const BINDINGS = [
    { key: 'Space', label: 'st.key.next', run: () => nextStep(), preventDefault: true },
    { key: 'ArrowUp', label: 'st.key.prevPair', run: () => switchPair(-1) },
    { key: 'ArrowDown', label: 'st.key.nextPair', run: () => switchPair(1) },
    { key: 'A', label: 'st.key.autoPlay', run: () => auto.toggle() }
  ];
  /* 键位分发也走共用那一份（core/base/keyDispatch.js）。原先两个模式各写一遍，
     press 实测 96% 逐字重合 —— 差别只有三处：模式名、就绪判据、
     以及故事那边多一条「这一局结束了就别动」。那三处现在通过参数进来。 */
  const keys = CS.keyDispatch.create({
    mode: () => 'classic',
    bindings: BINDINGS,
    /* 就绪之前不吃键：行情还没装上时推进一根没有意义 */
    canRun: () => ready()
  });
  const press = keys.press;
  const mountKeys = keys.mount;
  const toggleAutoPlay = () => auto.toggle();
  const setAutoPlay = on => auto.setAutoPlay(on);
  const hints = () => keys.hints();

  /* 指标的「背包」：CS.indicators 是宿主注入的（它不认识任何模式），模拟模式这边就住在这一格，
     跟着 save() / restore() 一起落盘；故事模式不用这一格 —— 它的背包是这一局的 state。
     放在这里而不是交易页：**存档读档的人负责它**；写在别处就会出现「存的时候有、读的时候没人恢复」
     的漂移，而漂移不报错，只是刷新一次设置就没了。 */
  const indicatorBag = { indicators: null };

  ns.replay = {
    advanceBars, advanceDays, setAutoPlay, toggleAutoPlay, setSpeed, stop, reset,
    save, readSave, restore, refresh, atEnd, now, barsPerDay, setAnim, stepBars, nextStep, syncFilterCursor,
    /* 订单预览线的价（图上那条可拖的线）：读/写各一个口，夹取与取整都在里面。
       它同时是下单面板「委托价格」那一格的数 —— 拖线与填数字改的是同一处。 */
    previewPrice, setPreviewPrice,
    mountKeys, press, hints, labelOf, normalizeKey, keyOf,
    get state() { return { on: auto.isOn(), busy: play.busy, speed: play.speed, playMs: play.playMs }; },
    get autoPlay() { return auto.isOn(); },
    get indicatorBag() { return indicatorBag; },
    /* 当前动画设置（**只读快照**，每次取都是新对象）：设置面板、抖动层与自检都读它。
       写它只有一条路 setAnim —— 它负责夹取、落盘、并按新间隔重排自动播放。
       给快照而不是给那一格本身：外面临时改一下（`anim().playMs = 1`）不该改到这一局。 */
    get anim() { return Object.assign({}, anim); }
  };
  return { classicReplay: ns.replay };
});
