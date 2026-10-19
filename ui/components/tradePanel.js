/* ============ 交易页（模拟模式与故事模式共用的同一张） ============
   两个模式的交易页必须是**同一个东西**（同一份代码、同一套读数、同一批术语），
   否则玩家在两边看到的是两套行情、两套账户、两套术语，读不对账。
   此页拆成几块：装配与节拍是本文件；数据换算 → tradeModel.js（零 DOM）；
   意图 → tradeIntents.js（不碰 DOM）；各块界面 → tradePanels.js + tradeOrders.js；
   K 线 → tradeChart.js（动画零件的接线在 tradeAnim.js / tradeChartAnim.js）。
   ★ 2026-10-19：交易悬浮窗整块删掉（用户口径），页面永远用紧凑摆法 —— 见下面 root 的 class。

   ★ 模式差异**一律走 ctx 上的可选钩子**（ctx.state / playback / keyHints /
     displayPrice / ticks / grow / pulse / loan === false / market.placeLimit），
     本文件里不许出现 `if (mode === 'story')` 或者直接摸 CS.storyKeys / CS.storyAnim。

   硬约束（与旧实现一致，不许破）：钱只走 ctx.account / ctx.market（面板拿不到也不许改
   state.cash）；表单填的是**显示货币**，进引擎前用 d.toUnits() 折成内部最小单位；
   行情只走 ports.market（未来数据守卫仍生效）；页签切走时 dispose() 必须清干净。 */
CS.define('ui/components/tradePanel', ["core/base/money","core/base/util","core/events/events","core/market/marketData","core/market/resample","lib/lodash","lib/memoize-one","ui/components/bits","ui/components/tradeAnim","ui/components/tradeChrome","ui/components/tradeHooks","ui/components/tradeIndicatorSource","ui/components/tradeIndicators","ui/components/tradeIntents","ui/components/tradeModel","ui/components/tradeOrders","ui/components/tradePanels"], function () {
  'use strict';
  const { el, clear } = CS.util;
  /* 文案取词走共享那一份（原先是 8 个面板各写一遍同样的包装） */
  const t = CS.uiBits.t;
  const TICK_MS = 400;
  /* 结算记录最多取最近 50 条：默认只露 10 条，超过就折叠（见 tradeOrders.buildHistory）。
     原来只取 12 条，展开也看不到多少，折叠就没有意义。 */
  const HISTORY_LIMIT = 50;
  function mount(ctx, host, options) {
    const o = options || {};
    const charts = [];
    const listeners = [];
    let timer = null;
    let disposed = false;

    /* 自动播放与键位提示由模式注入（见文件头）。两者都缺时面板照常工作：没有 playBtn，
       工具栏那一行提示是空的。ui 是**界面状态**：当前品种、一屏根数、表单输入。 */
    const playback = ctx.playback || null;
    const keyHintsText = () => { try { return ctx.keyHints ? String(ctx.keyHints() || '') : ''; } catch (_) { return ''; } };
    const ui = {
      instrumentId: null, bars: 120, margin: 0, leverage: 5, orderType: 'market', limitPrice: 0,
      /* 图表周期：一根 K 线代表多久。纯看图的东西 —— 不改时间、不改价格、不影响成交。 */
      timeframe: CS.resample.DEFAULT_TF
    };
    const d = CS.tradeModel.create(ctx, ui);
    const P = CS.tradePanels;
    const O = CS.tradeOrders;

    /* ---------------- 意图 ----------------
       每一下点击都落到 tradeIntents 里的一个函数上（那个文件不碰 DOM、不自己算钱）。
       这里只把「怎么重画」「改完之后通知谁」这两件事作为钩子递过去。
       ★ 钩子里引用到的 render / afterChange / form 都在下面才定义 —— 函数声明会提升、
       form 点下去时早建好了，不会踩 TDZ。改这段时留意这一点。
       开仓二次确认与追保/强平说明（都是「面板之外的界面」）在 tradeHooks 里装配，
       它的退订跟着面板的生命周期走 —— 退不干净就会切一次模式多一条订阅。 */
    const H = CS.tradeHooks.attach(d, ctx, ui, { afterChange: () => afterChange() });
    const I = CS.tradeIntents.create(ctx, d, ui, {
      render: opts => render(opts),
      confirm: H.confirmOpen,
      afterChange: () => afterChange(),
      refreshPreview: () => form.updatePreview(d.preview()),
      /* 一屏根数与图表周期是**显示偏好**：面板不存，改了就往模式喊一声让它落盘 */
      persist: (key, value) => { if (o.persist) o.persist(key, value); }
    });
    const {
      selectInstrument, setOrderType, setBarCount, setTimeframe, useCurrentPrice, setMaxMargin, onLeverage,
      submit, closePosition, closeAll, cancelOrder, cancelAll, openLoanDialog
    } = I;

    /* 一次「成交 / 平仓 / 撤单」之后要发生的事，**按层次说**：
         1) 广播 trade.changed —— 模式自己订阅（故事模式重算 buff、记分、去抖落盘；
            模拟模式去抖落盘）。面板不认识任何一个模式，也不认识 save。
         2) 通知局部调用方 o.onChanged（页签层可以拿来重排布局）。
       旧实现是直接调 ctx.story.act('reload')，等于让面板反向依赖模式层的内部动作名。 */
    function afterChange() {
      if (o.onChanged) { try { o.onChanged(); } catch (_) {} }
      try { CS.events.bus.emit('trade.changed', {}); } catch (_) {}
    }

    /* 面板要的那张契约：数据层 + 上面这些意图 */
    const api = Object.assign({}, d, {
      positions: () => d.snapshot().positions,
      /* 当前挂单 = 撮合引擎里还没成交的那几笔（不是面板自己记的）。
         归一成界面要的形状：引擎那一条是 {id, order:{…}, placedAt, status}。 */
      orders: () => {
        const raw = ctx.market.listOrders ? (ctx.market.listOrders() || []) : [];
        return raw.map(item => {
          const o = item.order || item;
          return {
            id: item.id || o.id, instrumentId: o.instrumentId, side: o.side, leverage: o.leverage,
            price: o.price, margin: o.margin, type: 'limit',
            /* 挂单那一刻就算好的两个读数（挂单行要显示）：
               冻结额 = 保证金 + 开仓手续费（撤单时原额退回），成交后强平价 = 按委托价与那一刻的杠杆算。
               它们**必须来自委托自己**（不是面板此刻的表单）——
               玩家挂完单可以接着改杠杆与保证金，拿当下的读数去算会与那一笔对不上。 */
            fee: Number(o.fee) || 0,
            notional: Number(o.notional) || 0,
            liquidationPrice: Number(o.liquidationPrice) || 0,
            placedAt: item.placedAt || null
          };
        }).reverse();
      },
      history: () => (ctx.account.closedTrades || []).slice(-HISTORY_LIMIT).reverse(),
      /* 限价委托能不能用，判据是**引擎有没有接上 placeLimit** —— 不是写死的开关。
         引擎接上了，这颗按钮自己就亮；哪天端口没了，它会自己变灰并说明原因。 */
      orderTypes: () => ({ market: true, limit: typeof ctx.market.placeLimit === 'function' }),
      marginRatio: d.marginRatio,
      canTrade: d.canTrade,
      clockLabel: d.clockLabel,
      selectInstrument, setOrderType, setBarCount, setTimeframe, useCurrentPrice, setMaxMargin, onLeverage,
      submit, closePosition, closeAll, cancelOrder, openLoanDialog,
      render, refreshPreview: () => form.updatePreview(d.preview()),
      /* 界面状态只读透出（按键层要问「现在看的是哪个交易对」、自动播放要问间隔）：
         它是一个活对象，读到的永远是最新值；写它仍然只能走上面那几个意图函数。 */
      ui: () => ui,
      /* 抖动那一层（可选，由模式注入 ctx.ticks）：图表按它逐帧重画最新一根。
         模式不给（没有抖动）时这里是 null：图表不接驱动，静止成本为 0。 */
      ticks: ctx.ticks || null
    });

    /* ---------------- 装配 ---------------- */
    const strip = P.buildAccountStrip(api);
    const market = P.buildMarketWatch(api, ui);
    const chart = P.buildChart(api, ui);
    const positions = P.buildPositions(api);
    const orders = O.buildOrders(api, ui);
    const history = O.buildHistory(api);
    const form = O.buildOrderForm(api, ui, {
      pct: () => api.settingsFlag('marginPct'),
      setPct: value => { if (o.persist) o.persist('marginPct', value); }
    });
    /* 「周转借款」是故事模式的债务入口（剧情债务唯一能借的地方），
       模拟模式没有那一层：ctx.loan === false 时整块不画。 */
    const loan = ctx.loan === false ? null : O.buildLoan(api);
    charts.push(chart);
    /* 三件动画零件（抖动 / 生长 / 波纹）的接线在 ui/components/tradeAnim.js ——
       两个契约之间的翻译，不是装配层的事。★ 抖动期间读数也要跟着走（现价那一行在
       chart.update() 里）；`o.onTick` 是模式搭这趟车的钩子（模拟模式：抖动扫到强平线就强平）。 */
    CS.tradeAnim.attach(ctx, chart.chart, () => ui.instrumentId, listeners);
    listeners.push(CS.tradeAnim.mountReadouts(api.ticks, r => render(r), () => disposed, o.onTick));
    /* 价格线的命中与拖动也接上（模式给 ctx.priceLine 才接；不给就只剩静态的线） */
    CS.tradeAnim.attachLines(ctx, chart.chart);

    /* ---------- 页签与工具栏：在 ui/components/tradeChrome.js ----------
       它们只管自己的状态与外观（不碰钱、不碰委托），只往外喊一声，所以单独一层。 */
    const ws = CS.tradeChrome.buildWorkspace({ initial: 'positions', layout: o.workspace });
    ws.panels.positions.appendChild(positions.root);
    ws.panels.orders.appendChild(orders.root);
    ws.panels.history.appendChild(history.root);
    const wsBar = ws.bar;
    const wsBody = ws.body;

    /* 工具栏只剩键位提示；前进 / 自动播放搬进右下角的悬浮控制条（2026-10-19 用户口径） */
    const chrome = CS.tradeChrome.buildToolbar({ keyHints: keyHintsText });
    const { syncKeyHints } = chrome;
    /* 悬浮控制条挂 document.body（见 tradeChrome.buildDock 的说明）。
       挂之前先把上一张（如果 dispose 没跑到）收掉，免得切模式后叠出两条。 */
    Array.from(document.querySelectorAll('.st-dock')).forEach(node => { try { node.remove(); } catch (_) {} });
    const dock = CS.tradeChrome.buildDock({ playback });
    if (dock) document.body.appendChild(dock.root);

    /* ---------------- 指标：状态归属 + 这一帧的数据源 ----------------
       引擎本身零依赖（不认识任何模式），它要一个「背包」才读得到状态。
       背包按模式给：
         故事模式 ctx.state()  → 这一局的 state（指标设置跟着剧情存档走）
         模拟模式             → 模式自己那一格（modes/classic/replay.js 落盘）
       绑定都走 uiTradeIndicators.attach()：两个模式各写一遍很容易漂移，
       而漂移的表现是「指标设置不跟着存档走」—— 不报错，只是刷新一次就没了。
       ★ 绑定失败不该让交易页挂不上：指标栏退化成「点了不生效」，账目与下单照常。 */
    let indicatorBag = null;
    try {
      indicatorBag = CS.uiTradeIndicators.attach({
        state: () => {
          const s = ctx.state ? ctx.state() : null;
          if (s && typeof s === 'object') return s;                            // 故事：这一局的 state
          return (CS.classicReplay && CS.classicReplay.indicatorBag) || null;  // 模拟：回放存档那一格
        }
      });
    } catch (error) {
      CS.errors.push({ message: `指标状态没绑上（指标栏会点不动，其余照常）：${error && error.message}` });
    }
    /* 图表要的「这一帧算出来的指标」：它只管问，不管怎么算 ——
       图表不认识 CS.indicators，也不认识行情是从哪来的。
       ★ 周期与根数走 chartView 那**唯一**一个口径（与蜡烛同一批数据），
       否则切到 8h 之后蜡烛是 8h 的、指标还在 4h 上算 —— 不报错，只是线对不上。
       ★ 字段名转换在 chartView.indicatorInput 里做（行情 {o,h,l,c} → 引擎 {open,high,low,close}）。 */
    const indicatorSource = CS.tradeIndicatorSource.build(d, ui, indicatorBag);
    /* ★ 建出来必须**交给图表**，否则指标栏能开、设置也进存档，图上却永远没有线 ——
       现场（逐帧试玩）：chart.setIndicators() 有定义、有导出，但**零调用点**：
       这个 source 被造出来之后就没人接过它，indicatorLayer 一直是 null，
       于是 chartIndicatorLayer.indicatorFrame(null, bars) 每次都返回空，
       主图叠加线与副图都不画。开关有反应、存档也写得进去，只有画面上什么都没有。
       source 为 null（这一局没有指标引擎）时也要调一次，把图层清干净。 */
    if (chart.chart && typeof chart.chart.setIndicators === 'function') {
      chart.chart.setIndicators(indicatorSource);
    }
    /* 指标栏：与图并排一列（教程页也是这么摆的）。
       绑不上就整块不画 —— 画一栏点不动的开关比不画更糟。 */
    const indicatorRail = indicatorBag
      ? CS.uiTradeIndicators.mount(api, el('div', { class: 'st-ind-host' }), {
        onChange: () => {
          /* 改完指标立刻重画 + 让模式落盘（设置也是「玩家做过的事」） */
          if (chart.chart) chart.chart.redraw();
          afterChange();
        }
      })
      : null;

    const root = el('div', { class: 'st-trade compact' }, [
      chrome.root,
      strip.root,
      el('div', { class: 'st-workspace' }, [
        el('div', { class: 'st-col st-col-left' }, [market.root]),
        /* 中间栏：图上那块 + 右侧指标栏并排（教程页也是这么摆的） */
        el('div', { class: 'st-col st-col-center' }, [
          el('div', { class: 'st-chart-row' }, [
            chart.root,
            indicatorRail ? indicatorRail.root : null
          ]),
          wsBar, wsBody
        ]),
        el('div', { class: 'st-col st-col-right' }, [form.root, loan ? loan.root : null])
      ])
    ]);
    host.appendChild(root);

    /* 交易悬浮窗整块删掉（2026-10-19 用户口径）：持仓 / 挂单 / 结算记录已经在
       页面下半部分按三张卡片堆着，再来一扇浮窗既重复又挡按钮。
       连带删掉工具栏那颗「浮窗」与设置面板里的「显示交易悬浮窗」。 */

    /* ---------------- 渲染 ----------------
       变化指纹：只读几个廉价字段。推进时间会改行情游标（nowIndex）；
       回信花钱会改 cash；开平仓会改持仓数；换月会改 monthIndex。
       指纹没变 → 这一拍什么都不做（空转成本 ≈ 0）。
       ★ 行情游标这一项**两个模式都必须有**：模拟模式没有剧情状态，
         早期这里第一行就是 `if (!s) return 'nostate'`，于是模拟模式推着时间走、
         面板却永远不重画（界面像死了一样，只有手动切页签才动一下）。 */
    /* 指纹闸门改用 lib/memoize-one（原来是一个 `let lastFingerprint` 加两句比较/赋值）：memoizeOne 只在参数
       与上次不 === 相等时才进函数体 —— 「同一份指纹只重画一次」于是就是「同一把指纹不会再进这个函数」。
       指纹是字符串，逐参 === 即逐字比较，与手写版的 `next === lastFingerprint` 一致，也都只记最后一次；
       差别只在抛异常：手写版先记指纹再重画（重画炸了同指纹也不再重画），memoizeOne 只在正常返回后提交缓存，会再试一次。 */
    const renderOnFingerprintChange = memoizeOne(() => render());
    function fingerprint() {
      const s = d.modeState();
      const meta = d.metrics();
      const snap = d.snapshot();
      const cursor = (CS.marketData && CS.marketData.ready) ? CS.marketData.nowIndex : 0;
      /* ★ 下单方式与委托价也要在指纹里：它们决定图上画不画**预览线**与
         「预估强平·委托价」那两条线。少了这两项，切到限价模式之后图上的线
         要等下一次别的变化才刷新 —— 表现是「点了限价，委托价那条线不出现」，
         而按钮的高亮、面板那一行都是对的（它们走 render 的另一条路）。
         实测踩过：探针里切到限价、按预期读到 5 条线，强制重画一帧才多出预览线。 */
      return [cursor, s ? s.dayIndex : '', s ? s.monthIndex : '', s && s.ended ? 1 : 0,
        snap.cash, snap.positions.length, api.orders().length,
        Math.round(meta.unrealized || 0), ui.instrumentId, ui.orderType, ui.limitPrice].join('|');
    }
    function render(opts0) {
      if (disposed) return;
      const opts = opts0 || {};
      const list = d.instruments();
      if (!list.length) {
        /* 行情包没就绪：画一条提示，**只画一次**（带 dataset 当记号），
           否则每 400ms 一拍就 clear(host) 重建一次 DOM */
        if (host.dataset.empty !== '1') {
          host.dataset.empty = '1';
          clear(host);
          host.appendChild(el('p', { class: 'muted small', text: t('trade.noData') }));
        }
        return;
      }
      if (host.dataset.empty === '1') { delete host.dataset.empty; host.innerHTML = ''; host.appendChild(root); }
      if (!ui.instrumentId || !list.some(x => x.id === ui.instrumentId)) {
        const prefer = ctx.instrumentId && ctx.instrumentId();
        ui.instrumentId = list.some(x => x.id === prefer) ? prefer : list[0].id;
      }
      strip.update();
      form.update();
      form.updatePreview(d.preview());
      /* ★ 图表的读数**两条路都要更新**：现价那一行、涨跌幅、点差、右上角「n 根 · 时间」
         都在 chart.update() 里，而它原来只在下面那条（非 light）路上 ——
         于是抖动的那一秒多里读数**是冻住的**：画布每帧在跳，右上角的数字一动不动，
         直到落定那一拍才跳到收盘价（实测：真时间推一根，墨迹变了 9 次、读数只变 2 次）。
         chart.update() 只写几个文本节点（K 线与指标由图表自己按帧重画），
         放在 light 路上不会打断行情列表里正在展开的下拉。 */
      chart.update();
      /* 悬浮条的「前进」在动画期间置灰：忙碌状态每拍都会变，跟着 render 刷一次最省事 */
      if (dock) dock.syncStepBtn();
      /* 抖动那条轻量路只带「现价」：行情列表不重建，但价格要跟着 K 线跳
         （2026-10-19 用户口径：列表现价 = 当前价格，并随抖动变化）。 */
      if (opts.light) { if (market.updateQuote) market.updateQuote(); return; }
      market.update();
      positions.update();
      orders.update();
      history.update();
      if (loan) loan.update();
      /* 页签角标：数字没变时 setCount 不写 DOM（这个函数每 400ms 跑一次，
         白写会一直触发重排） */
      ws.setCount('positions', api.positions().length);
      ws.setCount('orders', api.orders().length);
      ws.setCount('history', api.history().length);
      if (opts.resize) charts.forEach(c => c.resize());
      /* 下单面板 / 副图数量 / 提示行都会改变剩余高度；全量重画那一拍顺手量一次。
         轻量路（抖动）不跑，避免每 40ms 触发布局。 */
      fitMobileChart();
    }

    /* 限价单的成交**不在这里撮合** —— 撮合在 core/marketEngine.settleStep
       （每推进一根 K 线跑一次，见两个模式的 advanceBars）。
       面板只负责播报：玩家挂上单、推进一周，单子被市场走到了要让他看见。
       这里订阅引擎的成交事件；market.fill 对市价与限价都发，
       所以判据是 fill.type —— 市价单的成交在 submit() 里已经播报过一次了。 */
    listeners.push(CS.events.bus.onKey('market.fill', 'tradePanelFill', fill => {
      if (!fill || fill.type !== 'limit') return;
      CS.uiBits.toast(t('st.order.limitFilled', {
        price: CS.money.formatNumber(fill.avgPrice, d.digitsOf(fill.instrumentId))
      }), 'pos', 5600);
      render();
    }));

    /* 抖动开着时**每一拍都刷一次读数**，但只刷「账户条 / 下单表单 / 读数 / 右上角行情头」
       这几块（opts.light，见 render）—— 行情列表不重画，否则每 400ms 重建 18 行 DOM，
       把玩家正在展开的品种下拉与输入框打断。K 线本身由图表按帧重画，不走这条路。 */
    function tick() {
      if (disposed) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      if (api.ticks && api.ticks.active()) { render({ light: true }); return; }
      renderOnFingerprintChange(fingerprint());   /* 同一把指纹不会再进来第二次（见上） */
    }
    timer = setInterval(tick, TICK_MS);

    /* 外部（页签层 / 模式层）要求重画时走这条事件，不用等下一拍 */
    listeners.push(CS.events.bus.onKey('trade.render', 'tradePanel', () => render()));
    /* 换交易对：键位层（↑↓ 与以后别的入口）发这个事件，**换品种这条意图仍然只有一条路**
       （selectInstrument），键位层不许自己改 ui。 */
    listeners.push(CS.events.bus.onKey('trade.select', 'tradePanelSelect', payload => {
      if (payload && payload.instrumentId) selectInstrument(payload.instrumentId);
    }));
    /* 点上一条价格线要「切到限价委托」：模式发事件、面板照做 —— 模式不该直接改面板的
       界面状态（ui.orderType 是面板私有的），只能喊一声。 */
    listeners.push(CS.events.bus.onKey('trade.orderType', 'tradePanelOrderType', payload => {
      if (payload && payload.kind) setOrderType(payload.kind);
    }));
    /* 自动播放按钮跟着模式那边的开关走：按一下 A / 点一下播放，字与 aria-pressed 当场同步 */
    if (playback && playback.event) {
      listeners.push(CS.events.bus.onKey(playback.event, 'tradePanelPlayback', () => {
        if (dock) { dock.syncPlayBtn(); dock.syncStepBtn(); }
      }));
    }

    /* ---------------- 手机：主图按「副图 + 下单」的剩余高度自适应 ----------------
       用户口径（2026-10-19）：「主图自适应大小，应刚好和副图和下单界面填满（大一点）」。
       固定写 160/96 这些数只能在某一组组合下刚好；副图数量、下单面板高度（限价表单 /
       仓位比例 / 预览换行）一变，要么留白、要么把下单挤出屏幕。这里按真实高度算：
         主图 = 视口底（悬浮条/教程提示行之上） - 顶栏 - 下单面板 - 图表固定部分 - 间距
       只在手机上设**行内高度**（行内优先级压过 tutorial.css 里那几条 400px 的旧规则）；
       桌面/平板恢复 CSS 的 300px。 */
    const mobileMedia = window.matchMedia ? window.matchMedia('(max-width: 720px)') : { matches: false };
    let lastChartH = 0;
    function fitMobileChart() {
      if (disposed) return;
      const canvas = chart.root.querySelector('.st-chart');
      if (!canvas) return;
      if (!mobileMedia.matches) {
        if (canvas.style.height) { canvas.style.height = ''; lastChartH = 0; }
        return;
      }
      if (!canvas.isConnected) return;
      const shell = document.querySelector('.shell-top');
      const top = (shell ? shell.getBoundingClientRect().height : 61) + 4;
      const dock = document.querySelector('.st-dock');
      const hint = document.querySelector('.tut-hint');
      let bottom = window.innerHeight - 8;
      if (dock) {
        const r = dock.getBoundingClientRect();
        /* 留 16px 安全边：只扣 8px 时，320×568 上下单底边会压到控制条
           （实测 order.bottom 498 / dock.top 496），最后两个像素被盖住。 */
        if (r.height > 0) bottom = Math.min(bottom, r.top - 16);
      }
      if (hint) {
        const r = hint.getBoundingClientRect();
        const cs = window.getComputedStyle ? window.getComputedStyle(hint) : null;
        if (r.height > 0 && (!cs || (cs.display !== 'none' && cs.visibility !== 'hidden'))) {
          bottom = Math.min(bottom, r.top - 6);
        }
      }
      /* 教程提示行是**会换文案/换行数**的：它一变高变矮，可用高度就变了。
         第一次见到它时挂到同一个 ResizeObserver 上（提示行是绝对定位，
         offsetParent 为 null，不能拿它判断可见性）。 */
      if (fitRO && hint && hint !== hintObserved) {
        if (hintObserved) { try { fitRO.unobserve(hintObserved); } catch (_) {} }
        hintObserved = hint;
        try { fitRO.observe(hint); } catch (_) {}
      }
      const panelH = chart.root.getBoundingClientRect().height;
      const canvasH = canvas.getBoundingClientRect().height;
      const fixed = Math.max(0, panelH - canvasH);
      const orderH = form.root.getBoundingClientRect().height;
      const gap = Math.max(6, form.root.getBoundingClientRect().top - chart.root.getBoundingClientRect().bottom);
      let next = Math.floor(bottom - top - orderH - fixed - gap);
      /* 90px 是正常手机主图的底线；320×568 这类超短屏如果也守 90，
         下单按钮一定会被挤到悬浮条下面。短屏允许主图收到 60px，
         优先保证「主图 + 下单」完整可见（预览读数已由 CSS 让位）。 */
      const floor = window.innerHeight < 620 ? 60 : 90;
      next = Math.max(floor, Math.min(380, next));
      if (Math.abs(next - lastChartH) > 1 || !canvas.style.height) {
        lastChartH = next;
        canvas.style.height = `${next}px`;
      }
    }
    const onResize = () => { lastChartH = 0; render(); };
    if (window.addEventListener) window.addEventListener('resize', onResize);
    listeners.push(() => { if (window.removeEventListener) window.removeEventListener('resize', onResize); });

    /* 副图开关 / 下单面板换行不会改指纹，也就不一定走下一次全量 render；
       用 ResizeObserver 盯住「图表面板 + 下单面板」，高度一变就重量一次。 */
    let fitFrame = 0;
    let hintObserved = null;
    const raf = (typeof window.requestAnimationFrame === 'function')
      ? cb => window.requestAnimationFrame(cb)
      : cb => setTimeout(cb, 16);
    const scheduleFit = () => {
      if (fitFrame) return;
      fitFrame = raf(() => { fitFrame = 0; fitMobileChart(); });
    };
    let fitRO = null;
    if (typeof ResizeObserver === 'function') {
      fitRO = new ResizeObserver(scheduleFit);
      fitRO.observe(chart.root);
      fitRO.observe(form.root);
    }
    listeners.push(() => {
      if (fitRO) { try { fitRO.disconnect(); } catch (_) {} }
      if (fitFrame && typeof window.cancelAnimationFrame === 'function') { try { window.cancelAnimationFrame(fitFrame); } catch (_) {} }
    });

    render({ resize: true });
    /* 首帧时宿主可能还没有布局（页签刚挂上），下一帧再量一次尺寸 */
    setTimeout(() => { if (!disposed) { charts.forEach(c => c.resize()); fitMobileChart(); } }, 60);
    /* 教程提示行是面板挂上之后才由教程写进来的：它一出现，悬浮条上方的可用高度就变了。
       再补两拍（不依赖下一次 400ms 指纹重画 —— 提示行变化不进指纹）。 */
    setTimeout(() => { if (!disposed) fitMobileChart(); }, 240);
    setTimeout(() => { if (!disposed) fitMobileChart(); }, 700);

    return {
      refresh: () => render({ resize: true }),
      resize: () => charts.forEach(c => c.resize()),
      /* 面板的界面状态（交易对 / 周期 / 一屏根数 / 保证金 / 杠杆 / 下单方式）：
         模式要读它才能把这一局的方向盘存下来、也才能让引导临时接管那几个开关。
         写走 setUi —— 面板私有的状态只从这一个口进。 */
      ui: () => ui,
      setUi(patch) { Object.assign(ui, patch || {}); render({ resize: true }); },
      dispose() {
        disposed = true;
        if (timer) clearInterval(timer);
        timer = null;
        listeners.forEach(off => { try { off(); } catch (_) {} });
        listeners.length = 0;
        try { H.dispose(); } catch (_) {}
        charts.forEach(c => { try { c.dispose(); } catch (_) {} });
        charts.length = 0;
        if (dock) { try { dock.dispose(); } catch (_) {} }
        /* 宿主（故事模式）为这个面板挂的订阅也要退掉，否则切来切去越订越多 */
        if (ctx.disposeOffs) { try { ctx.disposeOffs(); } catch (_) {} }
        clear(host);
      }
    };
  }

  return { tradePanel: { mount } };
});
