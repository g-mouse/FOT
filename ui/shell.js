/* ============ 壳层（壳只做模式切换与容器，不懂任何模式的业务） ============
   ★ coin 版：**故事模式已移除**。模式注册表里现在只有模拟模式（classic），
     新手引导是它内部的一层（core/tutorial + modes/classic/tutorial.js），不是另一个模式。
     因此原来那套「教程没结束 → 故事模式连按钮都不显示」的门禁（cs:gate:tutorialDone）
     整块撤掉了：一排只有一个模式的按钮，门禁既拦不住谁，也只会让那颗唯一的按钮
     点下去弹一句莫名其妙的提示。

   顶栏右侧那一行字仍由模式自己声明（modes.registry.tagline()）：
     classic → mode.classic.tagline —— **2026-10-04 起是空串**（用户口径：那行
               「模拟模式 · 虚拟资金 · 历史行情回放」去掉），所以那里不显示字。
   两处共用一个 #shellTagline 元素，setTagline('') 画出来就是一个空 span。
   无障碍 [E]：字号缩放、高对比主题、减弱动效、色盲友好。 */
CS.define('ui/shell', ["core/base/contentLoader","core/base/util","core/content/index","core/events/events","core/market/marketData","core/text/i18n","core/text/sensitive","core/validate/validate","lib/lodash","ui/components/bits","ui/components/modal"], function () {
  'use strict';
  const { el, clear } = CS.util;
  /* 开发面板要用到这几个零件（漏声明会在打开 dev 面板时抛 `kv is not defined`） */
  const { kv, table } = CS.uiBits;

  const DEFAULT_MODE_KEY = 'cs:shell:mode';
  /* 模式按钮的切换回调：模块级留一份。
     modes/classic/tutorial.js 的 touchTopExit（按下那颗 ⏏ 之后）会**不带参数**调
     buildModeButtons() 重画那一排 —— 拿不到回调就等于把点击闭包写成 undefined
     （那时候两颗按钮都在、看着正常，点下去抛 TypeError）。 */
  let lastOnSwitch = () => {};

  /* 这一排按钮画哪几个模式：注册表里有几个就画几个（coin 版只有一个）。
     以前这里还有一道「教程未结束只画模拟模式」的可见性过滤，见文件头。 */
  function buildModeButtons(onSwitch) {
    const nav = document.getElementById('shellModes');
    if (!nav) return;
    const switchTo = typeof onSwitch === 'function' ? onSwitch : lastOnSwitch;
    lastOnSwitch = switchTo;
    nav.__onSwitch = switchTo;
    clear(nav);
    const modes = CS.modes.list();
    /* 2026-10-19：只剩一个模式时**不画**那一排（用户口径：「📈 模拟模式去掉」）。
       一个模式的切换器没有可切换的东西，画出来只是一颗占地方的徽章。
       注册表仍然照常走，哪天再加第二个模式，这一排自己就回来了。 */
    if (modes.length <= 1) { nav.setAttribute('aria-hidden', 'true'); return; }
    nav.removeAttribute('aria-hidden');
    modes.forEach(mode => {
      const btn = el('button', {
        type: 'button', class: 'mode-button', role: 'tab',
        dataset: { mode: mode.id },
        onClick: () => switchTo(mode.id)
      }, [
        el('span', { class: 'mode-icon', text: mode.icon || '◆' }),
        el('span', { text: CS.i18n.t(mode.titleKey) })
      ]);
      nav.appendChild(btn);
    });
  }

  function setFontScale(scale) {
    document.documentElement.style.setProperty('--fs', `${(15 * Math.max(1, Math.min(1.6, scale))).toFixed(2)}px`);
    try { localStorage.setItem('cs:shell:fontScale', String(scale)); } catch (_) {}
    return scale;
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme === 'contrast' ? 'contrast' : 'default';
    try { localStorage.setItem('cs:shell:theme', theme); } catch (_) {}
    return theme;
  }
  function setMotion(mode) {
    if (mode === 'off') document.documentElement.dataset.motion = 'off';
    else document.documentElement.removeAttribute('data-motion');
    try { localStorage.setItem('cs:shell:motion', mode); } catch (_) {}
    return mode;
  }
  function restorePrefs() {
    try {
      const fs = Number(localStorage.getItem('cs:shell:fontScale') || '1');
      if (fs > 1) setFontScale(fs);
      setTheme(localStorage.getItem('cs:shell:theme') || 'default');
      setMotion(localStorage.getItem('cs:shell:motion') || 'auto');
    } catch (_) {}
  }
  /* ★ 三个**读取器**：这三个偏好说了算的是 shell（DOM 属性 + localStorage），
     而设置面板原来读的是 `state.settings.fontScale / theme / motion` ——
     那三个字段初始成 1/'default'/'auto' 之后**没有任何一处写过**，是死字段。
     于是面板每次打开都按默认值画：玩家把字号设成 160%、页面确实是 160%，
     可滑杆显示 100%；他一拖滑杆，字号当场被拉回小号（逐帧试玩抓到的）。
     面板改为读这里，让「谁说了算」只有一份答案。 */
  function fontScale() {
    const v = Number(getComputedStyle(document.documentElement).getPropertyValue('--fs').replace('px', ''));
    return Number.isFinite(v) && v > 0 ? v / 15 : 1;
  }
  function theme() { return document.documentElement.dataset.theme === 'contrast' ? 'contrast' : 'default'; }
  function motion() { return document.documentElement.dataset.motion === 'off' ? 'off' : 'auto'; }

  function markActive(modeId) {
    const nav = document.getElementById('shellModes');
    if (!nav) return;
    Array.from(nav.querySelectorAll('.mode-button')).forEach(btn => {
      const on = btn.dataset.mode === modeId;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  /* 顶栏右侧那一行字。coin 版里模拟模式给的是空串，所以这里通常什么都不画；
     「阶段名 · 进度」那一段解析保留着，因为 modes.registry.tagline() 的契约没变
     （那一行是什么由模式自己决定，壳只负责排版）。 */
  function setTagline(text) {
    const node = document.getElementById('shellTagline');
    if (!node) return;
    clear(node);
    if (!text) { node.appendChild(el('span', { text: '' })); return; }
    const m = String(text).match(/^(.*?·\s*[^：]*：)(.*)$/);
    if (m) {
      node.appendChild(el('span', { class: 'obsession-stage', text: m[1] }));
      node.appendChild(el('span', { class: 'obsession-progress', text: m[2] }));
    } else {
      node.appendChild(el('span', { text: String(text) }));
    }
  }

  function boot(onSwitch) {
    restorePrefs();
    buildModeButtons(onSwitch);
    CS.events.bus.onKey('shell.tagline', 'tagline', () => setTagline(CS.modes.tagline()));

    const settingsBtn = document.getElementById('shellSettingsBtn');
    if (settingsBtn) settingsBtn.addEventListener('click', () => {
      const mode = CS.modes.getMode(CS.modes.current);
      const items = mode && typeof mode.provideSettings === 'function' ? (mode.provideSettings() || []) : [];
      const action = items.find(i => i.kind === 'action' && i.run);
      if (action) action.run();
      else if (CS.i18n.t('shell.settings') && window.confirm(CS.i18n.t('shell.noSettings'))) { /* 占位：无设置的模式 */ }
    });

    const debugBtn = document.getElementById('shellDebugBtn');
    if (debugBtn) {
      debugBtn.classList.toggle('hidden', !CS.dev);
      debugBtn.addEventListener('click', openDebug);
    }
  }

  /* ★ coin 版：帮助面板（顶栏那颗 ?）按需求移除 —— openHelp / help.* 文案 / 那颗按钮
     一起删掉了。壳层原来还负责列出 docs/ 下的文档清单，那一格也没有了读者。
     要恢复的话：在 build-index.mjs 的 HTML_BODY 里加回那颗按钮，
     再把这一段实现搬回来（它是一张只读弹窗，不碰任何业务状态）。 */

  /* 内容搜索（**开发面板专用**）。
     coin 版：共享内容库（新闻 / 邮件 / buff / 结局…）随故事模式一起移除了，
     启动时不再装 data/ 下那一批内容文件 —— 所以这个倒排索引通常只有语言包可搜。
     它仍然是 core/content/index.js（MiniSearch）**唯一**的调用点：
     将来又有一批内容被登记进 CS.content 时，这个框立刻就有东西可搜。 */
  function debugSearch() {
    const out = el('div', { class: 'small mono' });
    const input = el('input', {
      type: 'search', class: 'shell-btn', style: 'width:100%', placeholder: '搜内容（标题 / 正文 / 邮件主题…）',
      'aria-label': '搜内容',
      onInput: e => {
        const q = e.target.value;
        clear(out);
        if (!q || !q.trim()) return;
        const hits = CS.contentIndex.search(q, { limit: 12 });
        if (!hits.length) { out.appendChild(el('div', { class: 'muted', text: '没有命中' })); return; }
        const stats = CS.contentIndex.stats();
        out.appendChild(el('div', { class: 'muted', text: `${hits.length} 条命中（索引 ${stats.docs} 条文档）` }));
        hits.forEach(h => out.appendChild(el('div', { text: `${h.bucket} · ${h.id} · ${h.score.toFixed(2)}` })));
      }
    });
    return el('div', {}, [input, out]);
  }

  function openDebug() {
    const snap = {
      content: CS.contentLoader.snapshot(),
      registryIssues: CS.registryIssues.slice(0, 60),
      errors: CS.errors.slice(-40),
      i18n: CS.i18n.snapshot(),
      market: CS.marketData.snapshot(),
      sensitive: CS.sensitive.describe(),
      validate: safeValidate()
    };
    const body = el('div', {}, [
      el('div', { class: 'grid-2' }, [
        kv('data files', String(snap.content.dataFiles.length)),
        kv('character files', String(snap.content.characterFiles.length)),
        kv('failed', String(snap.content.failed.length)),
        kv('contentVersion', snap.content.contentVersion),
        kv('market ready', String(snap.market.ready)),
        kv('dataVersion', snap.market.dataVersion || '—'),
        kv('guardTrips', String(snap.market.guardTrips)),
        kv('fullSeriesRefs', String(snap.market.fullSeriesRefs)),
        kv('缺语言键', String(snap.i18n.missing.count)),
        kv('内容校验', snap.validate ? (snap.validate.ok ? '通过' : `${snap.validate.errors.length} 个错误`) : '未运行')
      ]),
      el('h4', { text: '内容搜索（倒排索引）' }),
      debugSearch(),
      el('h4', { text: CS.i18n.t('debug.missingKeys') }),
      el('div', { class: 'small mono' }, snap.i18n.missing.keys.slice(0, 80).map(k => el('div', { text: k }))),
      el('h4', { text: CS.i18n.t('debug.registryIssues') }),
      snap.registryIssues.length ? tableOf(snap.registryIssues) : el('p', { class: 'small muted', text: '—' }),
      el('h4', { text: CS.i18n.t('debug.contentErrors') }),
      snap.validate && snap.validate.errors.length ? tableOf(snap.validate.errors.slice(0, 60)) : el('p', { class: 'small muted', text: '—' }),
      el('h4', { text: CS.i18n.t('debug.runtimeErrors') }),
      snap.errors.length ? el('div', { class: 'small mono' }, snap.errors.map(e2 => el('div', { text: e2.message }))) : el('p', { class: 'small muted', text: '—' })
    ]);
    CS.uiModal.open({ title: CS.i18n.t('debug.title'), body, actions: [{ label: CS.i18n.t('ui.close'), cls: 'primary' }] });
  }

  function tableOf(rows) {
    return CS.uiBits.table(['kind', 'id', 'why'], rows.map(r => [r.kind || '', r.id || '', r.why || r.message || '']));
  }

  function safeValidate() {
    try { return CS.validate.run({ flagWhitelist: true }); } catch (error) {
      return { ok: false, errors: [{ kind: 'validate', id: '', why: String(error && error.message) }], warnings: [], stats: {} };
    }
  }

  /* 启动遮罩那行字。⚠ 第一次调用 showBoot() 时**语言包还没装好**
     （boot.js 的顺序就是「显示正在载入语言包 → 再 loadLocales」），
     所以第一句必须是一个不查表的静态串。原来直接 t('shell.loadingLocales')，
     每次冷启动都会往 CS.errors 记一条「缺少语言键：shell.loadingLocales」——
     而 dev 下 CS.errors 非空是会被当成缺陷的（探针里也一直报）。
     现在：查得到就用查到的文案，查不到就用下面这句兜底，**不记缺键**。 */
  const BOOT_FALLBACK = '正在载入…';
  function bootText(key) {
    const dict = CS.i18n.available && CS.i18n.available.length;
    const text = dict ? CS.i18n.t(key) : '';
    return text && text !== key.split('.').slice(-1)[0] ? text : BOOT_FALLBACK;
  }
  function showBoot(text) {
    const node = document.getElementById('shellBootText');
    if (node && text) node.textContent = text;
  }
  /** 启动遮罩：按 key 写文案，语言包没装好时用内置兜底（不污染 CS.errors） */
  function showBootKey(key) { showBoot(bootText(key)); }
  function hideBoot() {
    const node = document.getElementById('shellBoot');
    if (node) node.classList.add('hidden');
  }

  /* 上次用的是哪个模式：coin 版默认（也是唯一）就是模拟模式。 */
  function rememberMode(id) { try { localStorage.setItem(DEFAULT_MODE_KEY, id); } catch (_) {} }
  function preferredMode() {
    try { return localStorage.getItem(DEFAULT_MODE_KEY) || 'classic'; } catch (_) { return 'classic'; }
  }

  return {
    shell: {
      boot, openDebug, setFontScale, setTheme, setMotion, restorePrefs, setTagline,
    fontScale, theme, motion,
      markActive, showBoot, showBootKey, hideBoot, rememberMode, preferredMode, buildModeButtons
    }
  };
});
