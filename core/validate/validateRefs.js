/* ============ 结局条件与旗标写入面的校验（validate.js 的第 5 节） ============
   为什么单独一个文件：这一节是「≥59 条结局里有多少条其实永远到不了」的唯一判据，
   而它的正确性完全取决于**两件容易被写窄的事**：

     1) 「哪些地方会写旗标」必须扫全。早先只扫了 characters[].mails / choices /
        news.effects / windows 三处，于是下面这些真实存在的写入点全被判成「没人写」：
          · 全局邮件库 C.mails
          · 诈骗话术库 C.scams
          · 彩蛋的声明式奖励 reward:{kind:'flag', flag:'…'}
        一条永远为真的假警报会把真问题一起淹掉 —— 「校验器看着没事」就是这么来的。

     2) 旗标的**同义组**必须展开。内容里写 story.hid_the_loss 与结局读
        story.hiding_losses 是同一件事（modes/story/flags.js 里写组里任何一个成员，
        整组一起置位）。不展开就会把「写了同义词」误报成「没有任何地方写入」。

   同义组表读 CS.storyFlags（**可选**）：这一层可能在只有 core + content 的场景里跑，
   拿不到就退回「不展开」，仍然能查出真正没人写的那些。

   本文件只读 C（CS.content），不碰 DOM。 */
CS.define('core/validate/validateRefs', ["core/text/expr"], function () {
  'use strict';

  /* 条件树里三个逻辑键：摊平 / 遍历时按它递归。
     旧形状是每个节点现写一个 `['all','any','none']` 字面量再 forEach ——
     一张**常量**表，却按「被访问的节点数」重复分配。提到模块级常量后
     遍历顺序与内容一模一样（只是不再每次都新建一个 3 元数组）。 */
  const LOGIC_KEYS = ['all', 'any', 'none'];

  /* 把一棵条件树里引用到的 flag 全部摊平（结局的 requires 是嵌套的 all/any/none/not） */
  function collectFlags(node, out) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach(n => collectFlags(n, out)); return out; }
    if (node.flag) out.push(node.flag);
    LOGIC_KEYS.forEach(k => (node[k] || []).forEach(n => collectFlags(n, out)));
    if (node.not) collectFlags(node.not, out);
    return out;
  }

  /* 收集「所有会把旗标置位的地方」。addFlag 会连带展开同义组。

     两个来源：
       1) 内容库里的声明式写入（op:'flag.set'、彩蛋的 reward.kind:'flag'）—— 下面扫；
       2) 引擎自己按可测事实置位的旗标 —— 登记在 modes/story/flags.js 的
          ENGINE_WRITTEN_FLAGS 里。它们写在引擎代码里，扫内容库扫不到，
          不登记就会被误报成「没有任何地方写入」（假警报）。
          那份登记表是**硬要求**：引擎新写一条旗标就要加一行。 */
  function collectWrittenFlags(C) {
    /* coin 版：同义组表（modes/story/flags.js 的 FLAG_ALIAS）随故事模式移除，
       所以这里不再展开同义组 —— 只按内容里写到的原始旗标名记账。 */
    const alias = null;
    const written = new Set();
    const addFlag = key => {
      if (!key) return;
      written.add(key);
      const group = alias && alias[key];
      if (group) group.forEach(name => written.add(name));
    };
    /* coin 版：引擎自己写的旗标登记表（ENGINE_WRITTEN_FLAGS）随故事模式一起移除 ——
       现在没有任何引擎旗标需要登记，内容库里声明的写入点仍是下面这一遍扫描的主来源。 */
    const scanWrites = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(scanWrites);
      if (node.op === 'flag.set' && node.key) addFlag(node.key);
      if (node.op === 'flagSet' && node.key) addFlag(node.key);
      /* 彩蛋的声明式奖励：{ reward: { kind:'flag', flag:'story.egg_author' } }
         （也接受 key 这个写法 —— 两批内容作者各写了一个字段名） */
      if (node.kind === 'flag') addFlag(node.flag || node.key);
      Object.values(node).forEach(v => { if (v && typeof v === 'object') scanWrites(v); });
    };
    Object.values(C.characters).forEach(ch => {
      Object.keys((ch.start && ch.start.flags) || {}).forEach(addFlag);
      (ch.mails || []).forEach(m => scanWrites(m));
      scanWrites(ch.options);
    });
    Object.values(C.choices).forEach(cs => (cs.options || []).forEach(o => scanWrites(o)));
    Object.values(C.news).forEach(n => scanWrites(n.effects));
    Object.values(C.windows).forEach(w => { scanWrites(w.onSubmit); scanWrites(w.onAbort); scanWrites(w.flows); });
    Object.values(C.mails).forEach(m => { scanWrites(m.options); scanWrites(m.ignoredConsequence); });
    Object.values(C.scams).forEach(s => { scanWrites(s.effects); scanWrites(s.flows); scanWrites(s.options); });
    Object.values(C.eggs).forEach(egg => scanWrites(egg.reward));
    return { writtenFlags: written, addFlag };
  }

  /* 主入口：把第 5 节的结论写进 errors / warnings / stats。
       deps = { C, knownBuffs, endingIds, refsOf, issue, opts }
       · knownBuffs 是调用方建好的 Set（buff 宇宙）—— 这里只做 has；
       · endingIds 是调用方 §1 已经取好的结局 id 数组（可选）：不传就自己
         Object.keys(C.endings)，让这个模块单独也能跑（tools/ 有直接调它的地方）。 */
  function checkEndings(deps) {
    const { C, knownBuffs, refsOf, issue, opts } = deps;
    const errors = deps.errors;
    const warnings = deps.warnings;
    const stats = deps.stats;
    const allEventIds = deps.allEventIds;
    const endingIds = deps.endingIds || Object.keys(C.endings);

    const knownFlags = new Set();
    const { writtenFlags } = collectWrittenFlags(C);
    /* stat 白名单是常量数组（CS.expr.STATS），旧形状对**每个被引用的 stat** 做一次
       STATS.indexOf(s) 线性扫描。这里每轮建一次 Set：成员都是字符串，
       indexOf 的 === 与 Set.has 的 SameValueZero 是同一个判据。 */
    const statUniverse = new Set(CS.expr.STATS);

    const reachable = [];
    for (const id of endingIds) {
      const e = C.endings[id];
      const bag = { flags: [], stats: [], facts: [], buffs: [], mails: [], unknowns: [] };
      refsOf(e.requires, bag);
      bag.stats.forEach(s => { if (!statUniverse.has(s)) issue(errors, 'error', 'ending', id, `引用了不存在的 stat：${s}`); });
      bag.unknowns.forEach(u => issue(errors, 'error', 'ending', id, `引用了不存在的量：${u}`));
      bag.buffs.forEach(b => { if (!knownBuffs.has(b)) issue(warnings, 'warn', 'ending', id, `引用了不存在的 buff：${b}`); });
      bag.flags.forEach(f => {
        knownFlags.add(f);
        if (!writtenFlags.has(f) && !opts.flagWhitelist) {
          /* 「写了却永远没人设置的 flag」＝永远到不了的结局，这是 [R5] 验收第 6 条要抓的 */
          issue(warnings, 'warn', 'ending', id, `flag「${f}」没有任何地方写入 → 这条结局可能不可达`);
        }
      });
      if (!['great', 'good', 'neutral', 'bad', 'doom', 'secret'].includes(e.tier)) issue(errors, 'error', 'ending', id, `tier 非法：${e.tier}`);

      /* 结局可达性粗判：没有任何 all/any/none 的结局算「无条件可达」，
         有条件的按「条件数 ≤ 4 且无互相矛盾」估算。真正的枚举在 tools/ 里做。 */
      const condCount = (collectFlags(e.requires, []) || []).length;
      const contradictions = [];
      const scanAll = (node, map) => {
        if (!node || typeof node !== 'object') return map;
        if (Array.isArray(node)) { node.forEach(n => scanAll(n, map)); return map; }
        if (node.flag) {
          const want = node.value === undefined ? true : node.value;
          if (map.has(node.flag) && map.get(node.flag) !== want) contradictions.push(node.flag);
          map.set(node.flag, want);
        }
        (node.all || []).forEach(n => scanAll(n, map));
        return map;
      };
      scanAll(e.requires, new Map());
      const scanAny = node => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(scanAny);
        (node.any || []).forEach(alt => {
          const local = new Map();
          scanAll(alt, local);           // 单个分支内部仍然不能自相矛盾
          (alt.all || []).forEach(n => scanAll(n, local));
        });
        (node.all || []).forEach(scanAny);
        if (node.not) scanAny(node.not);
      };
      scanAny(e.requires);
      if (contradictions.length) issue(errors, 'error', 'ending', id, `条件自相矛盾（同一 flag 既 true 又 false）：${contradictions.join(', ')}`);
      reachable.push({ id, tier: e.tier, condCount, plausibility: condCount <= 5 && !contradictions.length ? 'high' : condCount <= 9 ? 'medium' : 'low' });
    }
    stats.endingReachable = reachable.filter(r => r.plausibility !== 'low').length;
    stats.knownFlags = knownFlags.size;
    stats.writtenFlags = writtenFlags.size;
    void allEventIds;
    return { knownFlags, writtenFlags, reachable };
  }

  return { validateRefs: { checkEndings, collectFlags, collectWrittenFlags } };
});
