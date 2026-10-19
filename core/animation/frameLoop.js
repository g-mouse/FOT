/* ============ 排帧循环：把一段动画按帧推完（零 DOM、零业务） ============
   做一件事：**只要 `isActive()` 还是真，就一帧一帧地叫回来**，直到动画结束。
   `onFrame()` 就是那一帧要做的事（喊界面重画、推一下完成闸门）。

   ============ 为什么单独一层、为什么写得这么小心 ============
   这一格看起来只有十几行，但它是「动画会不会卡在半路」的唯一开关。三件事都实测踩过：

   1) **排帧器可能是假的**。无头垫片里的 `requestAnimationFrame` 常常
      「返回 0 且一次都不回调」（它返回的不是真定时器）。只按 rAF 续帧的话，
      驱动链断在第一帧上：`growAnimating()` 仍是真、图表永远走 light 那条路，
      而 CS.errors 一条都没有（一支 Node 闸门因此假红）。
      所以判据是「回调有没有**同步**跑过」：同步跑过或返回假值 → 这一层自己用
      `setTimeout` 接上（**不能靠 rAF 的返回值**判断有没有排上，返回值与回调是两件事）。

   2) **同步回调的垫片会把这一格变成自旋**。`raf()` 立刻回调时，逐帧链会一口气跑完，
      墙上时钟一格都没走（`progress()` 永远同一个数）。所以连续快速重排到一定次数就
      换成定时器：自旋既吃 CPU，又让「按墙上时钟推进」的动画永远不结束。

   3) **不能有第二条链**。`kick()` 是给「动画还在走、但没有任何一格在等下一帧」用的
      （看门狗）。少了 `driving` 这一个标记，看门狗会把整条链再排一遍：两条链各自又踢一次、
      四条、八条…… 探针里量到过「4 秒里时钟被问 1266 万次」，而且闸门反而更晚放行。
      `driving` 从「排上下一帧」一直真到「那一帧跑完」，中间任何 kick 都被它挡掉。

   `kick()` 的语义是**幂等**的：没在动、已经有一条链、或动画已经结束 → 什么都不做。
   调用方（tickEngine）把它挂在 `isActive()` 的读取上 —— 谁每帧读动画状态，谁就顺手
   把它自愈一次，不需要任何人记得调用什么修复函数。 */
CS.define('core/animation/frameLoop', ["core/animation/settleGate"], function () {
  'use strict';

  /* 兜底续帧的间隔：约 60fps 的节拍（raf 不真排时才用得到） */
  const FRAME_MS = 16;
  /* 连续快速重排到这个次数就退回定时器：见文件头第 2 条 */
  const SYNC_LIMIT = 8;

  /* opts = { active: () => bool, onFrame: () => void, raf: cb => id } */
  function create(opts) {
    const o = opts || {};
    const active = typeof o.active === 'function' ? o.active : () => false;
    const onFrame = typeof o.onFrame === 'function' ? o.onFrame : () => {};
    const raf = typeof o.raf === 'function' ? o.raf : (typeof requestAnimationFrame === 'function'
      ? cb => requestAnimationFrame(cb)
      : null);
    let rafId = null, timerId = null, driving = false, sync = 0, wrapped = false;

    /* 走一帧，然后决定还要不要继续 */
    const step = () => {
      rafId = null;
      timerId = null;
      try { onFrame(); } catch (_) {}
      /* ★ `sync` 只在这里清零：这是「排帧器真的叫了我们一次」的那条路（真 rAF 或兜底定时器）——
         墙上时钟确实往前走了一点，可以重新开始数「连续快速重排」。 */
      sync = 0;
      if (active()) { run(); return; }
      driving = false;              /* 收摊：下一次 kick() 可以重新起链 */
    };
    function run() {
      if (!active()) { try { onFrame(); } catch (_) {} return; }
      /* 没有真的排帧器：自己用定时器（不能自旋 —— 墙钟要走，进度才会变） */
      if (!raf) { timerId = setTimeout(step, FRAME_MS); return; }
      /* ★ `sync` 在**排之前**加：垫片如果「同步就回调」，step 会在 `raf()` 里面跑完，
         而它会把 sync 清零 —— 写成排完之后再加就永远到不了上限，于是纯自旋
         （墙上时钟一格都不走，动画按墙钟算的进度永远不结束）。 */
      sync++;
      wrapped = true;
      const id = raf(step);
      const ranSync = !wrapped;
      wrapped = false;
      if (ranSync || id == null || id === 0 || sync >= SYNC_LIMIT) {
        timerId = setTimeout(step, FRAME_MS);
        return;
      }
      rafId = id;
    }
    /* 幂等的一脚：动画还在走、又没有链在跑时，才起一条。
       ★ `driving = true` 必须在问 `active()` **之前**立起来：`active()` 会去读
       「动画在不在跑」，而那一读在 tickEngine 里又挂着 `kick()`（自愈就是挂在那儿的）——
       先问后立就是无限递归（实测：Maximum call stack size exceeded）。 */
    function kick() {
      if (driving) return false;
      driving = true;
      if (!active()) { driving = false; return false; }
      run();
      return true;
    }
    /* 停掉：取消排上的那一格，并允许下一帧重新 kick（不是「动画结束」，只是不再推） */
    function idle() {
      if (rafId != null && typeof cancelAnimationFrame === 'function') {
        try { cancelAnimationFrame(rafId); } catch (_) {}
      }
      if (timerId != null) { try { clearTimeout(timerId); } catch (_) {} }
      rafId = null;
      timerId = null;
      driving = false;
      sync = 0;
    }
    return { kick, idle, FRAME_MS, get driving() { return driving; } };
  }

  return { frameLoop: { create, FRAME_MS, SYNC_LIMIT } };
});
