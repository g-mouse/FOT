/* ============ 交易页的「委托与结算」面板（模拟模式与故事模式共用） ============
   与 ui/components/tradePanels.js 同一套写法：build* 返回 { root, update() }，
   root 只造一次、update() 只写文本与 class（交易页每 400ms 叫一次 update，
   整棵重建会让「正在输入的委托价」失焦）。

   拆成两个文件的理由只有一个：当时的单文件上限是 400 行。界线按主题划 ——
   这个文件是「下单与单据」（挂单 / 结算记录 / 下单表单 / 周转借款），
   另一个是「看盘」（账户条 / 行情列表 / K 线 / 持仓）。 */
CS.define('ui/components/tradeOrders', ["core/base/util","ui/components/bits","ui/components/tradePanels"], function () {
  'use strict';
  const { el, clear } = CS.util;
  const { button, muted } = CS.uiBits;
  /* 文案取词走共享那一份（原先是 8 个面板各写一遍同样的包装） */
  const t = CS.uiBits.t;
  const P = CS.tradePanels;

  /* ================= 当前挂单 ================= */
  function buildOrders(d, ui) {
    const count = el('span', { class: 'st-count', text: '0' });
    const hint = el('span', { class: 'st-quiet', text: '' });
    const notice = el('p', { class: 'st-note hidden', text: '' });
    const body = el('div', { class: 'st-rows' });
    /* 「全部撤单」只在真有挂单时可用（没有挂单时摆一颗点了没反应的按钮，比不摆更糟）。
       它必须在 root 之前建：root 的数组字面量里要用到它。 */
    const cancelAllBtn = button(t('st.order.cancelAll'), () => d.cancelAll(), '');
    const root = el('section', { class: 'st-panel st-orders-panel' }, [
      el('div', { class: 'st-panel-head row' }, [
        el('div', {}, [el('span', { class: 'st-kicker', text: t('st.kicker.orders') }),
          el('h3', {}, [el('span', { text: t('st.order.title') + ' ' }), count])]),
        el('div', { class: 'st-head-tools' }, [hint, cancelAllBtn])
      ]),
      notice, body
    ]);

    function update() {
      const list = d.orders();
      count.textContent = String(list.length);
      hint.textContent = list.length ? '' : t('st.order.none');
      cancelAllBtn.disabled = list.length === 0;
      const supported = d.orderTypes().limit;
      notice.textContent = supported ? '' : t('st.order.limitUnsupported');
      notice.classList.toggle('hidden', supported);
      clear(body);
      if (!list.length) {
        body.appendChild(el('div', { class: 'st-empty' }, [
          el('span', { class: 'st-empty-icon', text: '◇' }), el('span', { text: t('st.order.empty') })
        ]));
        return;
      }
      list.forEach(order => {
        const info = d.instrument(order.instrumentId);
        /* 「距成交」与「现价」是**此刻**的读数：挂单行每 400ms 由面板重画一次，
           所以它们跟着行情走（旧实现靠 render/live.js 逐帧改写这两格，同一个效果）。 */
        const move = order.price > 0 && info.price > 0 ? (order.price / info.price - 1) * 100 * (order.side === 'short' ? 1 : -1) : NaN;
        body.appendChild(el('div', { class: 'st-row st-order' }, [
          el('div', { class: 'st-cell st-cell-wide' }, [
            el('strong', { text: d.pairLabel(order.instrumentId) }),
            el('span', {}, [el('i', { class: `st-dir ${order.side === 'short' ? 'short' : 'long'}`, text: P.dirText(order.side) }),
              muted(`${order.leverage}×`, 'tiny')])
          ]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('st.order.price') }), el('strong', { class: 'mono', text: P.num(order.price, info.digits) })]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('st.order.live') }), el('strong', { class: 'mono', text: P.num(info.price, info.digits) })]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('st.order.distance') }),
            el('strong', { class: `mono ${Number.isFinite(move) && move < 0 ? 'pos' : ''}`.trim(),
              text: Number.isFinite(move) ? `${move >= 0 ? '+' : '−'}${Math.abs(move).toFixed(2)}%` : '—' })]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('st.order.frozen') }),
            el('strong', { class: 'mono', text: `${d.money(order.margin)} · ${order.leverage}×` })]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('st.order.liqAfterFill') }),
            el('strong', { class: 'mono', text: order.liquidationPrice > 0 ? P.num(order.liquidationPrice, info.digits) : '—' })]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('st.order.type') }), el('strong', { text: t(order.type === 'limit' ? 'st.order.limit' : 'st.order.market') })]),
          button(t('st.order.cancel'), () => d.cancelOrder(order.id), '')
        ]));
      });
      void ui;
    }
    return { root, update };
  }

  /* ================= 结算记录 ================= */
  /* 超过 10 条自动折叠（默认只露最近 10 条）；「展开全部 / 收起」是玩家自己的选择，
     展开后新记录进来不再强制折回去；回落到 10 条以内时重置成折叠态。 */
  const HISTORY_FOLD_AT = 10;
  function buildHistory(d) {
    const body = el('div', { class: 'st-rows st-history' });
    const count = el('span', { class: 'st-count', text: '0' });
    let expanded = false;
    const toggle = button('', () => { expanded = !expanded; update(); }, 'st-history-toggle');
    toggle.setAttribute('aria-expanded', 'false');
    const root = el('section', { class: 'st-panel st-history-panel' }, [
      el('div', { class: 'st-panel-head row' }, [
        el('div', {}, [el('span', { class: 'st-kicker', text: t('st.kicker.history') }),
          el('h3', {}, [el('span', { text: t('st.history.title') + ' ' }), count])]),
        el('div', { class: 'st-head-tools' }, [toggle])
      ]),
      body
    ]);
    function update() {
      const list = d.history();
      count.textContent = String(list.length);
      if (list.length <= HISTORY_FOLD_AT) expanded = false;
      const folded = list.length > HISTORY_FOLD_AT && !expanded;
      const shown = folded ? list.slice(0, HISTORY_FOLD_AT) : list;
      toggle.classList.toggle('hidden', list.length <= HISTORY_FOLD_AT);
      toggle.textContent = expanded ? t('st.history.collapse') : t('st.history.expand', { n: list.length });
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      clear(body);
      if (!list.length) {
        body.appendChild(el('div', { class: 'st-empty' }, [
          el('span', { class: 'st-empty-icon', text: '✳' }), el('span', { text: t('st.history.empty') })
        ]));
        return;
      }
      shown.forEach(trade => {
        const info = d.instrument(trade.instrumentId);
        body.appendChild(el('div', { class: 'st-row st-history-row' }, [
          el('div', { class: 'st-cell st-cell-wide' }, [
            el('strong', { text: d.pairLabel(trade.instrumentId) }),
            el('span', {}, [el('i', { class: `st-dir ${trade.side === 'short' ? 'short' : 'long'}`, text: P.dirText(trade.side) }),
              muted(t(`st.history.reason.${trade.reason}`), 'tiny')])
          ]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('trade.entry') }), el('strong', { class: 'mono', text: P.num(trade.entryPrice, info.digits) })]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('st.history.exit') }), el('strong', { class: 'mono', text: P.num(trade.exitPrice, info.digits) })]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('st.history.fee') }), el('strong', { class: 'mono', text: d.money(trade.fee || 0) })]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('trade.pnl') }),
            el('strong', { class: `mono ${trade.pnl > 0 ? 'pos' : trade.pnl < 0 ? 'neg' : 'muted'}`, text: `${trade.pnl >= 0 ? '▲ ' : '▼ '}${d.money(trade.pnl)}` })])
        ]));
      });
    }
    return { root, update };
  }

  /* ================= 下单 ================= */
  function buildOrderForm(d, ui, opts) {
    const o = opts || {};
    const readPct = () => {
      const value = Number(o.pct ? o.pct() : NaN);
      return Number.isFinite(value) ? Math.max(1, Math.min(100, Math.round(value))) : 5;
    };
    let pct = readPct();
    const pctRange = el('input', {
      type: 'range', min: '1', max: '100', step: '1', value: String(pct),
      'aria-label': t('st.order.pct'),
      onInput: event => setPct(Number(event.target.value), { apply: true, refresh: true }),
      onChange: () => savePct()
    });
    const pctValue = el('strong', { class: 'mono', text: `${pct}%` });
    const pctRow = el('div', { class: 'st-pct' }, [
      el('span', { class: 'st-pct-label', text: t('st.order.pct') }), pctRange, pctValue
    ]);
    const pair = el('strong', { text: '—' });
    const marginInput = el('input', {
      type: 'number', min: '0', step: '10', inputmode: 'decimal', 'aria-label': t('trade.margin'),
      onInput: event => {
        ui.margin = Math.max(0, Math.floor(Number(event.target.value) || 0));
        syncPctFromMargin();
        d.refreshPreview();
      },
      onChange: () => savePct()
    });
    const maxBtn = button('MAX', () => { setPct(100, { apply: false, save: true, refresh: false }); d.setMaxMargin(); }, '');
    const leverageLabel = el('strong', { class: 'mono', text: '5×' });
    const leverageRange = el('input', {
      type: 'range', min: '1', max: '100', step: '1', value: '5', 'aria-label': t('trade.leverage'),
      onInput: event => {
        ui.leverage = Math.max(1, Number(event.target.value) || 1);
        /* 仓位比例是「按可用余额的百分之几」—— 改杠杆就是改可用上限，
           保证金跟着同一比例重算，否则「记住的比例」只在拖的那一下有效。
           ★ 引导里除外：第六课讲的是「保证金没变、杠杆一调，名义仓位成倍放大」，
           这时按记住的比例重算保证金会把课上的固定保证金改掉（比如存过 25% 的玩家
           一拖杠杆，保证金从 500 变成 2,400+），课就讲错了。 */
        if (pct > 0 && !(d.tutorialOn && d.tutorialOn())) {
          ui.margin = marginFromPct(pct);
          marginInput.value = String(Math.round(ui.margin));
        }
        d.onLeverage();
      }
    });
    const ticks = el('div', { class: 'st-range-ticks' }, [1, 25, 50, 75, 100].map(n => el('span', { text: `${n}×` })));
    const capNote = el('p', { class: 'st-note', text: '' });

    const typeMarket = button(t('st.order.market'), () => d.setOrderType('market'), 'active');
    const typeLimit = button(t('st.order.limit'), () => d.setOrderType('limit'), '');
    const limitBox = el('div', { class: 'st-limit hidden' }, [
      el('label', { class: 'st-field' }, [
        el('span', { text: t('st.order.limitPrice') }),
        el('div', { class: 'st-input-shell' }, [
          el('input', {
            type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: t('st.order.limitPlaceholder'),
            onInput: event => { ui.limitPrice = Number(event.target.value) || 0; d.refreshPreview(); }
          }),
          button(t('st.order.usePrice'), () => d.useCurrentPrice(), '')
        ])
      ]),
      el('p', { class: 'st-note', text: t('st.order.limitNote') })
    ]);
    const typeRow = el('div', { class: 'st-order-type', role: 'group', 'aria-label': t('st.order.type') }, [typeMarket, typeLimit]);

    const preview = el('div', { class: 'st-preview' }, [
      ['trade.notional', 'notional'], ['trade.fee', 'fee'], ['st.order.funding', 'funding'],
      ['st.order.risk', 'risk'], ['st.order.liq', 'liq']
    ].map(([key, id]) => {
      const value = el('strong', { class: 'mono', text: '—' });
      value.dataset.preview = id;
      return el('div', { class: 'st-preview-row' }, [el('span', { text: t(key) }), value]);
    }));
    /* ★ 类名是 st-trade-btn，**不是** st-trade。
       story.css 里 `.st-trade` 是**整页的根**（display:flex; flex-direction:column），
       而买卖按钮曾经也叫 `.st-trade`（.long / .short）—— 两套规则互相命中对方：
       页面根吃到了按钮的 `font-size:.9rem; font-weight:700; display:inline-flex;
       justify-content:center; cursor:pointer; border; background`，于是整页字号被压到 13.5px、
       正文变粗、内容被居中、鼠标移上去变小手；按钮则吃到了页面的 `gap:12px; flex-direction:column`。
       两条规则都在、都不报错，只有量计算样式才看得出来。 */
    const longBtn = el('button', { type: 'button', class: 'st-trade-btn long', onClick: () => d.submit('long') },
      [el('span', { text: '↗' }), el('span', { text: t('trade.long') })]);
    const shortBtn = el('button', { type: 'button', class: 'st-trade-btn short', onClick: () => d.submit('short') },
      [el('span', { text: '↘' }), el('span', { text: t('trade.short') })]);

    const root = el('section', { class: 'st-panel st-order-panel' }, [
      el('div', { class: 'st-panel-head' }, [
        el('div', {}, [el('span', { class: 'st-kicker', text: t('st.kicker.order') }), el('h3', { text: t('st.order.new') })]),
        el('span', { class: 'st-glyph', 'aria-hidden': 'true', text: '✿' })
      ]),
      el('div', { class: 'st-order-pair' }, [el('span', { text: t('st.chart.pair') }), pair]),
      el('div', { class: 'st-fields' }, [
        el('div', { class: 'st-field st-margin-field' }, [
          el('span', { text: t('trade.margin') }),
          el('div', { class: 'st-input-shell' }, [el('span', { class: 'st-prefix', text: d.symbol() }), marginInput, maxBtn]),
          /* 仓位比例滑块：拖它 = 按可用余额自动算上面的保证金；数值记在设置槽里 */
          pctRow
        ]),
        el('div', { class: 'st-field' }, [
          el('div', { class: 'st-range-label' }, [el('label', { text: t('trade.leverage') }), leverageLabel]),
          leverageRange, ticks
        ])
      ]),
      capNote,
      typeRow, limitBox,
      preview,
      el('div', { class: 'st-trade-buttons' }, [longBtn, shortBtn]),
      el('p', { class: 'st-note', text: t('st.order.note') })
    ]);
    const limitPriceInput = limitBox.querySelector('input');
    const previewNodes = {};
    Array.from(preview.querySelectorAll('[data-preview]')).forEach(node => { previewNodes[node.dataset.preview] = node; });
    /* 引导期间这几格是固定的（限方向、固定杠杆与保证金、下单方式定成市价）：
       给它们打个标签，由 modes/classic/tutorial.js 统一置灰并配一句中性提示 ——
       **界面层不决定「什么时候锁」**，只负责让控件找得到。 */
    marginInput.dataset.tutLock = 'margin';
    maxBtn.dataset.tutLock = 'margin';
    pctRange.dataset.tutLock = 'margin';
    leverageRange.dataset.tutLock = 'leverage';
    typeMarket.dataset.tutLock = 'orderType';
    typeLimit.dataset.tutLock = 'orderType';
    limitPriceInput.dataset.tutLock = 'orderType';

    /* ---------- 仓位比例 ----------
       拖滑块 = 「用可用余额的百分之几」，保证金由它算；百分比写进设置槽（marginPct），
       下次进模拟模式/刷新页面都从这一格恢复。手动改保证金或按 MAX 会把滑块反向同步，
       这样「记住」的是玩家最后表达的那个比例，而不是一个和保证金对不上的旧数字。 */
    function maxMarginValue() {
      return Math.max(0, Number(d.maxMargin()) || 0);
    }
    function marginFromPct(value) {
      const max = maxMarginValue();
      return Math.max(0, Math.floor(max * (Math.max(1, Math.min(100, value)) / 100) * 100) / 100);
    }
    function savePct() {
      if (o.setPct) { try { o.setPct(pct); } catch (_) {} }
    }
    function setPct(value, how) {
      const h = how || {};
      pct = Math.max(1, Math.min(100, Math.round(Number(value) || 1)));
      pctRange.value = String(pct);
      pctValue.textContent = `${pct}%`;
      if (h.apply !== false) {
        ui.margin = marginFromPct(pct);
        marginInput.value = String(Math.round(ui.margin));
      }
      if (h.save) savePct();
      if (h.refresh !== false) d.refreshPreview();
    }
    function syncPctFromMargin() {
      const max = maxMarginValue();
      if (!(max > 0)) return;
      const shown = Math.max(0, Math.min(100, Math.round((ui.margin / max) * 100)));
      pct = shown;
      pctRange.value = String(Math.max(1, shown));
      pctValue.textContent = `${shown}%`;
    }
    /* 首次装配：按记住的比例把保证金算出来（引导期间不抢课上的固定保证金）。 */
    let pctApplied = false;
    if (!(d.tutorialOn && d.tutorialOn())) {
      const max = maxMarginValue();
      if (max > 0) {
        ui.margin = marginFromPct(pct);
        marginInput.value = String(Math.round(ui.margin));
        pctApplied = true;
      }
    }

    function update() {
      /* 引导里保证金是课上的固定值；退出引导后把「记住的比例」落一次，
         否则滑块写着 25%、保证金却还是引导的 500。 */
      if (!pctApplied && !(d.tutorialOn && d.tutorialOn())) {
        const max0 = maxMarginValue();
        if (max0 > 0) {
          ui.margin = marginFromPct(pct);
          marginInput.value = String(Math.round(ui.margin));
          pctApplied = true;
        }
      }
      const inst = d.instrument(ui.instrumentId);
      const limits = d.limits();
      const cap = limits.leverageCap == null ? 100 : limits.leverageCap;
      if (ui.leverage > cap) ui.leverage = cap;
      leverageRange.max = String(Math.max(1, cap));
      leverageRange.value = String(ui.leverage);
      leverageLabel.textContent = `${ui.leverage}×`;
      pair.textContent = d.pairText(inst.symbol);
      /* 正在输入的框不要被 update 覆盖（否则打字打到一半会被吃掉） */
      if (document.activeElement !== marginInput) marginInput.value = String(Math.round(ui.margin));
      /* ★ 保证金输入框的上限 = 这一档杠杆下真的能开出来的最大值
         （可用余额扣掉开仓手续费，再夹住 buff 给的保证金上限）。
         不写 max 的话，数字框的上下箭头与浏览器校验都会允许玩家填一个
         必然被拒的数 —— 「填得进去、点下去说余额不足」是最难受的一种反馈。 */
      const maxMargin = Math.max(0, Number(d.maxMargin()) || 0);
      /* maxMargin = 0 有两种可能：真的没钱，或**行情/账户还没就绪**。
         以前一律把保证金夹成 0：引导刚进来时账户还没 ready，课上预填的 500 被夹没，
         而保证金框在引导里是锁着的 —— 玩家改不了、点「做多」只得到「请先填写保证金」，
         第一课就卡死（用户 2026-10-19 报的就是这个）。
         现在只在确实有上限时才夹；0 的时候保留原值（真没钱时下单会被引擎拒，而不是先把输入清掉）。 */
      marginInput.max = maxMargin > 0 ? String(maxMargin) : '';
      if (maxMargin > 0 && ui.margin > maxMargin) {
        ui.margin = maxMargin;
        if (document.activeElement !== marginInput) marginInput.value = String(Math.round(maxMargin));
      }
      if (document.activeElement !== limitPriceInput && ui.limitPrice) limitPriceInput.value = String(ui.limitPrice);
      const supported = d.orderTypes().limit;
      /* ★ 「引导锁着」这一位也要算进来：这颗按钮每拍都被 update() 重写一次 disabled，
         而引导的锁（core/tutorial/lockControls.js）只在换课时写一次 ——
         只写 `!supported` 的话，锁完不到 400ms 就被这一行重新点亮，
         表现是「讲市价的那几课，点得动限价委托」（class 是锁自己的记号，见那里说明）。 */
      const lockedByLesson = typeLimit.classList.contains('tut-locked');
      typeLimit.disabled = !supported || lockedByLesson;
      typeLimit.classList.toggle('is-disabled', !supported || lockedByLesson);
      if (!supported && ui.orderType === 'limit') ui.orderType = 'market';
      typeMarket.classList.toggle('active', ui.orderType === 'market');
      typeLimit.classList.toggle('active', ui.orderType === 'limit');
      limitBox.classList.toggle('hidden', ui.orderType !== 'limit');
      /* 被行情过滤挡住的品种：两颗按钮一起灰掉，并在下面写清为什么 ——
         「点得动但被拒」在教程里是最让人恼火的一种反馈。 */
      const filtered = !!(inst.filter && inst.filter.available === false);
      longBtn.disabled = !d.canTrade() || filtered;
      shortBtn.disabled = !d.canTrade() || filtered;
      /* 这一行要知道的三件事：这一段行情能不能交易 / 本局杠杆上限 / 本局单笔保证金上限。
         ★ 保证金上限必须**说出来**（docs/ADD_BUFF.md §四第 3 条：藏住规则会让玩家
         以为是自己操作失误）—— 不说的话，玩家把它读成「杠杆坏了」。 */
      const capText = limits.positionCap == null
        ? ''
        : t('st.order.marginCap', { amount: d.money(limits.positionCap) });
      const notes = [];
      if (filtered) notes.push(inst.filter.reason || t('trade.reject.notListed'));
      else {
        if (cap < 100) notes.push(t('st.order.leverageCap', { cap }));
        if (capText) notes.push(capText);
      }
      capNote.textContent = notes.join(' ');
      capNote.classList.toggle('hidden', notes.length === 0);
    }

    function updatePreview(p) {
      const put = (id, text, cls) => {
        const node = previewNodes[id];
        if (!node) return;
        node.textContent = text;
        node.classList.remove('pos', 'neg', 'mixed', 'muted');
        if (cls) node.classList.add(cls);
      };
      put('notional', d.money(p.notional));
      put('fee', d.money(p.fee));
      put('funding', p.funding == null
        ? '—'
        : `${p.funding >= 0 ? '+' : ''}${(p.funding * 100).toFixed(4)}% · ${d.money(p.fundingCost)}`,
        p.funding >= 0 ? 'neg' : 'pos');
      put('risk', p.risk == null ? '—' : `${(p.risk * 100).toFixed(2)}%`, p.risk == null ? 'muted' : 'mixed');
      put('liq', p.liq == null ? '—' : P.num(p.liq, d.instrument(ui.instrumentId).digits), p.liq == null ? 'muted' : '');
    }

    return { root, update, updatePreview };
  }

  /* ================= 周转借款 ================= */
  function buildLoan(d) {
    const info = el('p', { class: 'st-note', text: '' });
    const actionBtn = button(t('st.loan.openAction'), () => d.openLoanDialog(), '');
    const root = el('section', { class: 'st-panel st-loan' }, [
      el('div', { class: 'st-panel-head' }, [
        el('div', {}, [el('span', { class: 'st-kicker', text: t('st.kicker.loan') }), el('h3', { text: t('st.loan.title') })])
      ]),
      info,
      el('div', { class: 'st-loan-actions' }, [
        actionBtn,
        el('span', { class: 'st-quiet', text: t('st.loan.hint') })
      ])
    ]);
    /* 那一行字要**跟着账本走**：没借钱时说明这块是干什么的；
       借了之后写清「欠多少、日利率多少」—— 那是玩家点开这张单子最想知道的两个数。 */
    function update() {
      const loan = d.loanState ? d.loanState() : null;
      const signed = !loan || loan.signed !== false || Number(loan.totalRemaining) > 0;
      if (loan && !signed) {
        info.textContent = t('st.loan.unsignedLine');
        info.classList.add('muted');
        actionBtn.textContent = t('st.loan.openAction');
      } else if (loan && loan.totalRemaining > 0) {
        info.textContent = t('st.loan.owedLine', {
          amount: d.money(loan.totalRemaining), rate: d.loanRate ? d.loanRate() : ''
        });
        info.classList.remove('muted');
        actionBtn.textContent = t('st.loan.manageAction');
      } else {
        info.textContent = t('st.loan.activeLine', {
          max: d.money(d.loanLimit ? d.loanLimit() : 0)
        });
        info.classList.remove('muted');
        actionBtn.textContent = t('st.loan.manageAction');
      }
    }
    return { root, update };
  }

  return { tradeOrders: { buildOrders, buildHistory, buildOrderForm, buildLoan } };
});
