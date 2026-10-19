/* ============ 新手引导的界面：那颗 ⏏ + 一行说明 ============
   这一层只做三件事：
     · 把 core/tutorial/session.js 给的结算数字画成一道横着飘的横幅（**中性文案**，只说钱）；
     · 挂那颗唯一的出口 ⏏（外壳顶栏、设置旁边）；
     · 底部露**一行**说明 —— 每一课都有（见下面 showHint 的理由）。
   它**不认识账户、不认识行情** —— 快照 / 文本里有什么就画什么。

   ============ 为什么只剩这三块 ============
   产品口径（2026-10-04）：引导要**看起来就是在主游戏里**。所以屏幕上不该有
   「新手引导 / GUIDED TRADING / 第 3 课 / 胜率 / 本课目标」这类字，也不该有
   围着按钮呼吸的聚光框（那是最明显的一处「有人在牵你」）。
   于是这一层只剩下 ⏏、结算横幅与那一行提示，三块都不含「教程」二字：
   · ⏏ 不挂 title（原来那句 title 会写「新手引导」）；
   · 横幅只说钱（`+$1,250（保证金的 25%）`），不再有「漂亮，这一单赢了」这种点评腔；
   · 提示那一行说的是「这一课该做什么」（目标 / 持有中看什么），不带课号。

   ★ 2026-10-19：提示原来只在最后两课（挂单 / 杠杆）出现，其余几课屏幕上**一个字都没有** ——
     用户报「教程没有渲染出来」。现在每一课都有一行（内容由 session.lessonHint() 给，
     见 core/tutorial/openTrade.js 的 hint），屏幕上一直看得见「现在该做什么」。
     文字里仍然没有「教程 / 引导 / 第几课」，所以「看起来像主游戏」那条还在。

   ★ 对外接口只多了一个 showHint，其余一个都没改：session 与 modes/classic/tutorial.js
     照旧调 show / showExit / speak / progress / showFlash / hideFlash / focus / …
     只是其中几个现在是**空动作**（老师条与进度条不画了）。
     留着那几个空接口而不是删掉，是因为删了要连带改 session（它只管喊，不管画）。 */
CS.define('ui/components/tutorialGuide', ["core/base/money","core/base/util","core/tutorial/copy","lib/lodash"], function () {
  'use strict';
  const { el, clear } = CS.util;

  function mount(host) {
    let layer = null, flash = null, hint = null, exitBtn = null;
    let onLeave = null;

    function build() {
      if (layer) return;
      /* 只剩一层：结算横幅 + 那一句话（原来还有 teacher / progress / spot 三块） */
      flash = el('div', { class: 'tut-flash hidden' });
      /* 每一课都有的那一行：内容由 session.lessonHint() 决定（目标 / 持有中旁白 /
         挂单那两句），空串时才收起来。见下面 showHint 的说明。 */
      hint = el('div', { class: 'tut-hint hidden' });
      layer = el('div', { class: 'tut-layer' }, [flash, hint]);
      host.appendChild(layer);
      /* 那颗 ⏏：长在顶栏（设置旁边）。**不挂 title** —— 屏幕上不该出现「新手引导」这几个字 */
      const actions = document.getElementById('shellActions');
      if (actions) {
        exitBtn = el('button', { type: 'button', class: 'shell-btn tut-exit hidden', text: '⏏', onClick: () => onLeave && onLeave() });
        actions.insertBefore(exitBtn, actions.firstChild);
      }
    }

    build();

    return {
      /* 界面整块显隐（session 决定什么时候叫）。现在整层只有横幅与那一句话，所以这一句只是开关它们。 */
      show(on) {
        if (layer && !on) {
          if (flash) flash.classList.add('hidden');
          if (hint) hint.classList.add('hidden');
        }
      },
      /* ⏏ 的显隐：课走完（graduated）之后它**仍然显示** —— 那是唯一的出口 */
      showExit(on) { if (exitBtn) exitBtn.classList.toggle('hidden', !on); },
      /* 老师的话：**不画了**（保留接口，见文件头） */
      speak() {},
      /* 进度条：**不画了**（同上） */
      progress() {},
      /* ★ 屏幕底部那一行「现在该做什么」。
         2026-10-19 起前四课也画（目标 / 持有中旁白），最后两课（挂单 / 杠杆）仍是挂单 / 杠杆那两句；
         只有 lessonHint() 给空串时才收起来（例如那两课已经开仓，不挡图）。 */
      showHint(text) {
        if (!hint) return;
        const line = String(text == null ? '' : text).trim();
        if (!line) { hint.textContent = ''; hint.classList.add('hidden'); return; }
        if (hint.textContent !== line) hint.textContent = line;
        hint.classList.remove('hidden');
      },
      /* 结算横幅：只说钱，不点评 */
      showFlash(result) {
        if (!flash || !result) return;
        flash.textContent = [result.headline, result.text].filter(Boolean).join('　');
        flash.classList.remove('hidden');
        flash.classList.toggle('neg', !result.win);
        /* 重播一次入场动画：同一个节点连加同一个类不会重放，所以先摘掉再强制回流 */
        flash.classList.remove('tut-flash-in');
        void flash.offsetWidth;
        flash.classList.add('tut-flash-in');
      },
      hideFlash() { if (flash) flash.classList.add('hidden'); },
      /* 聚光框：**不画了**（那是最明显的「有人在牵你」）。
         session 仍然会喊 focus(node)，这里收下就丢掉 —— 它不负责画。 */
      focus() {},
      snapshot() { return null; },
      setSnapshot() {},
      lastResult() { return null; },
      setLastResult() {},
      handlers(h) { onLeave = h.leave; },
      dispose() {
        if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
        if (exitBtn && exitBtn.parentNode) exitBtn.parentNode.removeChild(exitBtn);
        layer = null; flash = null; hint = null; exitBtn = null;
      }
    };
  }

  return { tutorialGuide: { mount } };
});
