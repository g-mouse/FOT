/* ============ 模态弹窗（壳层唯一的那一层） ============
   模式不自己造层：所有弹窗都挂在 #modalRoot 上。
   无障碍：打开时把焦点移进弹窗、Esc 关闭、关闭后焦点还给原来的元素。

   ============ 两种用法，同一个出口 ============
    1) 自己拼正文：`open({ title, body, actions })` —— 老约定，故事模式与设置面板都走它；
    2) 走「分节明细」那一套：`open({ icon, loss, title, message, sections, input, confirm, action })`
       —— 旧教程页的弹窗全是这个形状（强平说明 / 追保提示 / 开仓确认单）。
       渲染在 ui/components/modalBody.js，这一层只管开与关。

   ============ 队列与 isModalBusy ============
   弹窗**要排队**：引导推进之前会问一句「这一刻能不能安全推进」（isModalBusy）——
   连弹两张时会话必须知道「还有一张在等着」，否则它会趁着第一张刚关、第二张还没开
   的那 70ms 把行情推走，而第二张弹窗描述的正是刚被推进掉的那一根。
   同一时刻只有一张在屏幕上；关掉之后隔一拍再开下一张（让焦点与动画都收干净）。

   ============ 焦点圈定现在是 focus-trap ============
   Esc 关闭、Tab 在弹窗里循环、点遮罩关闭这三件事以前是手写的（一段 keydown +
   一段 mousedown）。现在交给 **focus-trap**（vendor/，MIT）：
     · Tab 循环与初始焦点由它算，`tabbable` 那套边界（禁用元素、tabindex=-1、
       隐藏元素）比手写的可靠 —— 手写版漏掉「按钮变 disabled 之后焦点还停在里面」
       这一档，玩家按 Tab 就跳到背后的面板上去了。
     · `clickOutsideDeactivates` 正好对应「点遮罩关闭」；`allowOutsideClick`
       让**遮罩本身**仍然点得到（不然 clickOutside 永远不触发）。
     · `escapeDeactivates` 对应 Esc；`returnFocusOnDeactivate` 对应
       「关闭后焦点还给原来的元素」。
   ★ 它装不上时退回原来那两段手写处理（Esc + 点遮罩）：弹窗不能因为一个库缺失就打不开。
     两条路**不会同时生效** —— 库在的时候不再挂那两段，否则一次 Esc 会关两张
     （第一张关掉后队列里的第二张会被同一次按键带走）。 */
CS.define('ui/components/modal', ["core/base/util","core/text/i18n","lib/focus-trap","lib/lodash","ui/components/bits","ui/components/modalBody"], function () {
  'use strict';
  const { el, clear } = CS.util;
  const { button } = CS.uiBits;

  let current = null;
  let lastFocus = null;
  const queue = [];
  const MAX_QUEUE = 8;
  let closing = false;      // 重入保护：focus-trap 的 deactivate 会把 close() 再叫一次

  function render(options) {
    const o = options || {};
    const root = document.getElementById('modalRoot');
    if (!root) return null;
    lastFocus = document.activeElement;
    /* 自己拼正文的走 o.body（标题仍由这一层画，老约定不变）；
       分节的走 modalBody.build（标题进 .modal-head，顺带给出底部按钮） */
    const built = o.body
      ? {
        body: el('div', { class: 'modal-body' }, [o.title ? el('h2', { text: o.title }) : null, o.body]),
        actions: o.actions || [], inputNode: null
      }
      : CS.modalBody.build(o);
    const card = el('div', { class: `modal-card ${o.cls || ''}`.trim(), role: 'dialog', 'aria-modal': 'true' }, [
      o.heading ? el('h2', { text: o.heading }) : null,
      built.body,
      el('div', { class: 'modal-foot' }, built.actions.map(a =>
        button(a.label, () => { if (!a.keepOpen) close(); if (a.onClick) a.onClick(); }, a.cls)))
    ]);
    root.appendChild(card);
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    current = { card, onClose: o.onClose, trap: null };
    const first = built.inputNode || card.querySelector('button, input, textarea, select');
    if (first) { try { first.focus(); } catch (_) {} }
    /* 输入框上按回车 = 点确认键（旧教程页也是这么接的） */
    if (built.inputNode) {
      built.inputNode.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const primary = card.querySelector('.modal-foot .btn.primary');
        if (primary) primary.click();
      });
    }
    /* vendor 缺失时的退路：Esc + 点遮罩（原来那一段）。
       ★ 它现在**有两个入口**：库没装、以及库装了但 activate() 抛错。
         第二种是实测踩出来的：focus-trap 的 UMD 把 tabbable 当外部依赖，
         少了那个全局名时 createFocusTrap() 装得上、activate() 一调就抛
         `Cannot read properties of undefined (reading 'tabbable')` ——
         而这里原来是 `catch (_) { current.trap = null; }`，于是弹窗既没有 Esc
         也没有焦点圈定，两条路都「看着正常」，只有真按一下 Esc 才知道。
         现在：退回手写那两段，并把原因记进 CS.errors（探针看得见）。 */
    const attachFallback = () => {
      const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
      root.addEventListener('keydown', onKey);
      root.addEventListener('mousedown', event => { if (event.target === root) close(); });
      current.onKey = onKey;
    };
    if (window.focusTrap && window.focusTrap.createFocusTrap) {
      /* 焦点圈定交给库。延迟到下一拍再启用：此刻首焦点刚设过，
         而 focus-trap 会自己挑一个初始焦点并接管 Tab。 */
      setTimeout(() => {
        if (!current || current.card !== card) return;   // 这一拍里已经被关掉/换掉了
        try {
          current.trap = window.focusTrap.createFocusTrap(card, {
            escapeDeactivates: true,
            clickOutsideDeactivates: true,
            returnFocusOnDeactivate: true,
            allowOutsideClick: event => event.target === root,
            onDeactivate: () => close(),
            fallbackFocus: card
          });
          current.trap.activate();
        } catch (error) {
          current.trap = null;
          CS.errors.push({ message: `弹窗焦点圈定（focus-trap）激活失败，已退回手写处理：${error && error.message}` });
          attachFallback();
        }
      }, 0);
    } else {
      attachFallback();
    }
    return card;
  }

  /* ★ 默认语义是**替换**，不是排队 —— 这一条踩过，而且症状很隐蔽：
     故事模式 init 会 `await CS.storyDialogs.openNewGameDialog()`（modes/story/mode.js:232），
     而那个 await 只有在弹窗被关掉（onClose → resolve(false)）或者玩家点了「开始」时才返回。
     老实现里 open() 第一件事就是 close()，于是「第二个模式实例进来」会把第一张关掉 ——
     第一个 init 于是以「玩家取消」返回、落一局默认存档，第二个 init 再读档时就不再弹窗了。
     改成排队之后：第二张被压进队列、第一张一直开着，那条 await **永远不返回** ——
     整页卡在「正在进入模式…」，而且一条错误都不报（run-tests 的浏览器侧就是被它抓到的）。
     所以：默认替换（旧行为），要排队的调用方显式传 { queue: true }。 */
  function open(options) {
    const o = options || {};
    if (current) {
      if (!o.queue) close();
      else if (queue.length < MAX_QUEUE) { queue.push(options); return null; }
    }
    return render(options);
  }

  function close() {
    /* ★ 重入保护：focus-trap 的 deactivate 也会调到这里（onDeactivate），
       而 close() 自己又要去 deactivate 它。没有这一格就是无限递归，
       表现是「关掉弹窗时爆栈」，而且只在装了库的那条路上出现。 */
    if (closing) return;
    closing = true;
    try {
      const root = document.getElementById('modalRoot');
      if (!root) return;
      const wasCurrent = current;
      if (wasCurrent && wasCurrent.onKey) root.removeEventListener('keydown', wasCurrent.onKey);
      current = null;
      clear(root);
      root.classList.add('hidden');
      root.setAttribute('aria-hidden', 'true');
      if (wasCurrent && wasCurrent.trap) { try { wasCurrent.trap.deactivate(); } catch (_) {} }
      const cb = wasCurrent && wasCurrent.onClose;
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (_) {} }
      if (cb) cb();
      if (queue.length) {
        const next = queue.shift();
        /* 隔一拍：让焦点与动画都收干净，也免得同一帧里连续两次 clear(root) */
        setTimeout(() => { if (!current) render(next); }, 70);
      }
    } finally { closing = false; }
  }

  function confirm(title, message, onYes) {
    return open({
      title,
      body: el('p', { text: message }),
      actions: [
        { label: CS.i18n.t('ui.cancel'), cls: '' },
        { label: CS.i18n.t('ui.confirm'), cls: 'primary', onClick: onYes }
      ]
    });
  }

  /* 免责声明：首次进入故事模式弹一次，设置页常驻可再看 */
  function disclaimer(onAck) {
    return open({
      title: CS.i18n.t('disclaimer.title'),
      body: el('div', {}, [
        el('p', { text: CS.i18n.t('disclaimer.body1') }),
        el('p', { text: CS.i18n.t('disclaimer.body2') }),
        el('p', { class: 'tiny muted', text: CS.i18n.t('disclaimer.filterHint') })
      ]),
      actions: [{ label: CS.i18n.t('disclaimer.ack'), cls: 'primary', onClick: onAck }]
    });
  }

  return {
    uiModal: {
      open, close, confirm, disclaimer,
      get isOpen() { return !!current; },
      /* 「这一刻能不能安全推进」：屏幕上有弹窗，或者还有一张排在队里 —— 两条都算忙。
         引导的 hop() 与强平判定都读它（少了排队那一条，第二张弹窗描述的那一根会被推走）。 */
      isBusy: () => !!current || queue.length > 0,
      clearQueue() { queue.length = 0; }
    }
  };
});
