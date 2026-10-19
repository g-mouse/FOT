/* ============ 交易页的工具栏与「持仓/挂单/记录」页签 ============
   从 ui/components/tradePanel.js 拆出来（那个文件一度 439 行，超过**当时**的单文件上限：400 行）。
   拆的理由不只是行数：这两块**只管自己的状态与外观**，不碰钱、不碰委托 ——
   它们只往外喊一声（onStep / onPlay），由交易页决定那是什么意思。

   ★ 结构与 class 与拆分前**逐字一致**（.st-tool / .st-ws-tab / .st-count / .st-ws-pane …）：
     这些名字是 CSS 与探针都在读的契约，拆文件不该顺手改名，
     否则表现是「功能都在、样式没了」，而那种坏法很难一眼看出来。

   2026-10-19 用户口径：
     · 加一颗「前进 →」：按一次前进一根 K 线（与空格同一条路）；
     · 去掉「浮窗」与「紧凑模式」两颗按钮 —— 悬浮窗整个删了，页面**永远**是紧凑摆法。
   所以工具栏现在只有：键盘提示 + 前进 + 自动播放。 */
CS.define('ui/components/tradeChrome', ["core/base/util","ui/components/bits"], function () {
  'use strict';
  const { el } = CS.util;
  /* 文案取词走共享那一份（原先是 8 个面板各写一遍同样的包装） */
  const t = CS.uiBits.t;

  /* 工作区那三个页签：持仓 / 挂单 / 记录。
     每个页签带一个计数角标（.st-count），由 syncCounts 更新。
     返回 { bar, body, show, current }：bar 与 body 是两块 DOM（中间隔着图），
     所以只能分开给、由调用方摆位置。

     ★ o.layout === 'stacked' 时**不摆页签栏**，三块同时展开 —— 那是旧教程页的摆法
     （`.center-column` 里「图表 + 持仓 + 挂单 + 结算」四张卡片纵向堆叠、整页滚动）。
     两种摆法共用同一批 DOM 与同一份计数逻辑，只是「一次给看几块」不同：
     模拟模式用 stacked（要像旧页），故事模式用默认的页签（一屏装下、切着看）。 */
  function buildWorkspace(options) {
    const o = options || {};
    const stacked = o.layout === 'stacked';
    const tabs = ['positions', 'orders', 'history'];
    const buttons = {};
    const badges = {};
    const panels = {};
    const bar = el('div', { class: `st-ws-tabs${stacked ? ' hidden' : ''}`.trim(), role: 'tablist', 'aria-label': t('st.ws.aria') });
    const body = el('div', { class: `st-ws-body${stacked ? ' stacked' : ''}`.trim() });
    let current = o.initial || tabs[0];

    function show(id) {
      if (tabs.indexOf(id) < 0) id = tabs[0];
      current = id;
      tabs.forEach(key => {
        const on = key === id;
        if (buttons[key]) {
          buttons[key].classList.toggle('active', on);
          buttons[key].setAttribute('aria-selected', on ? 'true' : 'false');
        }
        /* stacked：三块都露着，`show()` 只记「当前是哪一块」（角标与 aria 仍然对），
           不再把另外两块藏掉 —— 藏掉就退回页签那一套了。 */
        if (panels[key] && !stacked) panels[key].classList.toggle('hidden', !on);
      });
    }

    tabs.forEach(id => {
      const badge = el('i', { class: 'st-count', text: '0' });
      const btn = el('button', {
        type: 'button', class: 'st-ws-tab', role: 'tab', dataset: { ws: id },
        onClick: () => show(id)
      }, [el('span', { text: t(`st.ws.${id}`) }), badge]);
      buttons[id] = btn;
      badges[id] = badge;
      bar.appendChild(btn);
      panels[id] = el('div', { class: 'st-ws-pane', dataset: { ws: id }, role: 'tabpanel' });
      body.appendChild(panels[id]);
    });
    show(current);

    return {
      bar, body, show, buttons, panels, badges,
      current: () => current,
      /* 角标：数字一样就不写 DOM（每 400ms 一次的 tick 会调它，白写会一直触发重排） */
      setCount(id, n) {
        const badge = badges[id];
        if (!badge) return;
        const text = String(n);
        if (badge.textContent !== text) badge.textContent = text;
      }
    };
  }

  /* 工具栏：只剩一行键位提示（2026-10-19：前进 / 自动播放搬进了右下角的悬浮控制条）。
     o = { keyHints() } */
  function buildToolbar(options) {
    const o = options || {};
    const keyHints = el('span', { class: 'st-quiet st-keyhints', text: '' });
    const syncKeyHints = () => { keyHints.textContent = o.keyHints ? String(o.keyHints() || '') : ''; };
    syncKeyHints();
    const root = el('div', { class: 'st-toolbar' }, [
      el('div', { class: 'st-toolbar-tools' }, [keyHints])
    ]);
    return { root, syncKeyHints };
  }

  /* 右下角那颗「悬浮控制条」：前进 → + 自动播放。
     用户口径（2026-10-19）：「前进和自动播放改成悬浮窗，方便继续」——
     它固定在视口右下角、不随页面滚走；手机上是一条贴底的宽条（拇指够得到）。
     它挂在 document.body 上（不是 #modeHost 里面）：modeHost 的祖先带 transform/contain，
     在那个上下文里 position:fixed 会退化成「相对容器定位」，浮层就跟着页面滚走了。 */
  function buildDock(options) {
    const o = options || {};
    if (!o.playback) return null;

    const stepBtn = el('button', {
      type: 'button', class: 'st-tool st-step', text: t('st.play.step'), title: t('st.play.stepHint'),
      onClick: () => {
        if (!o.playback) return;
        if (stepBtn.disabled) return;
        stepBtn.disabled = true;
        try {
          Promise.resolve(o.playback.step()).catch(() => {}).then(() => syncStepBtn());
        } catch (_) { syncStepBtn(); }
      }
    });
    const playBtn = el('button', {
      type: 'button', class: 'st-tool', 'aria-pressed': 'false', text: t('st.play.auto'),
      onClick: () => { if (o.playback) o.playback.toggle(); }
    });
    const root = el('div', { class: 'st-dock', role: 'group', 'aria-label': t('st.dock.aria') }, [stepBtn, playBtn]);

    function syncStepBtn() {
      /* 自动播放时「前进」保持可点：每一拍 busy 都会从 true→false→true，
         把它跟着置灰/点亮就是肉眼看到的闪烁。自动播放期间按了也只是被 advanceBars
         的 busy 闸门忽略，不会重复推进；只有手动单步（没在自动播放）才临时置灰。 */
      const busy = !!(o.playback.busy && o.playback.busy());
      const playing = !!(o.playback.playing && o.playback.playing());
      const off = busy && !playing;
      if (stepBtn.disabled !== off) stepBtn.disabled = off;
    }
    function syncPlayBtn() {
      const on = !!o.playback.playing();
      playBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      playBtn.textContent = t(on ? 'st.play.pause' : 'st.play.auto');
      playBtn.classList.toggle('active', on);
    }
    syncStepBtn();
    syncPlayBtn();

    return {
      root, stepBtn, playBtn, syncStepBtn, syncPlayBtn,
      dispose() { if (root.parentNode) root.parentNode.removeChild(root); }
    };
  }

  return { tradeChrome: { buildToolbar, buildDock, buildWorkspace } };
});
