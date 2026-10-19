/* ============ 自动播放（模拟模式与故事模式共用） ============
   一拍 = 一根 K 线。两个模式各写了一遍，实测**逻辑完全一致**（80% 逐字，差异只是
   变量名与事件名）：
     · 自己排下一拍，**不用 setInterval** —— 拍到一半玩家按了暂停、或者这一局走到头了，
       下一拍就不再排；setInterval 会在结束后继续敲一个已经封账的局；
     · 开关时给一条 toast（文案两个模式共用 st.play.autoOn / autoOff）；
     · 状态变化发一条事件，界面上那颗按钮据此刷新。

   参数只有三样：intervalOf() 取间隔、step() 走一拍、shouldStop() 该不该停。

   ★ 间隔取不到数字时**不能抛**：自动播放是「自己会停的一条路」，
     而定时器里的异常不进 CS.errors —— 玩家只会看到「按了 A 没反应」。
     所以这里对间隔做了兜底钳制。
   ========================================================================== */
CS.define('core/base/autoPlay', ["core/events/events","core/text/i18n","lib/lodash"], function () {
  'use strict';

  /* opts = { intervalOf: () => ms, step: () => void, shouldStop: () => bool,
              event: string, minMs?: number, defaultMs?: number } */
  function create(opts) {
    const o = opts || {};
    let timer = null;
    let on = false;

    function clear() { if (timer != null) { clearTimeout(timer); timer = null; } }

    /* 自己排下一拍 */
    function schedule() {
      clear();
      if (!on) return;
      /* 间隔兜底：取不到就用 defaultMs，并钳在一个下限之上 —— 见文件头那条说明。
         1500 → 500：产品默认的自动播放间隔改成 500ms（与 animSettings 的 PLAY_OPTIONS
         和 tickEngine.DEFAULTS.playMs 同一档）。兜底值只在「读不到间隔」时生效。 */
      let ms = 0;
      try { ms = Number(o.intervalOf ? o.intervalOf() : 0) || 0; } catch (_) { ms = 0; }
      if (!ms) ms = Number(o.defaultMs) || 500;
      ms = Math.max(Number(o.minMs) || 120, ms);
      timer = setTimeout(() => {
        timer = null;
        if (!on) return;
        /* 该停了（走到数据末尾 / 这一局封账）——顺手关掉自己，别留着空转 */
        if (o.shouldStop && o.shouldStop()) { setAutoPlay(false); return; }
        if (o.step) o.step();
        schedule();
      }, ms);
    }

    function setAutoPlay(next) {
      const want = !!next;
      if (want === on) return on;
      on = want;
      if (on) {
        CS.uiBits.toast(CS.i18n.t('st.play.autoOn'), '', 3200);
        schedule();
      } else {
        clear();
        CS.uiBits.toast(CS.i18n.t('st.play.autoOff'), '', 3200);
      }
      if (o.event) { try { CS.events.bus.emit(o.event, { autoPlay: on }); } catch (_) {} }
      return on;
    }

    return {
      setAutoPlay,
      toggle: () => setAutoPlay(!on),
      stop: () => setAutoPlay(false),
      isOn: () => on,
      /* 间隔改了（动画设置面板）要立刻按新间隔重排；没开着就什么都不做 */
      reschedule: () => { if (on) schedule(); },
      dispose: clear
    };
  }

  return { autoPlay: { create } };
});
