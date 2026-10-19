/* ============ 抖动时钟（两个模式共用，零 DOM） ============
   一根 K 线「正在走」的那一小段里，现价在这根的 开/高/低/收 之间来回走一遍。
   这一层负责**什么时候走、走到哪了、此刻值多少**，路径本身在 jitterPlan.js。

   ============ 为什么两个模式都要它 ============
   ① 观感：这是「行情活着」最直接的证据。新引擎里模拟模式原本完全没有这一层
      （图表静止、现价只在推进时跳一次），而旧教程页有 —— 用户就是拿这一点说
      「教程的 UI 更美观」。
   ② 口径：抖动关掉时它什么都不做（`running` 为假、一帧都不排），静止成本为 0。

   ============ ★ 抖动价算不算成交价：这是**模式的选择**，不是这一层的 ============
   旧教程页：抖动价**就是**成交价（市价开仓/平仓、限价撮合、强平判定读的都是它，
             见 game/js/market/ticks.js 文件头）；
   故事模式：抖动**只影响显示**（成交、资金费、强平一律按这根自己的收盘价，
             见 modes/story/storyAnim.js 文件头；理由是「按下空格那一瞬间落在动画
             哪一帧是运气，不该由运气决定成交价」）。
   两种都有明文理由，所以这一层**两个数都出**：
     displayPrice(id, settle)  —— 屏幕上那个价（抖动中逐帧变）
     touched(id)               —— 这一轮**摸到过**的最高/最低（成交与强平判定要用旧口径时读它）
   谁用哪个由模式决定（见 tickEngine.policy）。默认「只影响显示」，
   与故事模式现状一致；模拟模式要不要改成旧口径，是一个待定的产品决定。

   ============ 可复现 ============
   ============ 「等到走完」这件事在这一层 ============
   用户口径：**下一根 K 线继续之前，当前这根要走到过最高价 H 与最低价 L**。
   路径那一层早就保证「走完就必然摸到 H/L」，所以这条口径要的不是新算法，是一个**完成信号**：
   `settled()` 给一个 Promise，`progress()` 真的到 1 才 resolve。两个模式拿它做推进的闸门
   （模拟模式在 modes/classic/replay.js 的每根循环里、故事模式在 modes/story/keys.js 的 stepOnce 里），
   于是「上一轮还没走完就被下一次 beginTick 盖掉」这件事不再可能发生。
   时钟与闸门本身在 core/animation/settleGate.js（两个模式共用，逐帧进度只有一份实现）。

   路径的随机数**必须可种子化**：旧教程页为此专门写了 game/js/market/rng.js ——
   因为那边抖动价就是成交价，不可复现就等于「同一份存档两次跑出不同的钱」。
   这里沿用旧引擎的种子公式（见 seedOf），并且逐字保持：
     种子 = (光标 + 1) × 2654435761 + 时间戳常量
   于是「同一根 K 线 → 同一段路径」，与机器、时间、帧率都无关 ——
   tools/parity-jitter.mjs 就是靠这一点逐点比对两代实现的。 */
CS.define('core/animation/tickEngine', ["core/animation/jitterPlan","core/animation/settleGate","core/animation/frameLoop","core/base/util","core/events/events"], function () {
  'use strict';

  /* 默认值：**唯一的源头**（模拟模式的 replay.js 从这里对齐）。
     历史上这里漂过一次 —— replay.js 是 1400 而这里是 1500，
     「默认是多少」取决于是谁问的；所以三个数只有这一处是"源头"。
     间隔 500ms = 设置面板 PLAY_OPTIONS 里的「500ms」那一档（产品默认值，见 animSettings）；
     抖动 3× = JITTER_COUNTS 里的一档，
     两者都必须落在档位表里，否则面板那颗按钮选不中（见 ui/components/animSettings.js）。 */
  const DEFAULTS = Object.freeze({ jitter: true, jitterCount: 3, playMs: 500 });
  const JITTER_COUNTS = [1, 2, 3, 4, 5];
  /* TICK_SHARE / TICK_MIN_DUR：一段抖动占一个播放间隔的 90%，留 10% 余量在下一次推进前落定。
     旧实现（constants.js:63）就是这两个数，注释里还写明「不能有 420ms 下限、不能有 900ms 上限」。
     ★ 定义在**模块作用域**，不放 create() 里面：外面要导出它们给对照工具用
     （compare-tutorial-ui 拿新旧两边的同一个数比对）；放进 create 就取不到，导出那一行会
     在加载时 ReferenceError，把整个 IIFE 打死 —— 页面上的抖动会**整个消失**，
     而语法检查一条错都看不出来（那是运行期错误）。 */
  const TICK_SHARE = (CS.config && CS.config.TICK_SHARE) || .9;
  const TICK_MIN_DUR = (CS.config && CS.config.TICK_MIN_DUR) || 60;

  const clampInt = (value, lo, hi, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
  };
  const clampJitterCount = value => clampInt(value, JITTER_COUNTS[0], JITTER_COUNTS[JITTER_COUNTS.length - 1], DEFAULTS.jitterCount);

  /* 设置归一：设置面板、存档整理、读档补写都要用同一份规则。
     间隔的合法区间与档位表一致（100ms – 5s）：填 0 或 1 亿都夹回来。 */
  function normalizeAnim(raw) {
    const it = raw || {};
    const play = Number(it.playMs);
    return {
      jitter: it.jitter !== false,
      jitterCount: clampJitterCount(it.jitterCount),
      playMs: Number.isFinite(play) ? Math.max(100, Math.min(5000, Math.round(play))) : DEFAULTS.playMs
    };
  }

  /* 与旧引擎同一个混淆函数（game/js/market/rng.js 的 mix32）：
     把 (种子, 第几次抽取) 折成一个 32 位数再映射到 [0,1)。
     用它而不是 mulberry32，是为了「序号 n 的取值只由种子决定」——
     同一根 K 线里第 40 次抽取永远是同一个数，与前面抽了几次无关。
     这对逐点比对两代实现是必需的：两边的抽取**顺序**要一致才行。 */
  function mix32(a, b) {
    let h = (a | 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (b | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /* 种子：旧引擎写的是 (cursor + 1) * 2654435761 + (market.t0 || 0)。
     新引擎没有全局的 market.t0（数据集历元 meta.start 才是那个量），
     所以用同一个形状：把 (光标 + 1) 乘上同一个魔数，再叠上历元。
     叠历元是为了「换了数据集/起点之后路径也换」——
     不叠的话，两份不同的数据集在同一根下标上会抖出一模一样的路径。 */
  function seedOf(cursor, epochMs) {
    return (Math.imul((Number(cursor) | 0) + 1, 2654435761) + (Number(epochMs) | 0)) | 0;
  }

  function create(options) {
    const o = options || {};
    const plan = CS.jitterPlan;
    /* 标的来源三件都由调用方注入：这一层不认识 marketData，也不认识任何模式 */
    const barOf = o.barOf;                 // (instrumentId) -> 这一根（{t,open,high,low,close}）| null
    const instrumentIds = o.instrumentIds; // () -> [id, …]（所有要一起抖的标的；一起开始、一起停）
    const epochMs = o.epochMs == null ? 0 : Number(o.epochMs) || 0;
    /* ★ 时钟必须是**函数形式**存下来（不能只留 `o.nowMs` 那个可能为空的引用）：
       闸门要的也是「一个现取的时钟」，而它的默认值是另一套（util.nowMs / Date.now）。
       两处不同源时，量具里会出现「引擎在走、闸门说走完了」——progress() 恒为 1
       （实测踩到过：假时钟注入不进去，一段本该 180ms 的动画在第一帧就被判结束）。 */
    const nowMs = typeof o.nowMs === 'function' ? o.nowMs : (() => (CS.util && CS.util.nowMs ? CS.util.nowMs() : Date.now()));
    /* playMs 可以是数，也可以是「现取」的函数：间隔住在模式那边（模拟模式在回放存档里，
       故事模式在这一局的状态里），这一层不该缓存一个会过期的副本。
       每起一轮读一次 —— 改完间隔下一拍就生效，不必等模式再调一次 configure。 */
    const playMsOf = () => {
      const raw = typeof o.playMs === 'function' ? o.playMs() : o.playMs;
      return Number.isFinite(Number(raw)) ? Number(raw) : settings.playMs;
    };
    const raf = typeof requestAnimationFrame === 'function'
      ? cb => requestAnimationFrame(cb)
      : cb => setTimeout(() => cb(nowMs()), 16);

    /* TICK_SHARE / TICK_MIN_DUR 在**模块作用域**上定义（见文件上方）——
       原来写在这里（create 里面），而我给外部导出时在模块作用域引用了它们，
       于是整个 IIFE 一加载就 ReferenceError：`CS.tickEngine` 变成 undefined，
       页面上**抖动整个消失**，而语法检查一条错都看不出来（那是运行期错误）。
       是 tools/compare-tutorial-ui.mjs 的「抖动默认值」那一列全变成「—」才暴露的。 */

    let settings = Object.assign({}, DEFAULTS);
    /* 排帧回调由调用方注入（默认走 rAF）：**测试与 Node 侧的量具要能自己推进**，
       否则「等它走完」这件事在没有 rAF 的环境里没法验。 */
    const onFrameCb = typeof o.onFrame === 'function' ? o.onFrame : null;
    const onIdleCb = typeof o.onIdle === 'function' ? o.onIdle : null;
    /* 帧的状态与「这一轮走完了没有」的闸门一起住在这一个对象里：
       换事件里的一行、换闸门里的一行，两处都从同一个 frame 取，不可能各说各话。
       `running`/`start`/`dur` 三个字段是 settleGate 认的形状，别的字段它不认识。
       ★ 变量名特意**不叫 frame**：`o.onFrame(frameState)` 传出去的那一个就是它，
       同名会让「回调拿到的帧」与「create 内的那一格」看着像两个东西。 */
    /* 完成闸门的账**住在引擎上**（跨帧累加）：闸门是一帧一个的，账记在闸门里的话，
       探针读到的是「最新那一帧的零」—— 而「一共等过几次」正是自检要的读数。
       （声明必须在 `frameState = idleFrame()` 之前：那句会立刻用到它。） */
    const settleStats = { waits: 0, active: 0 };
    let frameState = idleFrame();
    function idleFrame() {
      const f = { running: false, start: 0, dur: 0, seed: 0, states: Object.create(null), done: false };
      /* ★ 时钟必须**注入**给闸门：引擎自己的 nowMs 是可注入的（Node 量具靠它控制时间），
         闸门要是自己去读 util.nowMs / Date.now，就会出现「引擎说在走、闸门说走完了」
         —— 两边的时钟不同源，量具里必然踩到（实测踩到过：progress() 恒为 1）。 */
      f.gate = CS.settleGate.gate(() => f, { now: nowMs, stats: settleStats });
      return f;
    }

    const tickDur = () => Math.max(TICK_MIN_DUR, Math.round(playMsOf() * TICK_SHARE));
    /* 看门狗（`fan`）：动画还在走、但排帧链已经断了时，踢一脚把动画推完。
       为什么挂在这里：`tickRunning()` 与 `growAnimating()` 是图表/面板**每帧都读**的两个函数，
       把自愈挂在读上，就不需要任何人记得「动画卡住了要调用修复」。
       实测的断链现场：垫片里的 `requestAnimationFrame` 返回 0 且从不回调、
       或者取消刚好落在两次回调之间 —— 断了之后动画停住、状态仍是「在跑」，
       而 CS.errors 一条都没有（一支 Node 闸门因此假红）。
       `frames.kick()` 自己幂等（见 core/animation/frameLoop.js 的文件头）。 */
    const rawGrow = () => growStart > 0 && growDur > 0;
    const rawTick = () => !!(settings.jitter && frameState.running && frameState.dur > 0 && progress() < 1);
    function fan() {
      if (!rawTick() && !rawGrow()) return;
      frames.kick();
    }
    /* 逐帧进度、时长、剩余时间都在 settleGate 里（两个模式共用一份，见那个文件）——
       这里只是把「当前这一帧」交给它，不再自己算一遍墙钟除法。 */
    const progress = () => frameState.gate.progress();
    const tickRunning = () => { const on = !!(settings.jitter && frameState.gate.busy()); if (on) fan(); return on; };

    /* ============ 波纹（摸到折返点时从最新价扩散一圈）============
       窄幅 K 线（刚开出来的那一根）抖动的绝对位移不到一个像素，纵轴上根本看不出线在动 ——
       这一圈波纹加上顶部报价的跳字，才是「价格在盘中跳」的可见证据。
       触发判据与画出来的价用**同一套索引插值**：走到某个折返点段内八成就算摸到了它，
       同一个触点只起一次（N× 时每摸到一次 高/低 都会起一圈新的）。
       强度每帧乘 .62 衰减 —— 与旧实现 game/js/chart/ticks.js 的 progressTick 逐字一致。 */
    let pulse = 0, pulsedAt = -1;
    /* 推进波纹一帧（**一帧调一次**，由排帧循环调）：返回这一帧的强度。
       单独一个「只读」的 pulseOf() 给渲染用，是为了不让「读一次」也把强度衰减掉。 */
    function pulseCount(id) {
      const target = id || (instrumentIds ? (instrumentIds() || [])[0] : null);
      if (!tickRunning() || !target) { pulse = 0; pulsedAt = -1; return 0; }
      const bar = liveBarOf(target);
      if (!bar) { pulse *= .62; return pulse; }
      const plan = planFor(target, bar);
      const at = plan.locate ? plan.locate(plan, progress()) : CS.jitterPlan.locate(plan, progress());
      const next = at.i + 1;
      if (at.frac > .8 && next !== pulsedAt && next < plan.points.length - 1 && plan.points[next].turn) {
        pulsedAt = next;
        pulse = 1;
      }
      pulse *= .62;
      return pulse;
    }
    /* 当前波纹强度（只读，不推进）：给渲染用 —— 推进由 pulseCount() 负责，一帧一次 */
    const pulseOf = () => (tickRunning() ? pulse : 0);

    /* 一根 K 线的规划：按 (这一根的时间戳, 种子, 档位) 记忆。
       同一根里反复问「此刻值多少」不会再算一遍（每帧都要问）。 */
    function planFor(id, bar) {
      let state = frameState.states[id];
      if (!state || state.bar !== bar.t || state.seed !== frameState.seed || state.count !== settings.jitterCount) {
        const seed = frameState.seed;
        state = frameState.states[id] = {
          bar: bar.t, seed, count: settings.jitterCount,
          plan: plan.buildPlan(bar, settings.jitterCount, streamOf(seed)),
          draws: 0
        };
      }
      return state.plan;
    }
    /* 一条可复现的流：第 n 次抽取 = mix32(种子, n)。每条流各自从头开始，
       所以「同一个 id 的同一根」永远拿到同一串数。 */
    function streamOf(seed) {
      let n = 0;
      return () => { n++; return mix32(seed, n) / 4294967296; };
    }

    /* ---------- 对外的两个价 ----------
       displayPrice：屏幕上看到的价。没在抖（或抖动关掉）时就是这一根的收盘价。
       touched：这一轮**已经摸到过**的最高/最低（只增不减的包络）。
         旧口径下强平判定与限价撮合读的是它（「抖到过的极值就算数」）；用不到的模式不用。 */
    function liveBarOf(id) {
      if (!barOf) return null;
      const raw = barOf(id);
      if (!raw) return null;
      const open = raw.open;
      const close = Number.isFinite(raw.close) ? raw.close : open;
      return { t: raw.t, open, close, high: Math.max(raw.high, open, close), low: Math.min(raw.low, open, close) };
    }
    /* 这一刻画出来的那根：**整根都在长**，不是只换一个收。
       收 = 此刻的即时价（与报价线同一个数、同一拍，所以实体长度一跳一跳地变、
            颜色也跟着它翻 —— 即时价穿过开盘价那一刻当场翻红/翻绿）；
       高/低 = 从**开盘价出发**、到此刻为止走过的那段区间（单调包络，只增不减）。
       为什么影线也要长：旧引擎就是这么画的（game/js/market/ticks.js 的 tickShape）。
       只换收的话，新那根一出现就是满高低的完整影线，看起来像「一根已经画好的 K 线
       在等待收盘」，而不是「这一根正在走」。 */
    function displayBar(id, bar) {
      if (!bar) return bar;
      /* ★ 传进来的那根是**行情层的形状**（{t,o,h,l,c}），而路径规划与包络要的是
         {open,high,low,close} —— 这里换一次名字，别指望调用方迁就我。
         （猜错的代价是静默的：open 变 undefined，整条路径算成 NaN，
         图上那一根不画，而控制台一条错都没有。） */
      const asPath = {
        t: bar.t,
        open: Number.isFinite(bar.o) ? bar.o : bar.open,
        high: Number.isFinite(bar.h) ? bar.h : bar.high,
        low: Number.isFinite(bar.l) ? bar.l : bar.low,
        close: Number.isFinite(bar.c) ? bar.c : bar.close
      };
      const shape = shapeOf(id, asPath);
      if (!shape) return bar;
      if (shape.close === bar.c && shape.high === bar.h && shape.low === bar.l) return bar;
      return Object.assign({}, bar, { c: shape.close, h: shape.high, l: shape.low });
    }
    /* 包络（走过的那段区间）：两个来源都只增不减 ——
         · 路径上**已经走到**的极值（含随机偏离，屏幕上真的出现过的价）；
         · 状态上记着的「这一轮摸到过的高/低」（噪声冒头也跟着撑开）。
       起点是**开盘价**：这一根一开始就是开盘价上的一条线，然后往两端撑开。 */
    function shapeOf(id, bar) {
      const raw = bar || liveBarOf(id);
      if (!raw) return null;
      const open = raw.open;
      const close = Number.isFinite(raw.close) ? raw.close : open;
      const full = { t: raw.t, open, close, high: Math.max(raw.high, open, close), low: Math.min(raw.low, open, close) };
      if (!settings.jitter || !tickRunning()) return null;
      const u = progress();
      const p = planFor(id, full);
      const state = frameState.states[id];
      if (state.envU == null || u < state.envU) { state.envU = -1; state.envHigh = open; state.envLow = open; }
      /* 从 0 扫到此刻（浮点，不取整）—— 屏幕上出现过的每一个价都算数 */
      const upto = Math.max(0, Math.min(plan.STEPS, u * plan.STEPS));
      for (let k = 0; k <= upto; k++) {
        const v = plan.priceAt(p, k / plan.STEPS);
        if (v > state.envHigh) state.envHigh = v;
        if (v < state.envLow) state.envLow = v;
      }
      const drawn = plan.priceAt(p, u);
      if (drawn > state.envHigh) state.envHigh = drawn;
      if (drawn < state.envLow) state.envLow = drawn;
      state.envU = u;
      let high = state.envHigh, low = state.envLow;
      /* N× 的随机价只在一条比整根窄的带子里来回（见 jitterPlan 的 band），
         所以影线还要**按进度**向真实的 高/低 补齐 —— 落定那一刻正好是真实区间，
         不会在最后一帧「啪」地弹一下。1× 不掺这一层：它的四个触点本来就摸到真实高/低。 */
      if (settings.jitterCount > 1) {
        high = Math.max(high, open + (full.high - open) * u);
        low = Math.min(low, open + (full.low - open) * u);
      }
      return { close: drawn, high: Math.max(high, open, drawn), low: Math.min(low, open, drawn), progress: u };
    }
    function displayPrice(id, settle) {
      const base = Number.isFinite(settle) ? settle : null;
      if (!settings.jitter || !tickRunning()) return base;
      const bar = liveBarOf(id);
      if (!bar) return base;
      return plan.priceAt(planFor(id, bar), progress());
    }
    /* 摸到过的极值：**这一轮路径上真实走到的**最高/最低，只增不减。
       与 shapeOf 的区别是它不看进度、只报「目前为止的包络」（成交与强平判定用旧口径时读它）。
       没在抖时返回这一根的真实 高/低（调用方拿到的永远是能用的数）。 */
    function touched(id) {
      const bar = liveBarOf(id);
      if (!bar) return null;
      if (!settings.jitter || !tickRunning()) return { high: bar.high, low: bar.low, progress: 1 };
      const shape = shapeOf(id, bar);
      return shape ? { high: shape.high, low: shape.low, progress: shape.progress } : { high: bar.high, low: bar.low, progress: 1 };
    }
    /* 自检/自动化用的快照：这一刻画出来的那根、摸了哪些触点、走到第几段 */
    function tickInfo(id) {
      const bar = liveBarOf(id);
      if (!bar) return null;
      const running = tickRunning();
      const u = progress();
      const state = frameState.states[id];
      return {
        running, progress: u, dur: frameState.dur, start: frameState.start,
        drawn: running ? displayPrice(id, bar.close) : bar.close,
        real: { open: bar.open, high: bar.high, low: bar.low, close: bar.close },
        waypoints: state ? plan.waypointPrices(state.plan) : null,
        waypointCount: state ? state.plan.points.filter(p => !p.hold).length : 0,
        legs: state ? state.plan.points.length - 1 : 0,
        count: settings.jitterCount
      };
    }

    /* ---------- 时钟 ---------- */
    /* 每一拍推进之后起一轮新的：所有标的**同一条时钟**（同一个开始时刻与时长），
       所以它们一起跳、一起停 —— 旧引擎就是这么做的（clock.states 共用 clock.start/dur）。 */
    function beginTick(cursor) {
      if (!settings.jitter) { stopTick(); return false; }
      /* 起新一轮之前先把上一轮**还挂着的等待**放掉（它们等的是上一帧，而它到此为止了）。
         ★ 顺序是「先把旧帧标记成结束，再 pump」：等待的语义是「等**这一轮**走完」，
         而这一轮已经被打断 —— 直接 pump 的话闸门看旧帧还在走，一个人都不放
         （实测踩到：被打断的那一轮等待永远挂着，真实页面上表现为「偶尔卡一拍」）。 */
      frameState.running = false;
      frameState.gate.pump();
      const f = idleFrame();
      f.running = true;
      f.start = nowMs();
      f.dur = tickDur();
      f.seed = seedOf(cursor, epochMs);
      frameState = f;
      emit('tick.begin', { start: f.start, dur: f.dur, count: settings.jitterCount });
      schedule();
      return true;
    }
    function stopTick() {
      const was = frameState.running;
      /* 先 pump 再换帧：等待的语义是「等**这一轮**走完」，而这一轮到此为止了 */
      frameState.gate.pump();
      frameState = idleFrame();
      stopFrames();
      if (was) emit('tick.begin', { start: 0, dur: 0, count: settings.jitterCount });
      return true;
    }
    /* 有动画在走的时候按帧叫醒界面一次（交易页与图表订阅 tick.frame）。
       两个动画任一在走都要排：只按抖动排的话，**抖动关掉时新 K 线就「啪」地出现**
       —— 长出来的那段过程整段消失（而它正是「新一根来了」最直接的反馈）。
       都没在走时一帧都不排 —— 静止成本为 0。
       ★ 排帧循环顺带做一件事：每帧把完成闸门 pump 一次。等待虽然有定时器兜着
       （见 settleGate.js 的第二条性质），但「有帧在走」时就不必等定时器 —— 少一拍延迟。
       ★ 循环本体（含「假 rAF」「同步 rAF」「只能有一条链」三处坑）在
       core/animation/frameLoop.js：那是**唯一**一处排帧实现，读那一份比读这里准。 */
    /* 一帧要做的事：喊界面重画（图表据此重排一帧）、再把闸门推一下。
       喊的顺序在 pump 之前 —— 落定那一帧必须**先画出来**，等它的那一方才看得到完整的 H/L。
       `done` 必须恰好发一次：图表订阅它做「动画结束，最后重画一帧」，
       多发一帧没事、**不发才是缺陷**（图表会停在动画中的那一帧上）。 */
    function frameOnce() {
      if (!(tickRunning() || growAnimating())) {
        frameState.gate.pump();
        if (!frameState.done) {
          frameState.done = true;
          emit('tick.frame', { done: true });
          if (onIdleCb) { try { onIdleCb(frameState); } catch (_) {} }
        }
        return false;
      }
      emit('tick.frame', { u: progress(), grow: growProgress(), tick: tickRunning() });
      if (onFrameCb) { try { onFrameCb(frameState); } catch (_) {} }
      frameState.gate.pump();
      return true;
    }
    const frames = CS.frameLoop.create({
      active: () => tickRunning() || growAnimating(),
      onFrame: frameOnce
    });
    /* 排帧循环的起点由 tickEngine 自己决定（起一轮、改设置、生长开始），
       自愈那一脚由 frameLoop 的 kick() 负责（挂在下面 tickRunning/growAnimating 的读上） */
    function schedule() { frames.kick(); }
    function stopFrames() { frames.idle(); }
    /* 事件总线兜一层：这一层要能在**纯 Node 工具**里装起来（假 DOM 也没有总线），
       少了它 tools/check-settle.mjs 那种量具跑不起来，而抛出的位置（beginTick）离原因很远。 */
    function emit(topic, payload) {
      if (CS.events && CS.events.bus && typeof CS.events.bus.emit === 'function') {
        try { CS.events.bus.emit(topic, payload); } catch (_) {}
      }
    }

    /* ============ 完成闸门：等**这一轮**抖动真的走完 ============
       用户口径「下一根 K 线继续之前，当前这根要走到过最高价 H 与最低价 L」的落点。
       走完的判据只有一条：`progress()` 到 1 —— 而路径规划保证进度到 1 时
       触点表上的 H 与 L 都已经走过（见 jitterPlan.js）。
       没在跑 / 抖动关掉 / 时长非正 → 立即 resolve(false)，一帧都不排。
       返回值是 Promise，调用方（两个模式的推进循环）`await` 它。 */
    const settled = () => frameState.gate.ensure();

    function configure(patch) {
      const next = normalizeAnim(Object.assign({}, settings, patch || {}));
      /* 间隔由外部现取时（playMs 是函数），不要把它抄进 settings：
         抄进来的那一份立刻就是旧的快照，而 playMsOf() 每次读到的才是真的 ——
         两份不一致时 settings.playMs 只是给界面看的，容易看岔。 */
      if (typeof o.playMs === 'function') next.playMs = playMsOf();
      settings = next;
      /* 改了参数就重起一轮：次数/开关的变化要**当场**看得见，不然玩家以为没生效 */
      const cursor = o.cursor ? o.cursor() : 0;
      if (settings.jitter) beginTick(cursor); else stopTick();
      return Object.assign({}, settings);
    }

    /* ============ 新 K 线「长出来」的进度 ============
       与抖动是**两段并行的动画**：抖动决定这一根的价走到哪儿，生长决定这一根的实体多宽。
       旧引擎里它们各有一个时钟（chart/canvas.js 的 stepStart/stepDur 与 market/ticks.js 的
       tickClock），共用同一条缓动曲线，所以一拍里看起来同源。

       时长 = 播放间隔的 30%，下限 180ms，上限「这一步的基础根数 × 基础周期」
       （旧实现 game/js/chart/canvas.js:57-61 逐字如此）。
       上限是给「一步跨多根基础 K 线」那种档位用的：一步本来就跨了很久，
       不该在最后再拖 1.5 秒。新引擎一档一根，所以实际上就是 max(180, playMs×.3)，
       但这条上限留着 —— 换档位表时它才有用。

       进度只在**真的在播**时才 > 0；没在播时返回 0，调用方据此知道「这一根不是刚出生的」。
       （旧实现注释里专门写了这一条：手动推进时 grow 恒为 0，
        把 0 当缩放系数会把实体画成一条细线。） */
    let growStart = 0, growDur = 0, growFor = null;
    const smooth = t => (CS.util && CS.util.smoothStep ? CS.util.smoothStep(t) : t * t * (3 - 2 * t));
    function growMsNow() {
      const perBase = (o.barMs ? o.barMs() : 4 * 3600000);
      return Math.max(180, Math.min(Math.round(playMsOf() * .30), perBase));
    }
    /* 起一轮生长。传 barT = 「这一轮是给哪一根的」（那一根的时间戳）：
       图表拿它跟「此刻最新那根」比，相等才把这根的实体育成细到宽。
       不传就退回「最后一根」（调用方不关心是哪一根时）。 */
    function beginGrow(barT) {
      growStart = nowMs();
      growDur = growMsNow();
      growFor = barT == null ? null : barT;
      /* 生长也要排帧：只在抖动里排的话，抖动关掉时新 K 线就「啪」地出现（没有长出来的过程） */
      schedule();
      return true;
    }
    function cancelGrow() { growStart = 0; growDur = 0; growFor = null; }
    const growAnimating = () => { const on = rawGrow(); if (on) fan(); return on; };
    const growForT = () => (growAnimating() ? growFor : null);
    function growProgress() {
      if (!growAnimating()) return 0;
      const t = (nowMs() - growStart) / growDur;
      if (t >= 1) { cancelGrow(); return 1; }
      return t <= 0 ? 0 : smooth(t);
    }

    return {
      DEFAULTS, JITTER_COUNTS, normalizeAnim, clampJitterCount,
      configure,
      get settings() { return Object.assign({}, settings); },
      beginTick, stopTick, schedule, tickRunning, progress,
      /* 完成闸门：等**这一轮**抖动走完（path 到 1 = H 与 L 都走过），
         两个模式的推进循环拿它做「下一根之前必须走到过 H/L」那道闸门 */
      settled, gateStats: () => Object.assign({}, settleStats),
      /* 波纹（摸到折返点时那圈扩散）：pulseCount 一帧推一次，pulseOf 只读 */
      pulseCount, pulseOf,
      displayPrice, displayBar, touched, shapeOf, liveBar: liveBarOf, tickInfo,
      /* 「新 K 线长出来」那一段（与抖动并行、各一个时钟，见上面那段说明） */
      beginGrow, cancelGrow, growAnimating, growProgress, growMs: growMsNow, growForT,
      /* 自检用：这一轮要走到哪些价（触点表） */
      planOf: id => {
        const bar = liveBarOf(id);
        return bar ? plan.waypointPrices(planFor(id, bar)) : null;
      }
    };
  }

  /* TICK_SHARE / TICK_MIN_DUR 也一并导出：这是「一段抖动占一个播放间隔的多少」的两个数。
     旧教程页把 TICK_SHARE 挂在 CS.config 上，新引擎原来只在内部用 —— 而对照工具要拿
     **两边的同一个数**比（compare-tutorial-ui 的抖动默认值那一节）。导出来比在工具里
     写死 0.9 可靠：写死的那个数会跟着实现漂，工具却照样绿。 */
  return {
    tickEngine: { create, normalizeAnim, clampJitterCount, seedOf, mix32, JITTER_COUNTS, DEFAULTS, TICK_SHARE, TICK_MIN_DUR }
  };
});
