/* ============ 六课脚本（LESSONS）与它的只读视图 ============
   课程表：**四课多空（两多两空）**，然后第五课挂单、第六课杠杆。
   2026-10-19 用户口径：「前面做多做空太冗长」—— 原来前四课是同一个动作重复五遍，
   现在压到四课：做多 → 做空 → 再做多（拿住）→ 再做空（收尾）。
   课表里**没有**「这一课该赢还是该亏」：输赢由那台 80% 的骰子逐单决定。
   ★ 由此带出一条文案纪律：`script.hold` **不许预告涨跌**。
     骰子有 20% 是亏单（亏单的行情往反方向走），写死「价格在跌 / 浮盈在变多」
     就会出现「教程说会跌、图上却在涨」。要讲方向就讲「做空跌了赚、涨了亏」这种规则，
     不替这一单下结论 —— 走反了由 openTrade.hint() 的亏单那一句来说。
   ★ 课表长度就是毕业判据：record.js 用「已下过的单数 ≥ 课表长度」判毕业，
     所以删课 / 加课之后旧存档会自然重算（改课表时要同时看 record.js 的 SYLLABUS）。 */

CS.define('core/tutorial/lessons', ["core/tutorial/tune","lib/lodash"], function () {
'use strict';

  const TUNE = CS.tutorialTune.TUNE;

  /* ============ 6 课脚本 ============
     每一课的字段：
       id        课号（存档里按课号记进度，改名会丢进度）
       side      1 = 做多，-1 = 做空 —— **多空交替**，前四课 2 多 2 空
       title     课名（老师的话与探针都读它）
       focus     这一课要玩家点的按钮（写 DOM id，界面只认 id）
       goal      本课目标（底部那一行「这一课要做什么」）
       holdHours 这一单要走多久（走几根 = holdHours ÷ 一次推进的小时数）
       script    { open, hold, close } —— 三个阶段老师的旁白

     ★ 第五、六课多出来的几格（前四课没有，都留空）：
       order      'limit' = 这一课用**限价委托**（引导会把下单方式切成它、并预填委托价）
       allow      **这一课要解锁哪几个控件**（写 data-tut-lock 的值）。
                  引导平时把它们置灰（固定 20× / 市价），只有讲它的那一课才放开 ——
                  否则「看得见、点得动、但点了不算数」会变成「讲杠杆的那一课杠杆是灰的」。
       hint / hintPlaced / hintFar / hintFilled
                  这一课在挂单 / 杠杆上的专用说明：
                  还没开仓给 hint，挂上还没成交给 hintPlaced（太远给 hintFar），
                  成交之后给 hintFilled。底部的提示行对每一课都画（见 openTrade.js 的 hint）。
       leverage   这一课默认多少倍（写 TUNE 的键名，由 pick 解出来）

     输赢不在这里：由 favor.js 的骰子逐单决定。所以旁白也**不预告结果**，
     只说「该做什么、为什么」。 */
  const LESSONS = [
    { id: 'L01', side: 1, title: '方向性敞口：建立多头头寸', focus: 'longBtn', holdHours: 12,
      goal: '以市价建立多头头寸，观察保证金、名义敞口与强平价的联动。',
      hint: '保证金已按当前执行档位预置并锁定，无需调整；直接执行「做多 / 买入」，建立多头头寸。',
      script: {
        open: '标的：CXP/USDT 永续合约。方向：多头。保证金与杠杆已按执行档位预置，按市价提交后以盘口现价成交。',
        hold: '多头头寸已建立。图中红线为强制平仓价，距现价仅数个价位；单根反向 K 线的影线即可触发强平。推进时间，观察权益随标记价格变动。',
        close: '通过持仓行的「平仓」了结头寸；未平仓盈亏仅为标记口径，不构成已实现损益。'
      } },
    { id: 'L02', side: -1, title: '方向性敞口：建立空头头寸', focus: 'shortBtn', holdHours: 24,
      goal: '以市价建立空头头寸，理解空头盈亏结构与强平价方向。',
      script: {
        open: '方向切换为空头。空头通过先卖出、后买回获取价差，保证金与强平规则与多头对称。执行「做空 / 卖出」。',
        hold: '空头头寸的盈亏与价格反向：价格下行产生盈利，上行产生亏损；强平价位于现价上方。推进时间，观察保证金占用。',
        close: '执行「平仓」买回头寸；浮动盈亏转为已实现损益。'
      } },
    { id: 'L03', side: 1, title: '持仓管理：趋势持有与回撤容忍', focus: 'longBtn', holdHours: 24,
      goal: '在既定方向上持有头寸，观察浮动盈亏与回撤路径。',
      script: {
        open: '建立多头头寸。开仓仅完成执行，持仓管理取决于对回撤的容忍度与强平边界。执行「做多 / 买入」。',
        hold: '持有期内浮动盈亏随标记价格波动；单根或连续 K 线的逆向影线不应改变既定风控边界。推进时间。',
        close: '执行「平仓」了结；将浮动盈亏固化为已实现损益。'
      } },
    { id: 'L04', side: -1, title: '双向执行：空头了结与节奏控制', focus: 'shortBtn', holdHours: 12,
      goal: '完成空头建仓与了结，形成双向执行的闭环。',
      script: {
        open: '再次建立空头头寸。空头亏损理论上无上限，须以强平价作为硬约束。执行「做空 / 卖出」。',
        hold: '空头持仓期间，价格上行会放大亏损；上方强平线是唯一的硬性边界。推进时间。',
        close: '执行「平仓」买回；双向执行序列到此完成。'
      } },
    /* ---------- 第五课：挂单 ----------
       下单方式在这一课**解锁**并切成「限价委托」，委托价由 session 预填
       （见 core/tutorial/entry.js 的 suggestLimitPrice）。
       成交不靠运气：引导会把下一根 K 线的影线排到委托价上（priceOverlay 的 pending 分支），
       然后走引擎真实的 settleStep → submitOrder —— 玩家看到的就是「挂单等成交」。 */
    { id: 'L05', side: 1, title: '委托执行：限价建仓与成交条件', focus: 'limitBtn', holdHours: 24,
      order: 'limit', allow: ['orderType'],
      goal: '以限价委托建立多头头寸，验证价格触发与成交价的确定性。',
      hint: '本段采用限价委托：委托价已预置于现价下方约 1%。执行「做多 / 买入」提交委托，再推进时间等待成交。',
      hintPlaced: '已挂单：推进时间，影线触及委托价即按委托价成交。',
      hintFar: '委托价距现价太远，短期无成交可能：在「未成交委托」中撤单，将委托价调整至现价 1% 以内后重新提交。',
      hintFilled: '已成交：成交价等于委托价，限价委托无滑点。推进时间，持有至目标周期后执行「平仓」。',
      script: {
        open: '市价委托追求即时成交，限价委托以指定价格为成交条件。提交限价买单后，委托进入未成交队列，等待行情触发。',
        hold: '委托在未成交队列中等待；价格未触及则不成交。推进时间，观察撮合结果。',
        close: '影线触及委托价，成交价即委托价，限价委托无滑点。执行「平仓」了结。'
      } },
    /* ---------- 第六课：杠杆 ----------
       杠杆在这一课解锁，默认 10×（TUNE.lessonLeverage）—— 比引导平时的 20× 低，
       因为这一课要看的是「杠杆越低、强平价离现价越远」。
       玩家真拖到别的倍率也没关系：价格层按**那一单真实的杠杆**算那两条硬边界
       （priceOverlay.js 的 leverageUsed 不再写死 guidedLeverage）。 */
    { id: 'L06', side: -1, title: '杠杆与保证金：名义敞口与风险边界', focus: 'leverageRange', holdHours: 12,
      leverage: 'lessonLeverage', allow: ['leverage'],
      goal: '调整杠杆，观察名义敞口、保证金占用与预估强平价的变化。',
      hint: '本段杠杆预设为 10×。拖动杠杆滑块，观察「预估强平价」相对现价的位移：杠杆越低，强平边界越远。设置完成后建仓。',
      script: {
        open: '保证金不变时，提高杠杆将按倍数放大名义敞口，同时把强平价推向现价。调整滑块并观察预估强平价，再提交委托。',
        hold: '杠杆对称放大盈亏：同等价格变动下，浮动盈亏按杠杆倍数放大；强平价越近，对反向影线的容忍度越低。推进时间。',
        close: '执行「平仓」。六段执行序列完成；后续仓位规模、方向与杠杆由交易者自行设定。'
      } }
  ];

  /* ============ 由 TUNE 推出来的两份派生数据（不写第二遍） ============ */
  /* 课表里 `margin: 'guidedMargin'` 这种写法的取值口 */
  const pick = (value, fallback) => {
    if (typeof value === 'string') {
      const resolved = TUNE[value];
      return resolved == null ? fallback : resolved;
    }
    return value == null ? fallback : value;
  };
  /* 课表里每一课补齐默认值之后的只读视图：读的地方（状态机、进度条、引导界面）只认这里的字段 */
  const lessonAt = (index) => {
    const raw = LESSONS[index] || null;
    if (!raw) return null;
    return {
      id: raw.id, index, side: raw.side === -1 ? -1 : 1,
      title: raw.title, goal: raw.goal, focus: raw.focus,
      margin: pick(raw.margin, TUNE.guidedMargin),
      leverage: pick(raw.leverage, TUNE.guidedLeverage),
      holdHours: pick(raw.holdHours, TUNE.defaultHoldHours),
      /* 第五 / 六课的那几格（前四课是默认值）：
         order = 这一课用什么下单方式；allow = 这一课要解锁哪几个控件；
         hint / hintPlaced / hintFar / hintFilled = 这一课露在屏幕上的专用句子。 */
      order: raw.order === 'limit' ? 'limit' : 'market',
      allow: Array.isArray(raw.allow) ? raw.allow.slice() : [],
      hint: raw.hint || '',
      hintPlaced: raw.hintPlaced || '',
      hintFar: raw.hintFar || '',
      hintFilled: raw.hintFilled || '',
      script: raw.script || {}
    };
  };
  const lessonList = () => LESSONS.map((_, index) => lessonAt(index));

  return { tutorialLessons: { LESSONS, lessonAt, lessonList, pick } };
});
