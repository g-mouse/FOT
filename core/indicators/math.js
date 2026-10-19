/* ============ 指标数学：纯函数 ============
   这一层只有「进数组、出数组」，不碰 DOM、不读 CS.state，所以 tools/indicator-check.mjs
   能在 Node 里直接跑它们做数值回归。

   四条统一约定（照着写新指标就不会跟别人不一样）：
     · 输入是一列价格（Float64Array 或普通数组都行），输出与输入**等长**；
     · 「这一段还不够长」的位置一律写 NaN —— 画线时自然断开，与主流行情软件一致；
     · **开头的 NaN 只是「还没开始」，不会把后面的值染成 NaN**：
       递推指标（EMA / RMA / RSI）与滑动窗口都从第一个有值的点起算。
       这条很要紧：ATR 是 rma(TR)，ATR 自己的均线又是 rma(ATR)，
       不跳过开头的 NaN 的话第二条线会整条是 NaN（曾经就是，被 tools/indicator-check.mjs 抓出来）。
     · 能增量的都写成 O(n)（滚动和 / 递推 / 单调队列）；只有滚动标准差是 O(n·p)，
       因为「平方和减去均值平方」在 8 万美金的价位上会丢掉 8 位有效数字（带宽会自己抖），
       宁可多算一遍也必须算准 —— 窗口最长 200 根、序列最长几百根，这点开销可以忽略。 */
CS.define('core/indicators/math', ["core/indicators/registry"], function () {
  'use strict';

  const ns = CS.open('indicators');

  const blank = n => { const out = new Float64Array(Math.max(0, n)); out.fill(NaN); return out; };
  const int = (value, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 1 ? n : fallback;
  };
  /* 市场数据里不该出现 NaN，但指标是自己拼出来的序列（例如 ATR 的头几根），读之前统一过一道 */
  const num = value => Number.isFinite(value) ? value : NaN;
  /* 第一个有值的下标；整条都是 NaN 时返回 -1（调用方直接返回一条空线） */
  function firstFinite(values) {
    for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) return i;
    return -1;
  }

  /* ============ 均线家族 ============ */

  /* 简单移动平均：序列里第 p 个有值的点起出值。
     ★ 窗内一旦混进非有限值就**这一窗作废**（并自动恢复），绝不能让那个值进滚动和：
     和一旦变成 NaN，后面每一次回退都还是 NaN，这条线从那个下标起**永远**是 NaN。
     这条正是文件头第 8-11 行承诺的事（「开头的 NaN 只是还没开始，不会把后面的值
     染成 NaN」），extremum() 也明确容忍内部 NaN —— 说明这种行确实会出现。
     受影响的调用方：cci() 的 mean = sma(tp, p)、布林带中轨。

     这里**故意**用逐窗求和（O(n·p)）而不是滚动和：
     滚动和要在「NaN 进窗 / 出窗」两种边界上把累积量修正回来，稍不留神就正是它要修的那个 bug
     （实测写错过一版：坏点滑出窗口后 sum 仍是残缺的）。窗口最长 200 根、序列最长几百根，
     这点开销可以忽略 —— 文件头对滚动标准差已经做过同一个取舍。 */
  function sma(values, period) {
    const n = values.length, p = int(period, 1), out = blank(n);
    const start = firstFinite(values);
    if (start < 0) return out;
    for (let i = start + p - 1; i < n; i++) {
      let sum = 0, ok = true;
      for (let k = i - p + 1; k <= i; k++) {
        const v = num(values[k]);
        if (!Number.isFinite(v)) { ok = false; break; }
        sum += v;
      }
      if (ok) out[i] = sum / p;
    }
    return out;
  }

  /* 指数移动平均：α = 2/(p+1)，前 p 个有值的点做简单平均当种子（主流行情软件的口径） */
  function ema(values, period) {
    const n = values.length, p = int(period, 1), out = blank(n);
    const start = firstFinite(values);
    if (start < 0) return out;
    const k = 2 / (p + 1);
    let seed = 0, prev = NaN;
    for (let i = start; i < n; i++) {
      const v = num(values[i]);
      const seen = i - start + 1;
      if (seen < p) { seed += v; continue; }
      if (seen === p) { seed += v; prev = seed / p; out[i] = prev; continue; }
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /* Wilder 平滑（RMA）：α = 1/p，同样用前 p 个有值的点做种子。ATR / RSI / ADX 都用它 */
  function rma(values, period) {
    const n = values.length, p = int(period, 1), out = blank(n);
    const start = firstFinite(values);
    if (start < 0) return out;
    let seed = 0, prev = NaN;
    for (let i = start; i < n; i++) {
      const v = num(values[i]);
      const seen = i - start + 1;
      if (seen < p) { seed += v; continue; }
      if (seen === p) { seed += v; prev = seed / p; out[i] = prev; continue; }
      prev = (prev * (p - 1) + v) / p;
      out[i] = prev;
    }
    return out;
  }

  /* 滚动标准差（总体口径，除以 p —— 布林带用的就是这一个）。
     两趟算：先求窗口均值，再累加偏差平方。**不能用**「平方和 / p − 均值²」那种一趟写法：
     8 万美金的价位上平方和是 1e10 量级、而带宽的方差可能只有个位数，相减会丢掉大半有效数字。 */
  function stdev(values, period) {
    const n = values.length, p = int(period, 1), out = blank(n);
    const start = firstFinite(values);
    if (start < 0) return out;
    for (let i = start + p - 1; i < n; i++) {
      let mean = 0;
      for (let k = i - p + 1; k <= i; k++) mean += num(values[k]);
      mean /= p;
      let acc = 0;
      for (let k = i - p + 1; k <= i; k++) { const d = num(values[k]) - mean; acc += d * d; }
      out[i] = Math.sqrt(acc / p);
    }
    return out;
  }

  /* ============ 区间极值（单调队列，O(n)）============ */
  function extremum(values, period, wantMax) {
    const n = values.length, p = int(period, 1), out = blank(n);
    const deque = new Int32Array(n);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;                 /* 还没有值的点：不参与，也不产出 */
      while (tail > head) {
        const back = values[deque[tail - 1]];
        if (wantMax ? back <= v : back >= v) tail--; else break;
      }
      deque[tail++] = i;
      if (deque[head] <= i - p) head++;
      if (i >= p - 1) out[i] = values[deque[head]];
    }
    return out;
  }
  const highest = (values, period) => extremum(values, period, true);
  const lowest = (values, period) => extremum(values, period, false);

  /* ============ 波动与动量 ============ */

  /* 真实波幅：max(高-低, |高-前收|, |低-前收|)。第一根没有前收，用当根的收代替 */
  function trueRange(highs, lows, closes) {
    const n = highs.length, out = blank(n);
    for (let i = 0; i < n; i++) {
      const prevClose = i > 0 ? num(closes[i - 1]) : num(closes[i]);
      out[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - prevClose), Math.abs(lows[i] - prevClose));
    }
    return out;
  }

  /* 相对强弱 RSI（Wilder）：先取前 p 个涨跌幅的均值，之后按 α=1/p 递推 */
  function rsi(closes, period) {
    const n = closes.length, p = int(period, 1), out = blank(n);
    let avgGain = NaN, avgLoss = NaN, sumGain = 0, sumLoss = 0;
    for (let i = 1; i < n; i++) {
      const change = num(closes[i]) - num(closes[i - 1]);
      const gain = Math.max(0, change), loss = Math.max(0, -change);
      if (i <= p) {
        sumGain += gain; sumLoss += loss;
        if (i < p) continue;
        avgGain = sumGain / p; avgLoss = sumLoss / p;
      } else {
        avgGain = (avgGain * (p - 1) + gain) / p;
        avgLoss = (avgLoss * (p - 1) + loss) / p;
      }
      out[i] = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  /* 典型价 = (高 + 低 + 收) / 3，CCI 与不少摆动指标都要 */
  function typicalPrice(highs, lows, closes) {
    const n = highs.length, out = blank(n);
    for (let i = 0; i < n; i++) out[i] = (highs[i] + lows[i] + num(closes[i])) / 3;
    return out;
  }

  /* 顺势指标 CCI：偏离典型价均值的程度 ÷ (0.015 × 平均绝对偏差) */
  function cci(highs, lows, closes, period) {
    const n = highs.length, p = int(period, 1), out = blank(n);
    const tp = typicalPrice(highs, lows, closes);
    const mean = sma(tp, p);
    for (let i = p - 1; i < n; i++) {
      if (!Number.isFinite(mean[i])) continue;
      let dev = 0;
      for (let k = i - p + 1; k <= i; k++) dev += Math.abs(tp[k] - mean[i]);
      const avgDev = dev / p;
      out[i] = avgDev === 0 ? 0 : (tp[i] - mean[i]) / (.015 * avgDev);
    }
    return out;
  }

  /* ============ 读结果的小工具 ============ */
  /* 最后一个有值的点（副图标题栏写「当前值」用） */
  function lastFinite(values) {
    for (let i = values.length - 1; i >= 0; i--) if (Number.isFinite(values[i])) return values[i];
    return null;
  }
  /* 一列数在 [from, to) 区间里的极值，全 NaN 时返回 null */
  function minMax(values, from, to) {
    let lo = Infinity, hi = -Infinity;
    for (let i = from; i < to; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return Number.isFinite(lo) ? [lo, hi] : null;
  }

  Object.assign(ns, {
    math: {
      sma, ema, rma, stdev, highest, lowest, trueRange, rsi, typicalPrice, cci,
      lastFinite, minMax, blank, firstFinite
    }
  });
});
