/* ============ regime 分类（[R18] §4A.4(4)） ============
   纯函数：输入 bar 数组与下标，输出「这一天是什么形态」。
   校准期可以看到未来（fwdRet / fwdMAState），执行期只能看已揭晓的过去 ——
   同一份代码，靠调用方决定传进来的 bars 到哪里为止。

   事件窗口先贴标签（本文件），再让新闻认领（newsScheduler）。
   这样「涨势里出利好、崩盘前出可疑的乐观消息」就是匹配问题的解，而不是随机弹窗。 */
CS.define('core/market/regime', [], function () {
  'use strict';

  function sma(bars, i, n) {
    if (i < n - 1) return null;
    let sum = 0;
    for (let k = i - n + 1; k <= i; k++) sum += bars[k].c;
    return sum / n;
  }
  function stdev(returns) {
    const n = returns.length;
    if (n < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / n;
    const varSum = returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
    return Math.sqrt(varSum);
  }
  function returns(bars, i, n) {
    const out = [];
    for (let k = Math.max(1, i - n + 1); k <= i; k++) {
      const prev = bars[k - 1].c;
      if (prev > 0) out.push(bars[k].c / prev - 1);
    }
    return out;
  }
  function retOver(bars, i, n) {
    const j = i - n;
    if (j < 0) return 0;
    const base = bars[j].c;
    return base > 0 ? bars[i].c / base - 1 : 0;
  }

  /* 波动率分位：拿最近 250 根（或全部）的滚动 20 日波动率做经验分布。
     用经验分位而不是绝对阈值 —— 加密资产的「高波动」与蓝筹的完全不是一个数量级。 */
  function volatilityPercentile(bars, i, window) {
    const w = window || 250;
    const from = Math.max(20, i - w);
    const vols = [];
    for (let k = from; k <= i; k++) vols.push(stdev(returns(bars, k, 20)));
    if (vols.length < 5) return 0.5;
    const cur = vols[vols.length - 1];
    let below = 0;
    for (const v of vols) if (v <= cur) below++;
    return below / vols.length;
  }

  /* 主函数。bars 可以是日线也可以是 4h，窗口参数用 opts 覆盖。
     fwdRet 只在 i + h <= bars.length-1 时有值，否则为 null —— 绝不外推。 */
  function classify(bars, i, opts) {
    const o = opts || {};
    const maFast = o.maFast || 20, maSlow = o.maSlow || 60, maLong = o.maLong || 200;
    const horizons = o.horizons || [5, 20, 60];
    if (!bars || !bars.length) return null;
    i = Math.max(0, Math.min(bars.length - 1, i | 0));

    const f = sma(bars, i, maFast), s = sma(bars, i, maSlow), l = sma(bars, i, maLong);
    const fPrev = sma(bars, Math.max(0, i - 5), maFast);
    const slope20 = (f && fPrev) ? (f / fPrev - 1) : 0;
    const sPrev = sma(bars, Math.max(0, i - 5), maSlow);
    const slope60 = (s && sPrev) ? (s / sPrev - 1) : 0;

    let maAlign = 'tangled';
    if (f != null && s != null) {
      if (l == null) maAlign = f > s ? 'bull' : 'bear';
      else if (f > s && s > l) maAlign = 'bull';
      else if (f < s && s < l) maAlign = 'bear';
    }

    const ret20 = retOver(bars, i, 20);
    let trend = 'range';
    if (maAlign === 'bull' && slope20 > 0.002) trend = 'up';
    else if (maAlign === 'bear' && slope20 < -0.002) trend = 'down';
    else if (ret20 > 0.05) trend = 'up';
    else if (ret20 < -0.05) trend = 'down';

    const dailyVol = stdev(returns(bars, i, 20));
    const vp = volatilityPercentile(bars, i);
    let volState = 'normal';
    if (vp >= 0.95 || dailyVol > 0.09) volState = 'panic';
    else if (vp >= 0.75) volState = 'high';
    else if (vp <= 0.25) volState = 'low';

    const fwdRet = {};
    for (const h of horizons) {
      fwdRet[h] = (i + h <= bars.length - 1) ? (bars[i + h].c / bars[i].c - 1) : null;
    }
    let fwdMAState = 'flat';
    const hAhead = o.maCrossAhead || 20;
    if (i + hAhead <= bars.length - 1) {
      const now = sma(bars, i, maFast), later = sma(bars, i + hAhead, maFast);
      const sNow = sma(bars, i, maSlow), sLater = sma(bars, i + hAhead, maSlow);
      if (now != null && later != null && sNow != null && sLater != null) {
        const diffNow = now - sNow, diffLater = later - sLater;
        if (diffNow <= 0 && diffLater > 0) fwdMAState = 'crossUp';
        else if (diffNow >= 0 && diffLater < 0) fwdMAState = 'crossDown';
      }
    }

    const px = bars[i].c;
    const fwd20 = fwdRet[20];
    const high60 = Math.max.apply(null, bars.slice(Math.max(0, i - 59), i + 1).map(b => b.h));
    const low60 = Math.min.apply(null, bars.slice(Math.max(0, i - 59), i + 1).map(b => b.l));
    let eventClass = 'chop';
    if (fwd20 != null) {
      if (volState === 'panic' && fwd20 < -0.12) eventClass = 'shock_down';
      else if (volState === 'panic' && fwd20 > 0.12) eventClass = 'shock_up';
      else if (px >= high60 * 0.999 && fwd20 > 0.02) eventClass = 'breakout';
      else if (px <= low60 * 1.001 && fwd20 < -0.02) eventClass = 'breakdown';
      else if (trend === 'up' && fwd20 > 0.01) eventClass = 'drift_up';
      else if (trend === 'down' && fwd20 < -0.01) eventClass = 'drift_down';
      else if ((trend === 'down' && fwd20 > 0.06) || (trend === 'up' && fwd20 < -0.06)) eventClass = 'reversal';
      else eventClass = 'chop';
    }

    return {
      i, t: bars[i].t, close: px,
      trend, slope20, slope60, maAlign, volState,
      fwdRet, fwdMAState, eventClass,
      volatilityPercentile: vp,
      vol20: dailyVol,
      ret20,
      ma: { fast: f, slow: s, long: l }
    };
  }

  /* 整段区间的「气质」描述：世界种子画廊（[R19] 增强项 27）用它生成
     「风平浪静 / 一路阴跌 / 反复抽打」这类**不剧透具体走势**的一句话。
     只看统计量，不给方向、不给时点。 */
  function temperament(bars) {
    if (!bars || bars.length < 30) return { key: 'world.temper.unknown', stats: {} };
    const rets = [];
    for (let k = 1; k < bars.length; k++) if (bars[k - 1].c > 0) rets.push(bars[k].c / bars[k - 1].c - 1);
    const vol = stdev(rets);
    const total = bars[0].c > 0 ? bars[bars.length - 1].c / bars[0].c - 1 : 0;
    let peak = bars[0].c, maxDd = 0;
    for (const b of bars) { if (b.c > peak) peak = b.c; maxDd = Math.max(maxDd, peak > 0 ? 1 - b.c / peak : 0); }
    let swings = 0;
    for (let i = 21; i < bars.length; i++) {
      const a = retOver(bars, i, 20);
      const b2 = retOver(bars, i - 20, 20);
      if (a * b2 < 0) swings++;
    }
    const swingRate = swings / Math.max(1, Math.floor(bars.length / 20));
    const stats = { totalReturn: total, maxDrawdown: maxDd, vol, swingRate };
    let key = 'world.temper.chop';
    if (vol < 0.02 && Math.abs(total) < 0.15) key = 'world.temper.calm';
    else if (total < -0.3 && swingRate < 0.9) key = 'world.temper.slide';
    else if (swingRate >= 1.2) key = 'world.temper.whip';
    else if (total > 0.5) key = 'world.temper.bull';
    else if (maxDd > 0.5) key = 'world.temper.crash';
    return { key, stats };
  }

  /* ★ 这里以前还有一个 buildIndex(bars, opts)：对每一根 K 线调一次 classify，
     而 classify 内部又各自 bars.slice(...) 取窗口 —— 是 O(n²) 的校准期辅助函数。
     全仓库没有任何调用点（排片器 modes/story/newsScheduler.js 用的是它自己那份索引），
     却一直被导出着，谁顺手用一下就会在校准期把 9.6MB 数据集的建索引拖成分钟级。
     真要用再照 newsScheduler 的口径写一个 O(n) 的。 */

  return { regime: { classify, temperament, sma, stdev, retOver, volatilityPercentile } };
});
