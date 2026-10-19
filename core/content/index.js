/* ============ 内容索引：把「每次线性扫全库」换成建一次的索引 ============
   这一层解决的是同一个毛病在仓库里长了 185 处的那个：**拿数组当集合/索引用**
   （全仓库 117 处 `.indexOf()` + 68 处 `.find()`，而 Map 只有 13 个、Set 只有 14 个）。
   内容库装完之后 id → 条目、代码 → 国家这类查找都应该是 O(1)，
   而「按文字找条目」应该是**倒排索引**，不是每次把一千多条内容全扫一遍。

   两样东西：
     1) O(1) 查找表（countryByCode / bucketIds）——
        起因是一个真实的重复调用：`Object.values(CS.content.countries).find(c => c.code === X)`
        在 bits.js / statBar.js / tradeModel.js 各写了一遍，
        而 bits.js 的 fmtMoney 是**每次渲染金额**都会走到的路径 ——
        每次调用都新建一个数组再线性找。实测 20 万次：线性 253ms，索引 40ms（6.2×）。
     2) **MiniSearch 倒排索引**（MIT，vendor/，UMD）——
        索引的是**玩家真正看到的文字**，不是 id：内容条目里的内联 lang 块
        在登记时已经被 core/content/registry.js 展开进 CS.content.locales[code].dict
        （键是 `${ownerId}.${field}`），所以这里直接按 ownerId 把那些文案收拢起来建索引。
        走 id 反查词条，因此不需要把每个内容的 textKey 再解一遍。

   ★ 这一格的读数要如实看（tools/check-content-index.mjs 每次都打）：
     在**当前**这个规模（1371 条文档）上，倒排索引的单次查询 **不比线性扫快** ——
     换来的东西是**能力**：分词、多词 AND、前缀、相关性排序，这些线性那边一点都没有，
     要凑出来就得自己写一套（那才是真的重复造轮子）。
     语料放大到几万条之后它才会在速度上也赢。所以这一层是「为将来的搜索准备的结构」，
     不是「现在就更快的东西」—— 不这么写清楚，下一个人会以为它是个性能优化。
   ★ 索引什么时候重建：不靠调用方记得调。内容**epoch**（registry 每登记一条 +1）变了就重建，
     比一次计数器是 O(1)。第一版这里写成「现数一遍各桶长度」，比它要替代的线性写法还贵。
   ============================================================= */
CS.define('core/content/index', ["core/content/registry","lib/minisearch"], function () {
  'use strict';

  const BUCKETS = ['news', 'mails', 'windows', 'endings', 'buffs', 'scams', 'choices', 'obsessions', 'eggs', 'publishers', 'characters'];
  const TEXT_FIELDS = ['title', 'name', 'lede', 'body', 'subject', 'desc', 'hint', 'label', 'text', 'epilogue'];

  const state = {
    epoch: -1,
    countryByCode: new Map(),
    bucketIds: new Map(),      // bucket → Set(id)
    index: null,               // MiniSearch 实例
    docs: 0,
    chars: 0,
    builtAt: 0
  };

  /* 索引失效判据：内容 epoch（core/content/registry.js 每登记一条 +1），读一次是 O(1)。
     ★ 这里曾经写成「现数一遍各桶的 Object.keys 长度」——那是 11 次数组分配，
     比它要替代的那句 `Object.values(...).find(...)` 还贵：
     实测查找 200k 次，索引 4220ms、线性 266ms，**慢 10 倍**。 */
  const epoch = () => (typeof CS.content.epoch === 'number' ? CS.content.epoch : 0);

  /* ---------- 分词：中文走 bigram（二元组） ----------
     MiniSearch 自带的分词是按空白/标点切的，对中文等于「整段一个词」——
     实测那样搜「联合储备」一条都命中不了。
     这里对 CJK 连续段切二元组、对西文按词切并转小写。
     第一版写成「整块 + 每个单字」都塞进去，索引与查询都重得多；bigram 更省也更准
     （单字会把「储」「备」这种无关共现也拉进来）。
     ★ 它是纯函数并且导出给 tools/check-content-index.mjs 用：
     对照实验必须与线上用**同一套**分词，否则比出来的是两件事。
     ★ 它必须建在**工厂作用域**：第一版手滑写进了 rebuild() 里，
     而返回对象在工厂作用域引用了它 —— 装配期直接 `tokenize is not defined`。 */
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  function tokenize(text) {
    const out = [];
    const chunks = String(text == null ? '' : text).split(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffA-Za-z0-9]+/);
    for (const chunk of chunks) {
      if (!chunk) continue;
      if (CJK.test(chunk)) {
        if (chunk.length === 1) { out.push(chunk); continue; }
        for (let i = 0; i < chunk.length - 1; i++) out.push(chunk.slice(i, i + 2));
      } else {
        out.push(chunk.toLowerCase());
      }
    }
    return out;
  }

  /* 把一条条目的可搜文字收拢出来：先直接读 entry.lang（作者写的原文），
     再补上登记期展开到语言表里的词条（键是 `${ownerId}.${field}`）。 */
  function textOf(id, entry, dict) {
    const parts = [];
    const push = v => { if (typeof v === 'string' && v) parts.push(v); };
    const lang = entry && entry.lang;
    if (lang && typeof lang === 'object') {
      for (const code of Object.keys(lang)) {
        const block = lang[code];
        if (!block || typeof block !== 'object') continue;
        for (const f of TEXT_FIELDS) push(block[f]);
      }
    }
    for (const f of TEXT_FIELDS) push(dict[`${id}.${f}`]);
    return parts.join(' ');
  }

  function rebuild() {
    const content = CS.content;
    state.countryByCode = new Map();
    state.bucketIds = new Map();
    for (const c of Object.values(content.countries || {})) {
      if (c && c.code) state.countryByCode.set(String(c.code), c);
    }
    for (const bucket of BUCKETS) {
      state.bucketIds.set(bucket, new Set(Object.keys(content[bucket] || {})));
    }

    const zh = (content.locales && content.locales['zh-CN'] && content.locales['zh-CN'].dict) || {};
    const en = (content.locales && content.locales.en && content.locales.en.dict) || {};
    const documents = [];
    let chars = 0;
    for (const bucket of BUCKETS) {
      for (const [id, entry] of Object.entries(content[bucket] || {})) {
        const text = textOf(id, entry, zh) || textOf(id, entry, en);
        if (!text) continue;
        chars += text.length;
        documents.push({ id, bucket, text });
      }
    }

    const MiniSearch = window.MiniSearch;
    state.index = new MiniSearch({
      fields: ['text'],
      storeFields: ['bucket'],
      idField: 'id',
      tokenize: tokenize,
      searchOptions: { prefix: true, combineWith: 'AND' }
    });
    try { state.index.addAll(documents); } catch (error) { state.index = null; }
    state.docs = documents.length;
    state.chars = chars;
    state.epoch = epoch();
    state.builtAt = Date.now();
  }

  function ensure() {
    if (!state.index || state.epoch !== epoch()) rebuild();
    return state.index;
  }

  /* O(1) 查找：国家代码 → 国家条目（替掉三处 Object.values(...).find(...)） */
  function country(code) {
    if (!state.countryByCode.size || state.epoch !== epoch()) rebuild();
    return state.countryByCode.get(String(code)) || null;
  }

  /* 倒排索引查询：返回 [{ id, bucket, score }]，已按相关度排序 */
  function search(query, options) {
    const index = ensure();
    if (!index) return [];
    const text = String(query == null ? '' : query).trim();
    if (!text) return [];
    const limit = (options && options.limit) || 20;
    const hits = index.search(text, Object.assign({}, options, { prefix: true }));
    return hits.slice(0, limit).map(h => ({ id: h.id, bucket: h.bucket, score: h.score }));
  }

  function has(bucket, id) {
    if (!state.bucketIds.size || state.epoch !== epoch()) rebuild();
    const set = state.bucketIds.get(bucket);
    return !!set && set.has(id);
  }

  function stats() {
    ensure();
    return { docs: state.docs, chars: state.chars, countries: state.countryByCode.size, buckets: BUCKETS.length, builtAt: state.builtAt };
  }

  return {
    contentIndex: { rebuild, country, search, has, stats, BUCKETS, tokenize }
  };
});
