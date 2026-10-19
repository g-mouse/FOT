/* ============ 模拟模式 · 盘中抖动（那根 K 线「正在走」的一小段） ============
   一格 = 一根 4h K 线。推进一步之后，最新那根会在一小段动画里依次摸到自己的
   开 / 高 / 低 / 收 —— 图上那根实体随动画长出来，页面上每一个价格读数跟着跳。
   这一层把它接起来：

     core/animation/jitterPlan.js  算这一根的路径（纯函数、可种子化）
     core/animation/tickEngine.js  管时钟与逐帧推进（零 DOM）
     本文件                        接上「模拟模式的那根 K 线」与「这一局怎么存档」

   ============ 与故事模式的一处**故意不同**（不许当成 bug 改掉）============
   这里的抖动**只作用于显示**：成交、资金费与强平一律按这一根的收盘价结算
   （见 core/animation/tickEngine.js 文件头）。那一句说明原来还写在设置面板里，
   coin 版按「面板不放说明性长文案」的口径删掉了，口径本身一行没变。
   旧教程页不是这样 —— 那边抖动的价**就是**成交价。两种都有明文理由，
   所以 tickEngine 两个数都出：displayPrice（屏幕上的价）与 touched（摸到过的极值）。
   换口径只需改这一层的取价函数，不必动路径与时钟。

   ============ 存档 ============
   动画设置是**显示偏好**，和指标设置同一类：存在回放存档里（modes/classic/replay.js
   的 anim 那一格），刷新之后还在。设置面板改完立刻生效并落盘。 */
/* ★ coin 版：去掉了 core/text/i18n 这个依赖 —— 这一层唯一那处 CS.i18n.t() 是给设置面板
   传的 classic.anim.note 覆盖文案，而那一句已随「设置面板不放说明性长文案」删除；
   剩下取文案都走 uiBits.t（见下面 `const t = CS.uiBits.t`）。 */
CS.define('modes/classic/tick', ["core/animation/tickEngine","core/events/events","core/market/marketData","lib/lodash","modes/classic/replay","modes/registry","ui/components/animSettings","ui/components/bits","ui/components/modal"], function () {
  'use strict';
  const ns = CS.open('classic');
  const t = CS.uiBits.t;

  let engine = null;
  let offs = [];

  const ready = () => !!(ns.host && ns.ports && CS.marketData && CS.marketData.ready);
  /* 这一局这一根：市场数据层给的是 {t,o,h,l,c}，抖动层要 {t,open,high,low,close}。
     缺一根（上市之前、或还没揭晓）时返回 null —— 不编一根出来。 */
  function liveBar(id) {
    if (!ready() || !id) return null;
    let bars = [];
    try {
      const now = CS.marketData.nowIndex;
      bars = CS.marketData.loadSeries(id, { from: Math.max(0, now - 1), to: now });
    } catch (_) { return null; }
    const b = bars.length ? bars[bars.length - 1] : null;
    if (!b) return null;
    return { t: b.t, open: b.o, high: b.h, low: b.l, close: b.c };
  }

  function ensure() {
    /* 探针要在这里挂：boot.js 会把 window.__cs 换掉，而它排在模式脚本之后（见 exposeProbe） */
    exposeProbe();
    if (engine || !ready()) return engine;
    const meta = CS.marketData.getDatasetMeta();
    engine = CS.tickEngine.create({
      barOf: id => liveBar(id || ns.instrumentId),
      epochMs: meta && meta.start != null ? meta.start : 0,
      cursor: () => CS.marketData.nowIndex,
      /* 时长跟着自动播放的间隔走（一步的 90%，见 tickEngine 里的 TICK_SHARE）。
         兜底 500 与 replay.js 的 DEFAULT_PLAY_MS / tickEngine.DEFAULTS.playMs 同一档。 */
      playMs: () => (ns.replay ? ns.replay.state.playMs : 500)
    });
    engine.configure(animOf());
    return engine;
  }
  /* 设置从回放那一格现取（它是唯一的一份，见 modes/classic/replay.js 的 anim） */
  function animOf() {
    const a = (ns.replay && ns.replay.anim) || {};
    return CS.tickEngine.normalizeAnim(a);
  }

  /* 推进之后起一轮新的。**只在光标真的动了之后叫**（见下面 subscribe 的说明）：
     每一拍都重起的话，抖到一半就会被下一次推进打断，动画永远走不完。 */
  function begin() {
    const e = ensure();
    if (!e) return false;
    /* 两段动画一起起：抖动（价走到哪儿）与生长（实体多宽）。
       生长与自动播放无关 —— 手动按「下一根」也要看到这一根长出来，
       否则两条推进路径又是一套有一个没有（旧引擎只给自动播放播，那是个遗憾）。
       生长要带上**是给哪一根的**：图表靠它认出「这一根是刚来的」。 */
    const bars = liveBar(ns.instrumentId);
    e.beginGrow(bars ? bars.t : null);
    return e.beginTick(CS.marketData.nowIndex);
  }
  function stop() { if (engine) engine.stopTick(); }

  /* ============ 闸门：等这一轮真的扫过 H 与 L ============
     replay.js 每揭一根就 await 一次这一口，抖不到极值不许下一根继续（那条缺口的另一半在那边）。
     ★ 这里**不许把异常抛给调用方**：一次动画等不到不该把推进打挂 —— 记 CS.errors、回 false。
     gate 是给浏览器闸门读的（window.__cs.classicTickProbe().gate）：waits 只增不减，
     「闸门真的生效了」的判据就是它涨过；active 是此刻还挂着的等待数。
     ⚠ 不直接透引擎的 gateStats()：那一份挂在**当前这一轮**的帧上（settleGate 的 gate 每轮新建，
     见 tickEngine 的 idleFrame），新一轮一来就归零 —— 而探针要的是跨轮累计，所以在这里自己数。 */
  const gate = { waits: 0, active: 0 };
  /* 此刻有没有一轮正等着走完（= 引擎的 busy()，抖动关掉时恒假）。
     ★ emitStepped 在 await 之后发出，而 bus.emit 在 depth 0 时是**同步**派发（core/events/events.js），
     所以这里读得到刚起的那一轮；「没有可等的」与「等不到」在这一层必须是两件事。 */
  const tickBusy = () => {
    try { return !!(engine && engine.tickRunning && engine.tickRunning()); } catch (_) { return false; }
  };
  /* 抖动关了 / 没有引擎 / 引擎没这一口 → 立即 false（推进方据此知道「没什么可等的」）。
     ★ 只有真有一轮在跑才算「等」过：engine.settled() 在没有一轮时也是立即 resolve，
       把它也计进 waits 的话，探针就分不出「闸门生效」与「闸门被绕过」。 */
  function settled() {
    const e = engine;
    if (!e || typeof e.settled !== 'function') return Promise.resolve(false);
    const waiting = tickBusy();
    if (waiting) { gate.waits++; gate.active++; }
    const done = v => { if (waiting) gate.active--; return !!v; };
    const fail = error => {
      if (waiting) gate.active--;
      CS.errors.push({ message: `等待抖动走完失败：${error && error.message}`, stack: error && error.stack });
      return false;
    };
    try { return Promise.resolve(e.settled()).then(done, fail); } catch (error) { return Promise.resolve(fail(error)); }
  }

  /* 这一局的取价与抖动读数：交易页（ctx.displayPrice / ctx.ticks）读它 */
  const displayPrice = (id, settle) => {
    if (!engine) return settle;
    try { return engine.displayPrice(id, settle); } catch (_) { return settle; }
  };
  /* 帧事件的订阅：**每次一个独立的 key**。
     ★ 这里踩过一个极隐蔽的坑：原先写的是 `onKey('tick.frame', 'classicTickFrame', cb)` ——
     固定 key。而 onKey 的语义是「同 key 只留一个，后来者替换旧的」（那是为面板重挂载设计的），
     于是**第二个订阅者会把第一个顶掉**：图表先订（重画那一路），面板的波纹订阅后订，
     图表那份就被静默删掉了 —— 引擎每帧仍在喊，图却一动不动，而 CS.errors 一条都没有。
     更坏的是它骗过了探针：探针是第三个订阅者，它把自己换进去之后照样收得到帧，
     于是「帧事件有、画布没变」被归因到了别处。
     修法：key 由这里生成（每个订阅者一把），把去重语义留给真正需要它的地方。 */
  let frameSubSeq = 0;
  const onFrame = cb => {
    frameSubSeq++;
    return CS.events.bus.onKey('tick.frame', `classicTickFrame:${frameSubSeq}`, cb);
  };
  const ticks = {
    active: () => !!(engine && (engine.tickRunning() || engine.growAnimating())),
    displayBar: (id, bar) => (engine ? engine.displayBar(id, bar) : bar),
    /* 图表按帧重画：引擎的 tick.frame 已经带着两个进度（抖动 u / 生长 grow），
       直接转给图表的水龙头 —— 那里的 createTickDriver 负责「任一在走就重画」。 */
    onFrame,
    /* 顺带把「摸到过哪些价」与快照透给自动化（探针要能核对动画真的在走） */
    touched: id => (engine ? engine.touched(id) : null),
    info: id => (engine ? engine.tickInfo(id) : null)
  };
  /* 「新 K 线长出来」的驱动：只回答「在不在播、走到哪儿了」。
     没有它图表就把新那根直接画成满宽（「啪」地出现，没有长出来的过程）。 */
  const grow = {
    active: () => !!(engine && engine.growAnimating()),
    progress: () => (engine ? engine.growProgress() : 0),
    /* ★ 这一轮生长是给**哪一根**的（那一根的时间戳）。
       图表拿它与「此刻最新那根」比 —— 相等才把这根的实体育成细到宽。
       不多这一格的话只能靠「上一帧有没有见过它」判，而推进之后图表会先因为光标移动
       重画一帧，那时新那根已经画过一遍了，于是永远判不出「它是刚来的」（实测踩过）。 */
    forBar: () => (engine ? engine.growForT() : null)
  };
  /* 图像那一侧要的是 { active, progress }，不是引擎本身 */
  /* 生长：可选传「这一根的时间戳」。不传就只排帧、不声明是哪一根（旧调用点行为不变）。
     replay 在换图之前要先用这一口把新那根标成「正在长」，否则新图会先按满宽画一帧，
     下一帧才开始长 —— 看起来就是「闪了一条别的 K 线」。 */
  const beginGrow = barT => { if (engine) engine.beginGrow(barT); };
  /* 波纹（摸到折返点时从最新价扩散一圈）：step 每帧推一次、value 只读。
     窄幅 K 线上抖动的位移不到一个像素，纵轴看不出线在动 —— 这圈波纹是「在跳」的证据。 */
  const pulse = {
    step: () => (engine ? engine.pulseCount(ns.instrumentId) : 0),
    value: () => (engine ? engine.pulseOf() : 0)
  };

  /* 设置面板里那一块（ui/components/animSettings.js）。
     ★ coin 版：原来这里传了一句自己的 `note`（classic.anim.note），而 animSettings 自己也有一句
     默认文案 —— 同一格说明两个来源，改一处另一处就漏。现在**两边都不画**：
     设置面板里不放说明性长文案（animSettings 在没收到 o.note 时整段跳过）。 */
  function buildSettings() {
    return CS.animSettings.build({
      anim: animOf(),
      onChange: patch => {
        if (!ns.replay) return;
        ns.replay.setAnim(patch);        // 夹取 + 落盘 + 按新间隔重排自动播放
        ensure();
        if (engine) engine.configure(animOf());
      },
      /* 档位按钮的高亮要当场变：弹窗里的内容是快照，不重开就看着没生效 */
      resync: () => { CS.uiModal.close(); if (ns.openSettings) ns.openSettings(); }
    });
  }

  /* ============ 什么时候起一轮 ============
     订阅三件事：
       classic.stepped           手动推进 → **每揭一根发一次**（replay.js 的 emitStepped）→ 起一轮
       classic.playback.changed  自动播放的开关与每一拍 → 起一轮
       classic.anim.changed      动画设置改了 → 按新设置重起（关掉就停）
     前两件都要订：只订「播放开关」那个的话，手动推进时抖动不启动（实测踩过）。
     起一轮是按**当下光标**重算的：同一根重复触发不会抖两次，光标往前走一步就换一轮。 */
  function attach() {
    if (offs.length) return;
    const onStep = () => {
      if (CS.modes.current !== 'classic') return;
      begin();
    };
    offs.push(CS.events.bus.onKey('classic.stepped', 'classicTickStep', onStep));
    offs.push(CS.events.bus.onKey('classic.playback.changed', 'classicTick', onStep));
    offs.push(CS.events.bus.onKey('classic.anim.changed', 'classicTickAnim', () => {
      if (!engine) return;
      engine.configure(animOf());
    }));
  }
  function detach() {
    offs.forEach(off => { try { off(); } catch (_) {} });
    offs.length = 0;
  }
  function dispose() { detach(); stop(); }

  /* 自检入口（给 tools/check-classic-tick.mjs 用，界面上没人调）。
     「抖动到底有没有在走、抖完有没有落回收盘价」这两件事只能从**真的在跑的那个引擎**上读，
     而它在闭包里 —— 所以透出这一个只读探针，与 tradePanel.js 的 tradeAlignProbe 同一个理由：
     这一类缺陷不报错、只是看着不对，没有量化入口就只能靠人碰巧看见。

     ★ 为什么是「被 ensure() 叫一次」而不是在加载期就挂上：
     **app/boot.js 会把 window.__cs 整个换掉**（`window.__cs = { errors, mode, … }`），
     而 boot.js 排在所有模式脚本之后 —— 加载期挂上，boot 一跑就没了。
     这个坑极难查：文件确实执行了（挂的那一刻 typeof 是 function），页面上却读不到，
     而 CS.errors 里一条错都没有。ensure() 由 onEnter 触发，那时 boot 早就跑完了。 */
  function exposeProbe() {
    try {
      window.__cs = window.__cs || {};
      window.__cs.classicTickProbe = () => {
        const id = ns.instrumentId;
        const bar = ready() ? liveBar(id) : null;
        return {
          engine: !!engine,
          settings: engine ? engine.settings : CS.tickEngine.normalizeAnim(animOf()),
          running: !!(engine && engine.tickRunning()),
          progress: engine ? engine.progress() : 1,
          /* 生长那一段的两个读数（自检要核对「新 K 线真的在长」而不只是「读数在跳」） */
          growing: !!(engine && engine.growAnimating()),
          grow: engine ? engine.growProgress() : 0,
          growMs: engine ? engine.growMs() : 0,
          growFor: engine ? engine.growForT() : null,
          cursor: ready() ? CS.marketData.nowIndex : null,
          instrumentId: id,
          bar: bar,
          settle: bar ? bar.close : null,
          drawn: bar && engine ? engine.displayPrice(id, bar.close) : null,
          touched: engine && bar ? engine.touched(id) : null,
          info: engine && bar ? engine.tickInfo(id) : null,
          plan: engine && bar ? engine.planOf(id) : null,
          /* 闸门读数（replay.js 每根的 await 走的就是上面那个 settled）：waits 只增，涨过 = 闸门生效 */
          gate: { waits: gate.waits, active: gate.active }
        };
      };
    } catch (_) {}
  }

  ns.tick = {
    ensure, begin, stop, dispose, attach, detach, exposeProbe, grow, beginGrow, pulse,
    displayPrice, ticks, buildSettings, liveBar, settled, gate,
    get engine() { return engine; },
    label: () => t('settings.anim.jitter')
  };
  return { classicTick: ns.tick };
});
