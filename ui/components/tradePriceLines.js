/* ============ 交易页图上的价格线（六个身份，两个模式共用） ============
   旧实现在 game/js/account/lines.js… 不是，在 game/js/chart/lines.js：那一层既算线又画线。
   这里只做**前一半**：把「此刻该画哪几条线、每条的价与标签是什么」算出来；
   画由 ui/components/chartIndicatorLayer.js 的 layoutPriceTags / drawPriceLines 负责
   （它已经逐调用对着旧画笔比过：tools/parity-plot.mjs）。

   六个身份（颜色与虚实是它们唯一的区别；开关在图例里）：

     身份            颜色        虚实        谁的
     开仓价          灰          实线        每个持仓一条（**不单独开关**：持仓就在图上）
     强平线          深红        [3,3]       每个持仓一条
     保本线          蓝          [1.5,2.5]   每个持仓一条（含开仓/平仓手续费与已结算资金费）
     委托线          琥珀        [5,3]       每笔未成交的限价委托一条
     预览线          紫红        [8,4]       **唯一可拖动的一条**：拖它就是挑限价单的价
     预估强平·现价·多   玫红        [5,3]       按**当前下单参数**算，按现价成交（默认开）
     预估强平·现价·空   深玫红      [2,4]       同上，另一个方向（默认开）
     预估强平·委托价·多 浅玫红      [1.5,2.5]   同上，按委托价成交（默认关，且只在限价模式画）
     预估强平·委托价·空 粉          [1,3]       同上，另一个方向

   ★ 三处口径必须与旧实现一致，否则「图上那条线」与「面板上那个数」会对不上：
     1) 保本价 = 开仓价 × (1 + (开仓费 + 平仓费 + 已结算资金费) / 名义仓位 × 方向)
        —— 实现在 core/engine/accountEngine.js 的 breakEvenOf（那里有完整理由）。
     2) 预估强平**多空两侧都画**（2026-10-04 用户口径）：
        原来只画「离现价更近的那一侧」、固定落成做多，理由是「面板同一时刻只可能出一个方向，
        两条会让人以为是两个仓位」。改成两侧的理由：玩家**正在选**方向 ——
        两条一起看才知道这一单往上扫到哪、往下扫到哪；而每条线的标签写着「多」「空」，
        不会被当成两个仓位。两侧都调同一个 liqAt(fill, side, lev)，公式不在这层重写。
     3) 预估强平·现价用的「现价」是**屏幕上那个价**（抖动中就是盘中跳到的价）——
        面板那一格用的也是它，两处是同一个读数的两种画法。 */
CS.define('ui/components/tradePriceLines', ["ui/components/bits"], function () {
  'use strict';
  const t = CS.uiBits.t;

  /* 颜色与虚实逐字照旧实现（game/js/chart/lines.js:25-27）。
     玫红那一族是「这一单会死在哪」，与持仓强平线的深红刻意分开。 */
  const RGB = {
    entry: '#64748b',        // [100,116,139]
    liquidation: '#f23645',  // DOWN_RGB
    breakEven: '#2563eb',    // [37,99,235]
    pending: '#d97706',      // [217,119,6]
    preview: '#db2777',      // [219,39,119]
    liqEstimate: '#f472b6',  // [244,114,182]
    liqEstimateOrder: '#f9a8d4', // [249,168,212]
    /* ★ 2026-10-04：做空那一侧的预估强平单独给色 —— 多空两条同屏，
       同色只靠标签区分容易看错（线条本身很细）。同属「玫红这一族 = 这一单会死在哪」，
       只是把做空压深一档；虚线也改成点线，一眼能分出上下两侧。 */
    liqEstimateShort: '#be185d',
    liqEstimateOrderShort: '#f06292',
    up: '#089981',
    down: '#f23645'
  };
  const DASH = {
    entry: null,
    liquidation: [3, 3],
    breakEven: [1.5, 2.5],
    pending: [5, 3],
    preview: [8, 4],
    liqEstimate: [5, 3],
    liqEstimateOrder: [1.5, 2.5],
    /* 做空那两条用点线（见 RGB 里那段说明） */
    liqEstimateShort: [2, 4],
    liqEstimateOrderShort: [1, 3]
  };
  /* 旧实现里六个开关的默认值（config/constants.js 的 DEFAULT_SHOW_*）：
     只有「预估强平·委托价」默认关 —— 它在市价模式下本来就不该露面。 */
  const SHOW_DEFAULT = {
    showBreakEven: true, showLiqLine: true, showPendingLine: true,
    showPreviewLine: true, showLiqPreviewLine: true, showLiqPreviewOrder: false
  };

  /* 开关读的是**模式给的那一格**（故事在这一局的状态里，模拟在回放的存档里），
     缺省时用上面的默认值 —— 老存档没有这些键，不能因此整条线不画。 */
  function visible(get, key) {
    const value = get ? get(key) : undefined;
    return value === undefined || value === null ? SHOW_DEFAULT[key] !== false : !!value;
  }

  /* opts 由调用方（交易页的数据层）给：
       digits      价格精度（按交易对）
       price(v)    价格 → 文本
       money(units) 金额 → 文本（预估强平线悬停提示里写保证金用）
       displayPrice 屏幕上那个价（抖动中逐帧在变）
       settlePrice  这一根的收盘价（算保本与委托价那几条用它，不用抖动价）
       positions   这一屏品种的持仓
       orders      未成交的限价委托
       flags(key)  读线开关
       leverage / margin  下单面板此刻的参数
       orderTypeActive() 是不是「限价委托」模式（预览线与预估·委托价只在它下面画）
       previewPrice()    订单预览线的价
       breakEvenOf(pos)  保本价（引擎算）
       liqPriceAt(price, side, leverage) 强平价
     返回 [{ kind, price, label, color, dash, live?, toggleKey? }]，按价格升序。 */
  function build(opts) {
    const o = opts || {};
    const out = [];
    const fmt = o.price || (v => String(v));
    const flags = o.flags || (() => undefined);
    const orders = o.orders || [];
    const positions = o.positions || [];
    const limitMode = !!(o.orderTypeActive && o.orderTypeActive());

    if (visible(flags, 'showPendingLine')) {
      orders.forEach(order => {
        if (!Number.isFinite(order.price) || order.price <= 0) return;
        out.push({
          kind: 'pending', price: order.price, color: RGB.pending, dash: DASH.pending,
          toggleKey: 'showPendingLine',
          label: `${t(order.side === 'short' ? 'trade.short' : 'trade.long')} ${t('st.line.pending')} ${fmt(order.price)}`
        });
      });
    }
    positions.forEach(pos => {
      out.push({
        kind: 'entry', price: pos.entryPrice, color: RGB.entry, dash: DASH.entry,
        label: `${t('st.line.entry')} ${fmt(pos.entryPrice)}`
      });
      if (visible(flags, 'showLiqLine')) {
        out.push({
          kind: 'liquidation', price: pos.liquidationPrice, color: RGB.liquidation, dash: DASH.liquidation,
          toggleKey: 'showLiqLine',
          label: `${t('st.line.liq')} ${fmt(pos.liquidationPrice)}`
        });
      }
      if (visible(flags, 'showBreakEven') && o.breakEvenOf) {
        const be = o.breakEvenOf(pos);
        if (Number.isFinite(be) && be > 0) {
          out.push({
            kind: 'breakEven', price: be, color: RGB.breakEven, dash: DASH.breakEven,
            toggleKey: 'showBreakEven',
            label: `${t('st.line.breakEven')} ${fmt(be)}`
          });
        }
      }
    });
    /* 预览线与「预估强平·委托价」一起进退：委托价是限价单的东西，
       市价模式下摆着一堆用不上的参考线只会挤掉真正有用的那几条。 */
    if (visible(flags, 'showPreviewLine') && limitMode && o.previewPrice) {
      const price = o.previewPrice();
      if (Number.isFinite(price) && price > 0) {
        out.push({
          kind: 'preview', price, color: RGB.preview, dash: DASH.preview, toggleKey: 'showPreviewLine',
          label: `${t('st.line.preview')} ${fmt(price)}`
        });
      }
    }
    /* 预估强平：把**下单面板此刻的保证金与杠杆**摊到入场价上。
       它们只做展示 —— 不参与下单、不参与结算。
       ★ 2026-10-04 用户口径：**多空两侧都画**（原来只画「离现价更近的那一侧」、
       而且固定落成做多那一侧）。理由说清楚：
         · 下单面板同一时刻只可能出一个方向，但玩家**正在选**哪个方向 ——
           两条线一起看才知道「这一单往上扫到哪、往下扫到哪」，
           只看一侧会让人以为另一侧不可能爆；
         · 两条线各自的标签写着「多」「空」，不会看成两个仓位（原来担心的正是这个）。
       做多的强平价在成交价**下方**（跌到那儿才亏掉保证金的 80%），做空在上方 ✓
       —— 两侧都调同一个 liqAt(fill, side, lev)，不在这里重写公式。 */
    const lev = Number(o.leverage);
    const spot = Number.isFinite(o.displayPrice) ? o.displayPrice : NaN;
    const preview = o.previewPrice ? Number(o.previewPrice()) : NaN;
    const liqAt = o.liqPriceAt;
    if (liqAt && lev > 0) {
      [['showLiqPreviewLine', 'liqEstimate', spot, RGB.liqEstimate, DASH.liqEstimate, 'st.line.fromSpot'],
        ['showLiqPreviewOrder', 'liqEstimateOrder', preview, RGB.liqEstimateOrder, DASH.liqEstimateOrder, 'st.line.fromPreview']]
        .forEach(([key, kind, fill, color, dash, fromKey]) => {
          if (!visible(flags, key) || !Number.isFinite(fill) || fill <= 0) return;
          if (kind === 'liqEstimateOrder' && !limitMode) return;
          /* 两个方向各一条：同一条开关（toggleKey）管着，开关一按两条一起进退 ✓ */
          [['long', key, kind, color, dash],
            ['short', key, `${kind}Short`, RGB[`${kind}Short`] || color, DASH[`${kind}Short`] || dash]]
            .forEach(([side, toggleKey, lineKind, lineColor, lineDash]) => {
              const price = liqAt(fill, side, lev);
              if (!Number.isFinite(price) || price <= 0) return;
              const sideWord = t(side === 'long' ? 'st.side.long' : 'st.side.short');
              out.push({
                kind: lineKind, price, color: lineColor, dash: lineDash, toggleKey,
                fill, leverage: lev, long: side === 'long',
                label: `${t('st.line.liqEst')}·${sideWord} ${fmt(price)}`,
                title: t('st.line.liqEstTitle', {
                  leverage: lev, from: t(fromKey),
                  move: ((0.8 / lev) * 100).toFixed(2)
                }),
                hover: t('st.line.liqEstHover', {
                  margin: o.money ? o.money(o.margin || 0) : '',
                  leverage: lev, fill: fmt(fill), price: fmt(price)
                })
              });
            });
        });
    }
    return out.sort((a, b) => a.price - b.price);
  }

  return { tradePriceLines: { build, RGB, DASH, SHOW_DEFAULT } };
});
