/* ============ 动画的时钟与「走完了没有」（零 DOM、零业务） ============
   这一层只回答两个问题，两个模式的两段动画（盘中抖动 / 新 K 线长出来）共用同一份答案：

     1) **走到哪了** —— 按墙上时钟算的进度。`progress(frame)` 与 `remaining(frame)`。
     2) **走完了没有** —— `gate.ensure()` 给一个 Promise，**真的走完**才 resolve。

   ============ ② 是这一轮用户口径的直接落地 ============
   「下一根 K 线继续之前，当前这根要走到过最高价 H 与最低价 L」。
   路径本身早就保证「走完就一定摸到 H/L」（见 jitterPlan.js 的触点表），
   所以这条口径缺的**不是算法，是一个完成信号**：推进的那一方必须等得到它，
   否则 `beginTick()` 会把上一轮盖掉，那一根的 H 或 L 可能一次都没在屏幕上出现。

   ============ 为什么不用库（这一条被人问过，答案留在这里）============
   池子里的动画库（tween.js / anime.js / popmotion / motion…）管的是**插值与排帧**：
   它们自己拥有那条时间轴，于是你不知道「我的这条曲线走到哪了」，除非把整条曲线交给它。
   而这里的曲线是**逐点被 parity 工具比着的规格**（`jitterPlan.js` 的触点表与 OU 偏离，
   `TICK_SHARE` 的时长分配，两个模式「同一根 K 线两次抖动走一样的路」的承诺）——
   换成库的时间轴就等于把那些读数全部重算一遍，而换来的只是「少写 40 行轮询」。
   所以时间轴留在这里，**被等的对象与等的实现必须是同一个东西**。
   （同一条判断的完整核对：docs/LIBRARIES.md 的「K 线抖动这一轮」那一节。）

   ============ 三条必须成立的性质（都是踩过的坑）============
   · **帧是「对象」，不是全局的一对 start/dur**：一轮结束时 `frame.running` 变假，
     排队中的 Promise 在那一刻就该 resolve。用全局两个数记时刻的话，
     下一轮会把上一轮的等待悄悄续上（表现是「等一次要等两轮」）。
   · **没有排帧也要超时兜底**：这段动画靠 requestAnimationFrame 推进，而**后台标签页里
     rAF 会被节流到几乎不触发**。没有兜底的话，切走标签页再切回来，
     推进那一路会永远挂在 await 上 —— 页面看着就是卡住了，而 CS.errors 一条都没有。
     兜底不是「大概够了」：`progress()` 是墙上时钟算的，超时那一刻进度**必然**已经是 1。
   · **零在跑就是零成本**：没有动画在走时 `ensure()` 立即 resolve，一帧都不排，
     所以「抖动关掉」这条路上这一层等于不存在。 */
CS.define('core/animation/settleGate', ["core/base/util"], function () {
  'use strict';

  /* 两件共用的小事：墙上时钟 + 事件总线。
     在这里各兜一层，是因为这一层要能在**纯 Node 工具**里装起来（不需要假 DOM 也不需要总线），
     否则 tools/check-settle.mjs 那种量具就得自己再造一套时钟。 */
  const nowMs = () => (CS.util && CS.util.nowMs ? CS.util.nowMs() : Date.now());
  const emit = (topic, payload) => {
    if (CS.events && CS.events.bus && typeof CS.events.bus.emit === 'function') {
      try { CS.events.bus.emit(topic, payload); } catch (_) {}
    }
  };
  /* 超时兜底在时长之上再加多少：见文件头第三条 —— 它只需要「足够让最后一帧落地」 */
  const SETTLE_SLACK_MS = 1500;
  /* ★ 这一格的定时器**不许 unref**（Node 侧工具里踩过）：等待靠它放行，
     unref 之后事件循环没有别的活儿就直接退出 —— 表现是「未决的顶层 await」警告
     + 闸门永远不 resolve，而失败点看着像「动画没走完」。浏览器里本来就没有 unref。 */
  /* 轮询间隔。用 rAF 是为了不在动画期间额外排一堆定时器；没有 rAF 的环境退回定时器 */
  const rafTick = typeof requestAnimationFrame === 'function'
    ? cb => requestAnimationFrame(cb)
    : cb => setTimeout(cb, 16);

  const clamp01 = t => (t <= 0 ? 0 : t < 1 ? t : 1);

  /* 帧的形状 → 这一帧的读数。时间源由调用方给（见 gate 的 opts.now）：
     引擎与故事模式的时钟**都是可注入的**，这一层要是自己读一份墙钟，
     就会出现「引擎说在走、闸门说走完了」这种两边不同源的错（量具里必然踩到）。 */
  function frameOf(f) {
    const it = f || {};
    return { running: !!it.running, start: Number(it.start) || 0, dur: Number(it.dur) || 0 };
  }
  /* 进度：0 → 1。**没在跑或时长非正时是 1**（「已经走完了」而不是 0）——
     调用方据此判「这一帧结束没有」，返回 0 会让结束的那一帧被当成还没开始。 */
  function progress(f, now) {
    const fr = frameOf(f);
    if (!fr.running || !(fr.dur > 0)) return 1;
    const at = typeof now === 'function' ? now() : nowMs();
    return clamp01((at - fr.start) / fr.dur);
  }
  /* 还差多少毫秒走完（已经走完 → 0）。超时兜底按它算 */
  function remaining(f, now) {
    const fr = frameOf(f);
    if (!(fr.dur > 0)) return 0;
    const at = typeof now === 'function' ? now() : nowMs();
    return Math.max(0, fr.start + fr.dur - at);
  }

  /* ============ 完成闸门 ============
     `read()` 由调用方给：**每次现取**那一帧（不许缓存 —— 调用方会换掉整个 frame 对象）。
     `opts.now` 也由调用方给（默认 util.nowMs）：**与调用方的时钟同源**，理由见 frameOf 上面那段。
     `opts.stats` 是**调用方的账**（只增不减的那一份）：闸门是**一帧一个**的（每起一轮就换一个），
     把账记在闸门里的话，`gateStats()` 读到的永远是「最新那一帧的零」——
     而「一共等过几次」正是浏览器闸门要的读数（实测踩到：waits 恒为 0）。
     用法是「起一轮 → 排帧 → 每帧 step() → 谁想知道走完没有就 ensure()」。 */
  function gate(read, opts) {
    const o = opts || {};
    const slack = Number.isFinite(Number(o.slackMs)) ? Number(o.slackMs) : SETTLE_SLACK_MS;
    const at = typeof o.now === 'function' ? o.now : nowMs;
    /* 这一份账由调用方持有、跨帧累加；没给就自己开一份（单帧的用法） */
    const stats = o.stats || { waits: 0, active: 0 };
    let waiters = [];

    /* 这一帧走完了没有：假 = 「没什么可等的」，真 = 「再等等」。
       零在跑 → 假（见文件头第三条）。
       ★ `read()` 必须**每次现取**：闸门是「一帧一个」的，而这一帧可能已经被换掉了
       （`beginTick` 打断上一轮时就是如此）—— 缓存成闭包里的常量会让等待永远等一个
       已经不存在的帧（实测踩到：被打断的那一轮等待永远不放行）。 */
    const busy = () => {
      const fr = frameOf(read());
      return fr.running && fr.dur > 0 && progress(fr, at) < 1;
    };
    /* 把已经走完的那些等待放掉。**一轮结束与下一轮开始都要调**：
       否则上一轮的等待会被下一轮续上（见文件头第二条）。 */
    function pump() {
      if (waiters.length && !busy()) {
        const list = waiters.slice();
        list.forEach(w => w.settle(true));
      }
      return waiters.length;
    }
    /* 等这一帧走完。**必须**在起一轮之前（或紧接着）调，语义是「等**此刻这一轮**走完」，
       不是「等到没有动画为止」—— 后者在循环里会永远等不完。 */
    function ensure() {
      if (!busy()) return Promise.resolve(false);
      stats.waits++;
      return new Promise(resolve => {
        let done = false, timer = null, guard = null;
        const clear = t => { if (t != null) { try { clearTimeout(t); } catch (_) {} } };
        /* 放行只有这一条路：**幂等**（轮询、pump、兜底闹钟三边都可能先到） */
        const settle = value => {
          if (done) return;
          done = true;
          clear(timer); clear(guard);
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          stats.active = waiters.length;
          resolve(value);
        };
        /* 每次醒来只看一次：这一帧还在不在。在就按剩余时间排下一次，不在就放行。
           **不用 rAF 来叫醒**：排帧循环（engine.step）会调 pump()，这条轮询只需要
           保证「没人排帧时也能走」—— 所以它自己排定时器，最坏 64ms 一次。 */
        const loop = () => {
          timer = null;
          if (done) return;
          if (!busy()) { settle(true); return; }
          timer = setTimeout(loop, Math.min(64, Math.max(8, Math.ceil(remaining(read(), at)) + 2)));
        };
        const waiter = { settle };
        /* 兜底闹钟与上面的轮询**互为保险**：它按「时长 + slack」定死一个上限，
           就算轮询被什么环境掐掉了，等待也一定会被放掉（见文件头第二条）。 */
        guard = setTimeout(() => settle(true), Math.max(0, remaining(read(), at)) + slack);
        waiters.push(waiter);
        stats.active = waiters.length;
        loop();
      });
    }
    const reset = () => { pump(); };
    /* progress / remaining 也挂在返回对象上：调用方拿到的就是「这一帧的时钟」，
       写成 `frame.gate.progress()` 比每次 `CS.settleGate.progress(frame)` 少一层犯错的机会
       （★ 第一版只导出了模块级函数，于是 tickEngine 里那句 `frame.gate.progress()`
       在真实页面上是 TypeError —— 假 DOM 一挂交易页就崩；而两支 Node 闸门都发现不了它）。 */
    return {
      ensure, pump, busy, reset, stats, SETTLE_SLACK_MS: slack,
      progress: () => progress(read(), at),
      remaining: () => remaining(read(), at)
    };
  }

  return { settleGate: { gate, progress, remaining, frameOf, nowMs, emit, SETTLE_SLACK_MS, rafTick } };
});
