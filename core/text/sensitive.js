/* ============ 敏感词与实体转写（[R15]） ============
   两处强制执行，这不是可选装饰：
     1) 校验期：tools/scrub-news.ps1 扫全量文本，命中即报错并列行号
     2) 运行期：新闻投放前**再过滤一次**（防御性 —— 作者写错了不至于漏到玩家面前）
   所以这一层必须是纯字符串函数、零副作用、可在 headless 里跑。

   规则表来自 data/sensitive/{rules.js, entityMap.js, blocklist.js}。
   分级设置 content.filterStrength = 严格 | 标准（默认标准）：
     · 标准：删除联系方式/导流/真实域名，转写真实机构，抽象化政治与伤亡细节
     · 严格：在标准之上，把赌博/诈骗话术也降级为含蓄表达，脏话一律替换

   ★ 「像不像一个联系方式 / 一个真实网址」这几条判据现在由 **validator.js**
     （vendor/，MIT）判定，不再是一堆手写正则：
       isEmail / isMobilePhone / isURL / isISO8601
     为什么敢换：这几条以前是**会静默出错**的那一类 —— 正则漏一种写法，
     结果不是报错，而是「一条真实手机号就这样投放到玩家面前」。
     库的实现有测试、有维护，边界比手写的清楚。

   ★★ 但有两条**必须**留在这里，换不得：
     1) **替换标记逐字不变**（［链接已移除］/［域名已移除］/［联系方式已移除］/
        ［已移除］/［已删减］）—— 它们同时写在 data/sensitive/rules.js 与
        tools/scrub-news.mjs 里，是跨文件的契约；改一个字，工具报的与运行期挡的
        就变成两套判定。
     2) RESERVED_TLDS 的判据是**子串**（列表里写着 '.example.com'，所以
        `x.example.com.evil.com` 也算保留名）。validator 的域名解析会把它收紧成
        「按最后一个标签判定」，那是**行为变化**：假窗口里那批刻意保留的假域名
        会有一批突然变成「真实域名」被删掉。所以 isReserved() 继续用子串判据。 */
CS.define('core/text/sensitive', ["lib/lodash","lib/validator"], function () {
  'use strict';

  /* validator.js 的 UMD 全局名就叫 validator；装不上就直接抛 ——
     静默缺失的表现是「真实的手机号与邮箱不再被拦」，而那种缺陷不会有人报错。 */
  const validator = window.validator;
  if (!validator) {
    throw new Error('vendor 没装齐：core/text/sensitive.js 需要 window.validator。见 index.html 的 vendor 段与 tools/check-vendor.mjs');
  }

  const state = { compiled: null, strength: 'standard', hits: [], applied: 0 };

  const DEFAULT_ENTITY_MAP = {
    countries: {
      US: '北国', CN: '华国', JP: '东瀛', IN: '天竺', NG: '西非联合共和国',
      BR: '南十字联邦', RU: '北陆联邦', KR: '汉江共和国', DE: '莱茵联邦',
      TR: '两海共和国', EG: '尼罗河国', ID: '千岛共和国', VN: '湄公国',
      BD: '恒河三角洲国', KE: '东非高原国', AR: '银之国', PL: '维斯瓦国',
      AE: '海湾联合酋长国', CA: '枫叶国', MX: '仙人掌国'
    },
    institutions: {
      '美联储': '联合储备局', '央行': '货币当局', '某央行': '联合储备局',
      '高盛': '华鼎资本', '摩根士丹利': '华鼎资本', '摩根大通': '华鼎资本',
      '纳斯达克': '环宇证券交易所', '纽交所': '环宇证券交易所',
      '路透社': '环球商讯', '彭博社': '环球商讯', '华尔街日报': '环球商讯',
      'IMF': '国际货币协调组织', '世界银行': '国际发展银行'
    },
    generic: { '某投行': '华鼎资本', '某交易所': '环宇证券交易所', '某媒体': '环球商讯' }
  };

  /* 真实域名/联系方式/导流：一律删掉。保留后缀白名单（.example/.test/.invalid）
     之外的一律视为真实域名残留 —— 诈骗窗口里的假域名也必须落在白名单内。
     ★ 判据是**子串**（见文件头第 2 条），不是域名解析。 */
  const RESERVED_TLDS = ['.example', '.test', '.invalid', '.example.com', '.example.net', '.example.org'];
  const URL_RE = /\bhttps?:\/\/[^\s"'<>）)】\]]+/gi;
  const BARE_DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|cn|net|org|io|co|me|app|xyz|top|info|biz|ru|jp|kr|de|uk|fr|br|in)\b/gi;
  const CONTACT_RE = /(?:\+?\d[\d\s\-()]{7,}\d)|(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(?:微信|QQ|Telegram|电报|WhatsApp|Line)\s*[:：]?\s*[A-Za-z0-9_\-]{4,}/gi;
  const QR_RE = /(扫码|二维码|长按识别|点击链接|加我好友|私聊我|客服微信|进群)/g;
  /* ISO 日期（2025-01-14）会被「电话号」那条正则误伤 —— 它是内容条目里的
     redaction.checkedAt，是合规证据而不是联系方式。所以按形状排除掉：
     形如 YYYY-MM-DD 的一律不算联系方式。
     ★ 形状判据仍然是这一条正则，不用 validator.isISO8601 替换它：
       库的 ISO 口径比这里宽（'2025-1-4'、周历、序数日期都算），
       而这里要排掉的是**恰好被电话号正则捞到的那一种形状**。
       库的那一支只作为「更宽松的先行挡板」串在后面（见 isContactLike），
       于是结果只会更保守，不会漏。 */
  const ISO_DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}$/;

  /* 一个匹配出来的片段「像不像真实联系方式」。
     三段判据都走 validator.js：
       · isISO8601  —— 日期形状（合规证据，不是联系方式）
       · isEmail    —— 邮箱
       · isMobilePhone('any') —— 纯数字/带分隔符的长串（真实手机号就是这样）
     最后那条「纯数字且长度 <= 10 的一律放过」**必须**保留：它是为了不把
     金额与编号（例如内部单号 1234567890）当成手机号删掉。 */
  function isContactLike(text) {
    const t = String(text).trim();
    if (t.length > 12 && validator.isISO8601(t)) return false;
    if (ISO_DATE_RE.test(t)) return false;
    const digits = (t.match(/\d/g) || []).length;
    if (digits < 7) return false;
    if (/^[\d\s]+$/.test(t) && digits <= 10) return false;
    if (validator.isEmail(t)) return true;
    if (validator.isMobilePhone(t, 'any')) return true;
    /* ★ 走到这里说明「有 7 位以上数字、但 validator 不认它是手机号」。
       不能就此放过：CONTACT_RE 本来就比手机号宽（带 ()/- 的号码、'电话:12345678'）。
       旧实现对这些形态一律算命中，所以这里也必须算 —— 换库只许更严，不许更松。 */
    return true;
  }

  function flattenEntityMap() {
    const out = [];
    const maps = CS.content.entityMaps;
    const ids = Object.keys(maps);
    const push = (from, to) => { if (from && to && String(from) !== String(to)) out.push({ from: String(from), to: String(to) }); };
    if (!ids.length) {
      Object.values(DEFAULT_ENTITY_MAP).forEach(group => Object.keys(group).forEach(k => push(k, group[k])));
      return out;
    }
    ids.forEach(id => {
      const entry = maps[id];
      const groups = entry.countries || entry.institutions || entry.generic || entry.map || entry.table;
      if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
        Object.keys(groups).forEach(k => {
          const v = groups[k];
          if (v && typeof v === 'object') Object.keys(v).forEach(k2 => push(k2, v[k2]));
          else push(k, v);
        });
      }
      (entry.pairs || []).forEach(p => push(p.from || p[0], p.to || p[1]));
    });
    /* 长词优先：先替换「摩根士丹利」再替换「摩根」，否则会切出半个词 */
    return out.sort((a, b) => b.from.length - a.from.length);
  }

  function flattenBlocklist() {
    const out = [];
    Object.keys(CS.content.blocklists).forEach(id => {
      const entry = CS.content.blocklists[id];
      (entry.terms || entry.words || []).forEach(t => {
        if (typeof t === 'string') out.push({ term: t, category: entry.category || id, action: 'block' });
        else out.push({ term: t.term || t.text, category: t.category || entry.category || id, action: t.action || 'block', replace: t.replace });
      });
    });
    return out;
  }

  function flattenRules() {
    const out = [];
    Object.keys(CS.content.sensitiveRules).forEach(id => {
      const entry = CS.content.sensitiveRules[id];
      (entry.rules || []).forEach((r, idx) => out.push(Object.assign({ id: `${id}#${idx}` }, r)));
    });
    return out;
  }

  function compile() {
    const entities = flattenEntityMap();
    const blocklist = flattenBlocklist();
    const rules = flattenRules();
    state.compiled = { entities, blocklist, rules, entityIndex: buildIndex(entities.map(e => e.from), 'entity'), blockIndex: buildIndex(blocklist.map(b => b.term), 'term') };
    return state.compiled;
  }

  /* 每个敏感词一条正则太慢（几百上千条），折成前缀索引 + 一次扫描。
     文本量级是「一个月几条新闻」，性能不是瓶颈，但校准期要跑几万次，还是快一点好。 */
  function buildIndex(terms, kind) {
    const map = {};
    terms.forEach(t => {
      if (!t) return;
      const c = t[0];
      (map[c] = map[c] || []).push({ term: t, kind });
    });
    return map;
  }

  function scanTerms(text, index, kind) {
    const hits = [];
    const src = String(text == null ? '' : text);
    for (let i = 0; i < src.length; i++) {
      const bucket = index[src[i]];
      if (!bucket) continue;
      for (const item of bucket) {
        if (src.startsWith(item.term, i)) hits.push({ kind, term: item.term, index: i, context: src.slice(Math.max(0, i - 12), i + item.term.length + 12) });
      }
    }
    return hits;
  }

  function isReserved(url) {
    const lower = String(url).toLowerCase();
    return RESERVED_TLDS.some(tld => lower.indexOf(tld) >= 0);
  }

  /* scan(text) → 命中清单。tools/scrub-news.ps1 用同一份逻辑的 JS 兜底实现，
     保证「脚本报的」与「运行期挡的」是同一套判定。 */
  function scan(text, options) {
    const opts = options || {};
    if (!state.compiled) compile();
    const src = String(text == null ? '' : text);
    const hits = [];
    (src.match(URL_RE) || []).forEach(u => { if (!isReserved(u)) hits.push({ category: 'real_url', match: u, action: 'remove' }); });
    (src.match(BARE_DOMAIN_RE) || []).forEach(d => { if (!isReserved(d)) hits.push({ category: 'real_domain', match: d, action: 'remove' }); });
    (src.match(CONTACT_RE) || []).forEach(c => { if (isContactLike(c)) hits.push({ category: 'contact', match: c, action: 'remove' }); });
    (src.match(QR_RE) || []).forEach(c => hits.push({ category: 'diversion', match: c, action: 'remove' }));
    scanTerms(src, state.compiled.blockIndex, 'blocklist').forEach(h => hits.push({ category: 'blocklist', match: h.term, action: 'remove', context: h.context }));
    scanTerms(src, state.compiled.entityIndex, 'entity').forEach(h => hits.push({ category: 'entity', match: h.term, action: 'transcribe', context: h.context }));
    state.compiled.rules.forEach(rule => {
      if (!rule.pattern) return;
      if (rule.strength === 'strict' && opts.strength !== 'strict') return;
      let re;
      try { re = new RegExp(rule.pattern, rule.flags || 'g'); } catch (_) { return; }
      let m; let guard = 0;
      while ((m = re.exec(src)) !== null && guard++ < 200) {
        hits.push({ category: rule.category || rule.id, match: m[0], action: rule.action || 'replace', replace: rule.replace, ruleId: rule.id });
        if (!re.global) break;
      }
    });
    return hits;
  }

  /* filter(text) → { text, hits, changed }：投放前真正执行的那一步 */
  function filter(text, options) {
    const opts = options || {};
    const strength = opts.strength || state.strength;
    const src = String(text == null ? '' : text);
    let out = src;
    const hits = scan(out, { strength });

    /* 1) 实体转写：先做，避免「华鼎资本」里的字又被别的规则切到 */
    if (state.compiled) {
      for (const e of state.compiled.entities) if (out.indexOf(e.from) >= 0) out = out.split(e.from).join(e.to);
    }
    /* 2) 删除类：联系方式、真实域名、导流、禁用词 */
    out = out.replace(URL_RE, m => (isReserved(m) ? m : '［链接已移除］'));
    out = out.replace(BARE_DOMAIN_RE, m => (isReserved(m) ? m : '［域名已移除］'));
    out = out.replace(CONTACT_RE, m => (isContactLike(m) ? '［联系方式已移除］' : m));
    out = out.replace(QR_RE, '［已移除］');
    if (state.compiled) {
      for (const b of state.compiled.blocklist) {
        if (!b.term || out.indexOf(b.term) < 0) continue;
        out = out.split(b.term).join(b.replace || '［已删减］');
      }
    }
    /* 3) 规则表（分级） */
    if (state.compiled) {
      for (const rule of state.compiled.rules) {
        if (!rule.pattern) continue;
        if (rule.strength === 'strict' && strength !== 'strict') continue;
        try {
          const re = new RegExp(rule.pattern, rule.flags || 'g');
          out = out.replace(re, rule.replace == null ? '［已删减］' : rule.replace);
        } catch (_) {}
      }
    }
    if (out !== src) { state.applied++; state.hits.push({ at: state.applied, count: hits.length }); }
    return { text: out, hits, changed: out !== src };
  }

  function setStrength(value) { state.strength = value === 'strict' ? 'strict' : 'standard'; return state.strength; }

  /* 只取一层的「结构扫描」：tools/ 用它逐字段扫内容文件 */
  function describe() {
    if (!state.compiled) compile();
    return {
      entities: state.compiled.entities.length,
      blocklist: state.compiled.blocklist.length,
      rules: state.compiled.rules.length,
      reservedTlds: RESERVED_TLDS.slice(),
      strength: state.strength,
      applied: state.applied
    };
  }

  return {
    sensitive: { scan, filter, setStrength, describe, compile, RESERVED_TLDS, isReserved, isContactLike, get strength() { return state.strength; } }
  };
});
