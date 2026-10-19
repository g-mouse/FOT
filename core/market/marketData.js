/* ============ 市场数据端口实现（[R18][R19]） ============
   数据集是仓库内唯一固定的那一份（players 不选、不切），
   元信息必须完整并落盘：datasetId / instrument / 起止 / 周期 / 复权方式 / 时区 / 交易日历 / dataVersion。

   执行期的红线（§4A.4(2)，[R18] 验收第 19 条）：
     执行期只能看到「已揭晓的 bar」。任何 loadSeries 越过 clock.now() 的读取都是缺陷。
     全量序列 getFullSeries 仅供开局校准期（newsScheduler.calibrate）使用，
     newsEngine / debtEngine 与所有面板都不许持有它 —— 这里用 futureGuard 做运行时断言，
     tools/validate-content.ps1 做静态扫描。

   数据来源：window.__MARKET_BUNDLE__（由 tools/build-market.mjs 从 tools/raw/ 内联生成）。
   注意它**没有成交量**：原始 K 线是 [t,o,h,l,c]。不许为了填字段编造成交量 ——
   DatasetMeta.volumeAvailable 如实写 false，regime 分类只用价格与波动率。 */
CS.define('core/market/marketData', ["core/market/resample"], function () {
  'use strict';

  const state = {
    ready: false,
    error: '',
    meta: null,
    series: {},          // id -> { id, digits, t0, step, count, o[], h[], l[], c[] , full: Bar[] }
    instruments: [],
    nowIndex: 0,         // 执行期「已揭晓到第几根」，由 clock 端口推动
    priceVersion: 0,     // 价格被就地改写了几次（见 bumpPrices）
    guardOn: false,      // debug.futureGuard
    guardTrips: [],
    fullSeriesRefs: 0    // 谁调了 getFullSeries（dev 面板要能看见）
  };

  const DATASET_ID = 'coinsim.perp4h.v1';

  const NAME_MAP = {
    BTCUSDT: 'BTC', ETHUSDT: 'ETH', SOLUSDT: 'SOL', BNBUSDT: 'BNB',
    XRPUSDT: 'XRP', AAVEUSDT: 'AAVE', ADAUSDT: 'ADA', AVAXUSDT: 'AVAX',
    DASHUSDT: 'DASH', DOGEUSDT: 'DOGE', DOTUSDT: 'DOT', FILUSDT: 'FIL',
    LINKUSDT: 'LINK', NEARUSDT: 'NEAR', UNIUSDT: 'UNI', ZECUSDT: 'ZEC',
    LTCUSDT: 'LTC', XLMUSDT: 'XLM'
  };

  function digitsOf(id) {
    const s = state.series[id];
    if (s) return s.digits;
    const meta = state.meta && state.meta.symbols && state.meta.symbols[id];
    return meta && Number.isFinite(meta.digits) ? meta.digits : 2;
  }

  function init() {
    const bundle = window.__MARKET_BUNDLE__;
    const meta = bundle && bundle.meta;
    const raw = (bundle && bundle.series) || {};
    if (!meta || !meta.order || !meta.step) {
      state.error = '行情数据缺失（window.__MARKET_BUNDLE__ 未加载）';
      return false;
    }
    state.meta = {
      datasetId: DATASET_ID,
      instrument: 'CRYPTO.PERP',
      symbols: meta.order.slice(),
      start: meta.startTime,
      end: meta.endTime,
      commonStart: meta.commonStart,
      interval: meta.interval || '4h',
      stepMs: meta.step,
      count: meta.count,
      /* 加密永续没有复权概念（不存在分红送股），如实写 none —— 
         写「前复权」是编的，校验脚本会拿它做数据集指纹。 */
      adjust: 'none',
      timezone: 'UTC',
      calendar: '24/7',
      fundingIntervalHours: (meta.funding && meta.funding.intervalHours) || 8,
      fundingSource: (meta.funding && meta.funding.source) || '',
      /* 存档里记这个版本号：将来换了数据源或复权方式，
         老存档要能识别出「本局建立在旧数据版本上」并提示，而不是静默漂移。 */
      dataVersion: String(meta.generated || 'unknown'),
      generated: meta.generated || '',
      volumeAvailable: false
    };
    state.series = {};
    state.instruments = [];
    meta.order.forEach(id => {
      const s = raw[id];
      if (!s || !Array.isArray(s.c) || !s.c.length) return;
      const info = (meta.symbols && meta.symbols[id]) || {};
      const count = s.c.length;
      const step = meta.step;
      const t0 = s.t0;
      const bars = new Array(count);
      /* 资金费：打包时写成扁平的 [全局下标, 费率, 全局下标, 费率, …]。
         拆成两张平行数组；fundingFrom 之前（合约还没上线）本就没有资金费，
         一律返回 fundingBefore，不编造费率。 */
      const fundingIndex = [], fundingRate = [];
      if (Array.isArray(s.funding)) {
        for (let i = 0; i + 1 < s.funding.length; i += 2) {
          fundingIndex.push(Number(s.funding[i]));
          fundingRate.push(Number(s.funding[i + 1]));
        }
      }
      const fundingFrom = Number.isFinite(s.fundingFrom) ? s.fundingFrom : null;
      const fundingBefore = Number.isFinite(s.fundingBefore) ? s.fundingBefore : 0;
      for (let i = 0; i < count; i++) {
        let o = s.o[i], h = s.h[i], l = s.l[i], c = s.c[i];
        /* 影线包住实体：上游 K 线偶尔出现 开/收 落在自己的 高/低 之外。
           只放宽不收紧，与 game/js/market/init.js 同一口径。 */
        const hi = Math.max(o, c), lo = Math.min(o, c);
        if (h < hi) h = hi;
        if (l > lo) l = lo;
        bars[i] = { t: t0 + i * step, i, o, h, l, c, v: 0 };
      }
      /* ★ off = 这个品种的第一根，落在全局网格上的第几格。
         全局下标（时钟的 barIndex）与品种自己的 bars 下标**差的就是这个常量**：
             自己的下标 = 全局下标 − off
         这不是可选的优化，而是两套口径之间唯一正确的桥：
         数据集里 18 个品种只有 BTC / ETH 的 t0 等于 meta.startTime（off = 0），
         其余品种的 off 从 485（BNB）到 6933（FIL）不等 ——
         少了这个换算，「按全局下标取品种自己的数组」就等于**把图倒回几个月甚至几年前**，
         而它不报错：图上日期与图上的价仍自洽，只有账户那边的取价落在另一段时间上。
         所以这个字段必须落在这里（数据层唯一知道 t0 与数据集历元关系的地方），
         由下面的 loadSeries / timeAt / indexAt 统一换算，别处一律用全局下标。 */
      const off = Math.round((t0 - state.meta.start) / step);
      state.series[id] = { id, digits: info.digits != null ? info.digits : 2, t0, step, count, off, bars, listed: info.listed || t0, fundingIndex, fundingRate, fundingFrom, fundingBefore };
      state.instruments.push({
        id, symbol: id, name: NAME_MAP[id] || id, currency: 'USDT',
        tickSize: Math.pow(10, -(info.digits != null ? info.digits : 2)),
        lotSize: 0.0001,
        listedAt: info.listed || t0,
        bars: count
      });
    });
    state.ready = state.instruments.length > 0;
    if (!state.ready) state.error = '行情包为空';
    return state.ready;
  }

  function requireReady() {
    if (!state.ready) throw new Error(state.error || '行情未就绪');
  }

  /* ---------- 未来数据守卫 ---------- */
  function guard(rangeFrom, where) {
    if (!state.guardOn) return true;
    if (rangeFrom > state.nowIndex) {
      const error = new Error(`读取了未来数据：${where} 请求第 ${rangeFrom} 根，而当前只揭晓到第 ${state.nowIndex} 根（[R18] 硬禁止）`);
      state.guardTrips.push({ where, from: rangeFrom, now: state.nowIndex, stack: (new Error()).stack });
      CS.errors.push({ message: error.message });
      throw error;
    }
    return true;
  }

  function setNowIndex(i) { state.nowIndex = Math.max(0, Math.round(Number(i) || 0)); }
  function setGuard(on) { state.guardOn = !!on; return state.guardOn; }

  /* ★ 价格被**就地改写**之后必须喊一声（把这一版数据重算一遍）。
     谁会改价格：教程引导铺价（core/tutorial/priceOverlay）、随机波动那一层（将来）。
     为什么必须有它：core/market/resample.js 的缓存键里有 version，
     而调用方传的是 nowIndex（ui/components/chartView.js 的 viewFor）。
     同一根 K 线之内改写价格 → nowIndex 没变 → 聚合缓存命中旧值 →
     图上画的还是改写前的蜡烛，而账户那边读的是改写后的价（「图上一个价、成交另一个价」，
     与 marketData.js 文件头里 loadSeries 那个 off 的坑是同一类：不报错，只是对不上）。
     所以改写方在写完 series 之后**必须**调一次它，再让界面重画。 */
  function bumpPrices() { state.priceVersion = (state.priceVersion + 1) >>> 0; return state.priceVersion; }

  /* ---------- 对外接口（对应 Ports.market） ---------- */
  function listInstruments() { requireReady(); return state.instruments.map(x => Object.assign({}, x)); }

  function getDatasetMeta() {
    requireReady();
    const m = state.meta;
    return {
      datasetId: m.datasetId, instrument: m.instrument, symbols: m.symbols.slice(),
      start: m.start, end: m.end, interval: m.interval, stepMs: m.stepMs,
      /* ★ commonStart 绝不能漏：它是**所有品种共同起点**，也是故事模式时钟的历元
         （core/engine/host.js 用 dataset.commonStart 当 startMs）。
         漏掉它的后果不是「少一个字段」，而是时钟静默退回到 start（全数据集最早那根，
         2017-08-17），于是日期与 monthIndex 整体平移 38 个月 ——
         而存档里只存了 dayIndex，读档后按新历元重算，monthIndex 与存档对不上，
         「刷新之后月份归零、时间线错乱」。headless 垫片自己造 clock，看不到这条。 */
      commonStart: m.commonStart,
      adjust: m.adjust, timezone: m.timezone, calendar: m.calendar,
      dataVersion: m.dataVersion, generated: m.generated, volumeAvailable: m.volumeAvailable,
      /* 分享串里的一格：ds=<datasetId>@<dataVersion> */
      shareTag: `${m.datasetId}@${m.dataVersion}`
    };
  }

  /* loadSeries(id, {from,to})：from/to 是**全局** 4h 下标（含端点）。
     执行期唯一允许的取数口，会被未来守卫盯着。

     ★ 这里以前是 `s.bars.slice(from, to + 1)` —— 把全局下标当成品种自己的下标用了。
     18 个品种里 16 个的 off 不为 0，于是「时刻 t 的行情」被换成另一段时间的行情
     （BNB 偏 485 根 ≈ 81 天，LTC 偏 707 根，DASH 偏 3528 根）。
     off 是常量，所以偏差是**整体错位**而不是抖动 —— 图上、指标、挂单撮合全都跟着错，
     而对不上的是账户那边的取价（marketEngine 按全局下标读 s.bars，那一边是对的），
     于是「图上一个价、成交另一个价」：最难查的那一类。 */
  function loadSeries(id, range) {
    requireReady();
    const s = state.series[id];
    if (!s) return [];
    const r = range || {};
    /* 全局下标 → 这个品种自己的下标 */
    const gFrom = Math.max(0, Math.round(r.from == null ? 0 : r.from));
    const gTo = Math.round(r.to == null ? state.nowIndex : r.to);
    guard(gTo, `market.loadSeries(${id})`);
    const from = Math.max(0, gFrom - s.off);
    const to = Math.min(s.count - 1, gTo - s.off);
    if (to < from) return [];
    return s.bars.slice(from, to + 1).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  }

  /* ★ 仅供校准期（newsScheduler.calibrate）使用的一次性全量取数。
     执行期持有它的引用是缺陷：这里把调用次数记下来，
     dev 面板与 tools/run-tests.ps1 会断言「执行期调用次数为 0」。 */
  function getFullSeries(id, reason) {
    requireReady();
    const s = state.series[id];
    if (!s) return [];
    state.fullSeriesRefs++;
    if (reason !== 'calibrate') {
      CS.errors.push({ message: `getFullSeries(${id}) 被非校准期调用（reason=${reason || '未声明'}）：这是未来数据泄漏` });
    }
    return s.bars.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  }

  /* 校准期的下标访问：不复制整个数组，省内存 */
  function seriesRef(id) { return state.series[id] || null; }

  /* 时间与下标的换算：**统一在全局口径上**（与时钟的 barIndex 同一套）。
     以前这两个函数按品种自己的 t0 算，于是 timeAt(id, K) 报的是「K 根之后」的日期
     而不是「数据集第 K 格」的日期 —— BTC 上两者恰好相等，换个品种就差了几个月。
     全局口径下 timeAt(id, K) 对任何品种都是同一个时刻，K 也永远是非负的
     （品种上市之前那一段没有 K 线，取到的是空数组，而不是另一段时间的 K 线）。 */
  function timeAt(id, index) {
    const s = state.series[id];
    if (!s) return 0;
    return state.meta.start + Math.round(Number(index) || 0) * s.step;
  }
  function indexAt(id, time) {
    const s = state.series[id];
    if (!s) return 0;
    const g = Math.round((Number(time) - state.meta.start) / s.step);
    return Math.max(0, Math.min(s.count - 1 + s.off, g));
  }
  /* countOf(id) = 这个品种**一共会有多少根**（全局口径下的最后一格 + 1）。
     于是「第几根 / 一共几根」在全局下标 K 上仍然读得通：
     上限是 countOf − 1，而 `K >= countOf(id) - 1`（走到数据末尾）与从前等价。 */
  function countOf(id) { const s = state.series[id]; return s ? s.count + s.off : 0; }
  /* 这个品种在全局网格上的第一格（= off）。界面要问「上市了没有 / 从第几格开始」时用它。 */
  function firstIndex(id) { const s = state.series[id]; return s ? s.off : 0; }

  /* 4h → 日线重采样：regime 分类与新闻排片按「日」为格。
     UTC 日界：step 是 4h，一天 6 根，起点对齐到 UTC 00:00 的那一根。
     uptoIndex 走**全局**口径（与时钟同一套）——调用方（story/actions、story/ui）
     传进来的就是 clock 的 barIndex，从前按品种自己的下标切，切的是一段错的日子。 */
  function dailyBars(id, uptoIndex) {
    const s = state.series[id];
    if (!s) return [];
    const bars = s.bars;
    const gTo = uptoIndex == null ? s.count - 1 + s.off : Math.round(uptoIndex);
    const limit = Math.max(-1, Math.min(bars.length - 1, gTo - s.off));
    /* 聚合口径在 core/market/resample.js 的 daily()（与周期重采样同一份，别在这里再写一遍）。
       这里只补它不管的那两个下标：日线要能反查回 4h 的下标区间（基准日校准要用）。 */
    const slice = limit >= 0 ? bars.slice(0, limit + 1) : [];
    const days = CS.resample.daily(slice);
    let at = 0;
    days.forEach(day => {
      day.firstIndex = at;
      /* 「同一个 UTC 日」用**天数**比，不要用「t 落在 [day.t, day.t+DAY) 里」——
         后者对 4h 这种整除规则看着一样，一旦基础周期不是整日的约数就会把
         下一根算进今天（这类错会静默地让 lastIndex 偏一根）。 */
      const dayNo = Math.floor(day.t / 86400000);
      while (at < slice.length && Math.floor(slice[at].t / 86400000) === dayNo) at++;
      day.lastIndex = Math.max(day.firstIndex, at - 1);
    });
    return days;
  }

  /* 资金费查询：barIndex 这一根上是否有结算点，返回费率（没有则 undefined）。
     借券费/持仓成本就挂在这里 —— 让「长期持有」在真实约束下也不是免费的。 */
  function fundingRateAt(id, barIndex) {
    const s = state.series[id];
    if (!s || !s.fundingIndex || !s.fundingIndex.length) return undefined;
    const at = s.fundingIndex.indexOf(barIndex);
    return at >= 0 ? s.fundingRate[at] : undefined;
  }

  return {
    marketData: {
      init, listInstruments, getDatasetMeta, loadSeries, getFullSeries,
      seriesRef, timeAt, indexAt, countOf, firstIndex, digitsOf, dailyBars, fundingRateAt,
      setNowIndex, setGuard, bumpPrices, DATASET_ID,
      get ready() { return state.ready; },
      get error() { return state.error; },
      get nowIndex() { return state.nowIndex; },
      /* 图表聚合缓存要把它折进 version（见 bumpPrices 那一段说明）。
         page 层读的是 `${nowIndex}|${priceVersion}` 这样一个字符串。 */
      get priceVersion() { return state.priceVersion; },
      snapshot: () => ({
        ready: state.ready, dataset: state.meta ? state.meta.datasetId : '', dataVersion: state.meta ? state.meta.dataVersion : '',
        instruments: state.instruments.length, nowIndex: state.nowIndex,
        priceVersion: state.priceVersion,
        guardOn: state.guardOn, guardTrips: state.guardTrips.length, fullSeriesRefs: state.fullSeriesRefs
      })
    }
  };
});
