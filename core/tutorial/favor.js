/* ============ 引导的行情照顾：按你手里的仓位铺 K 线 ============
这一段行情怎么画、走完该赚多少。什么时候掷骰子、什么时候收工在 session。
   ★ 由 core/tutorial/favor.js 按行区间**逐字搬来**（只换命名空间与文件头，
   算法一个字符没动）。搬家的理由：**当时**的单文件上限是 400 行 —— 旧实现 482 行。
   对照旧实现的工具是 tools/parity-guide-favor.mjs（改了这里就回去跑一遍）。 */

CS.define('core/tutorial/favor', ["core/tutorial/favorMath","core/tutorial/ride","core/tutorial/tune"], function () {
'use strict';

  const TUNE = CS.tutorialTune.TUNE;
  const M = CS.tutorialFavorMath;
  const R = CS.tutorialRide;
  /* ratioAt 原先与 rideBand / rideAt 同在一个文件里，所以是裸名调用；拆开之后按原样接回来。 */
  const { rideBand, rideAt } = R;
  const { num, clamp, easeOut, smooth, moveOf, dirOf, walkPath, noiseAt, deepOf } = M;

  /* 一段行情的「目标」：赢单 +winMargin（按保证金算）或亏单 −lossMargin。
     两者都换算成**价格比例**（目标价 / 成交价），价格层只需要这一个数。 */
  function targetRatioOf(notional, margin, side, win) {
    const value = Number(notional) > 0 ? Number(notional) : Math.max(1, Number(margin) || 0);
    const money = win ? Math.max(value * TUNE.winMove, TUNE.winMarginFloor * margin)
      : Math.max(value * TUNE.minLossMove, TUNE.lossOfMargin * margin);
    const move = Math.min(0.4, Math.max(0, money / value));   /* 夹一道：极端杠杆下也不画出 40% 以上的单边 */
    return side === 1 ? (win ? 1 + move : 1 - move) : (win ? 1 - move : 1 + move);
  }

  /* 「已下注的那一步」的**归一化**进度 w(t)（0 → 1，1 = 走到了目标）。
     归一化之后多空共用一套，偏移 = dir × |目标 − 1| × w —— 所以收尾一定落在目标上
     （这里写错过一次：赢单的封顶写死成「1 + …」，做空时方向反了，收尾差了一截）。 */
  function walkAt(t, target, win) {
    const move = Math.max(1e-9, moveOf(target));
    if (win) {
      const floorGap = TUNE.winMove * 1.35;                    /* 保本价那一步（与 session.js 的下限同一个数） */
      const reachCap = Math.max(floorGap, move * (1 + (TUNE.wickShare || .65) * 0.02));
      const reach = Math.min(1, reachCap / move);
      const knee = Math.min(1, TUNE.winFlex);
      return t <= knee
        ? reach * easeOut(t / knee)
        : reach + (1 - reach) * easeOut((t - knee) / (1 - knee));
    }
    /* 亏单：先快后慢地往不利方向走，收尾正好是目标（= 亏掉保证金的 lossOfMargin） */
    return Math.pow(t, Number.isFinite(TUNE.lossPeak) ? TUNE.lossPeak : 0.9);
  }
  /* 包络（相对成交价的比例）：单调朝目标推进，永远**浅于**目标。
     赢单：推进到目标（保本价之上，浮盈一路是绿的）；
     亏单：推进到**那条 45% 线**为止（不是推到 50% 的目标）——因为这一段最深只能到那里
     （再深就被价格层夹住、逐根钉在同一个数上、浮动盈亏就不动了）。
     lev = 这一单**实际**的杠杆（45% 保证金折算成价格比例要它）：原来写死 guidedLeverage，
     于是第六课把杠杆拖到别的倍率时，亏单包络的深度与价格层那条硬边界就对不上了
     （一边按 20× 画、另一边按真实杠杆夹，图上的浮亏会先被包络拦住、到不了深处）。 */
  function envelopeAt(t, target, win, lev) {
    const dir = dirOf(target);
    if (!win) {
      const deep = (Number.isFinite(TUNE.lossOfMargin) ? TUNE.lossOfMargin : 0.5)
        * (Number.isFinite(TUNE.lossPeak) ? TUNE.lossPeak : 0.9)
        / Math.max(1, Number(lev) || TUNE.guidedLeverage || 20);
      return 1 + dir * deep * Math.pow(t, Number.isFinite(TUNE.lossPeak) ? TUNE.lossPeak : 0.9);
    }
    return 1 + dir * moveOf(target) * walkAt(t, target, win);
  }


  /* 第 k 根（相对开仓那一根）的收盘比例。**这就是那一根 K 线的「实时价」**：
     价格层每铺一根就调它一次，所以每一根都是现算的（不是把一条预设曲线读出来）。

     span  这一段**原定**要走多少根（包络在 k = span 上正好到目标）。注意是原定：
           「该平仓的那一根」被延长之后（session.js 的 extendSpan）不该改动已经画过的图。
     limits 价格层算好的硬边界与市场波动 { floor, vol, candleBars }（可选）：
            floor 是那条不许越过的线，vol 决定段外那条路的步长（见 stepOf），
            candleBars 决定段外那条路**一步一步的尺度** = 你看的那张图的 K 线（见 ridePath）。 */
  function ratioAt(k, span, target, profile, index, limits) {
    const win = profile !== 'lose';
    const base = Number.isFinite(span) ? Math.max(1, Math.round(span)) : 1;
    /* ---- 段外：一条有趋势的随机行情（见文件头那一节）---- */
    if (k > base) return rideAt(k - base, index, target, win, limits);
    /* ---- 段内：包络（节奏）+ 一条**跟着市场波动**的漫步 ----
       用户报的「开仓后波动幅度跟原来不同」指的就是这一段：以前这里的幅度是**固定的一小截**
       （rideWave × 这一段 ≈ 0.25 × 1.25% ≈ 0.3% 的价格），而旁边那几根真行情是 2~4% ——
       一开仓图上的蜡烛就「缩」了，一眼看出是教程画的。现在段内与段外**共用同一条带子、
       同一个步长**（rideBand 的 amp：跟着市场当时的波动与这一档周期的 K 线尺度走），
       于是开仓前后是一个量级，两段之间也没有台阶。 */
    const t = Math.max(0, Math.min(1, k / base));
    const move = moveOf(target);
    const dir = dirOf(target);
    const band = rideBand(win, target, limits);
    const spine = envelopeAt(t, target, win, limits && limits.lev);
    const path = walkPath(index, base, Math.max(1, Math.round(k) + 1));
    /* 漫步的偏离夹在 ±1.2（单位 = 一根 K 线走多远）：它只决定这条路的**方向**，
       两头由下面的保护带收住，所以这里只防它跑飞。 */
    const dev = clamp((k >= 0 && k < path.length) ? path[k] : 0, -1.2, 1.2);
    /* 「刚开仓那两根收得很紧」原来写成 min(1, k/2)：k = 1 只有一半幅度 —— 于是**段内的第一格
       比段外小一半**，两段之间又是一道台阶（用户报的「开仓后波动幅度跟原来不同」里也有它）。
       只有 k = 0 必须收死（那一根的收盘 = 成交价，玩家买的就是那个数），其余几根按满幅度走。 */
    const ramp = k <= 0 ? 0 : Math.min(1, (k + 0.4) / 1.6);
    /* 摆动 = 漫步（有惯性、会回撤）+ 小抖动（碎步）+ 亏单的居中量。
       亏单那条带子只有「45% 线 ~ 成交价」这么宽（20× 下 2% 的价格），幅度再跟它收一道，
       否则会被夹成一条横线；居中量把它抬到带子中间，收尾那一根归零。 */
    const room = win ? band.amp : Math.min(band.amp, (deepOf(limits, win, dir, move) / move) / 3 + 0.05);
    const amp = Math.max(1e-6, room);
    const center = win ? 0 : (1 - smooth(Math.min(1, Math.abs(k - base) / Math.max(1, base * 0.8)))) * amp * 0.5;
    const swing = dir * move * (dev * amp + center + noiseAt(index + k * 7919, 613) * amp * 0.35) * ramp
      + noiseAt(index, 7) * TUNE.winMove * 0.5 * ramp;
    const ratio = spine + swing;
    /* 保护带：赢单不许跌破包络（更不许进保本价）；亏单夹在「那条 45% 线」与**包络**之间 ——
       比包络更浅就等于白捡，那会让「亏单」的账面变成赚的（实测踩过）。
       那条 45% 线在价格层给了就用它的数（两处口径只留一处），没给就按老口径算。 */
    const deep = deepOf(limits, win, dir, move);
    const far = target + dir * move * band.far;
    const bound = win ? [spine, far] : [1 + dir * deep, spine];
    return clamp(ratio, Math.min(bound[0], bound[1]), Math.max(bound[0], bound[1]));
  }


  /* ============ 胜率的那台骰子 ============
     逐单按 80% 掷，但**不是纯随机**：另外还有一层「配额」兜住运气。
     配额的意思很直白 —— 已下注的单里，赢的必须至少是 80%，这一单才允许输：
       连赢 4 单后，第 5 单允许输；只要输了一单，接下来 4 单就必然赢。
     为什么要有它：纯随机的十单里出现三连亏的概率超过 20%，而新手的前十分钟
     正好可能是那三单 —— 「尝甜头」就变成了「第一天就劝退」。
     代价是长程胜率会略高于 80%（约 80~85%），换来的是**任何时候都不会连着亏两单**。
     另外两条护栏（连输两单给一单、连赢三单还一单）保留：它们是给「玩家自己乱序平仓」
     那种情况下兜底的，与配额一起用不冲突。

     ★ 兜底那一掷不再是 Math.random()。
     这一段代码决定的是**真实盈亏**（引导铺的价按它写成赚或亏），
     原来是不可复现的：同一份引导存档重跑一遍，胜负序列可能不同，
     于是「按种子复现一局」这条承诺在引导里不成立，探针也复现不了玩家报的问题。
     现在改成**由已走过的单数决定的确定值**：
       · 配额与两条护栏都是确定判据，先判它们（行为逐字不变）；
       · 真的走到兜底时才用 `count` 折一个 [0,1) 的数 —— 分布与原来一样，
         但对同一个 count 永远给同一个结果，重跑可复现。 */
  function streakOf(trades, win) {
    let count = 0;
    for (let i = trades.length - 1; i >= 0; i--) {
      if (!!trades[i].win !== win) break;
      count++;
    }
    return count;
  }
  /* 由单数折出的确定值：与原 Math.random() 同为 [0,1) 均匀，但只跟 count 有关 */
  function rollOf(count) {
    let h = Math.imul((count | 0) ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function roll(trades) {
    const rows = trades || [];
    const wins = rows.filter(t => t.win).length;
    /* 配额：赢的次数不足 80%×总单数 —— 这一单必须赢 */
    if (wins < rows.length * TUNE.winRate) return true;
    if (streakOf(rows, false) >= TUNE.practiceLossStreakCap) return true;
    if (streakOf(rows, true) >= TUNE.practiceWinStreakCap) return false;
    return rollOf(rows.length) < TUNE.winRate;
  }
  /* 已经走了多少单、其中赢了多少（HUD 与自检都读这一份，口径只写一次） */
  function tallyOf(trades) {
    const wins = trades.filter(t => t.win).length;
    return { count: trades.length, wins, losses: trades.length - wins, rate: trades.length ? Math.round(wins / trades.length * 100) : 0 };
  }


  return {
    tutorialFavor: {
      targetRatioOf, envelopeAt, walkAt, ratioAt, rideBand: R.rideBand,
      marketCandleMove: R.marketCandleMove, noiseAt, jitter: M.jitter,
      roll, streakOf, tallyOf, smooth
    }
  };
});
