/* ============ 开仓二次确认（市价与限价两张单） ============
   旧教程页的「开仓二次确认」（account/trade.js 的 confirmOpenPosition 与
   account/orders.js 的 confirmLimitOrder）搬过来，字段逐条对齐：
     市价：交易对 / 方向 / 成交价 / 投入保证金 / 杠杆 / 名义仓位 / 开仓手续费 /
           资金费率 / 强平费 / 强平价
     限价：交易对 / 委托方向 / 委托价格 / 当前价格 / 距成交 / 冻结保证金 / 杠杆 /
           名义仓位 + 费用与风险 + 成交与撤销
   开关在设置槽里（classicSettings 的 confirmOpen），关掉就即点即成交。

   为什么值得留着这一层：那张单子一旦成交就改钱，而「点错了方向」是这个界面上
   唯一一个代价高昂的误操作 —— 两颗按钮挨在一起，多问一句比多赔一笔便宜。
   引导期间它被关掉（每一单都要玩家亲手点，再多一张确认单就是双重确认）。

   ★ 「成交价」写的是哪一个价：新引擎的市价单按**这一根的收盘价**成交（再叠滑点），
   不是抖动中屏幕上跳的那个数。确认单上写着「按此刻的当前价成交」时，
   玩家读到的是自己看到的大数字 —— 所以这里明确写「按这一根 K 线的收盘价成交」，
   把口径摆在纸面上，而不是让他在结算记录里发现差一点。 */
CS.define('ui/components/tradeConfirm', ["core/base/money","core/engine/accountEngine","core/market/marketData","lib/lodash","ui/components/bits","ui/components/modal"], function () {
  'use strict';
  const t = CS.uiBits.t;

  const num = (v, digits) => CS.money.formatNumber(v, digits);
  const pct = v => `${(Number(v) * 100).toFixed(2)}%`;

  function hoursOf() {
    try { return Number(CS.marketData.getDatasetMeta().fundingIntervalHours) || 8; } catch (_) { return 8; }
  }
  /* 下一期的资金费率（真实历史数据）与它折算到这一笔仓位上的金额 */
  function fundingOf(d, id, notional) {
    const inst = d.instrument(id);
    const rate = inst.funding;
    return {
      rate,
      text: Number.isFinite(rate) ? `${(rate * 100).toFixed(4)}% / ${hoursOf()} 小时` : t('st.order.fundingBefore'),
      cost: Number.isFinite(rate) ? Math.round(notional * Math.abs(rate)) : 0
    };
  }

  /* 市价开仓的确认单。onGo() 是「玩家已确认」之后真正下单那一下。 */
  function market(d, ui, side, onGo) {
    const id = d.currentInstrumentId();
    const inst = d.instrument(id);
    const p = d.preview();
    const sideText = side === 'short' ? t('trade.short') : t('trade.long');
    const fund = fundingOf(d, id, p.notional);
    const liqFee = Math.round(p.notional * CS.accountEngine.LIQ_FEE_RATE);
    CS.uiModal.open({
      icon: side === 'short' ? '↘' : '↗',
      /* ★ 标题里的交易对也用**显示写法**（BTC/USDT 那种）：引导期间它是别名
         （见 tradeModel 的 displaySymbolOf：BTCUSDT 显示成 CXPUSDT），而标题原来直接用
         `inst.symbol` —— 同一张单子上标题写「CXPUSDT」、参数行写「CXP/USDT」，两处不一样。 */
      title: t('trade.confirm.title', { pair: d.pairText(inst.symbol), side: sideText }),
      message: t('trade.confirm.message'),
      sections: [
        { title: t('trade.confirm.params'), rows: [
          [t('st.chart.pair'), `${d.pairText(inst.symbol)}`],
          [t('st.history.side'), sideText],
          [t('trade.entry'), `${num(p.price, inst.digits)} USDT`],
          [t('trade.margin'), d.money(p.margin)],
          [t('trade.leverage'), `${p.leverage}×`],
          [t('trade.notional'), d.money(p.notional)]
        ] },
        { title: t('trade.confirm.risks'), rows: [
          [t('trade.fee'), d.money(p.fee)],
          [t('st.order.funding'), fund.text],
          [t('trade.confirm.liqFee'), d.money(liqFee)],
          [t('st.order.liq'), `${num(p.liq, inst.digits)} USDT`],
          [t('st.order.risk'), p.risk == null ? '—' : pct(p.risk)]
        ] },
        { title: t('trade.confirm.after'), text: t('trade.confirm.afterText', {
          total: d.money(p.margin + p.fee),
          side: side === 'short' ? t('trade.risk.sideHigh') : t('trade.risk.sideLow'),
          hours: hoursOf()
        }) }
      ],
      confirm: t('trade.confirm.go'),
      action: () => onGo()
    });
  }

  /* 限价委托的确认单 */
  function limit(d, ui, side, onGo) {
    const id = d.currentInstrumentId();
    const inst = d.instrument(id);
    const p = d.preview();
    const sideText = side === 'short' ? t('trade.short') : t('trade.long');
    const fund = fundingOf(d, id, p.notional);
    const limitPrice = ui.limitPrice;
    const move = inst.price > 0 ? (limitPrice / inst.price - 1) * 100 : 0;
    CS.uiModal.open({
      icon: side === 'short' ? '↘' : '↗',
      title: t('trade.confirm.limitTitle', { pair: d.pairText(inst.symbol), side: sideText }),
      message: t('trade.confirm.limitMessage'),
      sections: [
        { title: t('trade.confirm.limitParams'), rows: [
          [t('st.chart.pair'), `${d.pairText(inst.symbol)}`],
          [t('st.history.side'), sideText],
          [t('st.order.limitPrice'), `${num(limitPrice, inst.digits)} USDT`],
          [t('st.order.live'), `${num(inst.price, inst.digits)} USDT`],
          [t('st.order.distance'), `${move >= 0 ? '+' : ''}${move.toFixed(2)}%`],
          [t('st.order.frozen'), d.money(p.margin)],
          [t('trade.leverage'), `${p.leverage}×`],
          [t('trade.notional'), d.money(p.notional)]
        ] },
        { title: t('trade.confirm.risks'), rows: [
          [t('trade.fee'), d.money(p.fee)],
          [t('st.order.funding'), fund.text],
          [t('st.order.liqAfterFill'), `${num(p.liq, inst.digits)} USDT`],
          [t('trade.confirm.liqFee'), d.money(Math.round(p.notional * CS.accountEngine.LIQ_FEE_RATE))],
          [t('st.order.frozenTotal'), d.money(p.margin + p.fee)]
        ] },
        { title: t('trade.confirm.limitAfter'), text: t('trade.confirm.limitAfterText', {
          side: side === 'short' ? t('trade.risk.sideHigh') : t('trade.risk.sideLow')
        }) }
      ],
      confirm: t('trade.confirm.limitGo'),
      action: () => onGo()
    });
  }

  return { tradeConfirm: { market, limit } };
});
