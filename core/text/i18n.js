/* ============ i18n ============
   t("key") / t("key", {name:"…"})。所有面向用户的文本都必须走这里，
   包括 classic 模式的标语 —— 因为它在故事模式下要被「当前执念」替换（[R11]），
   留在 HTML 里的那句话是改不动的。

   ★ 查表内核现在是 **i18next**（vendor/，MIT），不是手写的对象索引。
     但**缺键策略、语言回退、复数挑档、has() 的口径仍然由这一层说了算** ——
     那几件事是**产品行为**，不是库行为：

       1) 缺键契约（三支验收工具与 dev 面板都读它）：
            目标语言缺 → 回退 zh-CN；两边都缺 → 返回 key 的最后一段
            （`mail.x.subject` → `subject`），并把「谁在写这个不存在的键」
            记进 CS.errors 与调用点账本（missingReport().sites）。
          i18next 的缺键行为是「返回 key 本身」，也没有调用点账本 ——
          换过去就是换掉了这条契约。所以查表与「有没有」这两件事都由这一层说了算，
          引擎那一侧只出**文本**（getFixedT 取到的那一条）。
       1b) 占位符替换**仍然是这一层的 interpolate()**，没有交给引擎 ——
          差分实测过（同一批文案、同一批参数，两边逐字比）：
            · `params[k] === null`：本地版留字面量 `{k}`，引擎版替成空串；
            · `{{x}}`：本地版认里面的 `{x}`，引擎版整段不认；
            · `{a b}` / `{你好}`：本地版不认（只认 `\w+`），引擎版会认。
          要让引擎完全等价，得先加一层「把 null 参数删掉」的适配器 ——
          那比留着手写这 7 行更绕。所以留着，并把差异记在这里；
          引擎的 prefix/suffix 配置成单花括号只是**备用**（将来真交给它时不改文案）。
       2) `has(key)` 问的是「**任何一门**已加载的语言里有没有这个键」，
          这是校验器（core/validate + tools/validate-content.mjs + tools/validate-cities.mjs）
          要的问题形态，i18next 没有对应的问题。
       3) 复数：数据里写的是 `{one, other}` 两档（落在 `key.__plural`），
          而 i18next 走 ICU 的复数后缀（`_one` / `_other` / `_few`…）。
          两套都在，但**谁生效只能有一个**：这里把 `key.__plural` 拆成
          `key_one` / `key_other` 两份资源喂给引擎，查表时按 `n === 1` 显式挑。
          （中文只有 'other' 一个类别；全交给库去解析的话 tCount('x', 1)
            会落到 other 那一档，而作者手写的两档语义就是「1 与其它」。）

   绝不抛错、绝不白屏：一个缺键不该让整局游戏打不开。 */
CS.define('core/text/i18n', ["lib/i18next","lib/lodash"], function () {
  'use strict';

  const i18next = window.i18next;
  if (!i18next) {
    throw new Error('vendor 没装齐：core/text/i18n.js 需要 window.i18next（i18next 的 UMD 构建）。见 index.html 的 vendor 段与 tools/check-vendor.mjs');
  }

  const state = {
    locale: 'zh-CN',
    fallback: 'zh-CN',
    dicts: {},              // code -> { key: text }   本站的规范字典（has / 复数 / 调用点用）
    missingKeys: [],        // 去重后的缺键清单
    missingSet: new Set(),
    missingCount: 0,
    /* 缺键 → 调用点（"文件:行"）。键名漂移最难查的不是「缺了什么键」，
       而是「谁在写这个不存在的键」——'fee.lowUnreasonable' 这种
       在字典里查不到、在内容库里也搜不到，只有调用栈知道它从哪来。
       索引写进 missingCallSites 之后，一条 CS.errors 就够定位了。 */
    missingCallSites: {}
  };

  /* 从调用栈里挑第一帧**不属于本文件**的位置。
     为什么不取栈顶：栈顶永远是这里的 t() 自己，没有信息量。 */
  function callerSite() {
    try {
      const stack = String(new Error().stack || '').split('\n');
      for (let i = 0; i < stack.length; i++) {
        const line = stack[i];
        if (!line || /i18n\.js/.test(line)) continue;
        const m = line.match(/([^/\\()\s]+\.js):(\d+):(\d+)/);
        if (m) return `${m[1]}:${m[2]}`;
        const m2 = line.match(/at\s+(?:[^\s(]+\s+)?\(?([^):]+):(\d+):(\d+)\)?/);
        if (m2) return `${m2[1].split(/[/\\]/).pop()}:${m2[2]}`;
      }
    } catch (_) { /* 取不到调用点不影响缺键本身被记录 */ }
    return '';
  }

  /* ---------- 字典规范化（本站的那一份） ---------- */
  function normalize(dict) {
    const out = {};
    if (!dict) return out;
    for (const k of Object.keys(dict)) {
      const v = dict[k];
      if (Array.isArray(v)) {
        /* 结局的 epilogue 与新闻的 body 都可以写成**段落数组**。
           早期实现直接 String(v)，数组会被逗号连成一行 ——
           排版全毁，而且不报错。这里统一按段落拼接。 */
        out[k] = v.map(x => String(x == null ? '' : x)).join('\n\n');
      } else if (v && typeof v === 'object' && v.text != null) {
        out[k] = String(v.text);
        if (v.one != null && v.other != null) { out[k + '.__plural'] = { one: v.one, other: v.other }; }
      } else if (v != null) out[k] = String(v);
    }
    return out;
  }

  /* 本站字典 → i18next 资源：把 `key.__plural` 拆成 `key_one` / `key_other`（见文件头第 3 条） */
  function toResources(flat) {
    const translation = {};
    for (const k of Object.keys(flat)) {
      const v = flat[k];
      if (v && typeof v === 'object' && (v.one != null || v.other != null)) {
        if (v.one != null) translation[k + '_one'] = String(v.one);
        if (v.other != null) translation[k + '_other'] = String(v.other);
        continue;
      }
      translation[k] = v;
    }
    return { translation };
  }

  function resourcesOf() {
    const out = {};
    for (const code of Object.keys(state.dicts)) out[code] = toResources(state.dicts[code]);
    return out;
  }

  /* ---------- i18next 实例 ----------
     · initImmediate:false —— 本站的 t() 是**同步**调用的，资源就在内存里，
       file:// 下也没有「等资源加载」这件事。不同步初始化的话第一次 t()
       会打到还没装好的实例上（表现是首屏文案整片退化成 key 的尾段）。
     · keySeparator:false / nsSeparator:false —— 本站的键里带点
       （`mail.cn.x.subject`），而 i18next 默认把 `.` 与 `:` 当键/命名空间分隔符，
       那会把整串键拆开去找，结果什么都查不到。
     · interpolation.prefix/suffix 改成单个花括号 —— 本站的占位符就是 `{name}`
       （不是 i18next 默认的 `{{name}}`），于是语言包里那 7 千多条文案一个字都不用改。
     · escapeValue:false —— 这些文本进的是 textContent，从不进 innerHTML。 */
  const engine = i18next.createInstance();
  engine.init({
    lng: state.locale,
    fallbackLng: state.fallback,
    resources: {},
    initImmediate: false,
    keySeparator: false,
    nsSeparator: false,
    pluralSeparator: '_',
    returnNull: false,
    /* 兜底：正常路径不会走到（我们在调引擎之前已经用 lookup 判过存在性） */
    parseMissingKeyHandler: key => key,
    interpolation: { prefix: '{', suffix: '}', escapeValue: false }
  });

  /* 资源表变了就整份换掉。为什么不用 addResourceBundle：
     它对同名键是**深合并**（同键保留旧值），而本站并表的语义是
     「后加载的覆盖先加载的」。整份 store 换掉才是这里要的（并表本身幂等）。 */
  function publish() {
    engine.services.resourceStore.data = resourcesOf();
  }

  function registerLocale(code, dict) {
    state.dicts[code] = normalize(dict);
    publish();
    return state.dicts[code];
  }

  /* 从 CS.content.locales 里把内容库自带的词条也并进来：
     内容作者把文案写在内容文件里（defineNews 的 titleKey 等），
     落地时统一进同一张表，这样 t() 只有一个查表路径。 */
  function loadFromRegistry() {
    const reg = CS.content.locales || {};
    for (const code of Object.keys(reg)) {
      const entry = reg[code];
      if (entry && entry.dict) {
        state.dicts[code] = Object.assign({}, state.dicts[code] || {}, normalize(entry.dict));
      }
    }
    publish();
    return Object.keys(state.dicts);
  }

  function lookup(code, key) {
    const dict = state.dicts[code];
    if (!dict) return undefined;
    return dict[key];
  }

  /* 取一条**原文**：先确认它在这一门语言里存在，再让引擎把文本还给我。
     于是引擎只负责「查到之后怎么给出文本」，不参与「有没有」的判断 ——
     缺键账本因此仍然是我们在记（i18next 不知道调用点）。 */
  function rawOf(code, key) {
    if (lookup(code, key) === undefined) return undefined;
    const value = engine.getFixedT(code, 'translation')(key);
    return value === undefined ? undefined : String(value);
  }

  function interpolate(text, params) {
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, name) => {
      if (params[name] === undefined || params[name] === null) return m;
      return String(params[name]);
    });
  }

  function missKey(k) {
    state.missingCount++;
    if (!state.missingSet.has(k)) {
      state.missingSet.add(k);
      state.missingKeys.push(k);
      const site = callerSite();
      if (site) state.missingCallSites[k] = site;
    }
    if (CS.dev && CS.errors.length < 500) {
      const site = state.missingCallSites[k];
      CS.errors.push({ message: `缺少语言键：${k}（语言 ${state.locale}）${site ? ' @ ' + site : ''}` });
    }
  }

  function t(key, params) {
    if (key == null) return '';
    const k = String(key);
    let raw = rawOf(state.locale, k);
    if (raw === undefined && state.locale !== state.fallback) raw = rawOf(state.fallback, k);
    if (raw === undefined) {
      missKey(k);
      /* 「ns.key」这种形状的 key 至少把最后一段吐出来，比整串 key 好看 */
      return params && params.default ? String(params.default) : k.split('.').slice(-1)[0];
    }
    return interpolate(raw, params);
  }

  /* 复数/量词：中文不分单复数，英文分。数据里 {one, other} 是唯二的档。
     显式按 `n === 1` 挑（理由见文件头第 3 条），不查 Intl.PluralRules。 */
  function tCount(key, n, params) {
    const k = String(key);
    const want = Number(n) === 1 ? 'one' : 'other';
    for (const code of [state.locale, state.fallback]) {
      const plural = lookup(code, k + '.__plural');
      if (!plural) continue;
      const text = plural[want];
      if (text === undefined || text === null) continue;
      return interpolate(text, Object.assign({ n }, params));
    }
    return t(k, Object.assign({ n }, params));
  }

  /* has(key)：这个键**在任何一门已加载的语言里**存在吗。
     校验器要问的正是这个问题 —— 只查「当前语言 + 回退语言」的话，
     一条只有 en 词条的内容（zh-CN 允许缺正文）会被误报成缺键。 */
  function has(key) {
    const k = String(key);
    for (const code of Object.keys(state.dicts)) {
      if (state.dicts[code] && state.dicts[code][k] !== undefined) return true;
    }
    return false;
  }

  function setLocale(code) {
    if (!state.dicts[code]) return false;
    state.locale = code;
    engine.changeLanguage(code);
    try { localStorage.setItem('cs.locale', code); } catch (_) {}
    return true;
  }

  function detect() {
    let saved = null;
    try { saved = localStorage.getItem('cs.locale'); } catch (_) {}
    if (saved && state.dicts[saved]) return saved;
    const nav = (navigator.language || 'zh-CN');
    if (/^en/i.test(nav) && state.dicts.en) return 'en';
    return state.fallback;
  }

  function missingReport() {
    return {
      count: state.missingCount,
      keys: state.missingKeys.slice().sort(),
      /* 键 → 调用点（"文件:行"）：查「这个键是从哪冒出来的」全靠它 */
      sites: Object.assign({}, state.missingCallSites)
    };
  }

  return {
    i18n: {
      t, tCount, has, setLocale, detect, registerLocale, loadFromRegistry, missingReport,
      get locale() { return state.locale; },
      get available() { return Object.keys(state.dicts); },
      /* 只读快照：dev 面板要显示「哪些键缺了」 */
      snapshot: () => ({ locale: state.locale, fallback: state.fallback, available: Object.keys(state.dicts), missing: missingReport() }),
      /* 引擎句柄：**只给诊断用**（debug 面板与探针想看看 i18next 眼里的语言表）。
         业务一律走 t / tCount / has —— 直接改引擎会绕过上面的缺键账本。 */
      engine: () => engine
    },
    /* 简写：几乎所有模块都要用 t()。旧版是在注册之后手写一句 `CS.t = CS.i18n.t` ——
       那是一处**绕过注册表的全局写入**：静态检查看不见它，谁也不知道 CS.t 是谁的。
       现在它是这一份导出里的一个键，来源唯一（tools/check-graph.mjs 能对上账）。 */
    t
  };
});
