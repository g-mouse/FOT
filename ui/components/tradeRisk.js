/* ============ 追保提示与强平说明（两块弹窗 + 气泡档） ============
   旧教程页的 playback/risk.js 的 reportRisk 与 account/trade.js 里那张
   「关于 XX 持仓强制平仓的说明」搬过来，两个开关都在设置槽里：
     marginCallNotice  浮亏达到保证金的 60% → 弹提示并**暂停推进**（关掉只出气泡）
     liqNotice         被强制平仓 → 弹完整说明（关掉只出气泡，明细照样进结算记录）

   ============ 暂停推进这一格 ============
   弹窗开着时**不许再往前走**：那一下的结算已经发生、玩家正在读说明，
   再往后走一根就是在弹窗背后继续亏钱。门禁落在 replay.advanceBars（改设置槽里的
   riskPaused），解药只有关掉那张弹窗 —— 静默档（只出气泡）**刻意不置**这一格：
   那一档没有弹窗可关，置上就再没有出口（前进按钮永远是灰的、自动播放也起不来）。

   ★ 判定在引擎侧（marketEngine.settleStep → account.trackRisk → 事件 market.risk），
   这一层只负责「怎么说」。两边分开之后，「什么时候该提醒」只有一处定义。 */
CS.define('ui/components/tradeRisk', ["core/base/money","core/engine/accountEngine","core/events/events","lib/lodash","ui/components/bits","ui/components/modal"], function () {
  'use strict';
  const t = CS.uiBits.t;

  /* 「买涨」用最低价判、「买跌」用最高价判 —— 弹窗里那句话要跟着方向变 */
  const sideWord = side => (side === 'short' ? t('trade.risk.sideHigh') : t('trade.risk.sideLow'));
  const sideText = side => (side === 'short' ? t('trade.short') : t('trade.long'));

  function attach(d, ctx, hooks) {
    const h = hooks || {};
    const settings = () => (ctx.settings ? ctx.settings : (() => undefined));
    const flag = key => settings()(key) !== false;      // 默认开（设置槽里给的就是布尔）
    const offs = [];

    /* ---------- 追保 ---------- */
    offs.push(CS.events.bus.onKey('market.risk', 'tradeRisk', payload => {
      const risky = (payload && Array.isArray(payload.positions)) ? payload.positions : [];
      const first = risky[0];
      if (!first) return;
      const pos = d.snapshot().positions.find(p => p.id === first.id);
      if (!pos) return;
      const worst = Math.max(Number(first.worstRatio) || 0, CS.accountEngine.WARN_RATIO);
      const pnl = pos.unrealized || 0;
      const liq = pos.liquidationPrice;
      /* 建议金额 = 把浮亏摊到 55% 所需的那一笔（旧实现的算式，逐字照搬） */
      const suggestedUnits = Math.max(1, Math.ceil(-pnl / 0.55 - pos.margin));
      const suggested = d.fromUnits(suggestedUnits);
      const digits = d.instrument(pos.instrumentId).digits;

      /* ★ 提醒过一次就记下来，**只弹一遍**（2026-10-19 用户口径）。
         `trackRisk` 只用 `pos.warned` 做「该不该报」，而 `clearRisk` 以前全库没有调用点：
         于是同一笔仓位每一根结算都会再报一次 —— 弹窗一层层重开、自动播放时还会不停刷
         「追保弹窗还开着」的气泡。这里在处理之前先把这一批仓位全部标记掉（worstRatio 归零、
         warned=true）：同一笔仓位下一次要再报，得等玩家追加保证金（addMargin 会把 warned 清掉）
        或平仓；不是每根都来一次。
         ★ 先算完 worst/pnl/suggested 再清 —— clearRisk 会把 worstRatio 归零。 */
      risky.forEach(item => { try { ctx.account.clearRisk(item.id); } catch (_) {} });

      /* 弹窗要出来了：先把自动播放停下，否则它每一拍都会尝试推进、被暂停门禁挡回来。 */
      if (flag('marginCallNotice') && ctx.playback && ctx.playback.playing && ctx.playback.playing()) {
        try { ctx.playback.toggle(); } catch (_) {}
      }

      /* 静默档：只出一条气泡。**不置 paused** —— 那一档没有弹窗可关（见文件头） */
      if (!flag('marginCallNotice')) {
        CS.uiBits.toast(t('trade.risk.bubble', {
          pair: pos.instrumentId, side: sideText(pos.side), pct: (worst * 100).toFixed(1)
        }), 'neg', 9000);
        if (ctx.playback && ctx.playback.playing && ctx.playback.playing()) {
          try { ctx.playback.toggle(); } catch (_) {}
        }
        return;
      }
      CS.classicSettings.setPaused(true);
      CS.uiModal.open({
        icon: '!', loss: true, cls: 'risk-notice risk-margin-call',
        title: t('trade.risk.title', { pair: d.pairLabel(pos.instrumentId) }),
        message: t('trade.risk.message', { pair: d.pairLabel(pos.instrumentId), side: sideText(pos.side) }),
        sections: [
          { title: t('trade.risk.state'), text: t('trade.risk.stateText', {
            pair: d.pairLabel(pos.instrumentId), side: sideText(pos.side), pct: (worst * 100).toFixed(1)
          }) },
          { title: t('trade.risk.basis'), text: t('trade.risk.basisText', { side: sideWord(pos.side) }) },
          { title: t('trade.risk.position'), rows: [
            [t('st.chart.pair'), d.pairLabel(pos.instrumentId)],
            [t('st.history.side'), sideText(pos.side)],
            [t('trade.entry'), `${CS.money.formatNumber(pos.entryPrice, digits)} USDT`],
            [t('trade.pnl'), d.money(pnl), pnl >= 0 ? 'pos' : 'neg'],
            [t('st.order.liq'), `${CS.money.formatNumber(liq, digits)} USDT`],
            [t('trade.risk.warnLine'), `${(CS.accountEngine.WARN_RATIO * 100).toFixed(0)}%`],
            [t('st.position.funding'), d.money(-(pos.fundingPaid || 0))],
            [t('trade.confirm.liqFee'), d.money(Math.round((pos.notional || 0) * CS.accountEngine.LIQ_FEE_RATE))]
          ] },
          { title: t('trade.risk.actions'), text: t('trade.risk.actionsText') }
        ],
        input: { label: t('trade.risk.inputLabel', { amount: d.money(suggestedUnits) }), value: suggested, min: 1 },
        confirm: t('trade.risk.hold'),
        riskActions: {
          addLabel: t('trade.risk.addMargin'),
          addDisabled: d.snapshot().cash <= 0,
          onAdd: value => {
            const units = d.toUnits(Number(value) || 0);
            const result = ctx.account.addMargin(pos.id, units);
            if (!result || !result.ok) {
              CS.uiBits.toast((result && result.why) || t('trade.risk.lowBalance'), 'neg', 6000);
              return;
            }
            CS.uiBits.toast(t('trade.risk.added', {
              amount: d.money(units),
              liq: `${CS.money.formatNumber(result.position.liquidationPrice, digits)} USDT`
            }), 'pos', 6600);
            CS.uiModal.close();
          }
        },
        /* 关掉才解药：这一格是「这一刻不能推进」的唯一出口 */
        onClose: () => {
          CS.classicSettings.setPaused(false);
          if (h.onChanged) h.onChanged();
        }
      });
    }));

    /* ---------- 强平说明 ----------
       ★ 订阅 `account.positionClosed` 而不是 `market.liquidated`：
       后一个只在**推进的那一步**（marketEngine.settleStep）发得出来，
       而强平还有另一条路 —— 引导的收尾那一根扎穿强平价之后直接叫
       account.checkLiquidation（core/tutorial 的 pierce 钩子），那一路上没有 settleStep。
       只认 market.liquidated 的话，**上课期间被扫爆的那一单永远看不到说明**
       （而课表里本来就安排了「过几根 K 线被拉爆」那几单）。
       口径按 reason 认：'liquidation' 才是强平，手动平仓不弹这一张。 */
    offs.push(CS.events.bus.onKey('account.positionClosed', 'tradeLiqNotice', tr => {
      if (!tr || tr.reason !== 'liquidation') return;
      const digits = d.instrument(tr.instrumentId).digits;
      const fee = Number(tr.liqFee) || 0;
      /* ★ 引导手里那一单被扫爆时**不弹整页说明**，只出一条气泡。
         两个理由：
         1) 强平是**异步**事件，而整页模态会把交易页整个冻住 —— 玩家此刻最想看的
            恰恰是账户还剩多少、下一课该干什么，可遮罩挡着什么都点不到
            （实测：被扫爆之后按了十几下空格，面板一次都没响应）。
         2) 教程里本来就安排了「过几根 K 线被拉爆」的那几单，
            六课里弹好几张整页说明没人受得了；成绩与点评老师条上已经写着，
            完整明细照旧进「结算记录」。
         怎么认「引导手里那一单」：走模式自己的探针句柄拿引导会话，
         按**持仓 id** 认（不是「引导开着就算」—— 引导开着的时候玩家也可能自己下一单）。 */
      const guided = (() => {
        try {
          const mode = CS.classicMode;
          const session = mode && mode.probe ? (mode.probe().tutorial || {}).session : null;
          if (!session || !session.active || !session.active()) return false;
          const entry = session.entry ? session.entry() : null;
          return !!(entry && entry.id && entry.id === tr.positionId);
        } catch (_) { return false; }
      })();
      if (guided || !flag('liqNotice')) {
        CS.uiBits.toast(t('trade.liq.bubble', {
          pair: d.pairLabel(tr.instrumentId), side: sideText(tr.side), price: CS.money.formatNumber(tr.exitPrice, digits),
          pnl: d.money(tr.pnl), fee: d.money(fee)
        }), 'neg', 9000);
        return;
      }
      const m = d.accountMetrics ? d.accountMetrics() : {};
      CS.uiModal.open({
        icon: '✕', loss: true, cls: 'risk-notice risk-liquidation',
        title: t('trade.liq.title', { pair: d.pairLabel(tr.instrumentId) }),
        message: t('trade.liq.message'),
        sections: [
          { title: t('trade.liq.summary'), text: t('trade.liq.summaryText', {
            pair: d.pairLabel(tr.instrumentId), side: sideText(tr.side)
          }) },
          { title: t('trade.liq.detail'), rows: [
            /* ★ 这一节里两种口径并存，而且必须先说清楚，否则读者没法判断
               「4,041.08 USDT」是价格还是金额（逐帧试玩报的 B5）：
                 价格类（开仓价 / 平仓价）→ 合约的**计价货币**（USDT）
                 金额类（盈亏 / 手续费 / 可用余额）→ 账户的**本币**
               所以这里把单位显式写进标签，不靠读者自己猜。 */
            [t('trade.liq.entryPrice'), `${CS.money.formatNumber(tr.entryPrice, digits)} USDT`],
            [t('trade.liq.exitPrice'), `${CS.money.formatNumber(tr.exitPrice, digits)} USDT`],
            [t('trade.pnl'), d.money(tr.pnl), tr.pnl >= 0 ? 'pos' : 'neg'],
            [t('trade.fee'), d.money(tr.fee || 0)],
            [t('trade.funding'), d.money(tr.funding || 0)],
            [t('st.history.liqFee'), d.money(fee)],
            [t('trade.available'), d.money(m.cash || 0)]
          ] },
          { title: t('trade.liq.costs'), rows: [
            [t('settings.lifetime.fee'), d.money(m.feesPaid || 0)],
            [t('settings.lifetime.funding'), d.money(m.fundingPaid || 0)],
            [t('settings.lifetime.liqFee'), d.money(m.liqFeesPaid || 0)]
          ] },
          { title: t('trade.liq.note'), text: t('trade.liq.noteText') }
        ],
        confirm: t('ui.close')
      });
      if (h.onChanged) h.onChanged();
    }));

    return { dispose() { offs.forEach(off => { try { off(); } catch (_) {} }); } };
  }

  return { tradeRisk: { attach } };
});
