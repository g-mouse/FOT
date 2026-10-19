/* ============ 交易页的「看盘」面板（模拟模式与故事模式共用） ============
   账户总览条 → 交易对行情 → K 线图 → 当前持仓。
   下单与单据在 ui/components/tradeOrders.js（同一个页签，
   拆文件只是为了守住当时「单文件 ≤ 400 行」那条上限）。

   实现是壳里的一套 DOM：没有 iframe、没有第二套 window.CS，
   全部走壳的 CSS 变量与 ui/components/bits 的公共零件，
   所以高对比主题、字号缩放、窄屏堆叠都自动成立。

   每个 build* 返回 { root, update() }：
     · root 只造一次（不重建 DOM，输入焦点与滚动位置不会丢）
     · update() 只写文本与 class —— 交易页每 400ms 会叫一次，
       整棵重建会让「输入杠杆时输入框失焦」，那是不可接受的。
   所有钱一律走 d.money()（内部单位 → 显示货币），面板不自己做换算。 */
CS.define('ui/components/tradePanels', ["core/base/money","core/base/util","core/indicators/indicatorColors","core/indicators/indicatorState","core/indicators/registry","core/market/marketData","ui/components/bits","ui/components/chartView","ui/components/tradeChart"], function () {
  'use strict';
  const { el, clear } = CS.util;
  const { button, muted } = CS.uiBits;
  /* 文案取词走共享那一份（原先是 8 个面板各写一遍同样的包装） */
  const t = CS.uiBits.t;

  const dirOf = side => (side === 'short' ? 'short' : 'long');
  const dirText = side => t(dirOf(side) === 'long' ? 'trade.long' : 'trade.short');
  const pctText = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
  const num = (v, digits) => CS.money.formatNumber(v, digits == null ? 2 : digits);
  const signedText = units => (units > 0 ? '▲ ' : units < 0 ? '▼ ' : '— ');

  /* ================= 账户总览条 ================= */
  function buildAccountStrip(d) {
    const lead = el('strong', { class: 'st-account-equity mono', text: '—' });
    const cells = [
      ['st.account.equity', 'equity'], ['st.account.cash', 'cash'],
      ['st.account.floating', 'unrealized'], ['st.account.margin', 'marginUsed'],
      ['st.account.frozen', 'frozen'], ['st.account.debt', 'debt']
    ];
    const root = el('section', { class: 'st-account', 'aria-label': t('st.account.aria') }, [
      el('div', { class: 'st-account-lead' }, [
        el('div', { class: 'st-eyebrow' }, [
          el('span', { text: t('st.account.eyebrow') })
        ]),
        el('div', { class: 'st-account-title' }, [el('span', { text: t('st.account.equityLabel') }), lead])
      ]),
      el('div', { class: 'st-metrics' }, cells.map(([labelKey, key]) => {
        const value = el('strong', { class: 'mono', text: '—' });
        value.dataset.metric = key;
        return el('div', { class: 'st-metric' }, [el('span', { text: t(labelKey) }), value]);
      }))
    ]);
    const nodes = {};
    Array.from(root.querySelectorAll('[data-metric]')).forEach(node => { nodes[node.dataset.metric] = node; });

    function update() {
      const snap = d.account.getSnapshot();
      const meta = d.accountMetrics();
      lead.textContent = d.money(snap.equity);
      const set = (key, text, cls) => {
        const node = nodes[key];
        if (!node) return;
        node.textContent = text;
        node.classList.remove('pos', 'neg', 'muted');
        if (cls) node.classList.add(cls);
      };
      set('equity', d.money(snap.equity));
      set('cash', d.money(snap.cash));
      set('unrealized', `${signedText(meta.unrealized)}${d.money(meta.unrealized)}`,
        meta.unrealized > 0 ? 'pos' : meta.unrealized < 0 ? 'neg' : 'muted');
      set('marginUsed', d.money(snap.marginUsed));
      /* 冻结保证金 = 未成交委托的（保证金 + 开仓手续费）之和：那笔钱在下单那一刻就从
         可用余额里划走了（撤单原额退回），所以要有一格把它摆出来 —— 少了它，
         「可用余额 + 已用保证金 + 冻结 + 浮盈」凑不出权益，玩家一算就以为账错了。 */
      set('frozen', d.money(d.frozenMargin ? d.frozenMargin() : 0));
      /* 欠了多少：有债务概念的模式（故事）走 debtTotals —— 那是权威口径
         （本金余额合计，不含未来利息），与状态页签同一份数；
         没有那一层的模式（模拟）显示「—」，不编造一个 0。 */
      const debt = d.debtTotals();
      set('debt', debt ? d.money(debt.totalRemaining) : '—');
    }
    return { root, update };
  }

  /* ================= 交易对行情（点一下换品种） ================= */
  function buildMarketWatch(d, ui) {
    const list = el('div', { class: 'st-pair-list', role: 'listbox', 'aria-label': t('st.market.aria') });
    const sortBar = el('div', {
      class: 'st-market-sort', role: 'group', 'aria-label': t('st.market.sortAria')
    });
    let marketSort = 'default';
    const sortButtons = {};
    [
      ['default', t('st.market.sortDefault')],
      ['gain', t('st.market.sortGain')],
      ['loss', t('st.market.sortLoss')]
    ].forEach(([mode, label]) => {
      const btn = el('button', {
        type: 'button', class: 'st-sort-btn', text: label,
        'aria-pressed': mode === marketSort ? 'true' : 'false',
        onClick: () => {
          if (marketSort === mode) return;
          marketSort = mode;
          syncSortUI();
          update();
        }
      });
      sortButtons[mode] = btn;
      sortBar.appendChild(btn);
    });
    function syncSortUI() {
      Object.keys(sortButtons).forEach(mode => {
        const on = mode === marketSort;
        sortButtons[mode].classList.toggle('active', on);
        sortButtons[mode].setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    syncSortUI();
    const root = el('section', { class: 'st-panel st-market' }, [
      el('div', { class: 'st-panel-head' }, [
        el('div', {}, [el('span', { class: 'st-kicker', text: t('st.kicker.market') }), el('h3', { text: t('st.market.title') })]),
        el('span', { class: 'st-glyph', 'aria-hidden': 'true', text: '✳' })
      ]),
      sortBar,
      list
    ]);

    /* 行的零件建一次，之后只改文本与 class。
       为什么不是每拍 clear(list) 重建：外层给了滚动条（.st-pair-list 有 max-height
       + overflow:auto），而 tradePanel 每 400ms 调一次 update()。
       整表重建的后果不是「慢」，是**玩家往下滚这个列表时每 400ms 被弹回顶部**，
       永远点不到下面那几个品种；顺带每拍丢掉一次焦点（键盘用户在列表里按不动）。
       同一个文件里 chart 的品种下拉早就用 dataset.key 指纹防住了这件事，
       这里原来漏了 —— 现在按同一套写法收口。 */
    const rowsById = {};      // instrumentId -> { node, cells }
    let shapeKey = '';        // 品种表的形状（id 序列）：变了才重建行
    let orderKey = '';        // 当前排序后的 DOM 顺序
    /* ★ 这一格（以及下面下拉的 `select.dataset.key`、图例那处的 `legend.childElementCount`）
       是**故意不换成 lib/memoize-one 的**：它们看着像「记一下上次的输入」，被缓存的东西却是
       一棵 DOM 子树（还伴着手写的逐格回写），不是「一次输入 → 一个纯结果」。三个键的住处也不同
       —— 一个在闭包变量里、一个存在 DOM 的 dataset 上、一个是节点的子元素个数 —— 也就是说
       判断基准会随着 DOM 被别处重建而变化；memoizeOne 只认「上一次调用传进来的参数」，
       把基准挪进它内部之后，键与真实 DOM 之间就多出一份可能对不上的副本（这正是它要消掉的
       那类「忘了清缓存」的 bug）。所以这里保留原样：它们是渲染的差分判断，不是数据缓存。 */

    function rowOf(inst) {
      const cells = {};
      const node = el('button', {
        type: 'button', class: 'st-pair-row',
        dataset: { instrument: inst.id, tutLock: 'pair' },
        role: 'option',
        /* 点击时才去读「当前选中的是哪个」：闭包捕获的 ui 对象是活的，
           不需要每拍重建回调（重建回调就会重建整行）。 */
        onClick: () => { if (inst.id !== ui.instrumentId) d.selectInstrument(inst.id); }
      }, [
        el('span', { class: 'st-pair-name' }, [
          /* ★ 名字**不在建行时写死**：建行只在品种表变化时发生，而「引导开着吗」会变
             （按下那颗 ⏏ 就变）。写死的话引导期间列表会把别名烤进去、退出后还留着它，
             反过来也一样。所以这里留一个引用，每拍在 update() 里按 d.instrument() 填 ——
             那一格是唯一做过显示别名的地方（见 tradeModel 的 displaySymbolOf）。 */
          cells.title = el('strong', { text: d.pairText(inst.symbol) }),
          cells.name = el('small', { text: '' })
        ]),
        cells.priceBox = el('span', { class: 'st-pair-price' }, [
          cells.price = el('strong', { class: 'mono' }),
          cells.change = el('small', { class: 'mono' })
        ]),
        cells.tags = el('span', { class: 'st-pair-tags' })
      ]);
      return { node, cells };
    }

    function update() {
      /* ★ 引导期间这一块**不再整块收起**（用户口径 2026-10-04：交易对就叫 CXP、
         **其他交易对一律不出现**）—— 名单本身已经被 tradeModel.listedInstruments 收成
         只剩它一个，所以这里剩下的是一行只读的行情读数，而不是一个可选的列表。
         原来那句 `root.classList.toggle('hidden', tutorialOn())`（整块不画）随之删掉。 */
      const list0 = d.instruments();
      const key = list0.map(i => i.id).join(',');
      if (key !== shapeKey) {
        shapeKey = key;
        orderKey = '';
        clear(list);
        Object.keys(rowsById).forEach(id => { delete rowsById[id]; });
        list0.forEach(inst => {
          const row = rowOf(inst);
          rowsById[inst.id] = row;
          list.appendChild(row.node);
        });
      }

      list0.forEach(inst => {
        const row = rowsById[inst.id];
        if (!row) return;
        const info = d.instrument(inst.id);
        const active = inst.id === ui.instrumentId;
        /* ★ 2026-10-19 用户口径：这一格的读数改成**实时现价**，跟着 K 线抖动一起走。
           原来读 dailyQuote（上一日收盘、24 小时才动一次），与图表标题的现价差一截 ——
           用户看到的是「交易对行情」和「图表」两个价。现在两处同一个来源
           （instrument().price 已经过 displayPrice 抖动层）。差分写法不变：只改文本。 */

        row.node.classList.toggle('active', active);
        row.node.setAttribute('aria-selected', active ? 'true' : 'false');
        /* 名字每拍跟着唯一的显示别名填（引导期间 BTCUSDT 显示成 CXP/USDT）——
           见行建好时那段说明：写死会跟丢开关。 */
        if (row.cells.title) row.cells.title.textContent = d.pairText(info.symbol);
        paintPrice(row, inst, info);
        paintTags(row, info);
      });

      /* 行情排序：默认 / 涨幅榜（change 降序）/ 跌幅榜（change 升序）。
         只在顺序真的变了的时候才 appendChild；行对象复用，不重建 DOM。
         引导期间名单只剩 CXP，排序没有意义，整条工具收起来。 */
      sortBar.classList.toggle('hidden', !!(d.tutorialOn && d.tutorialOn()));
      const changeOf = id => {
        const info = d.instrument(id);
        return info && Number.isFinite(Number(info.change)) ? Number(info.change) : 0;
      };
      const sorted = marketSort === 'gain'
        ? list0.slice().sort((a, b) => changeOf(b.id) - changeOf(a.id) || String(a.id).localeCompare(String(b.id)))
        : marketSort === 'loss'
          ? list0.slice().sort((a, b) => changeOf(a.id) - changeOf(b.id) || String(a.id).localeCompare(String(b.id)))
          : list0;
      const nextOrder = `${marketSort}|${sorted.map(i => i.id).join(',')}`;
      if (nextOrder !== orderKey) {
        orderKey = nextOrder;
        sorted.forEach(inst => {
          const row = rowsById[inst.id];
          if (row) list.appendChild(row.node);
        });
      }
    }

    /* 只写「现价 / 涨跌幅」两格：整块 update() 会连同标签、选中态一起写，
       而抖动那条轻量路（render({light:true})）只需要让现价跟着走。 */
    function paintPrice(row, inst, info) {
      const listed = !(info.filter && info.filter.listed === false);
      const shownPrice = info.price;
      const shownChange = info.change;
      const cls = shownChange > 0 ? 'pos' : shownChange < 0 ? 'neg' : '';
      row.cells.price.textContent = listed ? num(shownPrice, inst.digits) : t('st.market.unlisted');
      row.cells.price.className = `mono ${listed ? cls : 'muted'}`.trim();
      row.cells.price.title = listed ? t('st.market.liveHint') : (info.filter && info.filter.reason) || t('st.market.unlistedHint');
      row.cells.change.textContent = listed ? pctText(shownChange) : '—';
      row.cells.change.className = `mono ${listed ? (cls || 'muted') : 'muted'}`;
    }

    /* 抖动期间只刷价格（12fps）：行情列表不重建，滚动位置与焦点都不受影响。 */
    function updateQuote() {
      d.instruments().forEach(inst => {
        const row = rowsById[inst.id];
        if (row) paintPrice(row, inst, d.instrument(inst.id));
      });
    }

    function paintTags(row, info) {
        const listed = !(info.filter && info.filter.listed === false);

        /* 标签位：持仓 / 未上市 / 被过滤，三种互斥，每次按当前状态重写。
           这一格的内容变化远低于价格，但重写文本的成本可以忽略，换来的是不丢滚动位置。 */
        let tagText = '';
        let tagCls = 'st-halt';
        let tagTitle = '';
        if (!listed) {
          tagText = t('st.market.unlisted');
          tagTitle = (info.filter && info.filter.reason) || t('st.market.unlistedHint');
        } else if (info.filter && info.filter.available === false) {
          tagText = t('st.market.filtered');
          tagTitle = (info.filter && info.filter.reason) || '';
        } else if (info.position) {
          tagText = t('st.market.holding');
          tagCls = `st-dir ${dirOf(info.position.side)}`;
        }
        const tagNode = row.cells.tags.firstChild;
        if (!tagText) {
          if (tagNode) clear(row.cells.tags);
        } else if (!tagNode) {
          row.cells.tags.appendChild(el('i', { class: tagCls, text: tagText, title: tagTitle }));
        } else {
          tagNode.className = tagCls;
          tagNode.textContent = tagText;
          tagNode.title = tagTitle;
        }
    }
    return { root, update, updateQuote };
  }

  /* ================= K 线图 ================= */
  function buildChart(d, ui) {
    const title = el('h3', { text: '—' });
    const name = el('div', { class: 'st-pair-sub', text: '' });
    const price = el('strong', { class: 'st-quote mono', text: '—' });
    const change = el('span', { class: 'st-change mono', text: '' });
    const spread = el('span', { class: 'mono', text: '' });
    const clock = el('span', { class: 'st-clock mono', text: '' });
    const canvasHost = el('div', { class: 'st-chart-host' });
    const legend = el('div', { class: 'st-legend' });
    const select = el('select', { 'aria-label': t('st.chart.pair'), onChange: event => d.selectInstrument(event.target.value) });

    const ranges = el('div', { class: 'st-ranges' }, [60, 120, 240].map(n => button(
      String(n), () => d.setBarCount(n), ui.bars === n ? 'primary' : ''
    )));
    /* 周期选择器：一档周期 = 一根 K 线代表多久。只影响看图，不动时间与价格。
       周期表来自 CS.resample，所以加一档周期不用改这一层。 */
    /* 副图宿主：主图下面单独一块。它是 root 的零件，所以**必须先于 root 建** ——
       放到 root 之后会撞上 TDZ（Cannot access 'paneHost' before initialization），
       而那一句是被 try/catch 包着的，表现是「整个交易页挂不上」。 */
    const paneHost = el('div', { class: 'st-pane-host' });
    const tfBar = CS.tradeTimeframe.mount(null, {
      current: ui.timeframe,
      onPick: id => d.setTimeframe(id)
    });
    /* ★ 引导期间**这一整行不画**（产品口径 2026-10-04：引导要看起来就是在主游戏里）：
       交易对下拉、周期胶囊、右上角那句「120 根 4h · 日期」一起收起来 ——
       屏幕上只留标题里的那个交易对名。
       ★ 为什么是「每次重画时切 hidden」而不是「建的时候不建」：
       引导是按那颗 ⏏ 进出的，而这块面板只挂一次、之后靠 update() 重画；
       建的时候判一次的话，玩家按了 ⏏ 之后控件**不会回来**（得刷新页面）。
       切 class 的成本可以忽略，而它天然跟着开关走。 */
    const controls = el('div', { class: 'st-chart-controls' }, [
      el('label', { class: 'st-select' }, [el('span', { text: t('st.chart.pair') }), select]),
      tfBar.root,
      ranges,
      el('div', { class: 'st-chart-meta' }, [
        el('span', {}, [muted(t('trade.spread') + ' '), spread]),
        clock
      ])
    ]);
    const root = el('section', { class: 'st-panel st-chart-panel' }, [
      el('div', { class: 'st-chart-top' }, [
        el('div', {}, [el('span', { class: 'st-kicker', text: t('st.kicker.chart') }), title, name]),
        el('div', { class: 'st-quote-block' }, [price, change])
      ]),
      controls,
      canvasHost, paneHost, legend
    ]);

    const chart = CS.tradeChart.mount(canvasHost, { height: 320, maxBars: 260 });
    chart.setPaneHost(paneHost);
    /* 一屏根数的按钮要能反映当前选择：换根数时重画整块（数量少，成本可忽略） */
    function paintRanges() {
      Array.from(ranges.children).forEach((node, i) => {
        const n = [60, 120, 240][i];
        node.classList.toggle('primary', n === ui.bars);
      });
    }

    /* ★ 图表这一屏的 K 线：周期 + 根数走**唯一**那个口径（ui/components/chartView.js）——
       指标算叠加线时读的是同一批，否则切到 8h 之后蜡烛是 8h 的、指标还在 4h 上算，
       图上那根 K 线与指标准不到一起，而且不报错。 */
    function visibleBars() {
      const view = CS.chartView.viewFor({
        barsOf: d.barsOf, id: ui.instrumentId, want: ui.bars, tfId: ui.timeframe,
        version: CS.marketData.nowIndex
      });
      /* 指标暖机也要按当前周期算：这里算出来交给 tradePanel 注入的指标源用，
         免得两处各算一遍「暖机要多少根」 */
      view.warmup = CS.indicators.warmupBars();
      return view;
    }

    let lastRangeKey = '';
    function update() {
      const inst = d.instrument(ui.instrumentId);
      const view = visibleBars();
      const bars = view.bars;
      /* 换品种 / 换周期时纵轴范围直接归位，别让新老价格之间的缓动拖成一段动画。 */
      const rangeKey = `${inst.id}|${ui.timeframe}`;
      if (rangeKey !== lastRangeKey) {
        lastRangeKey = rangeKey;
        if (chart.resetRange) chart.resetRange();
      }
      chart.setDigits(inst.digits);
      chart.setBars(bars);
      /* ★ 现价线与「预估强平·现价」是**现价的函数**，图表每帧画之前会带上一帧的现价来问
         一次（第二个参数）—— 只在每 400ms 这一拍重算的话，K 线每帧在跳、那两条线在后面追。 */
      chart.setLines(d.priceLines(), spot => d.priceLines(spot));
      tfBar.set(ui.timeframe);
      /* 引导期间把 K 线那一行控件收起来（见 buildChart 里那段说明） */
      controls.classList.toggle('hidden', !!(d.tutorialOn && d.tutorialOn()));
      title.textContent = d.pairText(inst.symbol);
      name.textContent = '';
      price.textContent = num(inst.price, inst.digits);
      price.classList.remove('pos', 'neg');
      if (inst.change > 0) price.classList.add('pos');
      if (inst.change < 0) price.classList.add('neg');
      change.textContent = pctText(inst.change);
      change.classList.remove('pos', 'neg', 'muted');
      change.classList.add(inst.change > 0 ? 'pos' : inst.change < 0 ? 'neg' : 'muted');
      spread.textContent = num(inst.spread, inst.digits);
      /* 右上角那行读数要写**当前周期**，否则切到 1D 之后还写着「120 根 4h」——
         玩家会以为没切成功 */
      clock.textContent = t('st.chart.barsTf', { n: bars.length, tf: view.tf.short, at: d.clockLabel() })
        || t('st.chart.bars', { n: bars.length, at: d.clockLabel() }) || t('st.chart.loading');
      /* 品种下拉：选项只在品种表变化时重建，避免每 400ms 打断展开中的下拉 */
      const key = d.instruments().map(i => i.id).join(',');
      if (select.dataset.key !== key) {
        select.dataset.key = key;
        clear(select);
        d.instruments().forEach(i => select.appendChild(el('option', { value: i.id, text: `${d.pairText(i.symbol)}` })));
      }
      if (select.value !== ui.instrumentId) select.value = ui.instrumentId;
      paintRanges();
      /* 图例：图上有哪几条线就列哪几条（与模拟模式的「价格线」一个意思）。
         这里也是每 400ms 跑一次：只在**线的条数**变了时重建，
         条数不变就只回写文本 —— 原来的 clear + 重建会让图例里的读数每拍闪一次。 */
      const lines = d.priceLines();
      if (legend.childElementCount !== lines.length) {
        clear(legend);
        lines.forEach(line => legend.appendChild(el('span', { class: 'st-legend-item' }, [
          el('i', { class: 'st-swatch', style: `background:${line.color}` }),
          el('span', { text: `${line.label} ${num(line.value, inst.digits)}` })
        ])));
      } else {
        lines.forEach((line, i) => {
          const node = legend.children[i];
          const swatch = node.firstChild;
          const label = node.lastChild;
          /* 颜色与标签是作者给的，值会变 —— 只回写会变的那一格 */
          if (swatch.getAttribute('style') !== `background:${line.color}`) swatch.setAttribute('style', `background:${line.color}`);
          const text = `${line.label} ${num(line.value, inst.digits)}`;
          if (label.textContent !== text) label.textContent = text;
        });
      }
    }
    /* ★ 必须把内层图表的 dispose 转发出去。
       tradePanel.dispose() 收尾时调的是 `charts.forEach(c => c.dispose())`，
       而这里以前只回了 { root, update, chart, resize } —— `c.dispose` 是 undefined，
       那一句抛 TypeError 又被外层的 try/catch 吞掉，于是 tradeChart.dispose() 成了
       **谁也够不到的死代码**：window 上的 resize 监听、ResizeObserver、抖动帧订阅
       在每次切模式/切页签后都留在原地（切一次漏一张图，窗口一缩放就挨个重画）。 */
    return { root, update, chart, resize: () => chart.resize(), dispose: () => chart.dispose() };
  }

  /* ================= 当前持仓 ================= */
  function buildPositions(d) {
    const count = el('span', { class: 'st-count', text: '0' });
    const hint = el('span', { class: 'st-quiet', text: '' });
    const closeAll = button(t('st.position.closeAll'), () => d.closeAll(), '');
    const body = el('div', { class: 'st-rows' });
    const root = el('section', { class: 'st-panel st-positions-panel' }, [
      el('div', { class: 'st-panel-head row' }, [
        el('div', {}, [el('span', { class: 'st-kicker', text: t('st.kicker.positions') }),
          el('h3', {}, [el('span', { text: t('st.position.title') + ' ' }), count])]),
        el('div', { class: 'st-head-tools' }, [hint, closeAll])
      ]),
      body
    ]);

    function update() {
      const list = d.positions();
      count.textContent = String(list.length);
      hint.textContent = list.length ? t('st.position.risk', { pct: (d.marginRatio() * 100).toFixed(1) }) : t('st.position.none');
      closeAll.disabled = list.length === 0;
      clear(body);
      if (!list.length) {
        body.appendChild(el('div', { class: 'st-empty' }, [
          el('span', { class: 'st-empty-icon', text: '✳' }), el('span', { text: t('trade.noPositions') })
        ]));
        return;
      }
      list.forEach(pos => {
        const info = d.instrument(pos.instrumentId);
        const pnlClass = pos.unrealized > 0 ? 'pos' : pos.unrealized < 0 ? 'neg' : 'muted';
        const roe = pos.margin ? pos.unrealized / pos.margin : 0;
        body.appendChild(el('div', { class: 'st-row st-position' }, [
          el('div', { class: 'st-cell st-cell-wide' }, [
            el('strong', { text: d.pairLabel(pos.instrumentId) }),
            el('span', {}, [el('i', { class: `st-dir ${dirOf(pos.side)}`, text: dirText(pos.side) }),
              muted(`${pos.leverage}×`, 'tiny')])
          ]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('st.position.margin') }), el('strong', { class: 'mono', text: d.money(pos.margin) })]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('trade.entry') }), el('strong', { class: 'mono', text: num(pos.entryPrice, info.digits) })]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('st.position.mark') }), el('strong', { class: 'mono', text: num(info.price, info.digits) })]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('st.position.liq') }), el('strong', { class: 'mono mixed', text: num(pos.liquidationPrice, info.digits) })]),
          el('div', { class: 'st-cell' }, [el('small', { text: t('trade.pnl') }),
            el('strong', { class: `mono ${pnlClass}`, text: `${signedText(pos.unrealized)}${d.money(pos.unrealized)} · ${pctText(roe)}` })]),
          button(t('trade.close'), () => d.closePosition(pos.id), '')
        ]));
      });
    }
    return { root, update };
  }

  return {
    tradePanels: { buildAccountStrip, buildMarketWatch, buildChart, buildPositions, dirText, pctText, num }
  };
});
