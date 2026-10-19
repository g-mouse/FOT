/* ============ 内容 schema 常量表（校验脚本与运行期共用同一批） ============
   为什么单独一个文件：这些表是**契约的文字形式** ——
      REQUIRED          每种条目必须有哪些字段
      EFFECT_OPS_*      新闻 / buff 允许出现的算子白名单
      EVENT_IDS         内核事件词表（buff 的 unlockEvent 另有词表，运行时并起来用）
      LANG_REQUIRED     哪些桶**必须**有 zh-CN 文案
      RESERVED_TLDS     演示用域名后缀（发布方域名不许用真域名）

   它们同时被 core/validate/validate.js（浏览器与 Node 都能跑）和 CS/tools/*.ps1 的静态扫描引用，
   「脚本说没事、运行期炸了」的根因就是两边各抄了一份表。所以只在这一处定义。

   零依赖、纯数据：这个文件不引用 CS 上的任何东西（除 allEventIds 里那次可选读取）。 */
CS.define('core/validate/validateSchema', ["core/text/expr"], function () {
  'use strict';

  const REQUIRED = {
    buff: ['id', 'polarity', 'tags', 'life', 'effects', 'source'],
    ending: ['id', 'tier', 'weight', 'priority', 'requires'],
    news: ['id', 'kind', 'publisherId', 'credibility', 'effects', 'redaction'],
    publisher: ['id', 'displayName', 'domain', 'tier', 'credibilityBase'],
    window: ['id', 'kind', 'chrome', 'risk', 'pages'],
    scam: ['id', 'category', 'channel'],
    choiceSet: ['id', 'options'],
    character: ['id', 'region', 'country', 'start'],
    country: ['id', 'code', 'currency', 'fxToUSD', 'incomeBand'],
    city: ['id', 'code', 'slug'],
    namePack: ['id', 'region', 'surnames', 'given'],
    obsession: ['id', 'stages'],
    egg: ['id', 'requires'],
    /* 小剧情（data/storylets/*.js）：category 是八类之一，line/node 是主线-支线图里的坐标，
       trigger 决定什么时候投递，options 是选项（选项的 buffs 就是「这段剧情换来的状态」）。 */
    storylet: ['id', 'category', 'line', 'trigger', 'options']
  };

  /* 发布方域名只允许这几个保留后缀 —— 内容里出现真域名是要拦下来的（NEWS_POLICY.md） */
  const RESERVED_TLDS = ['.example', '.test', '.invalid'];

  /* 内核事件：由 modes/story/storyEvents.js 在月度检查里 fire 的那些 */
  const EVENT_IDS = [
    'ev.margin_call', 'ev.liquidation', 'ev.big_win', 'ev.big_loss', 'ev.job_loss', 'ev.promotion',
    'ev.debt_overdue', 'ev.debt_cleared', 'ev.fraud_discovered', 'ev.hospitalized', 'ev.relation_break',
    'ev.new_month', 'ev.high_volatility', 'ev.drawdown_20', 'ev.profit_50', 'ev.rate_cycle_up', 'ev.rate_cycle_down'
  ];

  /* 新闻的效果算子白名单（与 newsEngine.applyEffects 的 switch 分支一一对应） */
  const EFFECT_OPS_NEWS = ['debtShock', 'debtIndexLink', 'sectorReturn', 'instrumentReturn', 'expenseShock', 'incomeShock', 'walletAlert', 'flagSet', 'mailUnlock', 'buffGrant'];

  /* buff 的效果算子白名单（与 buffEngine 汇总时实际支持的 switch 分支一一对应） */
  const EFFECT_OPS_BUFF = ['monthlyIncome', 'annualBonus', 'monthlyExpense', 'oneTimeCash', 'debtRateModifier', 'debtDueModifier', 'feeRate', 'feeRateMul', 'marginRatio', 'leverageCap', 'positionCap', 'instrumentWhitelist', 'instrumentBlacklist', 'statCap', 'statBonus', 'riskTolerance', 'socialCapital', 'infoEdge', 'creditScore', 'timeCost', 'taxRate', 'unlockEvent', 'unlockMail', 'fakeNewsBias', 'discoveryBonus'];

  /* 哪些内容桶**必须有 zh-CN 文案**：玩家真的会读到它们。
     发布方用 displayName、名字库用条目自身、影响画像是给排片器看的 —— 都不强制 lang。 */
  const LANG_REQUIRED = ['buff', 'ending', 'news', 'window', 'scam', 'choiceSet', 'obsession', 'egg', 'character', 'country', 'city', 'storylet'];

  /* buff 的 unlockEvent 用的是另一张词表（由 buffEngine 在月度结算时触发），
     与内核事件分开：这里把两张表并起来做引用校验。 */
  function allEventIds() {
    /* coin 版：buffEngine.BUFF_EVENTS 那张词表随故事模式的月度结算引擎一起移除了，
       所以这里只剩内核事件这一张表。 */
    return EVENT_IDS.slice();
  }

  function issue(list, level, kind, id, why) { list.push({ level, kind, id, why }); }

  /* 把一棵条件树里引用到的 flag / stat / fact / buff / mail 收集到一个袋子里 */
  function refsOf(cond, bag) {
    const r = CS.expr.references(cond || {});
    bag.flags.push(...(r.flags || []));
    bag.stats.push(...(r.stats || []));
    bag.facts.push(...(r.facts || []));
    bag.buffs.push(...(r.buffs || []));
    bag.mails.push(...(r.mails || []));
    bag.unknowns.push(...(r.unknowns || []));
    return bag;
  }

  return {
    validateSchema: { REQUIRED, RESERVED_TLDS, EVENT_IDS, EFFECT_OPS_NEWS, EFFECT_OPS_BUFF, LANG_REQUIRED, allEventIds, issue, refsOf }
  };
});
