/* ============ 内容注册表：所有 defineX 声明式内容落在这里 ============
   从旧内核 core/base/namespace.js 里搬出来的（内核只管模块装配，内容登记是业务）。
   语义**逐条保留**，包括三条踩过坑的规则：

   · 一条内容条目里可以内联 lang 块，登记时**递归**展开成全局语言表的词条
     （${ownerId}.${field}），并自动补 titleKey / bodyKey / nameKey …
     只给顶层展开的话，角色包里的邮件、选项组里的选项、窗口页面的文案全都查不到，
     表现是「选项显示成 opt1、邮件显示成 from」，而且不报任何错。
   · 共享内容库**只读**：登记时 deepFreeze，谁想改写一条新闻当场抛。
     例外是 locales 这一桶 —— 它是累加器（harvestNode 会持续往里写派生词条），
     冻上它会让整库语言键全部查不到。
   · id 全局唯一，重复即记一笔 registryIssues（不抛：一个坏角色不该让整局装不上）。
   ============================================================= */
CS.define('core/content/registry', ['core/base/util'], function () {
  'use strict';

  const CS_ = window.CS;
  const content = CS_.content = CS_.content || {
    namePacks: {}, countries: {}, cities: {}, buffs: {}, endings: {}, news: {}, publishers: {},
    windows: {}, scams: {}, choices: {}, obsessions: {}, eggs: {}, characters: {},
    impactProfiles: {}, locales: {},
    sensitiveRules: {}, entityMaps: {}, blocklists: {},
    /* 全局邮件库：不绑定某个角色的公共邮件（银行通知、催收模板、系统信），角色包可以引用它们 */
    mails: {},
    /* 小剧情库（data/storylets/*.js）：一条小剧情 = 一段有前情、有选项、有后果的小戏，
       由 modes/story/storyletEngine.js 编译成邮件投递，用来在「拿到某个 buff 之前」
       先讲清楚它是怎么来的。归属：category（八类）+ line/node（主线与支线的有向图）。 */
    storylets: {},
    /* 顺序账本：种子矩阵回归需要「注入顺序」稳定。
       ★ eggs 必须在列：defineEgg 走的是 definer('eggs','egg',null)，
         登记时 orderKey 落回 bucket 名 'eggs'，而这里没有这个数组的话
         `content.order.eggs` 就是 undefined —— 每月结算的 checkEggs() 都会抛一次
         TypeError，彩蛋判定整条链（[E] 隐藏成就）永远不会执行。 */
    order: { news: [], buffs: [], endings: [], characters: [], windows: [], scams: [], choices: [], eggs: [], storylets: [] }
  };
  /* ★ 内容 epoch：**登记一条就 +1**。
     它是 core/content/index.js 判断「索引要不要重建」的判据。
     为什么不能现算（比如每次去数 Object.keys(bucket).length）：那是 11 次数组分配，
     实测比它要替代的那句 `Object.values(...).find(...)` 还贵 ——
     「索引找了 200k 次、比线性慢 10 倍」这个读数就是这么来的（见 tools/check-content-index.mjs）。 */
  if (typeof content.epoch !== 'number') content.epoch = 0;

  const registryIssues = CS_.registryIssues = CS_.registryIssues || [];

  /* ---------- 内联文案的递归展开（见文件头） ---------- */
  function harvestNode(node, fallbackId, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return node;
    if (Array.isArray(node)) { node.forEach(item => harvestNode(item, fallbackId, depth)); return node; }
    /* 前缀怎么定：嵌套对象的 id 常常很短很通用（选项组里的 'opt1'），
       81 个选项组各有一个 opt1，直接拿它当前缀会互相覆盖（first-wins 会静默吃掉后面的）。
       规则：带点的 id（'mail.cn.line_lead.overtime_swap'）本身就是全局唯一的，直接用；
       不带点的 id 一律拼在父级后面（'choiceSet.scam_insider_check.opt1'）。 */
    const ownerId = node.id
      ? (String(node.id).indexOf('.') >= 0 ? node.id : (fallbackId ? `${fallbackId}.${node.id}` : node.id))
      : fallbackId;
    if (node.lang && typeof node.lang === 'object' && ownerId) {
      const zh = node.lang['zh-CN'] || node.lang.en || {};
      for (const code of Object.keys(node.lang)) {
        const dict = node.lang[code];
        if (!dict || typeof dict !== 'object') continue;
        if (!content.locales[code]) content.locales[code] = { id: code, dict: {} };
        const table = content.locales[code].dict;
        for (const field of Object.keys(dict)) {
          const key = `${ownerId}.${field}`;
          /* 第一个写进去的赢：后来者不该悄悄改写别人已经发布的文案 */
          if (table[key] === undefined) table[key] = dict[field];
        }
      }
      const has = field => zh[field] !== undefined;
      /* body 只给「有导语或正文」的条目自动补，且只补真的存在的那几个键 */
      if (!node.body && (has('lede') || has('body'))) {
        node.body = {};
        if (has('title')) node.body.titleKey = `${ownerId}.title`;
        if (has('lede')) node.body.ledeKey = `${ownerId}.lede`;
        if (has('body')) node.body.bodyKey = `${ownerId}.body`;
      }
      if (!node.nameKey && has('name')) node.nameKey = `${ownerId}.name`;
      if (!node.descKey && has('desc')) node.descKey = `${ownerId}.desc`;
      if (!node.titleKey && has('title')) node.titleKey = `${ownerId}.title`;
      if (!node.subjectKey && has('subject')) node.subjectKey = `${ownerId}.subject`;
      if (!node.bodyKey && has('body')) node.bodyKey = `${ownerId}.body`;
      if (!node.epilogueKey && has('epilogue')) node.epilogueKey = `${ownerId}.epilogue`;
      if (!node.hintKey && has('hint')) node.hintKey = `${ownerId}.hint`;
      if (!node.labelKey && has('label')) node.labelKey = `${ownerId}.label`;
      if (!node.textKey && has('text')) node.textKey = `${ownerId}.text`;
    }
    for (const field of Object.keys(node)) {
      const value = node[field];
      if (value && typeof value === 'object') harvestNode(value, ownerId || fallbackId, depth + 1);
    }
    return node;
  }
  const harvestLang = entry => harvestNode(entry, entry && entry.id, 0);

  function register(bucket, entry, orderKey) {
    const kind = orderKey || bucket;
    if (!entry || typeof entry !== 'object') { registryIssues.push({ kind, id: '(none)', why: '条目不是对象' }); return null; }
    if (!entry.id) { registryIssues.push({ kind, id: '(none)', why: '缺少 id' }); return null; }
    const table = content[bucket];
    if (Object.prototype.hasOwnProperty.call(table, entry.id)) {
      registryIssues.push({ kind, id: entry.id, why: 'id 重复（跨文件也必须全局唯一）' });
      return table[entry.id];
    }
    harvestLang(entry);
    /* 共享内容库「只读」：登记时就冻结（契约写在 util.js 与 CONTENT_GUIDE.md 里）。 */
    const frozen = (bucket !== 'locales') ? CS.util.deepFreeze(entry) : entry;
    table[entry.id] = frozen;
    content.epoch++;
    const list = content.order[orderKey];
    if (list && list.indexOf(entry.id) < 0) list.push(entry.id);
    return frozen;
  }

  /* 通用条目字段（§3.3 强制）：id / version / since / lang 或 key / tags / notes。
     这里只做「缺字段就记一笔」的软校验，硬校验交给 core/validate/validate.js 与 tools/。 */
  function base(kind, entry) {
    if (entry.version == null) registryIssues.push({ kind, id: entry.id, why: '缺少 version（种子稳定性与迁移要用）' });
    if (!entry.since) registryIssues.push({ kind, id: entry.id, why: '缺少 since（种子矩阵回归基线要用）' });
    return entry;
  }

  /* 登记函数的统一形状：**同时接受单条与数组**。
     内容作者两种写法都会用（defineBuff({...}) 与 defineNewsList([...])），
     而「数组被当成一条没有 id 的条目」是静默失败 —— 整批内容会凭空消失、
     只在 registryIssues 里留一句「缺少 id」。 */
  function batch(fn) { return list => (Array.isArray(list) ? list.map(fn) : fn(list)); }
  function definer(bucket, kind, orderKey, decorate) {
    const one = entry => {
      const e = decorate ? decorate(entry) : entry;
      return register(bucket, kind ? base(kind, e) : e, orderKey);
    };
    return batch(one);
  }

  const define = {
    definePublisher: definer('publishers', 'publisher', null),
    defineNamePack: definer('namePacks', null, null),
    defineCountry: definer('countries', 'country', null),
    /* 城市库（data/cities.js）：虚构地名层。与 countries 一样不进 order 账本 ——
       它不参与种子派生，只被 countries[].regions 与角色包的 city 引用。 */
    defineCity: definer('cities', 'city', null),
    defineBuff: definer('buffs', 'buff', 'buffs'),
    defineEnding: definer('endings', 'ending', 'endings'),
    defineNews: definer('news', 'news', 'news'),
    defineNewsGeneric: definer('news', 'news', 'news', e => { e.generic = true; if (!e.effects) e.effects = []; return e; }),
    defineImpactProfile: definer('impactProfiles', null, null),
    defineWindow: definer('windows', 'window', 'windows'),
    defineScam: definer('scams', 'scam', 'scams'),
    defineChoiceSet: definer('choices', 'choiceSet', 'choices'),
    /* 小剧情：orderKey 用桶名（与 eggs 同理），顺序账本要能在种子矩阵里回归 */
    defineStorylet: definer('storylets', 'storylet', 'storylets'),
    defineObsession: definer('obsessions', 'obsession', null),
    defineEgg: definer('eggs', 'egg', null),
    defineCharacter: definer('characters', 'character', 'characters'),
    defineMail: definer('mails', 'mail', null),
    defineLocale: definer('locales', null, null, e => (e && e.id && e.dict) ? e : { id: e && e.code, dict: e && e.dict }),
    /* [R15] 敏感过滤三张表：规则表 / 实体转写表 / 禁用词表 */
    defineSensitiveRules: definer('sensitiveRules', null, null),
    defineEntityMap: definer('entityMaps', null, null),
    defineBlocklist: definer('blocklists', null, null)
  };

  /* 批量别名：与单数同名同义，只是读起来更像「一次登记一批」 */
  define.definePublishers = define.definePublisher;
  define.defineBuffs = define.defineBuff;
  define.defineEndings = define.defineEnding;
  define.defineNewsList = define.defineNews;
  define.defineGenericNews = define.defineNewsGeneric;
  define.defineImpactProfiles = define.defineImpactProfile;
  define.defineWindows = define.defineWindow;
  define.defineScams = define.defineScam;
  define.defineChoiceSets = define.defineChoiceSet;
  define.defineStorylets = define.defineStorylet;
  define.defineObsessions = define.defineObsession;
  define.defineEggs = define.defineEgg;
  define.defineCountries = define.defineCountry;
  define.defineCities = define.defineCity;
  define.defineNamePacks = define.defineNamePack;
  define.defineMails = define.defineMail;
  define.defineCharacters = define.defineCharacter;
  /* 单数 CS.defineX 的**函数名**是内容文件唯一用到的接口；
     它们必须挂在 CS 顶层（data/*.js 里写的是 CS.defineNews(...)）。 */
  for (const key of Object.keys(define)) CS_[key] = define[key];

  return {
    register,
    registryIssues,
    content,
    contentRegistry: {
      content, registryIssues, register, harvestLang,
      define,
      /* 工具与调试面板读它：一张按桶统计的表 */
      counts() {
        const out = {};
        for (const bucket of ['news', 'buffs', 'endings', 'characters', 'windows', 'scams', 'choices', 'eggs', 'mails', 'obsessions', 'impactProfiles', 'countries', 'cities', 'namePacks', 'publishers']) {
          out[bucket] = Object.keys(content[bucket] || {}).length;
        }
        out.locales = Object.keys(content.locales || {}).length;
        return out;
      }
    }
  };
});
