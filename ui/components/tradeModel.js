/* ============ 交易页的数据层（零 DOM，模拟模式与故事模式共用） ============
   它只做一件事：把「模式状态 + 账户端口 + 行情端口」折成界面要的读数。
   界面在 ui/components/tradePanels.js，编排在 ui/components/tradePanel.js。

   ★ 这张页是**两个模式共用的同一张**（modes/classic 与 modes/story 都挂它），
   所以这里不许出现「故事模式才有的东西」：债务、执念、封账这些一律走
   ctx 上的可选钩子，缺了就当没有 —— 页面照样画得出来。

   拆出来的理由和硬约束有关：当时单文件不许超过 400 行。原来的 tradePanel.js 把
   「读数据 / 算预览 / 画界面 / 处理点击」全挤在一起，界面与模拟模式对齐之后
   直接涨到 430 行以上。现在这条界线同时也是一条**纪律**：
   这一层里不许出现 document / el / appendChild —— 于是「面板自己改钱」
   在物理上就做不到（改钱只能走 ctx.account）。

   钱一律用 money() 折成玩家的显示货币；面板不自己做换算。 */
CS.define('ui/components/tradeModel', ["core/base/money","core/base/util","core/content/index","core/engine/accountEngine","core/engine/marketEngine","core/market/filter","core/market/marketData","core/text/i18n","lib/lodash","lib/memoize-one"], function () {
  'use strict';

  /* ui 是编排层持有的那份界面状态（当前品种 / 一屏根数 / 保证金 / 杠杆…）。
     数据层直接读它，但不写它 —— 写界面状态是编排层的事。 */
  function create(ctx, ui) {
    /* 这一层原来有三个手写的「记一下上次的输入」变量：barCache.key / barCache.bars /
       instrumentsCache。它们现在都由 lib/memoize-one 的 memoizeOne 承担 ——
       那个库的语义正好就是这三行在做的事：**只记最后一次调用的参数与结果**，
       参数长度不同即不等、逐项按 === 比较（NaN 视为相等），键一变上一次的结果就作废。
       ★ 它没有「按 key 存一张表」这回事，也没有别的失效语义；各处替换后的差别
       （相等口径、失败路径、空结果）分别写在下面每一处的注释里。 */

    /* 模式状态：故事模式给的是它那一局的 state，模拟模式给 null（没有剧情状态）。
       下面所有读它的地方都必须容忍 null —— 这是两个模式共用一张页的前提。 */
    const modeState = () => (ctx.state ? ctx.state() : null);
    const currency = () => (modeState() && modeState().currency) || 'USD';
    const country = () => {
      const s = modeState();
      /* 原来这里是 Object.values(CS.content.countries).find(...)：每问一次就新建一个数组。
         这一格在 money() 里被每个金额调用一次 —— 走 core/content/index.js 的 O(1) 索引。 */
      return s ? CS.contentIndex.country(s.country) : null;
    };
    const money = units => CS.money.format(units, currency(), { fxToUSD: country() ? country().fxToUSD : 1 });
    /* 显示货币 ↔ 内部最小单位。下单表单那几格（保证金 / MAX）走这两个函数，
       别的地方一律只用 money() 显示 —— 界面里出现裸的内部单位就是缺陷。 */
    const fx = () => (country() ? country().fxToUSD : 1);
    const toUnits = amount => CS.money.fromDisplay(amount, fx());
    const fromUnits = units => Math.round(CS.money.toDisplay(units, fx()) * 100) / 100;
    const digitsOf = id => { try { return CS.marketData.digitsOf(id); } catch (_) { return 2; } };
    const limits = () => (ctx.limits ? ctx.limits() || {} : {});
    const metrics = () => { try { return ctx.account.metrics() || {}; } catch (_) { return {}; } };

    const snapshot = () => ctx.account.getSnapshot(id => {
      const bar = lastBarOf(id);
      return bar ? bar.c : NaN;
    });

    /* 欠了多少：有债务的模式各报各的 —— 故事模式走 debtTotals（与状态页签同一份数），
       模拟模式走 ctx.loan（周转借款那一本）。两者都给不出时返回 null，
       账户条上那一格显示「—」而不是编一个 0。 */
    function debtTotals() {
      if (ctx.loan && ctx.loan.totals) {
        try { return ctx.loan.totals(); } catch (_) { /* 落到下面 */ }
      }
      /* coin 版：故事模式的 debtTotals 那一支随故事模式一起移除了。
         这里给不出数时返回 null —— 账户条上那一格显示「—」而不是编一个 0。 */
      return null;
    }

    /* 一次绘制里同一个 (品种, 根数) 会被问好几遍（行情列表 18 行 × 现价、
       图表、下单预览…）。用「时钟水位」当缓存键：时钟一动就整批失效，
       同一根 K 线之内只读一次序列。
       ★ 键里还要带 priceVersion：教程引导会在**同一根 K 线之内**就地改写 OHLC
       （core/tutorial/priceOverlay），只认 nowIndex 的话这里会一直交回改写前的那一份
       —— 图与账户各读各的价。
       ★ 这一格原来是手写的：把四个输入拼成一把字符串键
       （`${id}|${n}|${now}|${priceVersion}`），再比 `barCache.key !== key`。
       换成 memoizeOne 之后比较的是这**四个参数本身**：逐项 ===（NaN 视为相等），
       四个输入都是字符串/数字，拼串再比与逐参 === 在这里逐字等价
       （拼串不可能把两个不同的四元组撞成同一把键）。
       它同样只记最后一次 —— 换个品种再换回来会重算，与手写版一致（不是按 key 存的表）。
       差别只有失败路径：手写版在 loadSeries 抛异常时**已经**把 key 写进去了，
       于是同一根 K 线之内再问一次会拿到上一批序列（可能是别的品种的，且不再重试）；
       memoizeOne 只在函数正常返回后才提交缓存，抛异常那一次不留痕，下次同键会重新读
       （仍失败则外层 catch 照旧返回 []）。参数 version 与键里那一段同义：
       它不参与计算，只用来让旧结果失效。 */
    const barsFor = memoizeOne((id, n, now, version) => {
      /* ★ 起点要**避开被过滤掉的那一段**（各交易对上线初期）：不夹的话图上会画出
         一段「不可交易」的行情，而玩家在那一段上点下单只会被拒 —— 图与规则对不上。 */
      const floor = CS.marketFilter ? CS.marketFilter.unlockIndexOf(id) : 0;
      return CS.marketData.loadSeries(id, { from: Math.max(floor, now - n + 1), to: now });
    });
    function barsOf(id, count) {
      try {
        const now = CS.marketData.nowIndex;
        const n = count || ui.bars;
        return barsFor(id, n, now, CS.marketData.priceVersion || 0);
      } catch (_) { return []; }
    }
    function lastBarOf(id) {
      const bars = barsOf(id);
      return bars.length ? bars[bars.length - 1] : null;
    }
    /* 资金费率：显示**下一期**（还没结算的那一期），不显示刚刚付过的上一期。
       2026-10-19 用户口径：「去掉一直保持上一个的资金费率」。
       原来的实现读 nowIndex：只有结算那一根有值，其余时候 undefined（界面闪成 —），
       而结算之后紧接着的那一根又返回刚刚付掉的旧费率 —— 看起来就是「一直挂着上一期」。
       现在从下一根开始往前找第一笔（最多覆盖一整期 16 根 4h），找不到就返回 undefined
       （界面写 —）；下单预览里的资金费也按这一期算，与实际要付的那一期一致。 */
    function fundingRateOf(id) {
      try {
        const now = CS.marketData.nowIndex;
        for (let i = 1; i <= 16; i++) {
          const rate = CS.marketData.fundingRateAt(id, now + i);
          if (Number.isFinite(rate)) return rate;
        }
        return undefined;
      } catch (_) { return undefined; }
    }
    /* 「屏幕上看到的那个价」：模式可以注入一层抖动（ctx.displayPrice，故事模式接的是
       storyAnim）。没注入就返回收盘价 —— 这不是「少一个功能」，而是这个模式没有那一层。
       取不到有限数时一律退回收盘价：这一格是每 400ms 都要算的读数，
       让它变成 NaN 会把整张行情列表画成空白。 */
    function displayPrice(id, settle) {
      if (!ctx.displayPrice) return settle;
      try {
        const v = ctx.displayPrice(id, settle);
        return Number.isFinite(v) ? v : settle;
      } catch (_) { return settle; }
    }

    /* 品种名单：行情包装好之后这份表就是固定的，算一次就够。
       手写版是 `let instrumentsCache = null` + `if (!instrumentsCache)`；
       memoizeOne 收**空参数列表**时正好是这条语义 —— 第一次调用算，之后每次都拿
       「没有参数」与「没有参数」比（长度都是 0、逐项 === 都成立）→ 交回同一个数组。
       ★ 空表也算数：旧写法里 [] 是真值，所以行情没就绪时算出来的空名单同样被记住，
       不再问第二次；memoizeOne 也把 [] 当结果缓存，两边一致（不是「空了就重算」）。

       ★ 「还没上市」的品种**不进这份名单**（用户口径）：光标落在 2017 年时，
       45 个品种里只有 BTC/ETH 存在，其余的一根 K 线都没有 —— 列出来只会是
       一行行「未上市」，把真正能交易的那两个挤到列表底部。
       判据用 core/market/filter.js 的 listedIndexOf（与下单闸门同一个来源，
       不在这一层另判一次时间）。缓存的作废已经在管这件事：游标一变
       （tradeModel 的 priceVersion / clear 那几处）这份名单就重算。 */
    const instruments = memoizeOne(() => listedInstruments(CS.marketData.nowIndex)
      .map(inst => Object.assign({}, inst, { digits: digitsOf(inst.id) })));
    function currentInstrumentId() {
      return ui.instrumentId || (instruments()[0] || {}).id || null;
    }
    /* ============ 引导期间：**只有 CXP 这一个交易对** ============
       产品口径（2026-10-04 两轮合并）：引导里交易对就叫 CXP，**其他交易对一律不出现** ——
       列表、K 线那个下拉、↑↓ 换品种、结算记录/持仓/风控弹窗上那些标签，全都是它。
       行情数据一个字节都不动：id 仍是 BTCUSDT（课表按它排、铺价按它铺、账目按它算），
       这里改的只有**显示**。判据收在两个模块级函数里（见下面 tutorialOn / pairLabelOf），
       所以静态入口（listInstruments）与面板实例看到的是同一个答案。 */
    const displaySymbolOf = inst => (tutorialOn() && TUTORIAL_ALIAS[inst.id]) ? TUTORIAL_ALIAS[inst.id] : inst.symbol;
    /* 给界面用的「交易对」写法：CXP/USDT（与全局的 BASE/QUOTE 惯例一致）。
       ★ 结算记录 / 持仓行 / 风控弹窗原来直接打 `instrumentId`（引导期间显示成 BTCUSDT），
       与图上那个 CXP/USDT 自相矛盾 —— 它们现在都走这一口。 */
    const pairLabel = id => pairText(displaySymbolOf({ id, symbol: id }));    function instrument(id) {
      const found = instruments().find(x => x.id === id)
        || instruments()[0] || { id: id || '', symbol: id || '—', name: '', digits: 2 };
      const bars = barsOf(found.id);
      const last = bars.length ? bars[bars.length - 1] : null;
      const prev = bars.length > 1 ? bars[bars.length - 2] : null;
      let quote = null;
      try { quote = ctx.market.quote(found.id); } catch (_) {}
      const pos = snapshot().positions.find(p => p.instrumentId === found.id) || null;
      const settle = last ? last.c : 0;
      /* 屏幕上那个「现价」：抖动开着时逐帧变（故事模式是 modes/story/storyAnim.js）。
         它是**看到的价格**，不是成交的价格 —— 下单预览、手续费、强平价一律用 settle，
         否则「按下开仓那一瞬间抖到哪儿」会决定成交价，玩家没法预期。
         抖动这一层由模式自己注入（ctx.displayPrice）；没注入的模式（模拟模式）
         现价就是收盘价，一个多算的减法都不做。 */
      const jittered = displayPrice(found.id, settle);
      return {
        id: found.id, symbol: displaySymbolOf(found), name: found.name, digits: found.digits,
        price: Number.isFinite(jittered) ? jittered : settle,
        settle,
        change: prev && prev.c ? (last.c / prev.c) - 1 : 0,
        open: last ? last.o : 0, high: last ? last.h : 0, low: last ? last.l : 0,
        spread: quote ? quote.spread : 0,
        /* 界面读数里既没有 liquidityCap 也没有 halt：
           成交上限、熔断、停牌三块都已按产品要求删掉。 */
        funding: fundingRateOf(found.id),
        /* 行情过滤：这个品种此刻可不可交易（列表据此标「过滤中」，下单按钮据此变灰）。
           判据只有一处（core/market/filter.js），界面与引擎用同一句话解释原因。 */
        filter: filterOf(found.id),
        position: pos
      };
    }
    /* 「这个品种此刻能不能交易」——拿不到过滤层（老壳、自检）时一律当作能交易。
       ★ 要分开「还没上市」与「被行情过滤隐藏」两件事：
       前者价格是 0（该品种一根 K 线都还没有），列表要写「未上市」而不是「0.00000」，
       而且不能让玩家去翻设置找开关（那不是设置能打开的）。 */
    function filterOf(id) {
      if (!CS.marketFilter) return { available: true, reason: '', unlock: 0, listed: true };
      const listedAt = typeof CS.marketFilter.listedIndexOf === 'function' ? CS.marketFilter.listedIndexOf(id) : 0;
      const at = CS.marketData.nowIndex;
      const listed = at >= listedAt;
      return {
        available: CS.marketFilter.isAvailable(id),
        reason: CS.marketFilter.reasonFor(id),
        unlock: CS.marketFilter.unlockIndexOf(id),
        listed, listedAt, at
      };
    }

    /* ============ 交易对行情列表的「日线读数」 ============
       产品口径：左侧那张行情列表**最小 24 小时更新一次** —— 它是「今日行情」，
       不是逐帧跳动的报价板。所以它的读数按 UTC 自然日聚合：
         · 价格 = **上一个已走完**自然日的收盘价（UTC 日界；4h × 6 根为一日）；
         · 涨跌 = 该收盘价相对其前一自然日收盘价的百分比；
         · 日界一翻（UTC 零点）才重算：推进一根 4h、抖动每一帧、面板每 400ms 重画一次，
           在这个自然日之内都不会让它动一个数。
       为什么是「上一个已走完的日子」而不是「走到当日最后一根就算今天收盘」：
       后者的更新时刻会落在每天 20:00 UTC（当日最后一根被揭示时），那个时刻没有含义，
       玩家也无法从界面上解释；而「日期一变就换」既符合「日线收盘价」的通行读法，
       又让这条规则可以用一句话说清、并被一条断言验证
       （tools 里的探针就是这么验的：日期不变 → 一个数都不许动；日期变了 → 必须换）。
       ★ 与 instrument() 的分工：那边给的是「屏幕上这一刻的现价」（图表标题、下单面板用），
         必须逐根/逐帧变；这一边只服务左侧那张列表。
       ★ 缓存按 (品种, 已收盘日, priceVersion) 记。priceVersion 是引导就地改写 OHLC 时
         会加的那个版本号 —— 少了它，引导铺出来的那段价在列表里会一直是改写前的值。
       ★ 不调 CS.marketData.dailyBars()：那支会把整段 K 线 slice 出来再重采样，
         18 个品种 × 每次推进都是 O(全部根数) 的分配；这里只按日界做一次算术定位
         （O(1)），日线口径与 resample.daily 完全一致（同一套 UTC 日界）。 */
    const DAY_MS = 86400000;
    const dayQuotes = new Map();          // instrumentId -> { key, quote }
    function dailyQuote(id) {
      let series = null;
      let meta = null;
      try {
        series = CS.marketData.seriesRef(id);
        meta = CS.marketData.getDatasetMeta();
      } catch (_) { return null; }
      if (!series || !series.bars || !series.bars.length || !meta) return null;
      const step = Number(series.step) || Number(meta.stepMs) || 0;
      const startMs = Number(meta.start);
      if (!(step > 0) || !Number.isFinite(startMs)) return null;
      const t = CS.marketData.timeAt(id, CS.marketData.nowIndex);
      if (!(t > 0)) return null;
      const perDay = Math.max(1, Math.round(DAY_MS / step));
      const dayNo = Math.floor(t / DAY_MS);
      /* 光标跨进新的一天之后，「上一天」才算是走完的 —— 这就是「UTC 零点更新」的全部含义。 */
      const closedDay = dayNo - 1;
      const version = CS.marketData.priceVersion || 0;
      const key = `${closedDay}|${version}`;
      const hit = dayQuotes.get(id);
      if (hit && hit.key === key) return hit.quote;
      /* 日收盘价所在的那一根 = 该日的最后一根。全局下标 = (收盘时刻 − 数据集起点) / step；
         减去这一品种的 off 才是它在 series.bars 里的位置（两端都可能越界）。 */
      const barAt = idx => {
        const j = idx - (Number(series.off) || 0);
        return (j >= 0 && j < series.bars.length) ? series.bars[j] : null;
      };
      const closeIdx = Math.round((closedDay * DAY_MS + (perDay - 1) * step - startMs) / step);
      const cur = barAt(closeIdx);
      const prev = barAt(closeIdx - perDay);
      let quote;
      if (cur) {
        quote = { price: cur.c, change: prev && prev.c ? (cur.c / prev.c) - 1 : 0, day: closedDay };
      } else {
        /* 数据集开头那不满一天的一段：没有走完的日子可用，退回第一根 —— 同样是常量，
           不会每推进一根就换一个数（「最小 24 小时更新一次」这条不留例外）。 */
        const first = series.bars[0];
        quote = { price: first ? first.c : 0, change: 0, day: null };
      }
      dayQuotes.set(id, { key, quote });
      return quote;
    }

    /* 图上的线（六种身份）：开仓 / 强平 / 保本 / 委托 / 预览 / 两条预估强平。
       线怎么来的在一起（ui/components/tradePriceLines.js），这里只负责**把零件递过去**：
       精度、开关、下单参数、保本与强平的算法都从这一层取（它才认识账户与界面状态）。
       现价那条额外带 live:true —— 图表据此在它那一点上画小圆点与波纹。

       `spot` 是可选参数：**这一刻的现价**。图表每帧画之前会带上一帧的现价来问一次
       （tradeChart 的 setLiveLines）—— 现价线与按现价算的「预估强平」是现价的函数，
       只在每 400ms 那一拍重算的话，K 线每帧在跳、那两条线却一跳一跳地追。
       传了就用它（成交/结算不读这里，所以不碰「抖动价算不算成交价」那条口径）。 */
    function priceLines(spot) {
      const id = currentInstrumentId();
      const snap = snapshot();
      const lim = limits();
      const cap = lim.leverageCap == null ? 100 : lim.leverageCap;
      const leverage = Math.max(1, Math.min(cap, ui.leverage));
      const inst = instrument(id);
      if (Number.isFinite(spot) && spot > 0) inst.price = spot;
      const bars = barsOf(id);
      let orders = [];
      try { orders = (ctx.market.listOrders ? ctx.market.listOrders() : []) || []; } catch (_) { orders = []; }
      const out = [];
      /* 现价那条自己算（它不属于上面那六种身份，且要 live/direction 两个额外信息）。
         ★ 方向色按「此刻的价 vs 上一根已收盘的收盘价」：与右轴标签、行情列表同一个基准。
           用「本根开→收」是另一回事 —— 那说的是这一根自己的涨跌，
           而玩家抬头看的是「relative 到上一根收，我现在是赚还是亏」。 */
      if (inst.price) {
        const prevClose = bars.length > 1 ? bars[bars.length - 2].c
          : (bars.length ? bars[bars.length - 1].o : inst.price);
        out.push({
          kind: 'last', label: CS.i18n.t('st.line.last'), price: inst.price,
          color: inst.price >= prevClose ? '#089981' : '#f23645', dash: null, live: true
        });
      }
      const engine = ctx.account;
      const built = CS.tradePriceLines.build({
        price: v => CS.money.formatNumber(v, inst.digits),
        money: units => money(units),
        displayPrice: inst.price,
        positions: snap.positions.filter(p => p.instrumentId === id),
        orders: orders.map(item => item.order || item).filter(x => x.instrumentId === id),
        /* 六条价格线的开关：故事模式在 modeState().settings 里，
           模拟模式走 ctx.settings 这个钩子（它的设置槽不在 state 上 ——
           模拟模式没有剧情状态，state() 必须是 null，指标背包靠的就是这一点）。 */
        flags: key => (modeState()
          ? (modeState().settings && modeState().settings[key])
          : (ctx.settings ? ctx.settings(key) : undefined)),
        leverage,
        margin: Math.max(0, Math.round(toUnits(ui.margin))),
        orderTypeActive: () => ui.orderType === 'limit',
        /* 拖预览线：价由**模式**落（模拟模式存进这一局的存档、故事模式进这一局的状态），
           没有那一层时退回界面状态 —— 至少拖动本身是通的（只是不落盘）。 */
        previewPrice: () => {
          const p = ctx.priceLine;
          return p && p.current ? p.current() : ui.limitPrice;
        },
        /* 保本与强平都走引擎/引擎常量 —— 图表不许自己抄一份公式（抄了就会与结算对不上） */
        breakEvenOf: pos => engine.breakEvenOf(pos),
        liqPriceAt: (price, side, lev) => {
          const risk = 1 / Math.max(1, lev) - CS.accountEngine.MAINTENANCE_MARGIN_RATE;
          return side === 'short' ? price * (1 + risk) : price * (1 - risk);
        }
      });
      built.forEach(line => out.push(line));
      /* 图上标签用「多 / 空」而不是 t('trade.long')（「做多 / 买入」太长） */
      return out.sort((a, b) => a.price - b.price);
    }

    /* ---------- 委托预览的算式（与 marketEngine 同一套口径） ----------
       ★ 输入框里那个保证金是**显示货币**（玩家看到的 C$ / $ / KSh），
       引擎只认内部最小单位，所以这里必须先折一次 —— 不折的话，
       玩家填 1000 会开出 0.1 美元的仓位（差 10^4 倍），
       而界面上「保证金 CAD 1000 / 名义仓位 C$2.70」会同时显示出来打自己的脸。

       ★ `positionCap` 的口径：**单笔保证金上限（自有资金投入上限）**，
       不再是「单笔名义仓位上限」。
       为什么改：旧口径下 `保证金 × 杠杆` 一旦撞上这个上限，**再往上拉杠杆
       名义仓位一动不动** —— 现场表现就是「杠杆调大了跟没调一样」，
       而玩家读到的结论是「名义仓位被卡在总资产那儿了」。
       改成保证金上限之后：设计意图（这条 buff 不让你重仓）保留 ——
       你最多只能压这么多自己的钱进去；杠杆则回到它该有的作用上，
       把这个保证金放大成相应倍数的名义仓位。
       口径只有这一处，marketEngine.submitOrder / placeLimit 用同一个式子。 */
    function preview() {
      const inst = instrument(currentInstrumentId());
      const lim = limits();
      const wanted = Math.max(0, Math.round(toUnits(ui.margin)));
      const margin = lim.positionCap == null ? wanted : Math.min(wanted, Math.floor(lim.positionCap));
      const cap = lim.leverageCap == null ? 100 : lim.leverageCap;
      const leverage = Math.max(1, Math.min(cap, ui.leverage));
      const notional = Math.round(margin * leverage);
      const feeRate = CS.marketEngine.feeRateFor(leverage, lim);
      const fee = Math.round(notional * feeRate);
      const price = ui.orderType === 'limit' && ui.limitPrice > 0 ? ui.limitPrice : inst.price;
      const risk = leverage > 0 ? (1 / leverage) - CS.accountEngine.MAINTENANCE_MARGIN_RATE : null;
      const liq = price > 0 ? price * (1 - risk) : null;
      const funding = inst.funding;
      const fundingCost = Number.isFinite(funding) ? Math.round(Math.abs(notional * funding)) : 0;
      return {
        margin, leverage, notional, fee, feeRate, price, risk, liq, funding, fundingCost,
        /* 上限被截断了吗（面板据此写一行说明，不让玩家以为是杠杆坏了） */
        marginCap: lim.positionCap == null ? null : lim.positionCap,
        marginCapped: margin < wanted
      };
    }

    /* 本档杠杆下**真的能开出来**的最大保证金（内部单位）。三条上限取最小：
         · 可用余额（snapshot().cash 是**扣过已用保证金**的余额）
         · buff/debuff 的 `positionCap`（单笔保证金上限）
         · 开仓手续费也要钱：`可用余额 / (1 + 杠杆 × 费率)`
       —— `保证金 + 手续费 ≤ 可用余额` 解出来的就是这个式子。
       ★ 少了第三条的表现（现场缺陷，用户报的「点 MAX 填满保证金后提高杠杆反而下单失败」）：
        MAX 按钮原来填的是**全部可用余额**，而开仓还要再收一笔开仓手续费，
        于是 `保证金 + 手续费 > 余额` **必然**成立 —— 杠杆越高手续费越高，
        点完 MAX 之后连点两次「做多」都是「可用余额不足」。
        现在 MAX = 这一档杠杆下真正能成交的最大值，点它再下单一定成。 */
    function maxMarginInternal() {
      const lim = limits();
      const cap = lim.leverageCap == null ? 100 : lim.leverageCap;
      const leverage = Math.max(1, Math.min(cap, ui.leverage));
      const feeRate = CS.marketEngine.feeRateFor(leverage, lim);
      const cash = Math.max(0, Number(snapshot().cash) || 0);
      const budget = Math.floor(cash / (1 + leverage * feeRate));
      const byCap = lim.positionCap == null ? budget : Math.min(budget, Math.floor(lim.positionCap));
      return Math.max(0, byCap);
    }
    /* 同一个数，折成**显示货币**给输入框用。★ 往**下**取到分，再回折校验一次 ——
       四舍五入到分可能把值抬过预算（不到一分的余量），那又变成「差一点点就不够」。 */
    function maxMargin() {
      const budget = maxMarginInternal();
      let display = Math.floor(fromUnits(budget) * 100) / 100;
      if (display < 0) display = 0;
      if (toUnits(display) > budget) display = Math.max(0, Math.round((display - 0.01) * 100) / 100);
      return display;
    }

    return {
      /* 模式状态与派生的货币口径。名字里不带 story：模拟模式读到的是 null，
         面板因此不能假设「一定有剧情状态」。 */
      modeState, currency, money, toUnits, fromUnits, digitsOf, limits, metrics, snapshot, debtTotals,
      /* 周转借款那一本的读数（模拟模式有、故事模式没有）。面板据此画「周转借款」那一块：
         欠了多少、日利率多少、还能借多少 —— 三个数都从这里来，面板不自己算。 */
      loanState: () => (ctx.loan && ctx.loan.totals ? ctx.loan.totals() : null),
      loanRate: () => (ctx.loan && ctx.loan.rateText ? ctx.loan.rateText() : ''),
      loanLimit: () => (ctx.loan && ctx.loan.max != null ? ctx.loan.max : 0),
      /* 设置槽里的一项（模拟模式走这条路读「开仓二次确认」那一类开关）。
         故事模式没有这一层 —— 它读 ctx.state().settings，读不到就按默认。 */
      settingsFlag: key => (ctx.settings ? ctx.settings(key) : undefined),
      /* 冻结保证金（未成交委托）：保证金 + 开仓手续费。
         这两个数在下单那一刻就扣掉了（挂在交易所那边的钱既不算可用余额、
         也不算已用保证金），所以账户条上必须有一格把它加回来 ——
         否则「可用余额 + 已用保证金 + 冻结」凑不出权益，玩家一算就以为账错了。 */
      frozenMargin() {
        try {
          const raw = ctx.market.listOrders ? (ctx.market.listOrders() || []) : [];
          return raw.reduce((sum, item) => {
            const o = item.order || item;
            return sum + (Number(o.margin) || 0) + (Number(o.fee) || 0);
          }, 0);
        } catch (_) { return 0; }
      },
      /* 账户端口原样透出：面板只允许读（getSnapshot / metrics / closedTrades），
         改钱必须走编排层的意图函数 —— 见 tradePanel.js 的 closePosition/submit。 */
      account: ctx.account,
      /* 面板里的名字（accountMetrics）与数据层里的名字（metrics）历史不同，
         这里显式给一个别名，免得两边对不上时在浏览器里炸出「不是函数」 */
      accountMetrics: metrics,
      barsOf, lastBarOf, instruments, instrument, currentInstrumentId, priceLines, preview, filterOf, dailyQuote,
      /* 「引导还开着吗」（面板据此不画 K 线那一行控件、也不画行情列表里那些别的品种）。
         判据是模块级那一份，不由模式注入 —— 静态入口与实例必须同一口径，见文件里那段说明 */
      tutorialOn,
      /* 界面上写「交易对」时都走这两口：pairLabel(id) 按 id（带引导别名），
         pairText(symbol) 按 symbol（纯格式化）。 */
      pairLabel, pairText,
      /* MAX 与「这一档杠杆下最多能开多少」：面板的 MAX 按钮与保证金输入框的上限都读它 */
      maxMargin, maxMarginInternal,
      /* 行情列表原样透出：两个模式的键位层（story/keys.js 与 classic/replay.js）的 ↑↓
         要在**同一份列表**上转圈，自己另拉一份 CS.marketData.listInstruments()
         迟早会与界面上的顺序对不上。两处都还只是读 —— 换交易对是走
         trade.select 事件回给面板的。 */
      listInstruments: instruments,
      /* 当前品种这一屏的 K 线（图表用）；bar 是「最新一根」的快捷方式 */
      bars: () => barsOf(currentInstrumentId()),
      /* 下单表单里的货币前缀（EUR / KSh / MX$ …）：与 money() 同一个口径 */
      symbol: currency,
      positions: () => snapshot().positions,
      /** 行情/账户之外的派生读数：界面里那些「一句话提示」用得上 */
      marginRatio() {
        const meta = metrics();
        const used = meta.marginUsed || 0;
        return used > 0 && meta.unrealized < 0 ? Math.min(1, Math.abs(meta.unrealized) / used) : 0;
      },
      canTrade: () => !(modeState() && modeState().ended) && instruments().length > 0,
      clockLabel() {
        const id = currentInstrumentId();
        const bar = lastBarOf(id);
        const date = bar ? CS.util.dateKey(new Date(bar.t)) : '—';
        return `${date} · ${CS.marketData.nowIndex + 1}/${CS.marketData.countOf(id)}`;
      }
    };
  }

  /* 品种名单的**静态**入口：给「不属于某一张面板实例」的调用方用。
     目前有两个：modes/story/keys.js 的 ↑↓ 换交易对、modes/classic/replay.js 的回放条。
     它们都写成 `CS.tradeModel.listInstruments()` 并做了 typeof 特性探测 ——
     而这个导出以前只挂在 create() 返回的实例上，于是探测恒为假、**静默退回空数组**：
     ↑↓ 一颗键都没有反应，工具栏却照样把「↑↓ 换交易对」那行提示画出来。
     ★ 2026-10-04：返回的是**过滤过的那一份**（listedInstruments）—— 未上市的交易对
     一律不出现，包括这里。以前转发的是 CS.marketData 的原始名单，于是 ↑↓ 能选到
     列表里明明藏起来的品种（见 listedInstruments 上面那段说明）。 */
  function listInstruments() {
    try { return listedInstruments(CS.marketData.nowIndex); } catch (_) { return []; }
  }

  /* ============ 「引导还开着吗」——**唯一**一份判据 ============
     两个条件都必要：当前模式是模拟模式（故事模式没有引导），且引导的界面还开着
     （session.uiVisible() 在按下那颗 ⏏ 之后变假 → 一切恢复原样）。
     ★ 为什么提到模块级：静态入口 listInstruments()（↑↓ 换交易对、回放条）**拿不到 ctx**，
     而它必须与面板实例给出同一个答案。做成模块级之后两边共用这一份，
     不再有「面板说 CXP、↑↓ 还能翻到 ETH」这种两套口径；也不必再指望
     「谁记得把钩子传进来」（原来 modes/classic/mode.js 专门给 tradeModel 传了一个
     tutorialOn 钩子 —— 现在删掉了，答案只有这里一处）。 */
  const TUTORIAL_PAIR = 'BTCUSDT';                 /* 引导经手的品种（数据口吻） */
  const TUTORIAL_ALIAS = { BTCUSDT: 'CXPUSDT' };   /* 屏幕上写成 CXP（→ CXP/USDT） */
  /* ★ 「BASE/USDT」这个显示写法**只有这一处**（2026-10-04 去重）。
     它原来在 tradePanels / tradeConfirm / tradeOrders 里各写一遍，共 9 处 ——
     同一个格式化散在三处，改口径就得记住三处（而漏改的那一处只在屏幕上看得出）。
     全库的 交易对 文字都走它。 */
  function pairText(symbol) {
    return String(symbol == null ? '' : symbol).replace('USDT', '/USDT');
  }
  function tutorialOn() {
    try {
      if (!CS.modes || CS.modes.current !== 'classic') return false;
      const s = CS.open('classic').tutorial.session;
      return !!(s && s.uiVisible());
    } catch (_) { return false; }
  }

  /* ============ 「此刻真的能交易的品种」——**唯一**一份口径 ============
     两条用户口径叠在这里：
       · 未上市的交易对**一律隐藏**（不是画一行「未上市」，而是根本不出现）；
       · 引导期间**只剩 CXP 一个**（其他交易对一律不出现）。
     判据用 core/market/filter.js 的 listedIndexOf（与下单闸门同一个来源，
     不在这里另判一次时间）。`at` 是当前光标（基础 K 线绝对下标）。
     ★ 提到模块级是因为有**两个**入口要同一份答案：
       · 面板实例里的 instruments()（列表 / K 线那个下拉框都读它）；
       · 静态的 listInstruments()（modes/story/keys.js 的 ↑↓ 换交易对、
         modes/classic/replay.js 的回放条）。
       原来静态那一份直接透传 CS.marketData 的**原始**名单 —— 于是列表里已经藏起来的
       未上市品种，用 ↑↓ 一颗键就能选出来：图上立刻变成「未上市」，而它旁边那个下拉框
       里根本没有它。同一个问题两份口径，就是这类毛病的来源。
     ★ 这里**不加 digits**：那一格要问 CS.marketData.digitsOf，而 digitsOf 是
       create() 那一层里的东西（模块级够不到）—— 第一版在这里顺手加了，
       结果是每一帧都抛 `digitsOf is not defined`、品种名单整份变空、交易页一片空白。
       面板要 digits，就由面板实例那一层自己补（见 instruments()）。 */
  function listedInstruments(at) {
    let list = [];
    try { list = CS.marketData.listInstruments() || []; } catch (_) { list = []; }
    if (tutorialOn()) {
      /* 引导期间只留它经手的那一个，并把 symbol 换成显示名（列表与下拉直接用这一格）。
         注意这一支**不看 listedIndexOf**：那是「上市没上市」的判据，而引导经手的这个
         品种本来就是挑好的，不该因为滤网把它筛掉。 */
      return list
        .filter(inst => inst.id === TUTORIAL_PAIR)
        .map(inst => Object.assign({}, inst, { symbol: TUTORIAL_ALIAS[inst.id] || inst.symbol }));
    }
    const listed = id => (CS.marketFilter && typeof CS.marketFilter.listedIndexOf === 'function')
      ? at >= CS.marketFilter.listedIndexOf(id) : true;
    return list.filter(inst => listed(inst.id)).map(inst => Object.assign({}, inst));
  }

  return { tradeModel: { create, listInstruments, pairText } };
});
