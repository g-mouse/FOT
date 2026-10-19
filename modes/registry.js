/* ============ 模式注册表（§0.2 的 registerMode） ============
   壳只负责渲染 + 挂载，**不知道模式的业务**：
   壳层不得出现 if (mode === "story") 之类的分支 —— 模式差异只能通过
   titleKey / icon / order / tabs / taglineKey 这些声明式字段表达。

   一个模式声明什么，壳就渲染什么：
     id / titleKey / icon / order      顶栏那一颗模式按钮
     taglineKey 或 tagline(ctx)        顶栏右侧那一行字（classic 是标语，story 是当前执念 [R11]）
     tabs[{id,titleKey,mount(ctx,el),badge(state)}]  模式自己的页签
     init/onEnter/onLeave/onTick/provideSettings      生命周期 */
CS.define('modes/registry', ["core/events/events","core/text/i18n","lib/lodash"], function () {
  'use strict';

  const registry = {};
  const order = [];
  const runtime = {
    current: null,
    ctx: null,
    tabs: {},          // modeId -> { tabId, el, dispose }
    mounted: false
  };

  function registerMode(mode) {
    if (!mode || !mode.id) throw new Error('registerMode 需要一个带 id 的模式');
    if (registry[mode.id]) throw new Error(`模式 id 重复：${mode.id}`);
    const normalized = Object.assign({
      titleKey: `mode.${mode.id}.title`, icon: '◆', order: 100,
      tabs: [], taglineKey: `mode.${mode.id}.tagline`,
      init: null, onEnter: null, onLeave: null, onTick: null, provideSettings: null
    }, mode);
    registry[normalized.id] = normalized;
    order.push(normalized.id);
    order.sort((a, b) => (registry[a].order - registry[b].order) || a.localeCompare(b));
    return normalized;
  }

  const getMode = id => registry[id] || null;
  const list = () => order.map(id => registry[id]);

  function makeContext(mode) {
    return {
      mode,
      ports: runtime.ctx ? runtime.ctx.ports : null,
      store: runtime.ctx ? runtime.ctx.store : null,
      shell: runtime.ctx ? runtime.ctx.shell : null,
      events: CS.events.bus,
      i18n: CS.i18n,
      t: CS.i18n.t,
      content: CS.content,
      /* ctx.log 是**信息性日志**，不是错误。
         早期它直接往 CS.errors 里塞，后果是「window.__cs.errors() 为空」这条验收
         在正常运行下永远不可能成立（模式挂载成功也会记一条「xx 模式就绪」）。
         现在分流到 CS.logs；CS.errors 只留真异常。 */
      log(message, extra) {
        CS.logs.push({ at: Date.now(), mode: mode.id, message: String(message || ''), extra: extra || null });
        if (CS.logs.length > 400) CS.logs.shift();
        if (CS.dev && typeof console !== 'undefined' && console.debug) console.debug(`[${mode.id}] ${message}`);
      }
    };
  }

  /* 壳把模式挂上去：先 init（注入 Ports、加载角色包、恢复存档），再 onEnter + 挂页签。
     init 只在第一次进入时跑一次。 */
  async function switchTo(modeId, host, options) {
    const opts = options || {};
    const mode = registry[modeId];
    if (!mode) return { ok: false, why: `没有这个模式：${modeId}` };
    if (runtime.current === modeId && !opts.force) return { ok: true, mode };

    const previous = runtime.current ? registry[runtime.current] : null;
    if (previous && typeof previous.onLeave === 'function') {
      try { previous.onLeave(makeContext(previous)); } catch (error) { CS.errors.push({ message: `模式 ${previous.id} onLeave 抛错：${error.message}` }); }
    }
    /* 卸页签：把注册在 ui 层的事件订阅一起退掉，避免切来切去越订越多 */
    Object.values(runtime.tabs).forEach(entry => { if (entry.dispose) try { entry.dispose(); } catch (_) {} });
    runtime.tabs = {};
    if (host) host.innerHTML = '';

    runtime.current = modeId;
    const ctx = makeContext(mode);

    if (!mode.__initialized) {
      try {
        if (typeof mode.init === 'function') await mode.init(ctx);
        mode.__initialized = true;
      } catch (error) {
        CS.errors.push({ message: `模式 ${modeId} 初始化失败：${error && error.message}`, stack: error && error.stack });
        return { ok: false, why: `${modeId} 初始化失败：${error && error.message}` };
      }
    }

    const mounts = [];
    if (host) {
      const bar = document.createElement('div');
      bar.className = 'mode-tabs';
      bar.setAttribute('role', 'tablist');
      const panels = document.createElement('div');
      panels.className = 'mode-panels';

      const tabs = mode.tabs || [];
      if (!tabs.length) {
        /* 没有页签的模式（classic）：整块区域交给模式自己 onEnter 里渲染 */
        host.appendChild(panels);
        runtime.tabs[modeId] = { tabId: '(none)', el: panels, dispose: null };
      } else {
        const buttons = [];
        /* badge 订阅的退订句柄。dispose 只调 badgeState() 是**没退订**的
           —— 这个 onKey 用的是固定 key，重挂载时会把旧的替换掉，
           所以它不会越订越多，但切走的那个模式仍被闭包钉在 bus 上。 */
        let offBadge = null;
        const activate = tabId => {
          buttons.forEach(b => {
            const on = b.dataset.tab === tabId;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
          });
          Array.from(panels.children).forEach(p => p.classList.toggle('hidden', p.dataset.tab !== tabId));
          const entry = runtime.tabs[modeId];
          if (entry && entry.active && entry.active !== tabId) {
            const prev = entry.panelsMap && entry.panelsMap[entry.active];
            if (prev && prev.onHide) try { prev.onHide(); } catch (_) {}
          }
          if (entry) entry.active = tabId;
          const panel = entry && entry.panelsMap && entry.panelsMap[tabId];
          if (panel && panel.onShow) try { panel.onShow(); } catch (_) {}
        };
        tabs.forEach(tab => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'mode-tab';
          button.dataset.tab = tab.id;
          button.setAttribute('role', 'tab');
          button.innerHTML = `<span class="mode-tab-title"></span><span class="mode-tab-badge hidden"></span>`;
          button.querySelector('.mode-tab-title').textContent = CS.i18n.t(tab.titleKey || `tab.${tab.id}`);
          button.addEventListener('click', () => activate(tab.id));
          bar.appendChild(button);
          buttons.push(button);
          const panel = document.createElement('section');
          panel.className = 'mode-panel';
          panel.dataset.tab = tab.id;
          panels.appendChild(panel);
          mounts.push({ tab, panel });
        });
        host.appendChild(bar);
        host.appendChild(panels);
        runtime.tabs[modeId] = { tabId: tabs[0].id, el: panels, dispose: null, panelsMap: {}, active: tabs[0].id };
        mounts.forEach(({ tab, panel }) => {
          runtime.tabs[modeId].panelsMap[tab.id] = tab;
          tab.__el = panel;
          try { if (typeof tab.mount === 'function') tab.mount(ctx, panel); }
          catch (error) { CS.errors.push({ message: `页签 ${tab.id} 挂载失败：${error && error.message}`, stack: error && error.stack }); }
        });
        activate(tabs[0].id);
        /* badge 轮询：模式只声明 badge(state) 这个纯函数，壳负责刷新 */
        const badgeState = () => {
          const snapshot = mode.badgeSource ? mode.badgeSource() : null;
          tabs.forEach((tab, index) => {
            if (typeof tab.badge !== 'function') return;
            const node = buttons[index].querySelector('.mode-tab-badge');
            let value = 0;
            try { value = tab.badge(snapshot) || 0; } catch (_) {}
            if (value > 0) { node.textContent = value > 99 ? '99+' : String(value); node.classList.remove('hidden'); }
            else node.classList.add('hidden');
          });
        };
        runtime.tabs[modeId].dispose = () => { if (offBadge) { try { offBadge(); } catch (_) {} offBadge = null; } };
        offBadge = CS.events.bus.onKey('shell.badge', 'badge', badgeState);
        badgeState();
      }
    }

    if (typeof mode.onEnter === 'function') {
      try { mode.onEnter(ctx); } catch (error) { CS.errors.push({ message: `模式 ${modeId} onEnter 抛错：${error && error.message}` }); }
    }
    CS.events.bus.emit('shell.modeChanged', { id: modeId });
    return { ok: true, mode };
  }

  /* 时钟联动：壳把 tick 转发给当前模式的 onTick，模式自己决定挂什么（故事模式的月度结算） */
  function attachClock(clockPort) {
    runtime.ctx = runtime.ctx || {};
    clockPort.onTick(t => notifyTick(t));
  }
  function notifyTick(t) {
    const mode = runtime.current ? registry[runtime.current] : null;
    if (mode && typeof mode.onTick === 'function') {
      try { mode.onTick(makeContext(mode), t); }
      catch (error) { CS.errors.push({ message: `模式 ${mode.id} onTick 抛错：${error && error.message}`, stack: error && error.stack }); }
    }
  }

  function setRuntime(ctx) { runtime.ctx = ctx; }

  /* 顶栏那一行字：故事模式返回「执念 · 第一阶段：…」，classic 返回标语 [R11]。
     壳只问一句 mode.tagline(ctx)，不关心它是怎么算出来的。 */
  function tagline() {
    const mode = runtime.current ? registry[runtime.current] : null;
    if (!mode) return '';
    if (typeof mode.tagline === 'function') {
      try { return mode.tagline(runtime.ctx) || ''; } catch (_) { return ''; }
    }
    return CS.i18n.t(mode.taglineKey || '');
  }

  return {
    modes: { registerMode, getMode, list, switchTo, attachClock, notifyTick, setRuntime, tagline, get current() { return runtime.current; }, get runtime() { return runtime; } },
    /* 模式文件用的是裸 registerMode（§0.2 的写法）。旧版这里写的是
       `CS.registerMode = registerMode` —— 又一处绕过注册表的全局写入；
       现在它是导出对象里的一个键，两个模式文件对它的依赖因此在依赖图里可见。 */
    registerMode
  };
});
