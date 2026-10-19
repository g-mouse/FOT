/* ============ 交易页的「意图层」（模拟模式与故事模式共用） ============
   面板里每一次点击最终都落到这里的一个函数上，而这个文件只做一件事：
   把「玩家想干什么」翻成一次端口调用 + 一句人话的反馈。
   它不碰 DOM、不读 state.cash、不自己算钱 —— 改钱只能走 ctx.account / ctx.market。

   为什么单独一层：ui/components/tradePanel.js 的硬约束是**当时的 400 行**，
   而「界面状态怎么变」（选品种、换根数、杠杆滑块）与「钱怎么动」（下单、平仓、
   撤单、借款）是两件事，混在一个文件里两边都看不清。分开之后还有一条好处：
   探针与页面内工具可以直接调这里的函数（不经按钮），行为与玩家点按钮完全一致。

   依赖是显式的（ctx / d / ui / hooks），没有隐藏的闭包：
   下单表单、图表、浮窗三处调用同一个 submit()，不可能出现两套成交口径。 */
CS.define('ui/components/tradeIntents', ["core/base/money","core/base/util","core/market/resample","lib/lodash","ui/components/bits","ui/components/modal"], function () {
  'use strict';
  /* 文案取词走共享那一份（原先是 8 个面板各写一遍同样的包装） */
  const t = CS.uiBits.t;
  const el = CS.util.el;

  /* hooks:
       render(opts)    重画面板（界面层的事）
       afterChange()   成交 / 平仓 / 撤单之后的收尾（广播 trade.changed + 通知调用方）
       refreshPreview() 只刷下单预览那几行（杠杆滑块拖动时走它，不整块重画） */
  function create(ctx, d, ui, hooks) {
    const h = hooks || {};
    const render = opts => { if (h.render) h.render(opts); };

    function selectInstrument(id) {
      if (!id || id === ui.instrumentId) return;
      ui.instrumentId = id;
      ui.limitPrice = 0;
      render({ resize: true });
    }
    function setOrderType(kind) { ui.orderType = kind === 'limit' ? 'limit' : 'market'; render(); }
    /* 一屏多少根 K 线：只影响看图，不动时间/价格/成交（与模拟模式那条口径一致）。
       它是**显示偏好**，所以改完往模式喊一声让它落盘（hooks.persist）。 */
    function setBarCount(n) {
      const next = Math.max(20, Math.min(240, Math.round(Number(n) || 120)));
      if (next === ui.bars) return;
      ui.bars = next;
      if (h.persist) h.persist('bars', next);
      render({ resize: true });
    }
    /* 图表周期（4h / 8h / 12h / 1d / 3d / 1w）。与「一屏多少根」同一个性质：
       纯看图的东西 —— 不改时间、不改价格、不影响成交与账目。
       非法 id 一律退回基础周期，而不是抛错：这个入口也可能被存档里的旧值调到。 */
    function setTimeframe(id) {
      const next = CS.resample.tfOf(id).id;
      if (next === ui.timeframe) return;
      ui.timeframe = next;
      if (h.persist) h.persist('timeframe', next);
      render({ resize: true });
    }
    function useCurrentPrice() { ui.limitPrice = d.instrument(d.currentInstrumentId()).price; render(); }
    /* MAX = **这一档杠杆下真的能开出来**的最大保证金（折成显示货币再填进框里）。
       ★ 这里原来填的是「全部可用余额」—— 而开仓还要再收一笔开仓手续费，
       于是 `保证金 + 手续费 > 可用余额` **必然**成立：点完 MAX 之后
       无论杠杆拉到多少，点「做多 / 买入」都只会得到一句「可用余额不足」。
       杠杆越高手续费越高，MAX 反而越不可能成交 —— 现场表现就是
       「杠杆调大了跟没调一样」。真正的上限由数据层算：
       `可用余额 / (1 + 杠杆 × 费率)`，再夹住 buff 给的保证金上限（d.maxMargin）。
       余额与上限都是内部单位，输入框是显示货币 → 折一次再填。 */
    function setMaxMargin() { ui.margin = Math.max(0, Number(d.maxMargin()) || 0); render(); }
    /* 杠杆滑块：拖动时每一步都调它。只刷「账户条 + 下单表单 + 预览」，
       **不重画行情列表与 K 线** —— 那两块跟杠杆无关，重画会让滑块发涩。
       ★ 顺手把保证金夹回「这一档杠杆下真的能开出来的最大值」：
       开仓手续费随杠杆上升（5× 0.04% → 100× 0.15%），所以同一个保证金在
       更高的杠杆下可能刚好超出可用余额。不夹的话，玩家按完 MAX 再把杠杆往上拉，
       下单只会得到一句「可用余额不足」—— 看上去就是「杠杆调大反而不能下单」。
       夹取只往下、且只在**确实超出**时动它，玩家填的小额保证金不受影响。 */
    function onLeverage() {
      const cap = d.maxMargin();
      if (ui.margin > cap) ui.margin = Math.max(0, cap);
      if (h.refreshPreview) h.refreshPreview();
      render({ light: true });
    }

    function rejectText(reject) {
      /* ★ circuit_breaker、partial_fill、suspended 三条映射都已删掉：
         熔断（引擎里没有分支了）、深度切碎（下单多少就成交多少）、
         停牌（成交那一层不再拒绝）—— 留着它们的映射只会让人以为引擎还会这么拒。 */
      const map = {
        insufficient_cash: 'trade.reject.insufficientCash',
        leverage_cap: 'trade.reject.leverageCap',
        instrument_blocked: 'trade.reject.blocked',
        instrument_not_allowed: 'trade.reject.notAllowed',
        /* 行情过滤：被设置隐藏的那一段（各交易对上线初期）不许下单 */
        not_listed_yet: 'trade.reject.notListed',
        no_data: 'trade.reject.noData'
      };
      if (!reject) return t('trade.rejected');
      return t(map[reject.code] || 'trade.reject.other', { why: reject.why || '', cap: reject.cap || '' });
    }

    /* 开仓（市价）。走后不放行的那一层是**开仓二次确认**：
       设置槽里 confirmOpen 开着、并且模式给了 confirm 渲染器时，先弹一张确认单，
       玩家点确认才带着 {confirmed:true} 再进来一次 —— 两条路最终落到同一段下单代码，
       所以「确认单上写的参数」与「真正下单用的参数」不可能是两套。 */
    function submit(side, opts) {
      const confirmed = !!(opts && opts.confirmed);
      const inst = d.instrument(d.currentInstrumentId());
      /* 封账之后不许再开新仓（多进程模拟玩家抓到的缺陷：结局已经触发的一局还能成交）。
         面板只是把下单按钮画灰了，而 submit() 自己没挡 —— 任何直接调它的入口
         （页面内工具、探针、以后的快捷键）都捅得进去，成交之后账目又长出一条
         属于「已经结束的那一局」的持仓。理由与「结局之后不许回信 / 不许重掷世界」同一条。 */
      if (!d.canTrade()) {
        CS.uiBits.toast(t('story.endedLocked'), 'neg', 6000);
        return;
      }
      /* 行情过滤：这一根还落在被隐藏的那一段里 → **在问之前就拒**。
         放在确认单之前（与旧引擎的 openQuote 同一位置）：先弹一张确认单、
         玩家点了确认再告诉他「这一段不可交易」，那是最难受的一种顺序。 */
      if (inst.filter && inst.filter.available === false) {
        CS.uiBits.toast(inst.filter.reason || t('trade.reject.notListed'), 'neg', 7000);
        return;
      }
      if (!(ui.margin > 0)) { CS.uiBits.toast(t('trade.marginRequired'), 'neg'); return; }
      const isLimit = ui.orderType === 'limit';
      if (isLimit && !(ui.limitPrice > 0)) { CS.uiBits.toast(t('st.order.limitNeedPrice'), 'neg'); return; }
      /* ★ **参数都过了才问**：确认单上写的必须是「真的会执行的那一笔」。
         问在前面的话，玩家会看到一张确认单、点确认、然后吃一句「限价单要先填委托价」。
         两条路（市价 / 限价）都从这里过，各自带上自己的 kind —— 确认单正文不同。 */
      if (!confirmed && h.confirm && d.settingsFlag && d.settingsFlag('confirmOpen') !== false) {
        h.confirm(side, isLimit ? 'limit' : 'market', () => submit(side, { confirmed: true }));
        return;
      }
      if (isLimit) {
        /* 真·限价委托：挂到撮合引擎的 pending 上，等 K 线走到委托价才成交
           （core/marketEngine.placeLimit / settleStep，每推进一步撮合一次）。
           早先这里是一段「本地撮合」：面板自己扫 K 线、命中就市价下单 ——
           它有个致命后果：挂单前那一屏历史也会被扫，于是任何一张买单
           一挂上就成交（过去 120 根里总有一根穿过委托价）。 */
        const placed = ctx.market.placeLimit
          ? ctx.market.placeLimit({ instrumentId: inst.id, side, margin: d.toUnits(ui.margin), leverage: ui.leverage, price: ui.limitPrice })
          : null;
        if (!placed || !placed.ok) {
          CS.uiBits.toast((placed && placed.why) || t('st.order.limitUnsupported'), 'neg', 6500);
          return;
        }
        CS.uiBits.toast(t('st.order.limitPlaced', { price: CS.money.formatNumber(ui.limitPrice, inst.digits) }), '', 5000);
        render();
        if (h.afterChange) h.afterChange();
        return;
      }
      /* 表单里填的是显示货币，引擎只认内部最小单位 —— 在这里折一次
         （见 tradeModel 的 toUnits：不折就是 10^4 倍的错账）。 */
      const fill = ctx.market.submitOrder({ instrumentId: inst.id, side, margin: d.toUnits(ui.margin), leverage: ui.leverage });
      if (!fill || !fill.ok) {
        CS.uiBits.toast(rejectText(fill && fill.rejects && fill.rejects[0]), 'neg', 7000);
      } else {
        /* 没有「只成交一部分」这一档了：深度/流动性整块删掉之后，
           submitOrder 要么拒（上面那一条）、要么全额成交。 */
        CS.uiBits.toast(t('trade.filled', { price: CS.money.formatNumber(fill.avgPrice, inst.digits) }), 'pos', 4200);
      }
      render();
      if (h.afterChange) h.afterChange();
    }

    function closePosition(id) {
      const pos = d.snapshot().positions.find(p => p.id === id);
      if (!pos) return;
      const bar = d.lastBarOf(pos.instrumentId);
      const result = ctx.closePosition ? ctx.closePosition(id, bar ? bar.c : pos.entryPrice) : { ok: false };
      if (result && result.ok === false) CS.uiBits.toast(t('trade.closeFailed'), 'neg');
      else if (result && result.trade) {
        CS.uiBits.toast(`${t('st.position.closed')} ${d.money(result.trade.pnl)}`, result.trade.pnl >= 0 ? 'pos' : 'neg', 5200);
      }
      render();
      if (h.afterChange) h.afterChange();
    }
    function closeAll() {
      const list = d.snapshot().positions.slice();
      if (!list.length) return;
      list.forEach(pos => {
        const bar = d.lastBarOf(pos.instrumentId);
        if (ctx.closePosition) ctx.closePosition(pos.id, bar ? bar.c : pos.entryPrice);
      });
      CS.uiBits.toast(t('st.position.closedAll', { n: list.length }), 'pos', 4600);
      render();
      if (h.afterChange) h.afterChange();
    }
    /* 撤单：走引擎的 cancelOrder。撤不掉（已经成交 / 已经被撮合掉）要**说出来**，
       静默失败会让玩家以为还撤掉了，而账上多出一笔他以为不存在的持仓。 */
    function cancelOrder(id) {
      const result = ctx.market.cancelOrder ? ctx.market.cancelOrder(id) : { ok: false };
      if (!result || !result.ok) CS.uiBits.toast(t('st.order.cancelFailed'), 'neg', 6000);
      else CS.uiBits.toast(t('st.order.canceled'), '', 3200);
      render();
      if (h.afterChange) h.afterChange();
    }
    /* 全部撤单：逐笔撤掉未成交的委托。**先问一句**（撤单会动钱：保证金与手续费原额退回），
       并把「一共退多少」摆在确认单上 —— 那是玩家点这颗按钮唯一想知道的事。 */
    function cancelAll() {
      const list = d.orders ? d.orders() : [];
      if (!list.length) { CS.uiBits.toast(t('st.order.none'), '', 3200); return; }
      const refund = list.reduce((sum, o) => sum + (Number(o.margin) || 0) + (Number(o.fee) || 0), 0);
      CS.uiModal.open({
        icon: '↩',
        title: t('st.order.cancelAllTitle', { n: list.length }),
        message: t('st.order.cancelAllMessage'),
        sections: [
          { title: t('st.order.cancelAllList'), rows: list.map(o => [
            `${d.pairLabel(o.instrumentId)} ${o.side === 'short' ? t('trade.short') : t('trade.long')}`,
            `${CS.money.formatNumber(o.price, d.digitsOf(o.instrumentId))} · ${d.money((o.margin || 0) + (o.fee || 0))}`
          ]) },
          { title: t('st.order.cancelAllRefund'), rows: [
            [t('st.order.frozenTotal'), d.money(refund)],
            [t('trade.available'), d.money(d.snapshot().cash + refund)]
          ] }
        ],
        confirm: t('st.order.cancelAllGo'),
        action: () => {
          list.forEach(o => { try { ctx.market.cancelOrder(o.id); } catch (_) {} });
          CS.uiBits.toast(t('st.order.canceled'), '', 3600);
          render();
          if (h.afterChange) h.afterChange();
        }
      });
    }
    /* 周转/授信：未签署时先进「面签接待」，签完立即提款；已签署后才进常规授信单。 */
    function receptionCell(label, value) {
      return el('div', { class: 'loan-reception-cell' }, [
        el('span', { text: label }),
        el('strong', { text: value })
      ]);
    }
    function openReception(loan, afterSign) {
      const max = d.fromUnits(loan.max);
      const amount = el('input', {
        type: 'number', class: 'loan-reception-input',
        min: '1', max: String(max), step: '100',
        value: String(Math.min(10000, max)),
        'aria-label': t('st.loan.drawAmount')
      });
      const body = el('div', { class: 'loan-reception' }, [
        el('div', { class: 'loan-reception-top' }, [
          el('div', {}, [
            el('span', { class: 'loan-reception-kicker', text: t('st.loan.receptionKicker') }),
            el('strong', { class: 'loan-reception-brand', text: t('st.loan.receptionBrand') })
          ]),
          el('span', { class: 'loan-reception-no', text: `${t('st.loan.protocolNo')} ${t('st.loan.protocolNoValue')}` })
        ]),
        el('p', { class: 'loan-reception-lead', text: t('st.loan.receptionLead') }),
        el('div', { class: 'loan-reception-grid' }, [
          receptionCell(t('st.loan.party'), t('st.loan.partyValue')),
          receptionCell(t('st.loan.customer'), t('st.loan.customerValue')),
          receptionCell(t('st.loan.facilityLimit'), d.money(loan.max)),
          receptionCell(t('st.loan.status'), t('st.loan.statusUnsigned')),
          receptionCell(t('st.loan.drawMethod'), t('st.loan.drawMethodValue')),
          receptionCell(t('st.loan.accrual'), t('st.loan.accrualValue')),
          receptionCell(t('st.loan.repayMethod'), t('st.loan.repayMethodValue')),
          receptionCell(t('st.loan.defaultAction'), t('st.loan.defaultValue'))
        ]),
        el('div', { class: 'loan-draw' }, [
          el('label', { class: 'loan-draw-field' }, [
            el('span', { text: t('st.loan.drawAmount') }),
            amount,
            el('em', { text: 'USDT' })
          ]),
          el('span', { class: 'loan-draw-max', text: t('st.loan.drawMax', { max: CS.money.formatNumber(max, 2) }) })
        ]),
        el('div', { class: 'loan-terms' }, [
          el('h4', { text: t('st.loan.termsTitle') }),
          el('p', { text: t('st.loan.rulesText') }),
          el('p', { class: 'loan-e-sign', text: t('st.loan.eSignNote') })
        ]),
        el('div', { class: 'loan-signature' }, [
          el('div', { class: 'loan-signature-line' }, [
            el('span', { class: 'loan-signature-label', text: t('st.loan.signLabel') }),
            el('strong', { class: 'loan-signature-name', text: t('st.loan.signName') }),
            el('em', { text: t('st.loan.signHint') })
          ]),
          el('span', { class: 'loan-seal', text: 'RC' })
        ])
      ]);
      CS.uiModal.open({
        cls: 'loan-reception-modal', icon: '§',
        title: t('st.loan.receptionTitle'),
        body,
        actions: [
          { label: t('st.loan.signCancel'), cls: '' },
          {
            label: t('st.loan.signAction'), cls: 'primary', keepOpen: true,
            onClick: () => {
              let value = Number(amount.value);
              if (!Number.isFinite(value) || value <= 0) {
                CS.uiBits.toast(t('st.loan.amountInvalid'), 'neg', 6000);
                amount.focus();
                return;
              }
              value = Math.min(max, value);
              loan.sign();
              const result = loan.borrow(d.toUnits(value));
              if (!result || !result.ok) {
                CS.uiBits.toast((result && result.why) || t('st.loan.failed'), 'neg', 6500);
                return;
              }
              CS.uiModal.close();
              CS.uiBits.toast(t('st.loan.signDone', { amount: d.money(result.debt) }), 'pos', 7000);
              render();
              if (h.afterChange) h.afterChange();
              if (afterSign) afterSign();
            }
          }
        ]
      });
    }

    /* 周转借款：两个模式各有一本账（模拟模式是 ctx.loan 的周转借款，故事模式是剧情债务）。
       这一层只画那张「借入 / 偿还」的单子，钱怎么动一律走 ctx.loan 那两个入口 ——
       面板不认识账本，账本也不认识面板。 */
    function openLoanDialog() {
      const loan = ctx.loan;
      if (!loan || !loan.totals) {
        CS.uiModal.open({
          title: t('st.loan.title'),
          body: CS.util.el('div', {}, [
            CS.util.el('p', { text: t('st.loan.body') }),
            CS.util.el('p', { class: 'tiny muted', text: t('st.loan.hint') })
          ]),
          actions: [{ label: t('ui.close'), cls: 'primary' }]
        });
        return;
      }
      /* 未签署：先接待、面签；签署动作本身立即执行首笔提款（用户口径「签了就借贷」）。
         旧存档可能只有欠款、没有 signed 字段：有未偿本息时按已签署处理，避免把还款入口挡掉。 */
      const legacyDebt = !!loan.totals && Number(loan.totals().totalRemaining) > 0;
      if (loan.signed && !loan.signed() && !legacyDebt) { openReception(loan, () => openLoanDialog()); return; }
      const digits = 2;
      const draw = () => {
        const totals = loan.totals();
        const owed = totals.totalRemaining || 0;
        const max = d.fromUnits(loan.max);
        CS.uiModal.open({
          icon: '§', cls: 'loan-sheet',
          title: t('st.loan.title'),
          message: t('st.loan.message'),
          sections: [
            { title: t('st.loan.state'), rows: [
              [t('st.loan.owed'), d.money(owed)],
              [t('st.loan.rate'), owed > 0 ? loan.rateText() : t('st.loan.rateTiers')],
              [t('st.loan.monthly'), d.money(totals.monthlyInterest || 0)],
              [t('st.loan.limit'), d.money(loan.max)],
              [t('st.loan.status'), t('st.loan.statusSigned')],
              [t('trade.available'), d.money(d.snapshot().cash)]
            ] },
            { title: t('st.loan.rules'), text: t('st.loan.rulesText') }
          ],
          input: {
            label: owed > 0 ? t('st.loan.repayLabel') : t('st.loan.borrowLabel', { max: CS.money.formatNumber(max, digits) }),
            value: owed > 0 ? d.fromUnits(owed) : Math.min(10000, max), min: 1, step: 100
          },
          confirm: t('ui.close'),
          riskActions: owed > 0
            ? {
              addLabel: t('st.loan.repay'), addDisabled: d.snapshot().cash <= 0,
              onAdd: value => {
                const result = loan.repay(d.toUnits(Number(value) || 0));
                if (!result || !result.ok) { CS.uiBits.toast((result && result.why) || t('st.loan.failed'), 'neg', 6000); return; }
                CS.uiBits.toast(t('st.loan.repaid', { amount: d.money(result.paid) }), 'pos', 6000);
                CS.uiModal.close();
                render();
                if (h.afterChange) h.afterChange();
                openLoanDialog();
              },
              /* 全额清偿：按**点击这一刻**的未偿本息结算，不受弹窗打开后
                 自动播放继续计息、输入框里是旧金额的影响；清完后这一笔授信结束，
                 重新进入面签接待（下次借款重新签署）。 */
              borrowLabel: t('st.loan.settleAll'), borrowDisabled: d.snapshot().cash <= 0,
              onBorrow: () => {
                const now = loan.totals();
                const result = loan.repay(now.totalRemaining);
                if (!result || !result.ok) { CS.uiBits.toast((result && result.why) || t('st.loan.failed'), 'neg', 6000); return; }
                CS.uiBits.toast(t('st.loan.repaid', { amount: d.money(result.paid) }), 'pos', 6000);
                CS.uiModal.close();
                render();
                if (h.afterChange) h.afterChange();
                openLoanDialog();
              }
            }
            : {
              addLabel: t('st.loan.borrow'), addDisabled: false,
              onAdd: value => {
                const result = loan.borrow(d.toUnits(Number(value) || 0));
                if (!result || !result.ok) { CS.uiBits.toast((result && result.why) || t('st.loan.failed'), 'neg', 6500); return; }
                CS.uiBits.toast(t('st.loan.borrowed', { amount: d.money(result.debt), rate: loan.rateText() }), 'pos', 6600);
                CS.uiModal.close();
                render();
                if (h.afterChange) h.afterChange();
                draw();
              }
            }
        });
      };
      draw();
    }

    return {
      selectInstrument, setOrderType, setBarCount, setTimeframe, useCurrentPrice, setMaxMargin, onLeverage,
      rejectText, submit, closePosition, closeAll, cancelOrder, cancelAll, openLoanDialog
    };
  }

  return { tradeIntents: { create } };
});
