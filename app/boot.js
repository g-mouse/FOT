/* ============ 启动 ============
   顺序：
     0) 封册：所有模块都已按 index.html 的顺序装配完（那一份顺序由
        tools/build-index.mjs 从每个模块的 CS.define 依赖生成，不是人手维护的）
     1) 载入语言包（localStorage 里记的语言优先，其次看 navigator）
     2) 搭壳（模式按钮 / 设置 / debug 按钮 / 无障碍偏好；帮助按钮已按需求移除）
     3) 切到上次用的模式（coin 版只有一个模式：模拟模式，它内部带着新手引导）
   失败不白屏：任何一步抛错都记进 CS.errors 并把启动遮罩换成一条可读的错误说明。 */
(function () {
  'use strict';

  /* ★ 封册：这一支是 index.html 里**最后一个**脚本，走到这里说明整张模块图的顺序都执行完了。
     顺序本身由依赖声明生成（不是人手维护），所以这里只做一件事：
     把「装了几个模块」记下来，并让 CS.ready 兑现 —— 自动化探针等的是这一刻。 */
  const moduleCount = CS.__seal();
  CS.logs.push(`内核：装配完成，${moduleCount} 个模块`);

  async function switchMode(modeId) {
    const host = document.getElementById('modeHost');
    const result = await CS.modes.switchTo(modeId, host);
    if (!result.ok) {
      CS.uiBits.toast(result.why || CS.i18n.t('shell.switchFailed'), 'neg', 8000);
      return result;
    }
    CS.shell.markActive(modeId);
    CS.shell.rememberMode(modeId);
    CS.shell.setTagline(CS.modes.tagline());
    return result;
  }

  async function boot() {
    try {
      CS.shell.showBootKey('shell.loadingLocales');
      /* 语言包是壳层的文案来源，必须先装好
         （coin 版没有共享内容库：故事模式那批带 lang 块的内容文件已随它移除） */
      await CS.contentLoader.loadLocales('./locales/');
      CS.i18n.setLocale(CS.i18n.detect());
      document.documentElement.lang = CS.i18n.locale;

      CS.shell.showBootKey('shell.loadingShell');
      CS.shell.boot(switchMode);

      /* 首屏进哪个模式：
         coin 版只剩模拟模式一个模式，所以这里不再有「教程没结束就先锁在模拟模式」
         那套门禁判断（见 ui/shell.js 文件头）。仍然保留两步兜底：
           1) 上次用的那个模式（localStorage 里记着）还在注册表里 → 就进它；
           2) 不在（例如升级前记的是已经移除的故事模式）→ 退到注册表里的第一个，
              保证一定有东西可玩，而不是停在一个没有按钮、也没有内容的空壳上。 */
      CS.shell.showBootKey('shell.loadingMode');
      const wanted = CS.shell.preferredMode();
      const first = CS.modes.getMode(wanted) ? wanted : ((CS.modes.list()[0] || {}).id);
      const result = await switchMode(first);
      if (!result.ok) {
        const fallback = (CS.modes.list()[0] || {}).id;
        CS.shell.markActive(first);
        await switchMode(fallback);
      }

      /* 时钟联动：壳把 tick 转发给当前模式的 onTick（只有模式自己知道要挂什么） */
      CS.events.bus.on('shell.modeChanged', () => CS.shell.setTagline(CS.modes.tagline()));

      CS.shell.hideBoot();
      CS.logs.push('启动完成');
    } catch (error) {
      CS.errors.push({ message: `启动失败：${error && error.message}`, stack: error && error.stack });
      const node = document.getElementById('shellBoot');
      if (node) {
        /* 错误必须看得见：遮罩可能已经被 hideBoot() 收掉了（例如模式在等玩家点对话框时
           才失败），所以这里要把 hidden 摘掉再写文案，否则玩家面对的是一片空白。 */
        node.classList.remove('hidden');
        node.innerHTML = `<div class="shell-error"><p>${CS.util.escapeHtml(CS.i18n.t('shell.bootFailed'))}</p><pre class="small">${CS.util.escapeHtml(String(error && error.message))}</pre></div>`;
      }
    }
  }

  /* defer 脚本按顺序执行，DOM 已就绪；直接跑 */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 给自动化探针用的只读句柄（tools/*.mjs 靠它读状态，不碰内部）。
     ★ 与旧版的差别只有一处：多了 graph() 与 vendor()，它们读的是**内核自己记的账**。
       探针因此可以断言「加载顺序确实是依赖拓扑序」，而不是只看结果对不对。 */
  window.__cs = {
    errors: () => CS.errors.slice(),
    logs: () => CS.logs.slice(),
    mode: () => CS.modes.current,
    modes: () => CS.modes.list().map(m => m.id),
    switchMode,
    shell: () => CS.shell,
    i18n: () => CS.i18n.snapshot(),
    graph: () => CS.graph(),
    vendor: () => CS.vendor.slice(),
    ready: () => CS.ready,
    content: () => CS.contentRegistry.counts(),
    validate: () => CS.validate.run({}),
    /* coin 版：故事模式已移除，story() 这一格随之删除（探针读到它会是一条假读数）。
       要读模拟模式的状态用 tools 里那几个探针，走 CS.classicMode.state()。 */
    tags: () => CS.shell.setTagline
  };
})();
