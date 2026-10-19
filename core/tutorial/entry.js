/* ============ 「手上这一单」的规格：走多久、目标在哪、怎么写进价格层 ============
   这一层是导引与价格覆盖层之间的**唯一转换口**：把「这一课要看多久、骰子说是赢是亏」
   折算成 core/tutorial/priceOverlay.js 认的那一份 spec，并在玩家一直不平仓时把它延长。

   为什么单独一个文件：core/tutorial/session.js 管的是**课表走到哪儿了**
   （开仓 / 推进 / 平仓 / 毕业 / 离开），而这一段管的是**这一单长什么样**（根数、目标、
   波动、时间尺度）。两件事混在一个文件里，单文件就压不住**当时**的 400 行上限了。

   ============ 一根 K 线有多长（小时 ↔ 基础 K 线的根数）============
   课表是按**小时**写的（这一课看 12 小时），而行情是按**根**铺的。
   两个换算口必须分清楚，混用会双重换算 —— 踩过这个坑：
   底料是 4 小时、周期 12 小时（一步走 3 根基础线）时，「已经过了 6 根基础线」= 24 小时；
   要是再除以一次「一小时几根」，12 小时的课就变成 48 小时，于是每节课都铺得过长：
   目标价永远走不到，行情一路贴到亏损上限 —— 十单全亏、还会擦到强平线。 */
CS.define('core/tutorial/entry', ["core/market/marketData","core/tutorial/priceOverlay","core/tutorial/tune","lib/lodash"], function () {
  'use strict';

  const TUNE = CS.tutorialTune.TUNE;
  const P = CS.tutorialPrice;

  /* deps: { cursor, baseStepHours, timeframeHours, stepBars, fundingHours, nextFundingRate } */
  function create(deps) {
    const hoursPerBar = () => Math.max(1, Number(deps.baseStepHours()) || 4);
    const barsOf = hours => Math.max(1, Math.round((Number(hours) || 0) / hoursPerBar()));
    const elapsedHours = fromBar => Math.max(0, deps.cursor() - fromBar) * hoursPerBar();
    /* 这一档周期一根 K 线有几根基础线：读**玩家自己选的那一档**（deps.timeframeHours），
       不读任何缓存 —— 启动那一刻缓存可能还没跟上，读错会让「一单走多久」换一套手感。 */
    const barsPerCandle = () => Math.max(1, Math.round((Number(deps.timeframeHours()) || hoursPerBar()) / hoursPerBar()));

    /* 这一段要走多少根：课表给了 holdHours 就照它算，自由交易里用默认值。
       赢单和亏单用同一个长度 —— 玩家看到的「一单要走多久」不该随输赢变。

       **没有课表的时候还要看图表周期**（自由练习 / 离开教程之后，周期是玩家自己选的）：
       固定按小时算的话，切到日线只有一根 K 线、切到周线连一根都不到，
       铺出来的那一段在图上什么都不是。所以给一个下限：至少走 TUNE.freeSpanCandles 根
       当前周期的 K 线，但不超过「点 maxStepsPerHop 次前进」那么多根（不然要按上百下）。
       课上有课表时不动：那几课的时长是课程设计的一部分（老师的话里就写着「走 12 小时」），
       而且引导在上课期间把周期锁在 12h。 */
    function spanOf(plan, hours) {
      const base = Math.max(2, hours > 0 ? barsOf(hours) : barsOf(plan ? plan.holdHours : TUNE.defaultHoldHours));
      if (plan) return base;
      const want = Math.round(Math.max(1, TUNE.freeSpanCandles) * barsPerCandle());
      const cap = Math.max(base, (Number(deps.stepBars()) || 1) * Math.max(1, TUNE.maxStepsPerHop));
      return Math.max(base, Math.min(want, cap));
    }
    /* 把这一段的规格写到价格层上（唯一的一处，免得漏字段）：
       `rideToBar` = 「这一单还开着，价格必须一直铺到光标脚下」。
       少了它，光标走出这一段之后就是真实行情 —— 时间一长必然被强平。
       `baseSpan` 与 `spanBars` 平时是同一个数，但两个都要传：段外那条「有趋势的随机行情」
       锚在 baseSpan 上（曲线不随段长被延长而重画），而 spanBars 决定「该平仓的那一根」。 */
    function applySpec(e) {
      P.set({
        pair: e.pair, index: e.bar, side: e.side, win: e.win,
        open: e.anchor, ratio: e.targetRatio, breakEvenGap: e.breakEvenGap,
        margin: e.margin, notional: e.notional,
        /* 这一单实际的杠杆：价格层拿它算 45% 那条硬边界（原来写死 guidedLeverage，
           第六课让玩家自己拖滑块之后就不成立了 —— 见 priceOverlay.js 的 leverageUsed） */
        leverage: e.leverage,
        spanBars: e.spanBars, baseSpan: e.baseSpan, rideToBar: deps.cursor(),
        /* 段外那条路的步长按「当时的市场波动」定，一步一步的**尺度**按「你看的那张图的 K 线」定 */
        vol: e.vol, candleBars: e.candleBars,
        /* 光标走到「该平仓的那一根」了吗：亏单的收尾那一根要扎穿强平价，
           但必须等玩家真走到那儿（否则开仓那一刻就被爆了） */
        walkedToDue: deps.cursor() >= e.bar + e.spanBars
      });
    }
    /* ============ 挂单（第五课）的两件小工具 ============
       挂单与持仓在价格层上是两份不同的 spec（见 priceOverlay.js 的 pending 分支）：
       挂上单时还没有仓位，只能先排「成交那一根」的影线；成交之后由 begin() 换成持仓那一份。 */
    /* 挂单那一份 spec：只回答「哪一根去碰、碰哪个价」。
       ★ 离得太远就返回 null（= 不排）：那一根要画成一根 −30% 的巨阴线，图和账都假。
         这时课上改成提醒玩家把委托价挪近一点（lessons.js 的 hintFar）。 */
    function pendingSpec(shape) {
      const price = Number(shape && shape.price);
      const anchor = Number(shape && shape.anchor);
      if (!(price > 0) || !(anchor > 0)) return null;
      const far = Math.abs(price / anchor - 1);
      if (far > Math.max(0.005, Number(TUNE.limitFillSpan) || 0.06)) return null;
      return {
        pending: true, pair: shape.pair, side: shape.side === -1 ? -1 : 1,
        index: Math.round(shape.bar), open: anchor, ratio: price / anchor,
        vol: shape.vol, candleBars: shape.candleBars
      };
    }
    /* 挂单课的委托价：现价下方（做多）/ 上方（做空）limitOffset 处，按这个品种的小数位取整。
       预填的理由：这一课要讲的是「挂上之后等它成交」，不是「手打一个价格」——
       数字框空着，玩家第一步就卡在「填多少」上。 */
    function suggestLimitPrice(plan, price, digits) {
      const p = Number(price);
      if (!(p > 0)) return 0;
      const off = Math.max(0.0005, Number(TUNE.limitOffset) || 0.008);
      const side = plan && plan.side === -1 ? -1 : 1;
      const raw = p * (side === 1 ? 1 - off : 1 + off);
      const step = Math.pow(10, Math.max(0, Math.round(Number(digits) || 2)));
      return Math.round(raw * step) / step;
    }
    /* 玩家点着「前进」一直不平仓时：把这一段的长度**跟着光标一起延长**。
       为什么要延长：这一段行情是按「走到 spanBars 根时正好在目标价」铺的，
       要是玩家在走到之前就多推了几根，光标就会跑出这一段 ——
       那里是真实行情，方向不受控，一单掷成「亏」的仓位可能反而赚、也可能被扫爆。
       延长之后，他不管在哪一根平掉，价格都在目标附近（仍然由骰子说了算）。

       上限是课表规定时长的 TUNE.spanExtendCap 倍：再往后**不再拉长这一段**
       （免得一单被拖成双倍的盈亏），但价格仍然铺到光标脚下（applySpec 的 rideToBar），
       而且在目标价附近小幅来回（浮盈跟着 K 线动，不许锁死），
       同时被保本价 / 强平线那两条边界夹住 —— 时间再久也不会被强平。

       onGrew：段长变了要**写回存档**（否则刷新之后铺回去的是旧段长，
       「该平仓的那一根」会往前跳一根）。由 session 传进来 —— 这一层不认识存档。 */
    function extendSpan(pos, e, plan, onGrew) {
      /* 已经过了多久（**小时**）→ 这一段该有多长（根）。单位换算只在这里做一次。 */
      const passed = elapsedHours(e.bar);
      const hours = Number(plan && plan.holdHours) > 0 ? Number(plan.holdHours) : TUNE.defaultHoldHours;
      const keep = Math.max(e.baseSpan, Math.min(Math.round(e.baseSpan * TUNE.spanExtendCap), barsOf(hours)));
      const want = passed > 0 ? barsOf(passed) : e.baseSpan;
      const span = Math.max(e.baseSpan, Math.min(keep, want));
      const longer = span > e.spanBars;
      if (longer) {
        e.spanBars = span;
        if (onGrew) onGrew();
      }
      /* 段长没变也要重铺一次：光标往前走了，rideToBar 得跟着走
         （不然新出现的那几根会退回真实行情）。签名里带着 rideToBar，所以这一步不会白算。 */
      applySpec(e);
      return longer;
    }
    /* 这一对交易对**此刻**每根基础 K 线大概走多少（相对值）：最近若干根的对数收益的平均
       绝对值（稳健、不被个别插针带跑）。取不到就返回 0 —— favor 那边会退回原来的手感。
       注意只看**光标之前**那几根：不能把引导自己铺过的价算进「市场波动」。 */
    function measureVol(pair, bar) {
      const s = CS.marketData.seriesRef(pair);
      if (!s || !s.bars) return 0;
      const B = s.bars;
      const end = Math.min(B.length - 1, bar - s.off);
      const from = Math.max(1, end - 240);
      let sum = 0, n = 0;
      for (let i = from; i <= end; i++) {
        const a = B[i - 1].c, b = B[i].c;
        if (!(a > 0) || !(b > 0)) continue;
        sum += Math.abs(Math.log(b / a)); n++;
      }
      return n >= 8 ? sum / n : 0;
    }
    /* 这一单如果在真实交易里，要付多少资金费（正数 = 要付出去）。
       引导的练习单**不收**（见 session 的 fundingExempt），所以这个数只用来在进度条上写一句
       「资金费（预估）」—— 让玩家知道这笔费用的存在，又不让它搅乱引导的结果。
       用**下一期的真实费率**估：这一段只有几根 K 线，费率不会跳太多；取不到就按 0 算。
       注意方向：正费率时做多付出、做空收取（accountEngine.settleFunding 的口径）。 */
    function fundingDrag(pos, span, side) {
      try {
        const notional = Number(pos.notional) > 0 ? Number(pos.notional) : pos.margin * pos.leverage;
        const periods = Math.max(1, Math.ceil(span * hoursPerBar() / (deps.fundingHours() || 8)) + 1);
        const rate = deps.nextFundingRate(pos.instrumentId);
        const paid = notional * (Number.isFinite(rate) ? rate : 0) * (side === 1 ? 1 : -1);
        return Math.round(paid * periods * 100) / 100;
      } catch (_) { return 0; }
    }

    return {
      hoursPerBar, barsOf, elapsedHours, barsPerCandle, spanOf, applySpec, extendSpan, measureVol, fundingDrag,
      pendingSpec, suggestLimitPrice
    };
  }

  return { tutorialEntry: { create } };
});
