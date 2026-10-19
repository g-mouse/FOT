/* ============ 内容加载器（§3.4 硬约束） ============
   铁律：角色包与内容库的加载一律走「清单文件 + 经典 <script> 动态注入」。
   · 不许 import()（file:// 下被 CORS 挡掉）
   · 不许 fetch/XHR 读本地 json（file:// 下同样被挡）
   · http:// 与 file:// 走**同一套代码**，不得出现两套分支逻辑

   清单文件本身也只是数据（纯数组 + 版本号），运维新增角色时整体替换它。
   加载顺序 = 清单里的顺序，这对种子矩阵回归是硬要求（顺序变了流的派生就变了）。 */
CS.define('core/base/contentLoader', ["core/text/i18n","lib/loadjs"], function () {
  'use strict';

  /* 注入引擎是 **loadjs**（vendor/，MIT）：它负责 createElement('script') + 设 src +
     保序执行 + 成功/失败回调 + 重试。这一层只保留**自己的契约**：
       · 单文件超时（§3.4「内容脚本加载超时」）—— loadjs 没有超时参数，
         丢了这一格就是「某个角色文件挂住 → 整局卡在加载中，一条错误都没有」；
       · 失败要进 CS.errors 与 state.failed（校验工具读它）；
       · 一个文件坏掉只让那一个下线，其余继续（见 injectAll）。
     ★ loadjs 装不上就直接抛：静默退回「什么都没有注入」看起来像内容库是空的，
       而那会把「22 个角色一个都选不到」变成一条查不到源头的现象。 */
  const loadjs = window.loadjs;
  if (typeof loadjs !== 'function') {
    throw new Error('vendor 没装齐：core/base/contentLoader.js 需要 window.loadjs（loadjs）。见 index.html 的 vendor 段与 tools/check-vendor.mjs');
  }

  const state = {
    loaded: [],            // 已注入的脚本 URL（按顺序）
    failed: [],            // { url, error }
    dataReady: false,
    charactersReady: false,
    contentVersion: '1.0.0',
    dataFiles: [],
    characterFiles: []
  };

  function injectScript(url, timeoutMs) {
    /* 超时自己兜（loadjs 没有这个口子）：契约是 §3.4 ——
       「内容脚本加载超时：URL」。挂住的脚本 loadjs 永远不会回调，
       没有这一格就是整局卡在「正在加载内容…」而 CS.errors 是空的。 */
    const limit = timeoutMs == null ? 8000 : timeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`内容脚本加载超时：${url}`));
      }, limit);
      /* 成功与失败都要先 clearTimeout —— 不然后面那条 reject 会在 8 秒后
         给一个已经 resolve 的 Promise 报一条没人接的错误。 */
      loadjs(url, {
        success: () => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          state.loaded.push(url);
          resolve(url);
        },
        error: () => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          /* 一个角色文件语法错误 / 不存在，只该让这一个角色下线，
             不该白屏（§5.4 第 9 条健壮性验收）。所以这里 reject，
             由调用方收集成 failed 列表并继续下一个。 */
          const error = new Error(`内容脚本加载失败：${url}`);
          state.failed.push({ url, error: error.message });
          CS.errors.push({ message: error.message });
          reject(error);
        }
      });
    });
  }

  async function injectAll(urls, options) {
    const opts = options || {};
    const results = [];
    for (const url of urls) {
      try { await injectScript(url, opts.timeoutMs); results.push({ url, ok: true }); }
      catch (error) { results.push({ url, ok: false, error: String(error && error.message) }); }
    }
    return results;
  }

  /* 加载共享内容库。
     清单：data/index.js  →  window.__DATA_MANIFEST__ = { version, files:[…] }
     引用它的那一句 <script> 也必须走注入（不能写成固定标签），
     否则「覆盖清单文件」这个运维动作就失效了。 */
  async function loadData(base) {
    const root = base || './data/';
    delete window.__DATA_MANIFEST__;
    await injectScript(root + 'index.js');
    const manifest = window.__DATA_MANIFEST__;
    if (!manifest || !Array.isArray(manifest.files)) {
      state.dataReady = false;
      CS.errors.push({ message: '内容库清单 data/index.js 缺失或格式不对' });
      return { ok: false, loaded: 0, failed: state.failed.slice() };
    }
    state.contentVersion = manifest.version || state.contentVersion;
    state.dataFiles = manifest.files.slice();
    const results = await injectAll(manifest.files.map(f => root + f));
    state.dataReady = true;
    /* ★ 装完就把内容条目内联的 lang 块并进 i18n 表。
       这一句以前只写在 loadAll() 的末尾，而故事模式是**直接调 loadData()** 的
       （modes/story/mode.js 的 init），于是真实运行时 i18n 表里只有 locales/ 两个文件，
       内容库那七千多条文案一条都没进去 —— 界面把每一段内容文案都显示成 key 的尾段：
       顶栏「执念 · 第 1 阶段：name —— s1」、邮件正文、buff 名、新闻、结局全都是。
       为什么测试没抓到：五个验收工具与自检都走 loadAll()（或自己补了一次并表），
       它们看到的是健康的 i18n；只有真实浏览器的启动路径是 loadData()。
       并表是幂等的、且只是复制，放在每个加载器末尾最安全 —— 谁调都不用记得再补一刀。 */
    CS.i18n.loadFromRegistry();
    return { ok: results.every(r => r.ok), loaded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok) };
  }

  /* 加载角色包。清单：characters/index.js
       window.__STORY_CHARACTERS__ = [ "cn/assembly_line_lead.js", … ]
       window.__STORY_CONTENT_VERSION__ = "2025.02.2"
     ★ 这个文件是运维会整体替换的那一个，它必须只包含文件名清单，不含任何逻辑。 */
  async function loadCharacters(base) {
    const root = base || './characters/';
    delete window.__STORY_CHARACTERS__;
    await injectScript(root + 'index.js');
    const list = window.__STORY_CHARACTERS__;
    if (!Array.isArray(list)) {
      state.charactersReady = false;
      CS.errors.push({ message: '角色包清单 characters/index.js 缺失或格式不对' });
      return { ok: false, loaded: 0, failed: [] };
    }
    if (window.__STORY_CONTENT_VERSION__) state.contentVersion = window.__STORY_CONTENT_VERSION__;
    state.characterFiles = list.slice();
    const results = await injectAll(list.map(f => root + f));
    state.charactersReady = true;
    /* 角色包里的邮件正文 / 独白 / 结局文案同样是内联 lang 块，同样要并表（理由见 loadData） */
    CS.i18n.loadFromRegistry();
    return { ok: results.every(r => r.ok), loaded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok) };
  }

  async function loadLocales(base) {
    const root = base || './locales/';
    const results = await injectAll(['zh-CN.js', 'en.js'].map(f => root + f));
    /* defineLocale 登记进 CS.content.locales，但那只是**收集**；
       真正让 t() 查得到的是这一句并表（loadFromRegistry 幂等）。 */
    CS.i18n.loadFromRegistry();
    return { ok: results.every(r => r.ok), results };
  }

  /* 一次性把整站内容装好：语言包 → 共享库 → 角色包。
     顺序不能换：角色包会引用共享库里的 buffId / mailId / endingId。 */
  async function loadAll(base) {
    const root = (base || './').replace(/\/?$/, '/');
    const locales = await loadLocales(root + 'locales/');
    const data = await loadData(root + 'data/');
    const characters = await loadCharacters(root + 'characters/');
    /* 内容条目内联的 lang 块在登记时被展开进全局语言表，
       所以内容装完之后必须再并一次表，否则 t("mail.xxx.body") 查不到。
       （loadData / loadCharacters 各自已经并过一次，这里是第三道；并表是幂等的。） */
    CS.i18n.loadFromRegistry();
    return {
      /* ★ ok 必须把 characters 也算进来。以前只看 locales && data，
         于是「22 个角色包一个都没装进来」这种全毁局面照样报 ok:true ——
         验收工具据此判定内容健康，玩家进故事模式却一个角色都选不到。 */
      ok: locales.ok && data.ok && characters.ok,
      locales, data, characters,
      contentVersion: state.contentVersion,
      loadedFiles: state.loaded.slice(),
      failedFiles: state.failed.slice(),
      /* ★ 清单文件名必须回传：工具侧靠它判断「磁盘上有、清单里没有」的孤儿文件
         （tools/validate-content.mjs、tools/news-audit.mjs）。
         少了这一格，那份比对拿到的永远是空集，于是把**已经在清单里**的
         news/*.js 统统误报成「没被加载」—— 14 条假警报盖住了真问题。 */
      dataFiles: state.dataFiles.slice(),
      characterFiles: state.characterFiles.slice(),
      registryIssues: CS.registryIssues.slice()
    };
  }

  return {
    contentLoader: {
      loadAll, loadData, loadCharacters, loadLocales, injectScript, injectAll,
      get contentVersion() { return state.contentVersion; },
      snapshot: () => ({
        dataReady: state.dataReady, charactersReady: state.charactersReady,
        contentVersion: state.contentVersion, loaded: state.loaded.length,
        failed: state.failed.slice(), dataFiles: state.dataFiles.slice(), characterFiles: state.characterFiles.slice()
      })
    }
  };
});
