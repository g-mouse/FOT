/* ============ classic · 模拟模式 ============
   玩法：虚拟资金 + 历史行情回放。撮合与失真在 core/marketEngine，
   账户（唯一改钱入口）在 core/accountEngine，回放控制在 modes/classic/replay.js。

   ★ 交易页与故事模式是**同一张**（ui/components/tradePanel.js）：
     两个模式挂同一个组件、读同一套读数口径、用同一套术语，
     所以「换了个模式」不会换一套界面。模式差异只能通过 ctx 上的钩子表达
     （playback / keyHints / loan:false / state:null），这一层不许去改面板。

   这一层只做四件事：
     1) 开局：建宿主（core/host）→ 读档 → 默认品种 → 把行情游标拨到这一局的进度
     2) 挂交易页 + 一条回放控制条（推进时间是模拟模式独有的动作）
     3) 设置：重置账户 / 看这一局的数据集
     4) 新手教程那一扇门（见下）

   ============ 新手教程：已经长在新外壳里（不再挂 iframe）============
   从前这一扇门后面是旧教程页 game/index.html，上完课再换成共用的交易页。
   现在整块教程引擎都搬进了 core/tutorial（状态机、行情照顾、价格覆盖层、存档）
   与 ui/components/tutorialGuide（老师的话 / 进度条 / 聚光标记），装配在 modes/classic/tutorial.js
   —— 界面上**只有一套**交易页，引导只是浮在它上面的一层提示与四个接线。
   门禁的判据没变：只认那颗 ⏏（cs:gate:tutorialDone），由 session.exitForReal 写。 */
CS.define('modes/classic/mode', ["core/base/money","core/base/util","core/engine/host","core/events/events","core/market/marketData","core/market/randomWalk","core/text/i18n","lib/lodash","modes/classic/replay","modes/classic/settingsPanel","modes/classic/tick","modes/classic/tutorial","modes/registry","ui/components/bits","ui/components/tradePanel","ui/shell"], function () {
  'use strict';

  const ns = CS.open('classic');
  const { el, clear } = CS.util;
  const { button, muted, card, kv } = CS.uiBits;

  const INITIAL_CASH_USD = 10000;   // 与旧页面一致：一局从 10,000 美元开始

  let panel = null;         // 共用的交易页实例
  let hostEl = null;        // 页面的挂载点（回放条 + 交易页都在里面）
  let tradeOff = null;      // trade.changed 订阅（成交后去抖落盘）
  let eggBtn = null;        // 死局时设置旁的 🥚
  let eggTimer = 0;
  let eggOffs = [];
  /* 落盘的去抖器（lodash，见 CS.util.debounce）。它是**一个**实例而不是每次订阅新建：
     模式反复进入时同一份待写状态不该排两次队。 */
  const saveSoon = CS.util.debounce(() => { if (ns.replay && ns.replay.save) ns.replay.save(); }, 400);

  function hostNode() {
    const host = document.getElementById('modeHost');
    if (!host) return null;
    return host.querySelector('.mode-panels') || host;
  }

  /* ================= 开局 =================
     数据集 9.6MB，与故事模式共用同一份（core/host 只加载一次）。
     宿主一旦建好就一直在：切模式不清账户，切回来接着玩。 */
  async function ensureHost() {
    if (ns.host) return true;
    await CS.host.ensureDataset();
    if (!CS.marketData.ready) {
      CS.errors.push({ message: '模拟模式：行情包没就绪（data/market/bundle.js）' });
      return false;
    }
    const list = CS.marketData.listInstruments();
    ns.initialCash = CS.money.fromNumber(INITIAL_CASH_USD);
    ns.instrumentId = list.some(i => i.id === 'BTCUSDT') ? 'BTCUSDT' : (list[0] || {}).id;
    ns.host = CS.host.create({
      initialCash: ns.initialCash,
      instrumentId: ns.instrumentId,
      storageNs: 'cs:classic:'    // 与故事模式各存各的（cs:story: 是另一份命名空间）
    });
    ns.ports = ns.host.ports;
    /* 周转借款那一本账要跟着宿主一起建（它记的是这一局的欠款） */
    ns.loan.ensure();
    ns.replay.restore(ns.replay.readSave());
    /* ★ 行情游标（CS.marketData.nowIndex）是**全站唯一**的一个：
       两个模式各有一个时钟，谁最后 reveal 谁说了算。所以每次进这个模式都要
       把自己的进度重新拨一遍 —— 少了这一步，从故事模式切回来会看到
       故事那边的日期与 K 线（读数与账本对不上，且不报错）。 */
    ns.ports.clock.reveal();
    /* ★★ 行情过滤与光标必须对到同一处。过滤开着时（默认 365 天 / 统一起点）可交易区
       从 max(commonStart, 上线时刻) + 365 天起算，而光标刚从存档/起点恢复出来 ——
       不拉过去的话，图上画的正是被藏掉的那一段：**0 根 K 线**、下单全被拒。
       这一步以前是「顺带」发生的：引导会把根数/周期/步长/二次确认改成与玩家不同的一套，
       每次 set() 都发一条 classic.settings.changed，而那个订阅里捎带调了 syncFilterCursor()。
       默认值与引导那几项**一致**之后，settings.set() 在「值没变」时提前返回、一条事件都不发，
       于是没人再拉光标 —— 一进游戏就是那个「坏掉的界面」。所以在这里明叫一次。
       放在 ensureHost 里是因为它同时满足两个前提：**行情已就绪**（上面刚校验过）
       且**光标已恢复**（上一句 restore + reveal），而它一局只跑一次（ns.host 建好就返回）。 */
    ns.replay.syncFilterCursor();
    /* 抖动那一层：挂上「推进之后起一轮新的」这条订阅，并按这一局的设置起第一轮。
       attach 是幂等的（重复调用不会订两次），onEnter 每次进来都可以叫。 */
    ns.tick.ensure();
    ns.tick.attach();
    ns.tick.begin();
    /* 新手引导：整块教程引擎的装配（状态机 + 价格覆盖层 + 界面 + 那四个接线）。
       它必须排在宿主之后 —— 引导要读账户、要接管开仓入口、要按光标铺价。 */
    if (!ns.tutorial) {
      ns.tutorial = CS.classicTutorial.create({
        account: () => ns.host.account,
        replay: () => ns.replay,
        tick: () => ns.tick,
        uiState: () => (panel && panel.ui ? panel.ui() : {}),
        setUi: patch => { if (panel && panel.setUi) panel.setUi(patch); },
        anim: () => (ns.replay && ns.replay.anim) || {},
        setAnim: (patch, opts) => { if (ns.replay && ns.replay.setAnim) ns.replay.setAnim(patch, opts); },
        instrumentId: () => ns.instrumentId
      });
      ns.tutorial.init();
    }
    /* 成交 / 平仓 / 撤单之后去抖落盘：连点下单不该写几十次 localStorage。
       去抖本体是 CS.util.debounce（lodash）—— 与原先手写的 clearTimeout + setTimeout
       同义（400ms 静默窗口），不同的是取消只需要 saveSoon.cancel() 一句。 */
    if (!tradeOff) {
      tradeOff = CS.events.bus.onKey('trade.changed', 'classicSave', saveSoon);
    }
    return true;
  }

  /* ================= 共用的交易页 ================= */
  function tradeCtx() {
    return {
      /* 模拟模式没有剧情状态：面板与数据层读到的 state 是 null，
         债务 / 封账 / 抖动这些「故事才有的东西」自然不出现。 */
      state: () => null,
      account: ns.host.account,
      /* ★ 开仓走**引导包过一层**的那一个行情端口：引导开着时限方向、停抖动、
         接管这一段行情；没开着时原样透传（见 modes/classic/tutorial.js 的 wrapMarket）。
         面板完全不知道有这回事 —— 它调的仍然是同一个 submitOrder。 */
      market: ns.tutorial ? ns.tutorial.wrapMarket(ns.host.market) : ns.host.market,
      /* 没有 buff/debuff：模拟模式没有任何额外的交易限制（成交上限与熔断也已去掉） */
      limits: () => ({}),
      /* 「周转借款」：模拟模式这一本债（借入 / 按日计息 / 随时还）。
         拿不到（宿主还没建）时给 false —— 面板据此整块不画。 */
      loan: ns.loan.ctx(),
      /* ★ 设置槽：三个交易开关、六条价格线开关、一屏根数、步长。
         交易页通过这一个口子读它（tradeModel 的 flags 就走这里）——
         模拟模式没有剧情状态，state() 必须是 null（指标背包靠的就是这一点），
         所以偏好不能塞进 state，只能另开一个钩子。 */
      settings: key => ns.settings.get(key),
      instrumentId: () => ns.instrumentId,
      /* ★ 「引导还开着吗」这一格**删掉了** —— 判据现在住在 ui/components/tradeModel.js
         的模块级 tutorialOn() 里（静态入口 listInstruments 也要同一份答案，
         而它拿不到 ctx；原来那种「模式注入钩子」的写法会让两边各有一份判断，
         迟早出现「面板说 CXP、↑↓ 还能翻到别的品种」）。 */
      /* ★ 平仓时间戳与权益曲线的刻度同源：settleStep 写曲线时用的就是这一根 K 线的
         行情时间戳（core/marketEngine 的 now().ts）。这里以前传的是 barIndex（根号），
         与曲线里那些毫秒时间戳混在一起 —— 同一个字段两种单位。story 也走这一个数。 */
      closePosition: (id, price) => ns.host.account.closePosition(id, price, {
        kind: 'manual',
        ts: (CS.marketData && CS.marketData.ready && ns.ports)
          ? (CS.marketData.timeAt(ns.instrumentId, ns.ports.clock.now().barIndex) || 0)
          : 0
      }),
      playback: {
        toggle: () => ns.replay.toggleAutoPlay(),
        playing: () => ns.replay.autoPlay,
        /* 工具栏那颗「前进 →」：与空格 / 图上那颗推进一步**同一条路**（replay.nextStep）。
           不在面板里自己碰行情 —— 面板只负责喊一声。 */
        step: () => ns.replay.nextStep(),
        busy: () => !!ns.replay.state.busy,
        event: 'classic.playback.changed'
      },
      keyHints: () => ns.replay.hints().map(h => `${ns.replay.labelOf(h.key)} ${h.label}`).join(' · '),
      /* ★ 抖动（盘中跳动）：模拟模式从这一版起也有了 —— 旧版只有故事模式有，
         模拟模式的现价只在推进时跳一次，图是死的（用户就是拿这一点说「教程的界面更美观」）。
         两个数分开给：displayPrice 是**屏幕上**那个价，成交与结算一律走 settle
         （见 core/animation/tickEngine.js 文件头「抖动价算不算成交价」那一段）。 */
      displayPrice: (id, settle) => ns.tick.displayPrice(id, settle),
      ticks: ns.tick.ticks,
      /* 生长那一段的驱动（只回答「在不在播、走到哪儿了」）：不给就整段不播 */
      grow: ns.tick.grow,
      /* 现价那一点的波纹：value 只读，step 由面板的帧订阅每帧推一次 */
      pulse: ns.tick.pulse,
      /* 图上那条**可拖的订单预览线**（唯一的交互线）：
         current/set 是它的价（夹取与取整在回放那一层，见 replay.js 的 previewPrice），
         pick 是「点了别的线」——旧实现的做法是切到限价委托并聚焦委托价输入框，
         dropped 是松手时告诉玩家一声「可以按这个价挂单了」。 */
      priceLine: {
        current: () => Number.isFinite(ns.replay.previewPrice()) && ns.replay.previewPrice() > 0
          ? ns.replay.previewPrice() : 0,
        set: price => {
          const next = ns.replay.setPreviewPrice(price);
          CS.events.bus.emit('trade.render', {});
          return next;
        },
        pick: () => {
          CS.events.bus.emit('trade.orderType', { kind: 'limit' });
          ns.replay.save();
        },
        dropped: price => {
          CS.uiBits.toast(CS.i18n.t('classic.lineDropped', {
            price: CS.money.formatNumber(price, CS.marketData.digitsOf(ns.instrumentId))
          }), '', 6200);
          ns.replay.save();
        }
      },
      storage: { onChange: () => {} },
      disposeOffs: () => {}
    };
  }

  /* ================= 挂载：交易页 ================= */
  /* 设置槽 → 面板的界面状态。一屏根数与图表周期是**显示偏好**，唯一的那份住所是设置槽；
     面板 ui 上那两个字段只是「这一刻屏幕上的样子」。挂载时灌一遍、之后每次改槽都同步。
     不这么做的话两边会各说各话：改槽（设置面板里改）之后图不动，
     改面板（图上那排按钮）之后槽不动 —— 刷新一次就回到另一个数。 */
  function applySettingsToPanel() {
    if (!panel || !panel.setUi) return;
    panel.setUi({ bars: ns.settings.get('bars'), timeframe: ns.settings.get('timeframe') });
  }
  /* ================= 抖动扫到就强平 =================
     用户口径：**价格线（现价、强平线、保本线…）跟着抖动走，扫到哪条就按哪条算**。
     价格线本身每一帧都在重画（tradeModel.priceLines 用「屏幕上那个价」），
     但「扫到强平线」原来只在**推进那一根**摊牌一次（marketEngine.settleStep），
     玩家看不到「就是这一刻被扫到的」。这里在抖动每一帧上补一次同样的判定：
       · 判据用的是**同一个** account.checkLiquidation（core/engine/accountEngine.js），
         不另写一套比较 —— 线上新加强平口径时这里跟着走，不会两套算法各说各话；
       · 喂给它的 bar 是这一刻**屏幕上真出现过**的最高/最低（tickEngine 的 touched 包络）；
       · 结算价取 min(强平价, 最低) / max(强平价, 最高)，与跳空穿仓那条口径一致。
     调用时机：面板的帧订阅（与「读数逐帧刷新」同一条链，见 ui/components/tradePanel.js），
     那边已经按 80ms 节流 —— 一次判定要遍历全部持仓，不必每 16ms 跑一遍。 */
  function sweepTickLiquidation() {
    if (!ns.host || !ns.host.account || !CS.classicTick || !CS.classicTick.ticks) return 0;
    const touched = CS.classicTick.ticks.touched(ns.instrumentId);
    if (!touched || !Number.isFinite(touched.high) || !Number.isFinite(touched.low)) return 0;
    const at = ns.replay.now();
    const bar = { t: at ? at.barIndex : 0, o: touched.low, h: touched.high, l: touched.low, c: touched.high };
    const liquidated = ns.host.account.checkLiquidation(id => (id === ns.instrumentId ? bar : null)) || [];
    if (!liquidated.length) return 0;
    /* 留一条「就是这一刻扫到的」痕迹：结算价与当时的抖动进度一起进事件载荷。
       少了它，事后只能看 CS.errors（空的）与账户余额，「强平发生在抖动中还是落定后」
       两个说法都说得通 —— 而这一条正是这次改动要保证的东西。 */
    const tickState = CS.classicTick.ticks.info ? CS.classicTick.ticks.info(ns.instrumentId) : null;
    CS.events.bus.emit('market.liquidated', {
      trades: liquidated, duringTick: !!(tickState && tickState.running),
      tickProgress: tickState ? tickState.progress : 1, touched: { high: touched.high, low: touched.low }
    });
    ns.replay.refresh();
    return liquidated.length;
  }

  function mountTradePage(host) {
    clear(host);
    hostEl = host;
    const box = el('div', { class: 'classic-trade-host' });
    host.appendChild(box);
    panel = CS.tradePanel.mount(tradeCtx(), box, {
      /* 面板里改了什么就落盘（回放控制条已去掉，这里仍是存档时机之一） */
      onChanged: () => { ns.replay.save(); },
      /* 面板改了「一屏根数 / 图表周期」就往设置槽里写 —— 它们是偏好，住在那儿才「刷新还在」 */
      persist: (key, value) => { ns.settings.set(key, value); },
      /* ★ 工作区用**堆叠**摆法（三张卡片一起露着、整页滚动），像旧教程页；故事模式仍用页签 */
      workspace: 'stacked',
      /* ★ 抖动每一帧上：扫到强平线就强平（复用面板已经接好的那条帧订阅，见上面那段） */
      onTick: () => sweepTickLiquidation()
    });
    applySettingsToPanel();
    /* 引导的界面挂在**交易页之上**（同一个宿主里）：老师的话、进度条、聚光标记、
       那颗 ⏏。面板本身完全不知道它在 —— 上完课把它摘掉，界面上就只剩一套交易页。 */
    if (ns.tutorial) ns.tutorial.mountUi(host);
    ns.replay.mountKeys();
  }
  function disposeTradePage() {
    if (ns.tutorial) ns.tutorial.unmountUi();
    if (panel && panel.dispose) { try { panel.dispose(); } catch (_) {} }
    panel = null;
    hostEl = null;
  }

  async function enterTradePage() {
    const host = hostNode();
    if (!host) return false;
    /* 行情包 9.6MB：第一次进这个模式要等一下。先画一句「正在载入」，
       否则玩家面对的是一片空白（看起来就是坏了）。 */
    if (!ns.host) {
      clear(host);
      host.appendChild(card(CS.i18n.t('classic.replay.title'), [muted(CS.i18n.t('shell.loadingMode'), 'small')]));
    }
    const ok = await ensureHost();
    if (!ok) {
      if (CS.modes.current !== 'classic') return false;
      clear(host);
      host.appendChild(el('div', { class: 'shell-error', text: CS.i18n.t('classic.loadFailed') }));
      return false;
    }
    if (CS.modes.current !== 'classic') return true;   // 载入期间玩家切走了：别往别人的页面上挂
    mountTradePage(host);
    CS.shell.setTagline(CS.modes.tagline());
    return true;
  }
  /* coin 版：故事模式已移除，所以这里不再有「按下 ⏏ 之后门禁打开、模式那一排跟着变」
     那套轮询/回调（原来由 CS.shell.gate 负责）。那颗 ⏏ 仍然是引导**唯一的出口**，
     它的效果只剩「界面收起来、照顾照旧」（见 core/tutorial/session.js 的 exitForReal）。 */

  /* ================= 设置 =================
     那一整块在 modes/classic/settingsPanel.js（这一局 / 动画 / 图表 / 行情过滤 /
     高级模式 / 交易设置 / 图上价格线 / 新手引导）—— 它自己一百多行，留在这里会顶破**当时**的 400 行上限。 */
  const openSettings = () => CS.classicSettingsPanel.open({ ns, tutorial: ns.tutorial });

  /* ================= 死局彩蛋 =================
     条件只有两条，且必须同时成立：
       1) 账户余额（可用余额或总权益）为负；
       2) 已经有一笔未还清的周转借款 —— 借贷同时只允许一笔，所以此时**无法再借入**。
     满足时在右上角设置旁露一个 🥚；点开是作者留言。任何一个条件不成立就收起来。 */
  function deadEndNow() {
    try {
      if (!ns.host || !ns.host.account) return false;
      const snap = ns.host.account.getSnapshot();
      const negative = Number(snap.cash) < 0 || Number(snap.equity) < 0;
      if (!negative) return false;
      const debt = ns.loan && ns.loan.debt ? Number(ns.loan.debt()) || 0 : 0;
      return debt > 0;
    } catch (_) { return false; }
  }
  function syncEgg() {
    if (!eggBtn) return;
    eggBtn.classList.toggle('hidden', !deadEndNow());
  }
  function openEgg() {
    const body = el('div', { class: 'egg-sheet' }, [
      el('div', { class: 'egg-portrait' }, [
        el('img', {
          class: 'egg-pixel', src: './assets/8bit-rat.png', alt: '',
          width: '112', height: '112'
        }),
        el('span', { class: 'egg-stamp', text: '鼠鼠资本' })
      ]),
      el('p', { class: 'egg-message', text: CS.i18n.t('egg.body') })
    ]);
    CS.uiModal.open({
      cls: 'egg-sheet-modal',
      title: CS.i18n.t('egg.title'),
      body,
      actions: [
        { label: CS.i18n.t('egg.close'), cls: '' },
        {
          label: CS.i18n.t('egg.replay'), cls: 'primary',
          onClick: () => { if (window.CSIntro && typeof window.CSIntro.play === 'function') window.CSIntro.play(); }
        }
      ]
    });
  }
  function mountEgg() {
    if (eggBtn) { syncEgg(); return; }
    const actions = document.getElementById('shellActions');
    const settings = document.getElementById('shellSettingsBtn');
    if (!actions || !settings) return;
    eggBtn = el('button', {
      type: 'button', class: 'shell-btn egg-btn hidden',
      title: CS.i18n.t('egg.aria'), 'aria-label': CS.i18n.t('egg.aria'),
      text: '🥚', onClick: openEgg
    });
    actions.insertBefore(eggBtn, settings.nextSibling);
    eggOffs = [
      CS.events.bus.onKey('trade.render', 'classicEgg', syncEgg),
      CS.events.bus.onKey('loan.changed', 'classicEgg', syncEgg),
      CS.events.bus.onKey('classic.stepped', 'classicEgg', syncEgg)
    ];
    eggTimer = setInterval(syncEgg, 700);
    syncEgg();
  }
  function unmountEgg() {
    if (eggTimer) clearInterval(eggTimer);
    eggTimer = 0;
    eggOffs.forEach(off => { try { off(); } catch (_) {} });
    eggOffs = [];
    if (eggBtn && eggBtn.parentNode) eggBtn.parentNode.removeChild(eggBtn);
    eggBtn = null;
  }


  /* ================= 注册模式 ================= */
  CS.registerMode({
    id: 'classic',
    titleKey: 'mode.classic.title',
    taglineKey: 'mode.classic.tagline',
    icon: '📈',
    order: 10,
    tabs: [],
    /* ★ 装配顺序：init 在页签容器建起来**之前**跑（registry.switchTo 的顺序是
       init → 建 .mode-panels → onEnter），所以 init 里只做准备动作，
       真正往页面上挂东西一律放 onEnter（那时 hostNode() 才找得到容器）。 */
    init(ctx) {
      ctx.log('模拟模式就绪：交易页与故事模式共用 ui/components/tradePanel.js；新手引导长在这个壳里（core/tutorial）');
      ns.replay.mountKeys();
      /* 设置槽改了（设置面板里勾一下、或面板上换周期）就同步到界面：
         线开关由交易页每帧自己读（ctx.settings），这里只管那两个要写进 ui 的。 */
      CS.events.bus.onKey('classic.settings.changed', 'classicSettingsApply', () => {
        applySettingsToPanel();
        /* 行情过滤改了要把光标拉到可交易的那一根上（见 replay.syncFilterCursor） */
        ns.replay.syncFilterCursor();
        CS.events.bus.emit('trade.render', {});
      });
    },
    onEnter() {
      const host = hostNode();
      if (!host) return;
      mountEgg();
      /* ★ 随机波动是**就地改写**行情的，而这一份数据两个模式共用 ——
         所以进这个模式时要把它按当前设置叠上（离开时不还原：见 onLeave 的说明）。 */
      if (ns.settings) ns.settings.reapply();
      /* ★★ 行情过滤按下去了，**光标也要跟着对到可交易区**：这两件事必须一起做。
         以前这一步是「顺带」发生的 —— 引导会把根数/周期/步长/二次确认改成与玩家不同的一套，
         每次 set() 都发一条 classic.settings.changed，而 mode.js 的订阅里捎带调了
         replay.syncFilterCursor()。默认值改成产品要求的那一套之后，引导那几项与默认值**一样**，
         settings.set() 在「值没变」时提前返回、一条事件都不发，于是光标停在第一根（2017）、
         而过滤还开着 365 天：图上 0 根 K 线、下单全被拒 —— 正是 syncFilterCursor 注释里
         说的那个「坏掉的界面」。
         所以这里明确叫一次，不再依赖任何事件副作用；它是幂等的（只前进不后退）。 */
      if (ns.replay && typeof ns.replay.syncFilterCursor === 'function') ns.replay.syncFilterCursor();
      if (panel) {
        /* 切回来：先把行情游标拨回这一局的进度（两个模式共用一个游标），再重画 */
        if (ns.ports) ns.ports.clock.reveal();
        CS.events.bus.emit('trade.render', {});
        if (ns.tutorial) ns.tutorial.refresh();
        return;
      }
      enterTradePage();
    },
    onLeave() {
      unmountEgg();
      /* 自动播放是这一层排的定时器：切走必须停，否则它在后台继续敲 */
      ns.replay.stop();
      /* ★ 这里**不再**把行情还原成真实历史（原来是 CS.randomWalk.deactivate()）。
         随机波动是就地改写共用的那一份 series 的，而两个模式现在都读它
         （见 modes/story/mode.js 的 applyMarketScope）：切走时还原成 pristine，
         故事模式拿到的就永远是真实历史 —— 它的新闻排片、市场状态、账户估值
         全都会建立在没被改写的那份序列上，与玩家打开的开关不一致。
         「要不要改写」只由设置槽决定（bag.randomOn）：把它关掉时，
         设置槽的 set → applyRandom 会自己 deactivate，所以离开这里不需要额外还原。 */
      /* 抖动也是按帧排的：切走要停，不然它会在别的模式里继续排帧 */
      ns.tick.dispose();
      if (tradeOff) { try { tradeOff(); } catch (_) {} tradeOff = null; }
      /* 取消待写的那一拍，然后立刻存一次 —— 与旧实现（clearTimeout）+ 下一行 save() 同义，
         只是「取消」有了名字。 */
      saveSoon.cancel();
      ns.replay.save();
      disposeTradePage();
    },
    provideSettings() {
      return [{ id: 'classic.open', kind: 'action', titleKey: 'shell.settings', run: openSettings }];
    }
  });

  return {
    classicMode: {
      openSettings,
      enterTradePage,
      /* 探针句柄：自动化要能「造一个危险的仓位、再推一步」——
         否则追保与强平那两条路只能靠真实行情碰运气，那等于没有回归。
         暴露的是**引擎端口**（账户只读快照 + 那两个受控入口），不是内部引用。 */
      probe: () => ({
        host: ns.host, replay: ns.replay, settings: ns.settings, tutorial: ns.tutorial,
        account: ns.host ? ns.host.account : null, market: ns.host ? ns.host.market : null,
        /* 抖动中的强平扫描（挂在面板的帧钩子上）：自检要能直接问它一句
           「这一刻扫到没有」，而不是靠真实行情碰运气 */
        sweep: () => sweepTickLiquidation()
      }),
      state: () => ({
        instrumentId: ns.instrumentId,
        cash: ns.host ? ns.host.account.getSnapshot().cash : null,
        clock: ns.replay.now(),
        playing: ns.replay.autoPlay,
        /* 「引导还开着吗」：coin 版不再拿门禁标记来回答（门禁随故事模式一起撤了），
           直接问引导自己 —— 它在跑就是 true。引导的进度另给一格，探针与自检分开读。 */
        tutorial: !!(ns.tutorial && ns.tutorial.isActive()),
        guide: ns.tutorial && ns.tutorial.session ? {
          active: ns.tutorial.session.active(),
          inLessons: ns.tutorial.session.inLessons(),
          graduated: ns.tutorial.session.graduated(),
          left: ns.tutorial.session.leftForReal(),
          lessonIndex: ns.tutorial.session.lessonIndex(),
          total: ns.tutorial.session.totalLessons(),
          trades: ns.tutorial.session.trades().length
        } : null
      })
    }
  };
});
