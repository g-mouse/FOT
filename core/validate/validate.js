/* ============ 内容校验（dev 下跑，浏览器与 Node 都能跑） ============
   这一层只做「能读 CS.content 就做得完」的检查：
     · id 唯一、通用字段齐全（id / version / since）
     · 跨文件引用可解析（buffId / endingId / flag / eventId / publisherId / impact.profileId / windowId / trapId）
     · 语言键齐全（每个条目至少 zh-CN，*Key 字段能查到）
     · 共享只读库没有被角色包改写（对比登记快照）
     · 结局可达性枚举、邮件死内容检测
   做不了的（要读源文件文本的静态扫描）交给 CS/tools/*.ps1：
     · Math.random / Date.now / eval / fetch / import 的调用点扫描
     · 新闻配额表、句式重复率、scrub-news 敏感词扫描
   两边用的是同一批 schema 常量，避免「脚本说没事、运行期炸了」。 */
CS.define('core/validate/validate', ["core/base/contentLoader","core/base/util","core/text/i18n","core/validate/validateRefs","core/validate/validateSchema"], function () {
  'use strict';

  /* ---------- schema 常量表 ----------
     REQUIRED / RESERVED_TLDS / EVENT_IDS / EFFECT_OPS_* / LANG_REQUIRED 以及
     allEventIds / issue / refsOf 都在 core/validate/validateSchema.js ——
     静态扫描脚本与这里必须用**同一批**表，所以只留一处定义。 */
  const { REQUIRED, RESERVED_TLDS, EVENT_IDS, EFFECT_OPS_NEWS, EFFECT_OPS_BUFF, LANG_REQUIRED, allEventIds, issue, refsOf } = CS.validateSchema;

  /* ---------- 常量表 → Set（装载时各建一次） ----------
     旧形状：这几张表都是「数组当集合用」—— LANG_REQUIRED.indexOf(bucket)、
     EVENT_IDS.indexOf(...)、EFFECT_OPS_*.includes(...)，而判据都落在**每个条目 /
     每条 effect** 上，等于把同一张 3~26 个字符串的表重扫上千遍。
     新形状：这些表在 validateSchema 里只定义、不修改，所以包一层 Set 就够 ——
     判据从「线性扫 N 个字符串」变成一次哈希。语义等价：成员全是字符串，
     indexOf / includes 的 `===` 与 Set.has 的 SameValueZero 是同一个判据。
     ★ 导出面仍然给**数组**：tools/from-original/validate-content.mjs 用
       `[].concat(CS.validate.EVENT_IDS)` 读它；Set 只在本文件内部用。 */
  const LANG_REQUIRED_SET = new Set(LANG_REQUIRED);
  const EVENT_ID_SET = new Set(EVENT_IDS);
  const EFFECT_OPS_NEWS_SET = new Set(EFFECT_OPS_NEWS);
  const EFFECT_OPS_BUFF_SET = new Set(EFFECT_OPS_BUFF);

  /* 主入口：返回 { ok, errors[], warnings[], stats } */
  function run(options) {
    const opts = options || {};
    const C = CS.content;
    const errors = [], warnings = [];
    const stats = {};

    /* ---------- 0. 索引：整轮校验的 id 宇宙只在这里取一次 ----------
       旧形状：本文件里 25 处 Object.keys() —— 同一张表被反复遍历（news 走三遍：
       §1 取 length、§1 再遍历、§2 语言键、§3 新闻；characters 走四遍），§9 又把
       buffs / endings / publishers / news 的键各取一遍；桶循环里还用
       `Object.values(C.countries).find(...)` 给**每个城市**重新线性找一遍国家
       （cities × countries，而且每找一个城市就新建一个数组）。
       新形状：桶 → id 数组、桶 → 表本体各存一份（§1 建，下面各节全部复用），
       跨表引用（国家 code / 邮件 id / 事件 id）折成 Map 或 Set。
       为什么 id 索引存**数组**而不是 Set：这些 id 还要用来遍历、取 .length、
       末尾 .sort() 算指纹；只有真要做「属于 / 不属于」判据的地方才再包一层 Set。
       内容库在一轮 run() 里只读（下面每一节都只 issue，不改内容），索引不会过期。 */

    /* 国家索引：一次遍历填两格 —— §1 的城市校验沿用原来 find 的**首个匹配**口径，
       §6 的角色校验沿用原来 Map.set 的**末个覆盖**口径。code 正常唯一，但两者在
       重复 code 下的行为不同，所以分开存，不合并成一张表。 */
    const countryByCode = new Map();
    const regionOfCountry = new Map();
    for (const c of Object.values(C.countries)) {
      if (!countryByCode.has(c.code)) countryByCode.set(c.code, c);
      regionOfCountry.set(c.code, c);
    }

    /* ---------- 1. 通用字段与 schema ---------- */
    const idsByBucket = {}, tablesByBucket = {};
    for (const bucket of Object.keys(REQUIRED)) {
      const table = bucket === 'buff' ? C.buffs : bucket === 'ending' ? C.endings : bucket === 'news' ? C.news :
        bucket === 'publisher' ? C.publishers : bucket === 'window' ? C.windows : bucket === 'scam' ? C.scams :
          bucket === 'choiceSet' ? C.choices : bucket === 'character' ? C.characters : bucket === 'country' ? C.countries :
            bucket === 'city' ? C.cities :
              bucket === 'namePack' ? C.namePacks : bucket === 'obsession' ? C.obsessions : C.eggs;
      /* ★ 本桶唯一的一次取键：stats 要的 length 与下面所有小节的遍历共用它。 */
      const ids = Object.keys(table);
      idsByBucket[bucket] = ids;
      tablesByBucket[bucket] = table;
      stats[bucket] = ids.length;
      for (const id of ids) {
        const entry = table[id];
        for (const field of REQUIRED[bucket]) {
          if (entry[field] === undefined) issue(errors, 'error', bucket, id, `缺少必填字段 ${field}`);
        }
        if (entry.version == null) issue(warnings, 'warn', bucket, id, '缺少 version（种子稳定性与迁移要用）');
        if (!entry.since) issue(warnings, 'warn', bucket, id, '缺少 since（种子矩阵回归基线要用）');
        /* 城市条目（data/cities.js）的两条硬约束：code 必须是国家库里的 code、
           slug 必须是该国 regions 里的一项。没有这两条，角色包写死的 city 就是无人校验的自由文本。 */
        if (bucket === 'city') {
          /* 旧形状：Object.values(C.countries).find(c => c.code === entry.code) ——
             每来一个城市就把国家表 values 成一个新数组再线性找。索引 §0 建好，
             这里一次 Map.get（口径同为「首个匹配」）。 */
          const home = countryByCode.get(entry.code);
          const regions = (home && home.regions) || [];
          if (!home || regions.indexOf(entry.slug) < 0) issue(errors, 'error', 'city', id, `code/slug 与国家库对不上：${entry.code}/${entry.slug}（该国城市键：${regions.join(', ') || '空'}）`);
        }
        if (LANG_REQUIRED_SET.has(bucket) && (!entry.lang || !entry.lang['zh-CN'])) {
          issue(errors, 'error', bucket, id, '缺少 lang["zh-CN"] 文案');
        }
      }
    }
    CS.registryIssues.forEach(it => issue(errors, 'error', it.kind, it.id, it.why));

    /* ---------- 2. 语言键齐全 ---------- */
    /* 分两档：
       硬错误 —— 玩家一定会读到的「条目自身文案」（name/desc/title/subject/body/epilogue…）；
       警告 —— 效果里的 reasonKey / textKey / labelKey 这类「次要说明」，
               它们有优雅降级（t() 会退到 key 的最后一段），缺了不好看但不会让内容消失。 */
    const HARD_FIELDS = ['nameKey', 'descKey', 'titleKey', 'subjectKey', 'bodyKey', 'ledeKey', 'epilogueKey', 'monologueKey', 'hintKey', 'blurbKey', 'clearedKey'];
    const SOFT_FIELDS = ['reasonKey', 'textKey', 'labelKey', 'logKey', 'templateId', 'noteKey', 'replyTextKey', 'npcReactionKey', 'fromKey', 'displayKey'];
    /* 这两档只做成员判据（walk 里每个 *Key 字段都要问一次），旧形状是
       SOFT_FIELDS.indexOf(k) / HARD_FIELDS.indexOf(k) —— 拿两个常量数组当集合，
       而且是按「字段出现次数」重扫。包一层 Set，口径同为字符串判等。 */
    const HARD_FIELD_SET = new Set(HARD_FIELDS);
    const SOFT_FIELD_SET = new Set(SOFT_FIELDS);
    /* 桶 → id 数组 / 表本体都取自 §0/§1 的索引：这里原来自己又 Object.keys 了 9 遍
       （buff/ending/news/window/scam/choiceSet/obsession/egg/character 各一遍全表遍历）。 */
    const checkKeys = bucket => {
      const table = tablesByBucket[bucket];
      for (const id of idsByBucket[bucket]) {
        const entry = table[id];
        HARD_FIELDS.forEach(field => {
          const key = entry[field];
          if (key && !CS.i18n.has(key)) issue(errors, 'error', bucket, id, `${field} 指向的语言键查不到：${key}`);
        });
        const walk = (node, where) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
          for (const k of Object.keys(node)) {
            const v = node[k];
            if (/Key$/.test(k) && typeof v === 'string') {
              if (SOFT_FIELD_SET.has(k)) {
                if (!CS.i18n.has(v)) issue(warnings, 'warn', bucket, id, `${where}.${k} 语言键查不到（有降级，会显示成「${String(v).split('.').pop()}」）：${v}`);
              } else if (HARD_FIELD_SET.has(k) && !CS.i18n.has(v)) {
                issue(errors, 'error', bucket, id, `${where}.${k} 语言键查不到：${v}`);
              }
            } else if (v && typeof v === 'object') walk(v, `${where}.${k}`);
          }
        };
        walk(entry, id);
      }
    };
    checkKeys('buff');
    checkKeys('ending');
    checkKeys('news');
    checkKeys('window');
    checkKeys('scam');
    checkKeys('choiceSet');
    checkKeys('obsession');
    checkKeys('egg');
    checkKeys('character');

    /* ---------- 3. 新闻：发布方、域名白名单、redaction、effects、impact ---------- */
    let emptyEffects = 0, fakeCount = 0, realCount = 0;
    /* id 数组取自 §1（旧形状在这里又 Object.keys(C.news) 了一遍）。 */
    for (const id of idsByBucket.news) {
      const n = C.news[id];
      const publisher = C.publishers[n.publisherId];
      if (!publisher) issue(errors, 'error', 'news', id, `publisherId 解析不到：${n.publisherId}`);
      else {
        const domain = String(publisher.domain || '');
        if (!RESERVED_TLDS.some(tld => domain.endsWith(tld) || domain.indexOf(tld) >= 0)) {
          issue(errors, 'error', 'news', id, `发布方域名不在保留后缀白名单内：${domain}`);
        }
      }
      if (!n.redaction || n.redaction.rewritten !== true) issue(errors, 'error', 'news', id, 'redaction.rewritten 必须为 true（加工过的机器可验证证据）');
      else {
        if (!n.redaction.sourceHint) issue(warnings, 'warn', 'news', id, 'redaction.sourceHint 为空');
        if (!n.redaction.checkedAt) issue(warnings, 'warn', 'news', id, 'redaction.checkedAt 为空');
      }
      if (!Array.isArray(n.effects)) issue(errors, 'error', 'news', id, 'effects 必须是数组');
      else {
        /* 「纯情绪条目 ≤70」这条配额针对的是**主新闻**。
           通用快讯池（news/generic/*，§4A.4(3) 用来填日历格的第三顺位）按设计
           effects 必须为空 —— 把它一起数进来的话，160 条填充内容会立刻顶爆配额，
           而那不是内容缺陷、恰恰是硬验收第 22 条要求的形状。
           通用池要查的是反过来的事：effects **非空**才算错。 */
        if (!n.effects.length) {
          if (n.generic) { stats.newsGenericEmptyEffects = (stats.newsGenericEmptyEffects || 0) + 1; }
          else emptyEffects++;
        } else if (n.generic) {
          issue(errors, 'error', 'news', id, '通用快讯池的条目 effects 必须为空（硬验收第 22 条：填格子不得改变任何数值）');
        }
        n.effects.forEach((e, i) => {
          if (!EFFECT_OPS_NEWS_SET.has(e.op)) issue(errors, 'error', 'news', id, `effects[${i}] 的 op 不在白名单里：${e.op}`);
        });
      }
      if (n.impact && n.impact.profileId && !C.impactProfiles[n.impact.profileId]) {
        issue(errors, 'error', 'news', id, `impact.profileId 解析不到：${n.impact.profileId}`);
      }
      if (!n.impact && !n.impactInline) issue(warnings, 'warn', 'news', id, '既没有 impact.profileId 也没有内联 impact，排片器只能靠 kind 猜');
      if (n.generic) { if (n.effects && n.effects.length) issue(errors, 'error', 'news', id, '通用快讯池的 effects 必须为空（[R18] 验收 22）'); }
      if (n.trigger && n.trigger.kind === 'event' && !EVENT_ID_SET.has(n.trigger.event)) {
        issue(errors, 'error', 'news', id, `trigger.event 不是已知事件：${n.trigger.event}`);
      }
      Object.values(n.relatedIds || {}).forEach(() => {});
      (n.relatedIds || []).forEach(rid => { if (!C.news[rid]) issue(errors, 'error', 'news', id, `relatedIds 指向不存在的新闻：${rid}`); });
      if (n.truth === false) fakeCount++; else realCount++;
      if (n.audienceRange && n.audienceRange.countries) {
        const codes = n.audienceRange.countries;
        /* 旧形状：Object.values(C.countries).some(c => c.code === code) ——
           每来一个国码就把国家表 values 成一个新数组再线性找。国家 code 集合
           已折进 §0 的 countryByCode 键集，这里一次 has（判据同为「有没有这个 code」）。 */
        const playable = codes.filter(code => countryByCode.has(code));
        /* 作者偶尔会写到国家库之外的地方（HK/NL/TH…）。
           这不是错误 —— 排片器会忽略不可玩的码（见 newsScheduler.audienceOk）。
           只有「一个可玩国家都没提到」时才提示一句，避免刷屏。 */
        if (!playable.length) issue(warnings, 'warn', 'news', id, `audienceRange.countries 里没有一个国家在可玩国家库里：${codes.join(',')}（该条目会当作通稿投放）`);
      }
    }
    stats.newsReal = realCount; stats.newsFake = fakeCount; stats.newsEmptyEffects = emptyEffects;
    if (emptyEffects > 70) issue(errors, 'error', 'news', '(统计)', `纯情绪条目 ${emptyEffects} 条，超过配额上限 70 条`);

    /* ---------- 4. buff ---------- */
    /* 邮件索引与事件并表：本节的「属于 / 不属于」判据要用（口径见下面 clearedBy 那段）。
       ★ 原来 mailIndex 建在 buff 循环**里面**：没传 opts.mailIds 时，每校验一条 buff
       就重建一次（82 条 buff × (91 封全局邮件 + 22 个角色的邮件) 各拷一遍，外加 82 个
       临时对象）—— 这是本文件里最实的一处重复劳动。索引的输入在一轮 run() 里不变，
       所以提到循环外只建一次；`opts.mailIds ||` 的短路顺序原样保留
       （调用方传了索引就一点都不建）。allEventIds() 同理，它每次调用都 concat 出新数组。
       为什么是 Set + 普通对象而不是别的：事件判据是纯成员测试（Set），邮件索引要按
       `mail.<id>` 整串取条目（对象键查表），两者都已经是 O(1)。 */
    const mailIndex = opts.mailIds || (() => {
      const map = {};
      Object.keys(C.mails).forEach(k => { map[k] = C.mails[k]; });
      Object.values(C.characters).forEach(ch => (ch.mails || []).forEach(m => { if (m && m.id && !map[m.id]) map[m.id] = m; }));
      return map;
    })();
    const allEventIdSet = new Set(allEventIds());
    /* id 数组取自 §1（旧形状在这里又 Object.keys(C.buffs) 了一遍）。 */
    for (const id of idsByBucket.buff) {
      const b = C.buffs[id];
      if (['pos', 'neg', 'mixed'].indexOf(b.polarity) < 0) issue(errors, 'error', 'buff', id, `polarity 非法：${b.polarity}`);
      if (!Array.isArray(b.effects)) issue(errors, 'error', 'buff', id, 'effects 必须是数组');
      else b.effects.forEach((e, i) => {
        if (!EFFECT_OPS_BUFF_SET.has(e.op)) issue(errors, 'error', 'buff', id, `effects[${i}] 的 op 不在白名单里：${e.op}`);
        if (e.op === 'unlockEvent' && !allEventIdSet.has(e.eventId)) issue(warnings, 'warn', 'buff', id, `unlockEvent 不在两张事件词表里：${e.eventId}`);
      });
      if (typeof b.life === 'string' && /^months:/.test(b.life) && !/^months:\d+$/.test(b.life)) issue(errors, 'error', 'buff', id, `life 格式应为 months:N：${b.life}`);
      /* clearedBy 的每一格都是「谁能让这条 buff 消失」，形状只有两种：
           `mail.<id>#<optId>`   —— 回某封信的某个选项
           `event.<id>`          —— 某个事件
         校验要三件事都做，少一件就是放过一条**永远解除不了**的负面 buff：
           1) 邮件 id 真的存在（**查 C.mails，不是 C.news** —— 早先查的是新闻表，
              于是每一条指向邮件的 clearedBy 都会报警，包括那些邮件明明存在的）；
           2) `#optId` 那半个也要存在（一条 buff 写着 mail.clinic_report#opt3，
              而那封信只有 opt1/opt2 —— 以前**没有任何工具**能发现，
              因为大家都只比对 # 前面那一半）；
           3) 事件在词表里。
         mailIds 由调用方（tools/）传全量索引；没传时把 C.mails 与角色包邮件并起来自己算
         （索引已在循环外建好，这里只取用）。 */
      (b.clearedBy || []).forEach(ref => {
        const text = String(ref);
        const hash = text.indexOf('#');
        const target = hash >= 0 ? text.slice(0, hash) : text;
        const optId = hash >= 0 ? text.slice(hash + 1) : '';
        if (target.startsWith('mail.')) {
          const mail = mailIndex[target];
          if (!mail) issue(warnings, 'warn', 'buff', id, `clearedBy 指向的邮件不存在：${target}（这条 buff 永远不会被它解除）`);
          else if (optId && !(mail.options || []).some(o => o && o.id === optId)) {
            issue(warnings, 'warn', 'buff', id, `clearedBy 指向的选项不存在：${text}（${target} 只有 ${(mail.options || []).map(o => o.id).join(' / ') || '没有选项'}）`);
          }
        } else if (target.startsWith('event.') || target.startsWith('ev.')) {
          /* coin 版：故事模式的 buffEngine 已移除，事件 id 归一化只剩这一条规则。
             （原来这里优先问 buffEngine.normalizeEventId，那是故事模式的词表。） */
          const norm = target.replace('event.', 'ev.');
          if (!allEventIdSet.has(norm)) issue(warnings, 'warn', 'buff', id, `clearedBy 指向的事件不在事件词表：${target}`);
        } else {
          /* clearBy 在运行期只会收到 `mail.x#optN` 或 event 两种引用（见 mailEngine / storyEvents），
             别的形状（例如 trade.sell_car）永远匹配不到 —— 这是一条**结构性**死引用。 */
          issue(warnings, 'warn', 'buff', id, `clearedBy 的引用形状无法匹配（只认 mail.x#optN 与 event.x）：${text}`);
        }
      });
    }

    /* ---------- 5. 结局：条件引用可解析 + 可达性 ----------
       整节搬到了 core/validate/validateRefs.js（结局条件与「旗标写入面」的校验）。
       搬走的原因：那一节的正确性取决于「哪些地方会写旗标」扫得全不全、
       以及同义组有没有展开 —— 这两条都需要大段说明，混在这里会把本文件撑过**当时**的 400 行上限。 */
    const knownBuffs = new Set(idsByBucket.buff);
    const { knownFlags, writtenFlags } = CS.validateRefs.checkEndings({
      /* endingIds 把 §1 已经取好的结局 id 数组带过去：validateRefs 原来为这一节
         又 Object.keys(C.endings) 了一遍（同一次 run() 里第二遍全表取键）。 */
      C, knownBuffs, endingIds: idsByBucket.ending, refsOf, issue, opts, errors, warnings, stats, allEventIds
    });

    /* ---------- 5b 已并入 §1 与 §6 ----------
       虚构地理表的三边一致性（国家 ↔ 城市 ↔ 角色）拆在两处，因为那两处本来就在遍历：
         §1 的桶循环里查「city 条目的 code 必须在国家库里、slug 必须在该国 regions 里」；
         §6 的角色循环里查「character.city 必须在本国 regions 里」。
       为什么必须查：character.city 存在时 pickCity() 会**直接返回它**、绕过 regions 兜底，
       写错一个键只会让人物面板显示一个不存在的城市，完全不报错。
       反向覆盖（regions 里的键是否都有城市条目）与 id 自洽由 tools/validate-cities.mjs 直接查表。 */

    /* ---------- 6. 角色包：引用可解析 + 增量清单一致性 ---------- */
    /* regionOfCountry 在 §0 与城市索引同一次遍历里建好（旧形状在这里又
       Object.values(C.countries) 走了一遍）。 */
    /* 全体角色的邮件 id 宇宙：旧形状在**每条邮件 × 每个 mutex / requires** 上做
       `own.some(x => x.id === mid) || Object.values(C.characters).some(c => c.mails.some(...))`，
       也就是 O(角色数 × 邮件数) 的重复扫描，而且每问一次就新建一个 Object.values 数组。
       这里一次收齐：own.mails 是全体角色邮件的子集，所以原来那两段「或」可以合并成
       一次 allMailIds.has(mid)（原判据是 `x.id === mid`，没写 id 的邮件会与 mid 为
       undefined 时匹配上；Set 里照原样收 undefined，口径一致）。 */
    const allMailIds = new Set();
    Object.values(C.characters).forEach(ch => (ch.mails || []).forEach(x => allMailIds.add(x.id)));
    /* id 数组取自 §1（旧形状在这里又 Object.keys(C.characters) 了一遍）。 */
    for (const id of idsByBucket.character) {
      const ch = C.characters[id];
      if (!regionOfCountry.has(ch.country)) issue(errors, 'error', 'character', id, `country 不在国家库里：${ch.country}`);
      /* 角色钉死的城市键必须是本国 regions 里的一项（写死的那条路绕过 pickCity 的兜底） */
      const homeRegions = (regionOfCountry.get(ch.country) || {}).regions || [];
      if (ch.city && homeRegions.indexOf(ch.city) < 0) issue(errors, 'error', 'character', id, `city「${ch.city}」不在 country.${ch.country}.regions 里（可用：${homeRegions.join(', ') || '空'}）`);
      (ch.start && ch.start.buffs || []).forEach(b => { if (!C.buffs[b]) issue(errors, 'error', 'character', id, `start.buffs 引用了不存在的 buff：${b}`); });
      (ch.mails || []).forEach(m => {
        if (!m.id) issue(errors, 'error', 'character', id, '有一封邮件没有 id');
        (m.options || []).forEach(o => {
          (o.effects || []).forEach(e => {
            if (e.op === 'buff.add' && e.id && !C.buffs[e.id]) issue(errors, 'error', 'character', id, `邮件 ${m.id} 的选项引用了不存在的 buff：${e.id}`);
            if (e.op === 'flag.set' && !e.key) issue(errors, 'error', 'character', id, `邮件 ${m.id} 的 flag.set 缺少 key`);
          });
          if (o.visibleIf) {
            const bag = { flags: [], stats: [], facts: [], buffs: [], mails: [], unknowns: [] };
            refsOf(o.visibleIf, bag);
            bag.unknowns.forEach(u => issue(errors, 'error', 'character', id, `邮件 ${m.id} 的 visibleIf 引用了不存在的量：${u}`));
          }
        });
        if (m.trigger && m.trigger.kind === 'event' && !EVENT_ID_SET.has(m.trigger.event)) {
          issue(warnings, 'warn', 'character', id, `邮件 ${m.id} 的 trigger.event 不是已知事件：${m.trigger.event}`);
        }
        /* mutex / requires 的「这封信存在吗」都改成查 §6 开头那一个 id 集合（O(1)） */
        (m.mutex || []).forEach(mid => {
          if (!allMailIds.has(mid)) issue(warnings, 'warn', 'character', id, `邮件 ${m.id} 的 mutex 指向不存在的邮件：${mid}`);
        });
        (m.requires || []).forEach(r => {
          if (r.mailId) {
            if (!allMailIds.has(r.mailId)) issue(errors, 'error', 'character', id, `邮件 ${m.id} 的 requires 指向不存在的邮件：${r.mailId}`);
          }
        });
      });
      (ch.obsession || []).forEach(o => {
        if (o.id && !C.obsessions[o.id] && !o.descKey) issue(warnings, 'warn', 'character', id, `obsession 引用了不存在的执念且没自带 descKey：${o.id}`);
      });
      /* 彩蛋字段名：schema（任务书 §3.4）写的是 `easterEggs`，早期校验器只读 `eggs`。
         两个都认 —— 因为两批内容作者各写了一个，而它们在语义上完全等价。 */
      const eggRefs = [].concat(ch.eggs || [], ch.easterEggs || []);
      Array.from(new Set(eggRefs)).forEach(eggId => { if (!C.eggs[eggId]) issue(warnings, 'warn', 'character', id, `easterEggs 引用了不存在的彩蛋：${eggId}`); });
      (ch.endings || []).forEach(e => { if (!e.id) issue(errors, 'error', 'character', id, '角色专属结局缺少 id'); });
      if (!ch.mails || !ch.mails.length) issue(warnings, 'warn', 'character', id, '这个角色一封邮件都没有');
      if (!ch.obsession || !ch.obsession.length) issue(warnings, 'warn', 'character', id, '这个角色没有执念（[R11] 顶栏要有东西可显示）');
    }

    /* ---------- 7. 角色清单一致性（「覆盖清单 + 丢文件」运维动作的护栏） ---------- */
    const manifest = CS.contentLoader.snapshot().characterFiles;
    if (manifest && manifest.length) {
      const registered = idsByBucket.character.length;
      if (registered < manifest.length) {
        issue(warnings, 'warn', 'characters', '(清单)', `清单里列了 ${manifest.length} 个角色文件，但只登记了 ${registered} 个角色（可能有文件语法错误或未调用 defineCharacter）`);
      }
    }

    /* ---------- 8. 窗口 / 诈骗 ---------- */
    /* 两个 id 数组都取自 §1（旧形状在这里各 Object.keys 了一遍）。
       kind / category / polarity / tier 这几个是**字面量**白名单，每个桶各扫一遍
       （窗口 60 余条、诈骗 20 余条），线性扫 3~8 个字符串不构成热点，故保持原样。 */
    for (const id of idsByBucket.window) {
      const w = C.windows[id];
      if (['browser', 'wallet', 'bank', 'im', 'exchange', 'app'].indexOf(w.kind) < 0) issue(errors, 'error', 'window', id, `kind 非法：${w.kind}`);
      if (!w.risk || !Array.isArray(w.risk.flaws) || !w.risk.flaws.length) issue(errors, 'error', 'window', id, 'risk.flaws 至少要有一条可发现线索');
      if (w.risk && w.risk.trapId && !C.scams[w.risk.trapId] && String(w.risk.trapId).startsWith('trap.')) {
        /* trap 允许指向 window 自己的 id 空间，这里只提示 */
        issue(warnings, 'warn', 'window', id, `risk.trapId「${w.risk.trapId}」在 scams 表里没有对应条目（若它指向的是 window 内部流程可忽略）`);
      }
      const addr = w.chrome && w.chrome.addressBar;
      if (addr && !RESERVED_TLDS.some(tld => String(addr).indexOf(tld) >= 0)) issue(errors, 'error', 'window', id, `chrome.addressBar 用了非保留域名：${addr}`);
    }
    for (const id of idsByBucket.scam) {
      const s = C.scams[id];
      if (!['insider', 'romance', 'fake_job', 'fake_tax_refund', 'relative_borrow', 'fake_cs', 'fake_platform', 'pig_butchering'].includes(s.category)) {
        issue(warnings, 'warn', 'scam', id, `category 不在建议清单里：${s.category}`);
      }
    }

    /* ---------- 9. 共享只读库没有被改写 ---------- */
    /* 名字（issue 的 kind）→ §1 的桶名：四张表的 id 数组在 §1 已经取过，
       旧形状在这里又把 buffs / endings / publishers / news 的键各取了一遍。 */
    const sharedBuckets = [['buffs', 'buff'], ['endings', 'ending'], ['publishers', 'publisher'], ['news', 'news']];
    for (const [name, bucket] of sharedBuckets) {
      const table = tablesByBucket[bucket];
      for (const id of idsByBucket[bucket]) {
        const entry = table[id];
        if (entry.__owner && entry.__owner !== 'shared') issue(errors, 'error', name, id, `共享库条目被角色包改写（owner=${entry.__owner}）`);
      }
    }

    return {
      ok: errors.length === 0,
      errors, warnings, stats,
      /* 指纹与摘要复用 §0 的 id 数组。★ 这里的 .sort() 必须作用在**副本**上：
         idsByBucket 里的数组本轮还要用（上面各节都按原顺序遍历），原地排序会把索引本身改掉。 */
      fingerprint: CS.util.fingerprint({
        buffs: idsByBucket.buff.slice().sort(), endings: idsByBucket.ending.slice().sort(),
        news: idsByBucket.news.length, characters: idsByBucket.character.slice().sort()
      }),
      summary: `${idsByBucket.character.length} 角色 · ${idsByBucket.buff.length} buff · ${idsByBucket.ending.length} 结局 · ${idsByBucket.news.length} 新闻 · ${idsByBucket.window.length} 窗口 · ${idsByBucket.scam.length} 话术 · ${idsByBucket.choiceSet.length} 选项组`
    };
  }

  return { validate: { run, REQUIRED, EVENT_IDS, EFFECT_OPS_NEWS, EFFECT_OPS_BUFF, RESERVED_TLDS } };
});
