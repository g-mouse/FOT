/* ============ 指标颜色（纯函数 + 色板） ============
   色板的顺序是**存档契约**：每条线的默认色按「第几个指标 × MAX_COLOR_LINES + 第几条线」
   取下标，所以只能往后追加、不能插队、不能改已经用过的顺序 —— 往前插一个色号会让
   所有玩家的指标线一起变色（存档里存的是用户自定义色，没改过的按这里的下标算）。

   这一份不认识状态、不认识 DOM：给色号、给 rgb、给人写过的颜色串，它给出规范形状。
   谁需要颜色都可以读（指标栏、图表、快照），改颜色仍然只能走 registry 的 setLineColor。

   由 game/js/indicators/registry.js 移植并拆分而来。 */
CS.define('core/indicators/indicatorColors', [], function () {
  'use strict';
  const ns = CS.open('indicators');

  const MAX_COLOR_LINES = 6;    /* 一个指标最多记几条线的自定义色（SMA / EMA 是 5，留一点余量） */
  /* 主图叠加与副图的上限。它们**不属于颜色**，但色板的长度是按它们算出来的，
     所以定义放在这里、由 registry 与 indicatorState 共用同一个数
     （拆文件时这两个常量一度掉在缝里，成了 undefined —— 面板上「n / 4」会变成 NaN，
      而「挡住第 5 个叠加」也一起失效。常量只留一处定义，就是这里）。 */
  const MAX_PANES = 3;          /* 副图最多三个（用户要求：三个副图，也可以全部去掉） */
  const MAX_OVERLAYS = 4;       /* 主图叠加最多四个（与副图一样是状态层挡住的） */
  /* 暖机最多往回取多少根。上限横在定义表与图表之间：
     一个 period=400 的指标不带这个闸就会让每帧多算几百根、还会把图表的可视窗口挤歪。 */
  const MAX_WARMUP = 300;

  /* 调色板：一条线一个色号。**只往后追加、不要插队、不要改已经用过的顺序** ——
     现有用户的指标颜色就是按这里的下标取的，往前插一个色号会让所有人的线一起变色。
     长度也不是上限：超出就取模回绕（colorSlots 里做的），所以再加多少指标都不会算崩；
     但**回绕就意味着撞色**，所以色号至少要有「MAX_COLOR_LINES × 主图叠加 + 副图」那么多，
     新加一个指标仍然各是各的颜色 —— 低于这个数会在注册时喊一声（见 register）。 */
  const PALETTE = [
    /* 前 16 个是既有色号，顺序不许动（已经发出去的存档按这些下标取色） */
    [245, 158, 11], [56, 189, 248], [167, 139, 250], [244, 114, 182], [45, 212, 191],
    [250, 204, 21], [129, 140, 248], [251, 146, 60],
    [217, 70, 239], [20, 184, 166], [132, 204, 22], [239, 68, 68],
    [14, 165, 233], [234, 88, 12], [99, 102, 241], [236, 72, 153],
    /* 后 12 个是给「以后再加指标」留的余量：主图 4 个 × 5 条线 = 20 个色号用不满这里 */
    [16, 185, 129], [202, 138, 4], [244, 63, 94], [2, 132, 199],
    [124, 58, 237], [77, 124, 15], [219, 39, 119], [13, 148, 136],
    [180, 83, 9], [79, 70, 229], [190, 24, 93], [87, 83, 78],
    /* 这一档是为了消掉启动时那条「需要 29 个、只有 28 个」的撞色警告：
       need = MAX_COLOR_LINES(6) × MAX_OVERLAYS(4) + 副图个数(5) = 29。
       只追加、不动前面任何一个下标 —— 前面 28 个的色号已经落在玩家的存档里了。 */
    [37, 99, 235], [217, 119, 6], [5, 150, 105], [147, 51, 234]
  ];

  /* ============ 颜色 ============ */
  /* 颜色的**唯一**写法是 '#rrggbb'（小写）：存档里只存这一种，所以「界面上显示的」
     与「算的时候用的」永远是同一个值。认不出来的一律当作「没有自定义色」，退回调色板。 */
  function parseColor(value) {
    if (Array.isArray(value) && value.length >= 3) {
      const parts = value.slice(0, 3).map(part => Math.round(Number(part)));
      if (parts.every(part => Number.isFinite(part) && part >= 0 && part <= 255)) return parts;
      return null;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    const short = /^#?([0-9a-f]{3})$/i.exec(text);
    if (short) return short[1].split('').map(char => parseInt(char + char, 16));
    const long = /^#?([0-9a-f]{6})$/i.exec(text);
    if (long) return [0, 2, 4].map(at => parseInt(long[1].slice(at, at + 2), 16));
    return null;
  }
  const hex2 = value => Math.max(0, Math.min(255, Math.round(Number(value) || 0))).toString(16).padStart(2, '0');
  const colorText = rgb => `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
  /* 一条线的默认色号：**只由「这个指标在定义表里排第几、这是第几条线」决定** ——
     与别的指标开没开、开在哪一步都无关。于是：
       · 再加一个新指标（追加在定义表末尾）不会动到任何已经开着的指标的颜色；
       · 关掉中间一个指标，后面的指标颜色也不会跟着换（它们排在定义表的第几就是第几）。
     下标最多到「指标个数 × MAX_COLOR_LINES」，色板不够长会取模回绕（register 里为此喊一声）。 */
  const colorSlots = (itemIndex, lineIndex) => PALETTE[(itemIndex * MAX_COLOR_LINES + lineIndex) % PALETTE.length];
  const defaultColorOf = (itemIndex, lineIndex) => colorSlots(Math.max(0, itemIndex || 0), Math.max(0, lineIndex || 0));
  /* 某一条线现在该用什么颜色：用户改过就用用户的，没改过用默认色号。
     两种可能都要在这里收成 [r,g,b] —— 画线的 rgbaOf()、图例的小色块都按下标取分量，
     给它一个 '#rrggbb' 字符串会画成 rgba(0,0,0,…)（踩过：登录时是字符串，画出来全是黑的）。 */
  function lineColor(line, itemIndex, lineIndex) {
    const custom = parseColor(line && line.color);
    return custom || defaultColorOf(itemIndex, lineIndex);
  }
  /* 把一条线的颜色盖上一条 series：把这一条 series **用到的每一种颜色**都设成同一个色 ——
     普通线是 rgb，柱子是 rgbUp/rgbDown，带子（BOLL）就是带的填充色。
     传进来的 rgb 必须是 [r,g,b]（lineColor() 负责把存档里的 '#rrggbb' 收成数组）；
     这一层是幂等的，同一个 series 盖两次结果一样。

     ★ 例外：series.keepTone === true 的柱子**不盖**（MACD 那根柱）。
     为什么：柱子的颜色本身就是数据 —— 正绿负红，一眼看出多空翻转。
     统一盖成「这一条线的颜色」之后，MACD 的柱子全变成一个色，
     涨跌方向就只剩长度可看了（现场截图确认过：柱子整排同色）。
     定义里给那一条 series 写上 keepTone 即可，不必每个指标各自去管颜色。 */
  function tintSeries(series, rgb) {
    const color = parseColor(rgb) || PALETTE[0];
    if (series && series.keepTone === true) return series;
    series.rgb = color;
    if (series.rgbUp !== undefined) series.rgbUp = color;
    if (series.rgbDown !== undefined) series.rgbDown = color;
    return series;
  }
  /* 一条 series 现在是什么颜色（computeFrame 盖过之后，每条都一定有 rgb）。
     界面上的色块用的是 indicatorState.js 的 lineColorOf()（按「第几条线」取，
     没算过指标时也能显示），这个是给「手上已经有一条 series、想知道它是什么色」的地方用的。 */
  const colorOfSeries = series => (series && Array.isArray(series.rgb) ? series.rgb : PALETTE[0]);

  /* ============ 状态（挂在账户存档上）============ */

  Object.assign(ns, {
    /* 这一份只出**纯函数**：给色号、给 rgb、给人写过的颜色串，得到规范形状。
       凡是要读「现在开着哪几条线」的（lineColorOf / setLineColor / resetLineColor）都在
       indicatorState.js —— 它们依赖模块内的状态，不属于这里。 */
    MAX_COLOR_LINES, MAX_PANES, MAX_OVERLAYS, MAX_WARMUP, PALETTE,
    parseColor, colorText, defaultColorOf, colorSlots, lineColor, tintSeries, colorOfSeries
  });
  /* 把三份文件共用的那块命名空间挂成对外的 CS.indicators。
     契约是「同一个对象」：CS.open('indicators') === CS.indicators —— 所以三份文件里
     无论用哪一个名字读写，看到的都是同一份定义表与同一份状态。
     三份文件里都写这一句是**有意的**：谁先加载谁建立这一格，
     顺序换了也不会出现「CS.indicators 是 undefined」而把后面那份整段打挂。 */
  return { indicators: ns };
});
