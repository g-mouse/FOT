/* ============ 内核：模块注册表 / 命名空间 / 错误账本 ============
   这一层替换掉旧版的 core/base/namespace.js。旧的 CS.ns 只做三件事：
   往 window.CS 上挂导出、重名就抛、`CS.open()` 开一块私有命名空间 ——
   但**依赖关系一个字节都没记**：谁依赖谁只存在于 index.html 的 <script> 顺序里
   （旧版自己在 tools/lib/script-prefix.mjs 里写过这件事的代价：
   同一份顺序在仓库里存在三份拷贝，改了两份就表现成「某一支工具挂了」）。

   新内核把「依赖」变成**声明**，并且是可核对、可生成的：

     CS.define('core/base/util', ['lib/lodash', 'lib/he', 'lib/dayjs'], function (_, he, dayjs) {
       'use strict';
       ...
       return { util: {...} };      // 返回值就是要挂到 CS 上的导出（旧版是 CS.ns(name, {...})）
     });

   内核在这一步做四件事，每一件都对应旧版的一个真实故障：
     1) **依赖先决**：deps 里任何一个没注册 → 当场抛，报出缺失的名字与「谁要它」。
        旧版的等价故障是 `CS.util is undefined` —— 出现在某个面板里，看起来像那个面板坏了。
     2) **顺序即声明**：tools/build-index.mjs 从这些 deps 拓扑排序生成 index.html，
        顺序不再是人手维护的第三份拷贝；tools/check-graph.mjs 再从源码反推一遍做对账。
     3) **重名即抛**：同名导出已存在且不是同一个值 → 抛。
        旧版这里有个坑（它自己的注释里记着）：Object.assign 对已存在的同名键保留旧值，
        于是「新挂上去的五个入口一个都进不去」，而外部只看到旧的那一份。
        本内核改成显式赋值 + 身份比较，同一对象重复挂载是幂等的（indicators 那三份就是这么用的）。
     4) **导出冻结**：注册完就 Object.freeze，之后谁想改写别人的模块面当场抛（严格模式）。

   环境事实（与旧版一致，不许改）：本站要求 file:// 双击直开，
   所以**没有构建期、没有 import()、没有 fetch 本地文件** ——
   每个文件仍然是经典 <script>，只是它自己声明自己依赖谁。
   ============================================================= */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  CS.version = '2.0.0';
  /* 信息性日志与错误分开记：模式的「xx 模式就绪」不该出现在错误账本里，
     否则「控制台零报错 / CS.errors 为空」这条验收永远不可能成立。 */
  CS.errors = CS.errors || [];
  CS.logs = CS.logs || [];

  CS.dev = (function () {
    try {
      const q = String(location.search || '');
      if (/[?&]dev=0\b/.test(q)) return false;
      return location.protocol === 'file:' ? /[?&]dev=1\b/.test(q) : true;
    } catch (_) { return true; }
  })();

  /* 全局错误账本：file:// 下 window.onerror 只给一句 "Script error."，
     把出错信息先记下来，dev 面板与自动化探针随时能读。 */
  window.addEventListener('error', event => {
    CS.errors.push({
      message: String(event.message || ''),
      source: String(event.filename || ''),
      line: Number(event.lineno) || 0,
      column: Number(event.colno) || 0,
      stack: event.error && event.error.stack ? String(event.error.stack) : ''
    });
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event && event.reason;
    CS.errors.push({
      message: `未处理的 Promise 拒绝：${reason && (reason.message || reason)}`,
      stack: reason && reason.stack ? String(reason.stack) : ''
    });
  });

  /* ============ 模块注册表 ============ */
  const registry = new Map();      // id → { id, deps, exports, module }
  const external = new Map();      // id → () => value（vendor 那几个库）
  const shared = new Map();        // CS.open(name) 的私有命名空间
  const loading = [];              // 正在装配的模块（错的时候好报出来）

  const KERNEL_GLOBALS = [
    /* 内核自己提供的成员：它们不是模块，静态检查要放行 */
    'version', 'dev', 'errors', 'logs', 'define', 'need', 'needs', 'has', 'open',
    'external', 'moduleOf', 'graph', 'loading',
    /* 内容登记面（core/content/registry.js 挂上来的，数据文件用） */
    'content', 'registryIssues', 'register'
  ];

  function fmt(value) {
    if (value === null) return 'null';
    const t = typeof value;
    if (t !== 'object' && t !== 'function') return String(value);
    return Array.isArray(value) ? 'array' : t;
  }

  /* ============ CS.external：把 vendor 库接进同一套依赖表 ============
     vendor/ 里落地的库是 UMD/IIFE，各自挂一个全局名（window._、window.dayjs…）。
     这一层把「全局名」包成模块 id（lib/lodash），于是模块可以像依赖内部模块一样
     声明它：CS.define('core/base/util', ['lib/lodash'], …)。 */
  CS.external = function (id, getter) {
    if (typeof id !== 'string' || !id) throw new Error('CS.external：id 必须是非空字符串');
    if (typeof getter !== 'function') throw new Error(`CS.external(${id})：getter 必须是函数`);
    if (registry.has(id)) throw new Error(`CS.external(${id})：这个 id 已经被模块占用了`);
    external.set(id, getter);
    return CS;
  };

  /* ============ CS.define：注册一个模块 ============
     factory 的返回值即该模块的导出对象；它的每一个键会被挂到 CS 上（身份相同则幂等）。 */
  CS.define = function (id, deps, factory) {
    if (typeof id !== 'string' || !id) throw new Error('CS.define：id 必须是非空字符串');
    if (typeof deps === 'function') { factory = deps; deps = []; }
    if (!Array.isArray(deps)) throw new Error(`CS.define(${id})：deps 必须是数组`);
    if (typeof factory !== 'function') throw new Error(`CS.define(${id})：factory 必须是函数`);
    if (registry.has(id)) throw new Error(`CS.define(${id})：重复注册（同一个模块被装了两次）`);

    /* 依赖先决：缺一个就报出「谁缺、缺谁、从哪儿找」。
       旧版的等价故障是一句 `CS.xxx is undefined`，出现在很远的地方。 */
    const args = [];
    for (const dep of deps) {
      if (typeof dep !== 'string' || !dep) throw new Error(`CS.define(${id})：deps 里有非法项 ${String(dep)}`);
      if (external.has(dep)) { args.push(external.get(dep)()); continue; }
      const hit = registry.get(dep);
      if (!hit) {
        throw new Error(
          `CS.define(${id})：依赖「${dep}」还没装载。` +
          `检查 app/modules.json 里 ${id} 的 deps（index.html 的顺序由它生成：node tools/build-index.mjs）`
        );
      }
      args.push(hit.exports);
    }

    loading.push(id);
    let exported;
    try {
      exported = factory.apply(null, args);
    } catch (error) {
      loading.pop();
      /* 装配期抛错必须带上模块 id：否则只有一条裸栈，看不出是哪个模块在装配时炸了 */
      CS.errors.push({
        message: `模块 ${id} 装配失败：${error && error.message}`,
        stack: error && error.stack ? String(error.stack) : ''
      });
      throw error;
    }
    loading.pop();

    if (exported == null) {
      /* 允许「只做副作用、不导出」的模块（例如给共享命名空间添零件的），
         但一定要显式返回一个对象 —— 忘写 return 是最难查的一类静默失败。 */
      exported = {};
    } else if (typeof exported !== 'object' && typeof exported !== 'function') {
      throw new Error(`CS.define(${id})：factory 必须返回对象（拿到的是 ${fmt(exported)}）`);
    }

    const record = { id, deps: deps.slice(), exports: exported };
    registry.set(id, record);

    /* 挂到 CS 上：同名同值是幂等（indicators 那三份共用一个 ns 对象），
       同名不同值当场抛 —— 旧版这里是静默保留旧值。 */
    for (const key of Object.keys(exported)) {
      const next = exported[key];
      if (Object.prototype.hasOwnProperty.call(CS, key) && CS[key] !== next) {
        throw new Error(
          `模块 ${id} 的导出「${key}」与已有成员冲突：` +
          `同一个名字被两个模块用了（已有类型 ${fmt(CS[key])}，新的类型 ${fmt(next)}）`
        );
      }
      CS[key] = next;
    }
    if (Object.prototype.hasOwnProperty.call(exported, id)) CS[id] = exported[id];
    /* 冻结导出面：谁想改别人的模块面就当场抛（严格模式下写只读属性会抛） */
    try { Object.freeze(exported); } catch (_) {}
    return exported;
  };

  /* ============ CS.need / CS.needs：取一个已装载模块的导出 ============ */
  CS.has = id => registry.has(id) || external.has(id);
  CS.need = function (id) {
    if (external.has(id)) return external.get(id)();
    const hit = registry.get(id);
    if (!hit) {
      throw new Error(
        `CS.need('${id}')：这个模块还没装载` +
        (loading.length ? `（正在装配 ${loading[loading.length - 1]}）` : '') +
        '。检查它的 deps 声明与 app/modules.json 的顺序'
      );
    }
    return hit.exports;
  };
  CS.needs = function () {
    const out = {};
    for (const id of arguments) out[id] = CS.need(id);
    return out;
  };

  /* ============ CS.open：模块之间共享的**私有**命名空间 ============
     旧版语义原样保留：同一个名字拿到同一个对象，多个模块可以往里添零件
     （指标那三份共用 'indicators'；两个模式各自开自己的 'story' / 'classic'）。
     它刻意不进 CS 的顶层 —— 私有状态不该成为对外导出面的一部分。 */
  CS.open = function (name) {
    if (typeof name !== 'string' || !name) throw new Error('CS.open：name 必须是非空字符串');
    if (!shared.has(name)) shared.set(name, { name });
    return shared.get(name);
  };

  /* ============ 供工具读取的两张账 ============ */
  CS.graph = () => {
    const mods = [];
    registry.forEach(rec => mods.push({ id: rec.id, deps: rec.deps.slice(), exports: Object.keys(rec.exports) }));
    const libs = [];
    external.forEach((_getter, id) => libs.push(id));
    return { modules: mods, libs, kernelGlobals: KERNEL_GLOBALS.slice() };
  };
  CS.loading = () => loading.slice();

  /* ============ 就绪回调 ============
     装配顺序由 index.html 决定，但「所有人都装好了」这件事需要有一个时刻。
     app/boot.js 会 await CS.ready —— 它是这条链上唯一的异步等待点。 */
  let resolveReady;
  CS.ready = new Promise(resolve => { resolveReady = resolve; });
  CS.__seal = function () {
    CS.sealed = true;
    resolveReady(CS);
    return registry.size;
  };
})();
