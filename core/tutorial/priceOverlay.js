/* ============ 引导的价格覆盖层：把「行情照顾」的那一段铺进 series 里 ============
   这一层不决定「该赢还是该亏」（那在 core/tutorial/favor.js），也不决定「走多久」
   （那在 core/tutorial/session.js）—— 它只负责把一段**已经算好的目标**铺成真实的 OHLC：

    1. 锚定：整段的锚 = **实际成交价**（pos.entryPrice）。行情层的口径是「当前价 = 光标那一根的收」，
       而成交发生在这一根的收上；引擎的市价单还会叠一点滑点，所以锚取成交价、
       重铺之后那一根的收就正好是玩家拿到手的那个价（图与账本从此同一个数）；
    2. 覆盖：从这一根起，按 favor.js 给的比例曲线铺若干根（开高低收一起改），
       每一根的开盘价接上一根的收盘价（价格连续，不会在图上留下跳空）；
    3. 结算：平仓那一下把这一段**照玩家看到的样子**钉进快照（见 core/tutorial/priceHistory.js），
       再把价格还给行情本身 —— 图不许变；
    4. 还原：退出引导时把这一段丢回原样，之后接回真实行情。

   价格是**就地改写** series 里的 o/h/l/c（core/marketData 的 seriesRef 给的就是那一份数组）。
   于是图表、成交价、浮动盈亏、强平判定、资金费结算全都自动跟着走，
   这一层之上**没有一处**需要知道「现在是不是在引导里」。

   ============ 与旧引擎（game/js/tutorial/guide/price.js）的两处形状差异 ============
    1) 数据形状：旧的是并行数组（series[id] = {o[],h[],l[],c[],off}），
       新的是一组 bar 对象（series[id].bars = [{o,h,l,c,t}]）。**下标口径完全一样**
       （局部下标 = 全局下标 − off），所以下面所有循环都是逐字照搬，只把 s.o[i] 写成 bars[i].o。
    2) 强平价：旧引擎按「保证金亏 80%」算（LIQ_RATIO/杠杆），新引擎按真实的维持保证金率
       （accountEngine.MAINTENANCE_MARGIN_RATE = 0.5%）。这里**直接问引擎**、不抄一份公式 ——
       抄了就会出现「引导扎穿的是旧口径的强平价、平台判的是新口径的」，那个亏单永远爆不掉。

   两个必须守住的边界（都由这里夹）：
     · 赢单：最低价不破保本价 → 浮盈自始至终是绿的，也不会被影线扫爆；
     · 亏单：最深的一根也不到「追保」那条线 → 引导里永远不会提前弹追保，
       被扫爆那一下只发生在**收尾那一根**（pierce 扎穿强平价，走平台真实的爆仓判定）。 */
CS.define('core/tutorial/priceOverlay', ["core/engine/accountEngine","core/market/marketData","core/tutorial/favor","core/tutorial/favorMath","core/tutorial/ride","core/tutorial/tune"], function () {
  'use strict';

  const TUNE = CS.tutorialTune.TUNE;
  const F = CS.tutorialFavor;
  const R = CS.tutorialRide;
  const M = CS.tutorialFavorMath;

  /* 「引导动手之前」的原始价格（局部下标 → 四个价）。第一次改写之前抄一份，退出时按它还原 ——
     所以要问「引导到底有没有动过数据」，永远只有一个答案。 */
  const base = { pair: '', store: null };
  /* 生效中的那一段：null 表示当前没有引导（价格就是行情本身） */
  let spec = null;
  let signature = '';
  /* 扎穿强平价之后由谁去结算：session 在装配时挂进来（覆盖层不认识账户）。
  /* 强平价那条线（liqRatioOf）与「扎穿之后叫谁结算」（pierceHook）**都拿掉了** ——
     引导不再制造爆仓，见 rebuild() 里那段说明。 */
  const seriesOf = pair => (pair ? CS.marketData.seriesRef(pair) : null);
  const cursor = () => CS.marketData.nowIndex;
  /* 这一单**实际**用的是多少倍杠杆（不再写死 guidedLeverage）：
     第六课让玩家自己拖滑块，而 45% 那条硬边界 = lossOfMargin × lossPeak ÷ 杠杆 ——
     写死 20× 的话，玩家拉到 50× 时那条线会在真实强平价之外（价格层以为还安全），
     拉到 5× 时又会把浮亏画得比实际深。取不到就退回引导的默认倍数。 */
  const leverageUsed = () => Math.max(1, Number(spec && spec.leverage) || TUNE.guidedLeverage || 20);

  /* ============ 这一段铺到哪儿为止（**光标里的绝对下标**） ============
     两个读取者必须用**同一个数**，否则就会出现「图上最后一根是铺过的价、
     持仓行报的却是另一根的价」这种两处读数打架的东西：
       · rebuild()  按它写 OHLC；
       · freeze()   按它决定「玩家看到的那几根」在哪里收尾。
     按**当时的光标**算 —— 不能只信 rideToBar：那是 session 在推进事件里写下/更新的，
     而光标有可能先动、事件还没跑。光标天然不超过它自己，所以「改写未来 K 线」也不会发生。 */
  const writeEndOf = shape => {
    if (!shape || !Number.isFinite(shape.index)) return null;
    if (Number.isFinite(shape.rideToBar)) return Math.max(shape.rideToBar, cursor());
    return shape.index + shape.spanBars;
  };
  const lastOf = shape => Math.max(shape.spanBars, Math.max(0, (writeEndOf(shape) || shape.index) - shape.index));
  /* 亏单在段内（以及段外那点来回）最深能到哪儿：保证金亏损 lossOfMargin × lossPeak（45%），
     换算成**不利方向**上的价格比例（做多往下、做空往上）。它同时是影线的下限（writeBar 的
     floorPrice）与实体/段外的地板（rebuild 的 floorRatio）—— 两处口径必须一致，所以只写一次。 */
  const lossFloorRatio = side => 1 + (side === -1 ? 1 : -1) * TUNE.lossOfMargin * TUNE.lossPeak / leverageUsed();

  /* 认一份规格：认不出来就返回 null（宁可「不铺」也不要拿半条坏数据去铺价） */
  function copySpec(next) {
    if (!next || !Number.isFinite(next.index)) return null;
    const ratio = Number(next.ratio);
    /* 挂单（第五课）：这一份 spec 只管**成交那一根**的影线怎么碰到委托价。
       它没有仓位、没有输赢、也没有段长，所以在最前面分流 —— 别让它混进下面那些字段里，
       否则 rebuild 会把它当成一单「赢单」去铺一整段，而那时光标下根本没有仓。 */
    if (next.pending) {
      return {
        pending: true,
        pair: next.pair,
        index: Math.round(next.index),
        side: next.side === -1 ? -1 : 1,
        open: Number(next.open) > 0 ? Number(next.open) : 0,
        ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
        vol: Number(next.vol) > 0 ? Number(next.vol) : 0,
        candleBars: Number(next.candleBars) > 0 ? Math.round(Number(next.candleBars)) : 1,
        leverage: 1,
        win: true, breakEvenGap: 0, margin: 0, notional: 0,
        spanBars: 1, baseSpan: 1, rideToBar: null, walkedToDue: false
      };
    }
    return {
      pair: next.pair,
      index: Math.round(next.index),
      side: next.side === -1 ? -1 : 1,
      win: next.win !== false,
      open: Number.isFinite(next.open) && next.open > 0 ? next.open : 0,
      ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
      vol: Number(next.vol) > 0 ? Number(next.vol) : 0,
      candleBars: Number(next.candleBars) > 0 ? Math.round(Number(next.candleBars)) : 1,
      breakEvenGap: Number.isFinite(next.breakEvenGap) ? next.breakEvenGap : 0,
      /* 这一单的杠杆（45% 那条线按它算）：缺省 = 引导的默认倍数 */
      leverage: Math.max(1, Number(next.leverage) || TUNE.guidedLeverage || 20),
      margin: Number(next.margin) > 0 ? Number(next.margin) : 0,
      notional: Number(next.notional) > 0 ? Number(next.notional) : 0,
      spanBars: Number.isFinite(next.spanBars) && next.spanBars > 1 ? Math.round(next.spanBars) : 4,
      /* 这一段**原定**要走多少根（包络在那一根上正好到目标）：段外那条「有趋势的随机行情」
         锚在它上面。它与 spanBars（= 该平仓的那一根）平时是同一个数，但**必须分开传** ——
         spanBars 会被 session 的 extendSpan 往后推，而曲线不该跟着重画。 */
      baseSpan: Number.isFinite(next.baseSpan) && next.baseSpan > 1 ? Math.round(next.baseSpan)
        : (Number.isFinite(next.spanBars) && next.spanBars > 1 ? Math.round(next.spanBars) : 4),
      /* 这一单还开着，价格就要一直铺到光标脚下（不能留给真实行情）。
         null / 缺省 = 只铺 spanBars 根（结算之后就走到这条路上了）。 */
      rideToBar: Number.isFinite(next.rideToBar) ? Math.round(next.rideToBar) : null,
      /* 光标已经走到「该平仓的那一根」了吗。亏单的收尾那一根要扎穿强平价，
         但只能在**真走到了**之后扎 —— 不然开仓那一刻就把玩家爆了。 */
      walkedToDue: next.walkedToDue === true
    };
  }

  /* ============ 改写 / 还原 ============ */
  /* 一次把**这一对交易对**的 OHLC 重算出来：先整体还原原始行情，再把这一段盖上去。
     整体还原而不是「只还原上一次改过的那几根」—— 段的边界每走一根就变一次，
     增量还原迟早会漏掉一根，而漏掉的那一根会永远留在图上（最难查的一类错）。 */
  function rebuild() {
    const b = base.store;
    const s = seriesOf(base.pair);
    if (!b || !s || s.bars.length !== b.c.length) return false;
    const B = s.bars;
    for (let i = 0; i < B.length; i++) { B[i].o = b.o[i]; B[i].h = b.h[i]; B[i].l = b.l[i]; B[i].c = b.c[i]; }
    if (!spec) return true;
    /* 挂单那一份：只铺「成交那一根」，铺完就等引擎去撮合（见 writePending） */
    if (spec.pending) return writePending(s);
    const e = spec.index - s.off;                       /* 开仓那一根在这个数组里的下标 */
    if (e < 0 || e >= B.length) return true;
    /* 整段的锚 = 成交价。**不能拿「这一根的开盘价」当锚**：那一根的开盘价会被我们改写，
       用它当锚就成了自指的（改一次价格，下一次的锚就变了）。成交价来自持仓，是稳定的。 */
    const anchor = spec.open > 0 ? spec.open : B[e].o;
    if (!(anchor > 0)) return true;
    const target = spec.ratio;
    const profile = spec.win ? 'win' : 'lose';
    const span = spec.baseSpan;
    /* 铺到哪儿为止（**相对开仓那一根的根数**，与循环里的 k 同一个坐标系）：
       **至少**铺满这一段；另外只要这一单还开着、光标又走到这一段之外了，就一路铺到光标脚下。
       为什么必须一路铺下去：光标一旦走出这一段，那里就是**真实行情**（我们从 base 里还原出来的
       原始价格），方向完全不受控 —— 时间足够长，做多的单一定会被扫到强平价。
       铺到光标脚下之后，价格按 favor.js 段外那条**有趋势的随机行情**走：浮动盈亏跟着 K 线走，
       而两条硬边界（赢单保本、亏单 45%）始终夹着它。

       注意两个坐标系的换算：spec.index 与 rideToBar 都是**基础 K 线的绝对下标**，
       而 s.off 是 series 数组的起点，循环里的 k 是相对开仓那一根的根数 ——
       所以 rideToBar 要减的是 **index**（不是 off，也不是 e）。 */
    const last = lastOf(spec);
    /* ★ 「亏单收尾那一根扎穿强平价」**已经拿掉**（2026-10-04 产品口径：引导要像主游戏，
       就不该有看不见的手把玩家拉爆 —— 玩家自己决定什么时候平仓）。
       原来这里算一档 diveDepth / piercePrice，写进 writeBar 的 pierce，再叫
       pierceHook 去判一次爆仓：结果是「时间一到必被拉爆」，而屏幕上没有任何预兆。
       现在这一整条链都不存在了：影线只受 floor 那条硬边界约束（赢单保本、亏单 45%），
       所以**引导期间不可能被强平**。真正的强平判定仍在引擎里（marketEngine），
       玩家的普通持仓、以及离开引导之后的持仓，照旧按真实规则结算。 */
    const gap = Math.abs(spec.breakEvenGap);
    /* 赢单的地板 = 保本价再往外一点点（winWickFloor）：实体与影线都不许回到保本价之内，
       所以赢单的浮盈自始至终是绿的 —— 段外那点来回也一样。
       · 方向要紧：做多的地板在成交价之上（价格不许掉下来），做空的在成交价**之下**。
       · 缺了保本价那一步时兜底按 winMove × 1.35 估 —— 与 session 给赢单目标用的下限同一个数。 */
    const floorGap = (gap > 0 ? gap : TUNE.winMove * 1.35) * TUNE.winWickFloor;
    /* 亏单的地板 = 段内最深 45% 保证金那条线（与影线下限同一个数，见 lossFloorRatio） */
    const floorRatio = spec.win ? (spec.side === 1 ? 1 + floorGap : 1 - floorGap) : lossFloorRatio(spec.side);
    /* 亏单的实体也要压在那条线之上：影线由 writeBar 夹（floorPrice），
       但**账面浮盈读的是收盘价** —— 只夹影线的话，抖动叠上去能把某一根的收盘价压到 45% 之下。 */
    const lossCap = ratio => (!spec.win && ratio < floorRatio ? floorRatio : ratio);
    /* 越过了那条硬边界没有 —— **方向按多空分开**（做多的地板在下方、做空的上方）。 */
    const beyondFloor = ratio => (spec.side === 1 ? ratio < floorRatio : ratio > floorRatio);
    /* k > span 是「段外」（玩家走到该平仓那一根还不平）：曲线继续往前走，但走法换了一套 ——
       favor.js 的 rideAt 给的是**一条有趋势的随机行情**（慢的趋势项 + 快的小波段），
       实体逐根落在不同的价上，于是持仓行的「当前价格」与「浮动盈亏」跟着 K 线一起动。 */
    const AT = Math.abs(target - 1) * anchor;
    /* 影线的「最小幅度」：**照着市场在这一档周期上一根 K 线大概走多远来定**。
       影线原来是 `实体 × wickShare`，于是收得安静的那几根会被画成一根又短又没影线的横线
       （真行情里没有这种 K 线，一眼就看出是画的）。 */
    const mktMove = R.marketCandleMove(target, { vol: spec.vol, candleBars: spec.candleBars }) * anchor;
    const spread = Math.max(AT * 0.35, mktMove * (Number.isFinite(TUNE.wickFloor) ? TUNE.wickFloor : 0.5));
    /* 每一根的收盘比例都从 favor.js 现算：**每一根都不一样、逐根实时算**，
       所以持仓行的「当前价格」与「浮动盈亏」一路跟着 K 线走，不会卡在某个数上。
       兜底的两道夹子仍然留着（噪声是逐根随机的，单靠约定的护栏不够稳）。 */
    const rideAt = k => {
      const ratio = F.ratioAt(k, span, target, profile, spec.index + k,
        /* lev 决定亏单包络的深度（45% ÷ 杠杆）：这一单真实的倍数，不再写死 guidedLeverage */
        { floor: floorRatio, vol: spec.vol, candleBars: spec.candleBars, lev: leverageUsed() });
      return lossCap(beyondFloor(ratio) ? floorRatio : ratio);
    };
    const endK = last;
    /* ★ 「扎穿强平价」那一段（piercePrice / pierceFor）**整块删掉了**：
       引导不再制造爆仓（见上面那段说明）。下面铺价时影线只受 floor 约束。 */
    /* 铺 **k = 0 … last** —— 一直到光标那一根为止（含它自己）。
       为什么必须含光标那一根：k 的终点是「显示价那一根」，而显示价那一根 = **光标脚下那一根**。
       以前只铺到 last - 1、把最后一根单独铺在 if 里，于是每一根被推进过的那一根都**没有被铺过**，
       还留着真实行情的价：图上最新那一根的开盘价接不上上一根的收盘，整根用的是真实行情的高/低。

       每一根的开盘价接上一根的收盘价（价格连续），**开仓那一根也不例外**：
       它照旧从上一根的收开出来，收盘才是成交价（= 这一段的锚）。 */
    for (let k = 0; k <= last; k++) {
      const i = e + k;
      if (i < 0 || i >= B.length) break;                   /* 走到序列尽头就停（别越界） */
      const open = i > 0 ? B[i - 1].c : (anchor || B[i].o);
      writeBar(B, i, open, rideAt(k) * anchor, floorRatio * anchor, spread);
    }
    /* ★ 铺过的那一段**右边第一根**要把开盘价接回来。
       那一根没被铺（它是真实行情），它的「开」仍然等于**真实**前一根的收 ——
       而我们刚把前一根的收改写成了铺出来的价，于是两段对不上：
       实测差 2.96%~4.10%（前收 58910.30 / 后开 57163.87）。
       平时看不见（图表只画到光标那一根），但覆盖层一停（平仓 / 强平 / 退出教程）它就露出来，
       图上是一道硬台阶 —— 用户报的「K 线断开了」。
       只动这一根的**开**，它的收与影线仍是真实行情；下一次推进铺到它时会被整根覆盖，
       而覆盖层一旦卸掉（release/clear），整条 series 又会从快照还原，所以这一下不留痕。 */
    const seam = e + last + 1;
    if (seam > 0 && seam < B.length) {
      const seamOpen = B[seam - 1].c;
      const sb = B[seam];
      if (seamOpen > 0) {
        sb.o = seamOpen;
        sb.h = Math.max(sb.h, seamOpen, sb.c);
        sb.l = Math.min(sb.l, seamOpen, sb.c);
      }
    }
    /* ★ 原来这里还有一段「收尾那一根扎穿强平价了吗 → 叫 pierceHook 立刻判一次爆仓」。
       引导不再制造爆仓之后整段删掉（见上面那段说明）。
       真正的强平判定仍在引擎里：marketEngine.settleStep 每根都会 checkLiquidation，
       所以玩家的普通持仓（以及离开引导之后的持仓）照旧按真实规则结算。 */
    return true;
  }

  /* ============ 挂单：把「成交那一根」的影线排到委托价上 ============
     第五课要玩家挂一张限价单再点「前进 →」等成交；真实行情里等几根都没碰到是常事，
     课上等不起，也讲不清。所以这一根由引导**排**出来：从上一根的收开出来、收在委托价上，
     影线正好停在委托价（做多给下影、做空给上影）。引擎的判据是
     `做多 bar.l <= 委托价 / 做空 bar.h >= 委托价`（marketEngine 的 settleStep），
     于是这一根**必然**触发撮合，成交价就是委托价 —— 玩家看到的仍是「影线碰到我的价」。
     ★ 只有光标**走到**那一根时才写（`spec.index <= cursor()`）：提前写就是把未来 K 线
       摆进 series，而「图表只画到光标」「读未来数据会报错」都建立在「不做这件事」上。
       syncToCursor 在每一根的**结算之前**调一次 sync()，正好赶在引擎判成交之前铺上。 */
  function writePending(s) {
    if (!s || !(spec.index <= cursor())) return true;
    const i = spec.index - s.off;
    const B = s.bars;
    if (i < 0 || i >= B.length) return true;
    const open = i > 0 ? B[i - 1].c : B[i].o;
    const anchor = spec.open > 0 ? spec.open : open;
    const price = anchor * spec.ratio;
    if (!(anchor > 0) || !(price > 0)) return true;
    /* 影线的最小幅度照「市场在这一档周期上一根走多远」来定 —— 与段内那些根同一个口径，
       免得成交那一根被画成一根又短又没影线的小横线（一眼看出是排的）。 */
    const spread = Math.max(Math.abs(price - open) * 0.35,
      R.marketCandleMove(spec.ratio, { vol: spec.vol, candleBars: spec.candleBars }) * anchor
        * (Number.isFinite(TUNE.wickFloor) ? TUNE.wickFloor : 0.5));
    writeBar(B, i, open, price, price, spread);
    return true;
  }

  /* 写一根 K 线：实体取 open→close，影线按实体长度散开，并且**影线不许越过 floor 那条硬边界**
     （赢单的 floor 在保本价上，所以影线永远扫不到亏损那一侧）。
     影线的长度取 max(实体, spread)：**spread 是「最小幅度」**—— 实体很小时也要有影线。

     影线用**下标决定的噪声**（favor.js 的 noiseAt），不用 Math.random()：
     铺价每推进一根就把整段重铺一遍，用 Math.random 的话**看过的那几根影线每次重铺都换个样**
     （同一根 K 线在眼皮底下抽动）；而且刷新页面看到的也不是同一张图。

     ★ 这里原来还有一个 pierce 参数（「这一根的影线必须扎到强平价之外」，亏单收尾用）。
     引导不再制造爆仓之后整个参数删掉了 —— 影线只受 floor 那条硬边界约束。
     夹完之后 K 线的四个价必须自洽（最低价不会高过实体，最高价不会低于实体）。 */
  function writeBar(B, i, open, close, floorPrice, spread) {
    const o = open, c = close;
    const scale = Math.max(Math.abs(c - o), Number.isFinite(spread) ? spread : 0);
    const toss = salt => (M.noiseAt(i, salt) + 1) / 2;         /* 下标决定、范围 [0,1) */
    const body = scale * TUNE.wickShare * (.35 + toss(31)) * (.35 + toss(53));
    let h = Math.max(o, c) + body * toss(97);
    let l = Math.min(o, c) - body * toss(211);
    /* 影线夹在那条硬边界之内 —— **夹哪一侧要看边界在哪边**：
       做多（与亏单）的边界在下方 → 压最低价；做空的赢单边界在**上方** → 压最高价。
       原来只压最低价，对做空的赢单等于没夹（边界在收盘价上方）。 */
    if (Number.isFinite(floorPrice)) {
      if (floorPrice <= Math.min(o, c)) l = Math.max(l, floorPrice);
      else if (floorPrice >= Math.max(o, c)) h = Math.min(h, floorPrice);
    }
    B[i].o = o; B[i].c = c; B[i].h = h; B[i].l = l;
  }

  /* ============ 对外的读数：这一段的价格归引导管 ============
     「当前价 = 光标那一根自己的收盘价」在新引擎里本来就成立（marketData.loadSeries 读的就是
     series 里的 bars，而我们把 bars 就地改了），所以这里只回答一个问题：
     「这一根是不是我铺的那一段」。返回 NaN = 不是，按行情本身算。 */
  function priceFor(id, index) {
    /* 挂单那一份不是「一段行情」：它那一根要到成交之后才由 begin() 接管成仓位，
       在那之前谁问价都该按行情本身算（返回 NaN = 不是引导铺的）。 */
    if (!spec || spec.pending || id !== spec.pair) return NaN;
    const s = seriesOf(id);
    if (!s) return NaN;
    if (index < spec.index || index > writeEndOf(spec)) return NaN;
    const i = index - s.off;
    if (i < 0 || i >= s.bars.length) return NaN;
    return s.bars[i].c;                                 /* 这一根的收盘价 = 此刻值多少 */
  }

  /* ============ 设置 / 清除 / 同步 ============ */
  /* 抄一份「引导动手之前」的价格。已经抄过就不动：抄第二次就等于把上一次引导的结果
     当成了原始行情，第一次改写之后的那段价格会永远留在序列里。 */
  function capture(pair, s) {
    if (base.pair === pair && base.store) return;
    base.pair = pair;
    const B = s.bars;
    const o = new Array(B.length), h = new Array(B.length), l = new Array(B.length), c = new Array(B.length);
    for (let i = 0; i < B.length; i++) { o[i] = B[i].o; h[i] = B[i].h; l[i] = B[i].l; c[i] = B[i].c; }
    base.store = { id: pair, off: s.off, o, h, l, c };
  }
  /* 记下一段；next 为 null 表示「这一段结束了，把价格还回行情本身」。
     这一步**一定**重算一次（不看签名）：它同时也承担「还原」的职责。 */
  function set(next) {
    const wanted = copySpec(next);
    const pair = (wanted && wanted.pair) || base.pair;
    const s = pair ? seriesOf(pair) : null;
    if (wanted && !s) return false;
    if (s) capture(pair, s);
    spec = wanted;
    signature = signatureOf(spec);
    rebuild();
    invalidate();
    return true;
  }
  const clear = () => set(null);
  const current = () => spec;
  const active = () => !!spec;
  const captured = () => !!base.store;
  /* 这一段是谁（交易对 + 开仓那一根 + 成交价 + 目标 + 段长 + 杠杆）：sync() 靠它判断「要不要重算」。
     杠杆要进签名：它在同一单里不会变，但它决定 45% 那条线（lossFloorRatio）——
     第六课换着倍率开单时，签名里少了它，上一单的铺法就会被当成「没变」沿用下去。 */
  const signatureOf = next => {
    const shape = copySpec(next);
    if (!shape) return '';
    if (shape.pending) return `pending|${shape.pair}|${shape.index}|${shape.side}|${shape.ratio.toFixed(6)}`;
    return `${shape.pair}|${shape.index}|${shape.side}|${shape.win ? 1 : 0}|${shape.ratio.toFixed(6)}|${shape.breakEvenGap.toFixed(6)}|${shape.spanBars}|${shape.baseSpan}|${shape.vol.toFixed(6)}|${shape.candleBars}|${shape.leverage}|${shape.open.toFixed(4)}|${shape.rideToBar == null ? '-' : shape.rideToBar}`;
  };
  /* 把这一段铺到 series 上。签名没变就什么都不做。
     force = true 时无条件重算（数据层整个重写了一遍时不这么做会漏铺）。 */
  function sync(force) {
    if (!CS.marketData.ready || !base.store) return false;
    /* 挂单那一份没有签名可依：光标每走一根，它就从「还没到」变成「就是这一根」，
       所以要**每根都重铺一次**（只写一根，成本可忽略；签名不变的话上面那句会把它跳过去）。 */
    if (spec && spec.pending) { rebuild(); invalidate(); return true; }
    const next = signatureOf(spec);
    if (!force && next === signature) return false;
    signature = next;
    rebuild();
    invalidate();
    return true;
  }
  /* 还原但不丢快照：rebuild() 在 spec 为 null 时做的就是这件事 */
  function restore() {
    if (!base.store) return false;
    rebuild();
    invalidate();
    return true;
  }
  /* 真的一次都不引导了（把覆盖层彻底卸掉时用）：还原并忘掉那份快照 */
  function release() {
    restore();
    base.pair = '';
    base.store = null;
    spec = null;
    signature = '';
  }
  /* 价格改了，按周期重采样出来的 K 线就不能再用旧的。
     **必须走 marketData.bumpPrices**：图表聚合缓存的键里带着 priceVersion，
     只改数组不清版本号的话，图上画的还是改写前的蜡烛（不报错，只是对不上）。 */
  function invalidate() {
    if (CS.marketData.bumpPrices) CS.marketData.bumpPrices();
  }

  return {
    tutorialPrice: {
      set, clear, current, active, captured, sync, restore, release, invalidate, priceFor,
      /* ★ 只给 core/tutorial/priceHistory.js 用（冻结那一段要读同一个 spec 与同一份快照，
         又不能让这一份涨过**当时**的 400 行上限）。别在别处用它 —— 换价格一律走 set/sync。 */
      internals: {
        base: () => base,
        spec: () => spec,
        seriesOf,
        writeEndOf,
        lastOf
      }
    }
  };
});
