/* ============ 指标注册表：定义、参数与这一帧的计算 ============
   这一层回答三个问题：**有哪些指标**、**参数是多少**、**这一帧算出来是什么数**。
   它不碰画布也不碰 DOM —— 画线的在图表渲染里，指标栏那块界面的在交易页里。

   ============ 加一个新指标 = 加一个文件 ============
   在 core/indicators/ 里新建一个文件，注册一份定义，再把它加进 index.html 的 <script> 列表：

     (function () {
       'use strict';
       const ns = CS.open('indicators');
       ns.register({
         id: 'cci',                     // 唯一 id（也是存档里的键，定了就别改）
         name: 'CCI', cn: '顺势指标',    // 面板上的名字与中文全称
         kind: 'pane',                  // 'overlay' 画在主图上 / 'pane' 自己占一个副图
         desc: '一句话说明这个指标在算什么。',
         lines: 1,                      // 最多几条参数组（SMA/EMA 是 5，其余都是 1）
         params: [                      // 参数表：面板据此**自动生成**输入框
           { key: 'period', label: '周期', min: 2, max: 200, step: 1, def: 20, int: true }
         ],
         defaults: [{ period: 20 }],
         warmup: p => p.period + 5,
         range: [-250, 250],
         guides: [{ value: 0 }],
         compute(ctx) {
           const values = ns.math.cci(ctx.highs, ctx.lows, ctx.closes, ctx.params.period);
           return { series: [{ key: 'cci', label: 'CCI' + ctx.params.period, rgb: [56, 189, 248], values }] };
         }
       });
     })();

   compute(ctx) 里的 ctx（每次调用现建，别存下来）：
     rows    这一帧的 K 线（含左边一段预热），每项 { open, high, low, close, t, bucketT, forming }
     from    可见窗口在 rows 里的起点：0..from-1 只是预热，画不到，不要给它们画东西
     closes / highs / lows / opens  同样是 Float64Array，省得每个指标各自 map 一遍
     params  这一条线的参数（已按 params 表夹取过的数字）
     index   这是第几条线（0 起；lines 为 1 的指标恒为 0）—— 多线指标用它取颜色
     digits  当前交易对的价格小数位（要写价格标签时用）

   compute 的返回值：
     series  要画的曲线，每条：
                { key, label, values, rgb, type:'line'|'hist'|'band', dash?, width?, alpha?,
                  rgbUp?, rgbDown?, tones? }
                · values 必须与 ctx.rows **等长**，NaN 表示这一段还没有值（画线时自然断开）；
                · type:'hist' 从 0 轴画柱子；· tones 是每条一个 ±1 的趋势（如 SUPERTREND）；
                · type:'band' 要同时给 values 与 values2，画成半透明的带子。
     guides  这一帧要画的参考线 [{ value, label? }]（也可以直接写在定义里）
     range   这一帧的纵轴 [lo, hi]（副图用；写在定义里就是固定纵轴）

   颜色在 indicatorColors.js，一份状态的默认值与归一再 indicatorState.js。
   由 game/js/indicators/registry.js 移植并拆分而来。 */
CS.define('core/indicators/registry', ["core/indicators/indicatorState"], function () {
  'use strict';
  const ns = CS.open('indicators');
  /* 颜色与夹取函数由同一命名空间提供（indicatorColors.js 先加载） */

  const defs = [];
  const byId = Object.create(null);
  /* 版本号与「这一帧算过了」的备忘：**存在共用命名空间上**，不住在本文件的闭包里。
     为什么：这两样是跨文件的共享可变状态 —— 改状态的是 indicatorState.js（它 bump 版本号
     并清备忘），算这一帧的是本文件（它读版本号当缓存键、把结果写进备忘）。
     各自存一份的话，那边改了状态这边的缓存不会作废：表现是「勾了指标但图上没变」，
     而且只在特定顺序下出现。放在 ns 上，两份文件读写的就是同一个格子。 */
  ns._revision = ns._revision || 0;
  if (ns._memo === undefined) ns._memo = null;

  /* ============ 注册 ============ */
  function register(def) {
    if (!def || !def.id) throw new Error('指标定义缺少 id');
    if (byId[def.id]) throw new Error(`指标「${def.id}」重复注册`);
    if (def.kind !== 'overlay' && def.kind !== 'pane') throw new Error(`指标「${def.id}」的 kind 必须是 overlay 或 pane`);
    if (typeof def.compute !== 'function') throw new Error(`指标「${def.id}」没有实现 compute(ctx)`);
    if (!def.name) def.name = def.id.toUpperCase();
    if (!def.cn) def.cn = '';
    if (!def.desc) def.desc = '';
    if (!(def.lines >= 1)) def.lines = 1;
    if (!Array.isArray(def.params)) def.params = [];
    if (!Array.isArray(def.defaults) || !def.defaults.length) def.defaults = [{}];
    byId[def.id] = def;
    defs.push(def);
    /* 「以后再添指标不会出问题」的护栏：色号是按「第几个指标 × MAX_COLOR_LINES + 第几条线」取的，
       色板短于这个数就会回绕撞色。主图有上限（MAX_OVERLAYS 个，每个最多 5 条线），
       副图数量就是定义表里 pane 的个数 —— 真到了就在控制台喊一声，
       而不是等几个月后有人发现「两个指标一个颜色」。 */
    const need = ns.MAX_COLOR_LINES * Math.max(ns.MAX_OVERLAYS, defs.filter(one => one.kind === 'overlay').length)
      + Math.max(1, defs.filter(one => one.kind === 'pane').length);
    if (ns.PALETTE.length < need && !register.warned) {
      register.warned = true;
      console.warn(`指标调色板只有 ${ns.PALETTE.length} 个色号，按现在的指标数量需要 ${need} 个（会回绕撞色）：往 PALETTE 后面追加颜色即可。`);
    }
    return def;
  }
  const list = () => defs.slice();
  const get = id => byId[id] || null;
  const overlayDefs = () => defs.filter(def => def.kind === 'overlay');
  const paneDefs = () => defs.filter(def => def.kind === 'pane');

  /* ============ 参数夹取 ============ */
  /* 参数一律是数字：超出区间夹回、按 step 归整、声明了 int 的取整。
     夹取只发生在这里，所以界面上显示的数与算的时候用的数永远是同一个。 */
  function clampParam(spec, value) {
    const fallback = Number(spec.def);
    const raw = Number(value);
    const base = Number.isFinite(raw) ? raw : fallback;
    const step = Number(spec.step) > 0 ? Number(spec.step) : (spec.int ? 1 : .01);
    const lo = Number.isFinite(Number(spec.min)) ? Number(spec.min) : -Infinity;
    const hi = Number.isFinite(Number(spec.max)) ? Number(spec.max) : Infinity;
    const snapped = spec.int ? Math.round(base) : Math.round(base / step) * step;
    const clamped = Math.max(lo, Math.min(hi, snapped));
    return Number.isFinite(clamped) ? Number(clamped.toFixed(6)) : fallback;
  }
  /* 一份完整的参数（缺的补默认、多出来的丢掉、全部夹取一遍） */
  function cleanParams(def, saved, fallback) {
    const out = {};
    (def.params || []).forEach(spec => {
      const pick = saved && Number.isFinite(Number(saved[spec.key])) ? Number(saved[spec.key])
        : fallback && Number.isFinite(Number(fallback[spec.key])) ? Number(fallback[spec.key])
          : spec.def;
      out[spec.key] = clampParam(spec, pick);
    });
    return out;
  }
  const specOf = (def, key) => (def.params || []).find(spec => spec.key === key) || { key, def: 0 };
  /* 面板标题上的参数串：MACD(12,26,9) 里的那一截 */
  const paramText = (def, params) => (def.params || []).map(spec => {
    const value = params ? params[spec.key] : spec.def;
    return Number.isFinite(Number(value)) ? String(Number(Number(value).toFixed(4))) : String(spec.def);
  }).join(',');

  /* ============ 现在开着什么 ============ */
  /* 副图：按 panes 里的顺序，每个带上它那条线的参数 */
  function paneList() {
    const current = ns.state();
    return current.panes.map(id => byId[id]).filter(Boolean).map(def => {
      const item = current.items[def.id];
      const line = item ? item.lines[0] : null;
      return { id: def.id, def, params: line ? line.params : cleanParams(def, null, def.defaults[0]) };
    });
  }

  /* ============ 暖机：要多少根更早的 K 线才够算 ============ */
  /* 没写 warmup() 的按「主参数 × 3」估（EMA / RSI / ATR 这类递推指标需要更长的历史才收敛）。 */
  function warmupOf(def, params) {
    const want = typeof def.warmup === 'function' ? Number(def.warmup(params || {})) : NaN;
    if (Number.isFinite(want) && want > 0) return want;
    const period = Number(params && params.period);
    return Number.isFinite(period) && period > 0 ? period * 3 : 120;
  }
  /* 当前开着的指标里，最费历史的那个要多少根；一个都没开时是 0（那就一根都不用往回取） */
  function warmupBars() {
    const current = ns.state();
    let need = 0;
    overlayDefs().forEach(def => {
      const item = current.items[def.id];
      if (!item || !item.on) return;
      item.lines.forEach(line => { if (line.on) need = Math.max(need, warmupOf(def, line.params)); });
    });
    current.panes.forEach(id => {
      const def = byId[id];
      const item = current.items[id];
      if (!def || !item) return;
      need = Math.max(need, warmupOf(def, item.lines[0] ? item.lines[0].params : {}));
    });
    return Math.max(0, Math.min(ns.MAX_WARMUP, Math.round(need)));
  }

  /* ============ 算这一帧 ============ */
  function buildContext(rows, digits) {
    const n = rows.length;
    const ctx = {
      rows, from: 0, index: 0, params: null, digits: Number.isFinite(digits) ? digits : 2,
      closes: new Float64Array(n), highs: new Float64Array(n), lows: new Float64Array(n), opens: new Float64Array(n)
    };
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      ctx.closes[i] = row.close; ctx.highs[i] = row.high; ctx.lows[i] = row.low; ctx.opens[i] = row.open;
    }
    return ctx;
  }
  /* 一个指标算崩了不该把整张图带下去：这里兜住异常、只记一次，图表照画其余部分 */
  function safeCompute(def, ctx) {
    try {
      const out = def.compute(ctx);
      def.error = null;
      if (!out || !Array.isArray(out.series)) return { series: [], guides: [], range: null };
      const series = out.series.filter(s => s && s.values && s.values.length === ctx.rows.length).map(series_ => ({
        type: 'line',
        ...series_,
        /* 每条线都**必须**有一个 rgb：图例上的小色块、副图最新那一点都要它。
           柱子（MACD）是按正负分别上色的，它自己没有固定色，图例上给个中性灰。 */
        rgb: Array.isArray(series_.rgb) ? series_.rgb : (series_.type === 'hist' ? [148, 163, 184] : ns.PALETTE[0])
      }));
      return { series, guides: out.guides || [], range: out.range || null };
    } catch (error) {
      if (!def.error) {
        def.error = error;
        console.error(`指标「${def.id}」计算失败：`, error);
      }
      return { series: [], guides: [], range: null };
    }
  }
  /* 这一帧的全部指标结果。tag 是行情标识（交易对 + 周期），同一帧里重复调用只算一次。
     最后那根 K 线的收/开也进 key：抖动中它逐帧都在变，指标跟着它动（与画出来的蜡烛同一拍）。 */
  function computeFrame(rows, from, tag, digits) {
    const candles = Array.isArray(rows) ? rows : [];
    const first = candles[0], last = candles[candles.length - 1];
    const key = [
      ns._revision, tag || '', candles.length, from,
      first ? first.t : 0, last ? last.t : 0,
      last ? last.close : 0, last ? last.open : 0, last && last.forming ? 1 : 0
    ].join('|');
    if (ns._memo && ns._memo.key === key) return ns._memo.value;
    const current = ns.state();
    const base = buildContext(candles, digits);
    const overlays = [], panes = [];
    overlayDefs().forEach((def, itemIndex) => {
      const item = current.items[def.id];
      if (!item || !item.on) return;
      const series = [], guides = [];
      let range = null;
      item.lines.forEach((line, index) => {
        if (!line.on) return;
        const out = safeCompute(def, { ...base, from, index, params: line.params });
        /* 颜色在这里**统一盖一遍**（用户自定义色优先，否则调色板里属于它的那个色号）：
           绘制、图例、副图最新那一点读的都是这一个 series.rgb，所以改色立刻全线生效。
           第 2 条线及以后是同一个指标里的其它序列（BOLL 的上/下轨、MACD 的柱与信号线），
           它们跟着这一条线的颜色走。 */
        const rgb = ns.lineColor(line, itemIndex, index);
        out.series.forEach(entry => series.push(ns.tintSeries(entry, rgb)));
        out.guides.forEach(guide => guides.push(guide));
        if (out.range) range = out.range;
      });
      if (series.length) overlays.push({ id: def.id, def, series, guides, range });
    });
    current.panes.forEach((id, itemIndex) => {
      const def = byId[id];
      const item = current.items[id];
      if (!def || !item) return;
      const line = item.lines[0] || null;
      const params = line ? line.params : cleanParams(def, null, def.defaults[0]);
      const out = safeCompute(def, { ...base, from, index: 0, params });
      if (!out.series.length) return;
      const rgb = ns.lineColor(line, itemIndex, 0);
      panes.push({
        id, def, params, series: out.series.map(entry => ns.tintSeries(entry, rgb)), from,
        guides: (out.guides && out.guides.length ? out.guides : def.guides) || [],
        range: out.range || def.range || null
      });
    });
    const value = { overlays, panes, rows: candles, from, warmup: warmupBars() };
    ns._memo = { key, value };
    return value;
  }

  /* ============ 快照（页面内工具与自动化测试用，只读）============ */
  /* 「最后一个有值的点」直接用 math.js 里那一份（overlays.js 与 render/indicators.js 也是用它）。
     注意 **不能**在顶层写成 `const lastFinite = ns.math.lastFinite`：math.js 在本文件之后加载，
     加载期读它会是 undefined。 */
  const lineSummary = (line, index, itemIndex) => ({
    index, on: !!line.on, params: { ...line.params },
    /* 实际生效的颜色（自定义色或默认色号）：界面、页面内工具与测试都读这一个 */
    color: ns.colorText(ns.lineColor(line, itemIndex, index)),
    custom: !!line.color
  });
  function summary() {
    const current = ns.state();
    /* itemIndex 一律用**定义表里的绝对位置**（不是「开着的第几个」），与 computeFrame 取色号的口径一致 ——
       两处口径不同的话，指标栏上的色块会显示成另一个指标的颜色（踩过）。 */
    const overlayDefsAll = overlayDefs(), paneDefsAll = paneDefs();
    return {
      overlays: overlayDefsAll.filter(def => current.items[def.id] && current.items[def.id].on).map(def => ({
        id: def.id, name: def.name,
        lines: current.items[def.id].lines.map((line, index) => lineSummary(line, index, overlayDefsAll.indexOf(def)))
      })),
      panes: current.panes.slice(),
      paneItems: current.panes.map(id => {
        const item = current.items[id];
        const itemIndex = Math.max(0, paneDefsAll.indexOf(byId[id]));
        return { id, lines: item ? item.lines.map((line, index) => lineSummary(line, index, itemIndex)) : [] };
      }),
      maxOverlays: ns.MAX_OVERLAYS, maxPanes: ns.MAX_PANES,
      warmup: warmupBars()
    };
  }
  function snapshot() {
    const base = summary();
    const frame = ns._memo ? ns._memo.value : null;
    if (frame) {
      base.computed = {
        from: frame.from, rows: frame.rows.length,
        overlays: frame.overlays.map(o => ({
          id: o.id, series: o.series.map(s => ({ key: s.key, label: s.label, type: s.type || 'line', rgb: (s.rgb || []).slice(), last: ns.math.lastFinite(s.values) }))
        })),
        panes: frame.panes.map(p => ({
          id: p.id, params: { ...p.params },
          series: p.series.map(s => ({ key: s.key, label: s.label, type: s.type || 'line', rgb: (s.rgb || []).slice(), last: ns.math.lastFinite(s.values) }))
        }))
      };
    }
    return base;
  }
  /* 全部关掉、参数回到默认（账户重置走这条路，指标设置也可以单独恢复默认） */
  function reset() { const next = ns.defaultState(); const current = ns.state(); current.items = next.items; current.panes = next.panes; ns.touch(); return current; }
  /* 只恢复**一个**指标：参数、条数、自定义色、开没开，全按定义表重来。
     为什么要有它：玩家调坏了一个指标的参数（比如把 SMA 的 5 条都改成 2），
     想回到「刚开的样子」时只有「全部重置」一条路 —— 那会把另外三个也一起清掉。
     口径与 reset() 完全一样（都从 defaultState() 那一份里取），
     区别只是只写回这一格：两处各写一套默认值迟早会漂移。 */
  function resetOne(id) {
    const def = ns.get(id);
    if (!def) return false;
    const fresh = ns.defaultState();
    const current = ns.state();
    if (!current.items[id]) return false;
    current.items[id] = fresh.items[id];
    if (def.kind === 'pane') {
      /* 副图：先把这个 id 从 panes 里摘掉（恢复默认 = 关掉），顺序里其余的不动 */
      const at = current.panes.indexOf(id);
      if (at >= 0) current.panes.splice(at, 1);
    }
    ns.touch();
    return true;
  }

  /* ============ 指标骨架工厂 ============
     注册表里最常被复制的一段不是数学，而是「元数据 + 参数 + 暖机 + 拼一条 series」这套架子。
     同一套架子抄五遍，改一处（比如参数上限、暖机口径）就得记住改五处，所以这里给两个工厂：

       defineMA(spec)   —— 主图叠加的移动平均（SMA / EMA）：5 条线、每条一条周期参数、
                           （这条线自己的颜色由 computeFrame 统一盖上去，标签是「名字 + 周期」；
       definePane(spec) —— 副图（RSI / ATR / CCI 这类「一个周期参数 + 若干条线」）：
                           参数区间与默认值由 spec 给，range / guides 可选。

     两者都强制 `params.period` 一定存在（clampParam 保证它是有限数），但**保留了
     `params.period || 默认值` 这一层兜底**：warmupBars() 在「副图那条线还没建出来」时
     会拿 `{}` 来问暖机长度，那时 period 是 undefined —— 少了兜底，暖机会从 100 变成 120
     （warmupOf 的 period*3 兜底），属于无声的口径变化。

     怎么写一个新指标：数学放 math.js（或本文件里的小工具），然后
       ns.definePane({ id: 'xxx', name: 'XXX', cn: '中文名', desc: '…', def: 14, max: 200,
                       warmup: p => p * 5, series: (ctx, period) => [{ … }] });
     —— 面板、参数控件、副图外壳、快照全都会自动跟上（见本文件顶部）。 */
  function periodSpec(spec) {
    return [{ key: 'period', label: '周期', min: 2, max: spec.max || 200, step: 1, def: spec.def, int: true }];
  }
  function defineMA(spec) {
    register({
      id: spec.id, name: spec.name, cn: spec.cn, kind: 'overlay', lines: 5, desc: spec.desc,
      params: periodSpec({ def: 20, max: 400 }),
      defaults: [{ period: 5 }, { period: 10 }, { period: 20 }, { period: 30 }, { period: 60 }],
      warmup: params => spec.warmup(params.period || 20),
      compute(ctx) {
        const period = ctx.params.period;
        return {
          series: [{
            key: `${spec.id}${ctx.index}`,
            label: `${spec.name}${period}`,
            rgb: ns.PALETTE[ctx.index % ns.PALETTE.length],
            values: spec.values(ctx, period),
            width: 1.4
          }]
        };
      }
    });
  }
  function definePane(spec) {
    register({
      id: spec.id, name: spec.name, cn: spec.cn, kind: 'pane', desc: spec.desc,
      params: periodSpec({ def: spec.def, max: spec.max }),
      defaults: [{ period: spec.def }],
      warmup: params => spec.warmup(params.period || spec.def),
      range: spec.range,
      guides: spec.guides,
      compute(ctx) { return { series: spec.series(ctx, ctx.params.period) }; }
    });
  }

  Object.assign(ns, {
    register, list, get, overlayDefs, paneDefs,
    /* 上限常量定义在 indicatorColors.js（色板长度按它们算），这里只是转出来 ——
       免得消费者为了读一个数字还得知道「它住在哪个文件里」。 */
    MAX_WARMUP: ns.MAX_WARMUP, MAX_PANES: ns.MAX_PANES, MAX_OVERLAYS: ns.MAX_OVERLAYS,
    defineMA, definePane,
    clampParam, cleanParams, paramText, specOf,
    /* 状态读写整体在 indicatorState.js（它先加载、并且由它自己挂出去）。
       这里**不再转一遍** —— registry 是最后加载的那一份，而 CS.indicators 在它之前
       就已经发布给消费者了，晚挂上去的成员对已经拿到引用的那一方等于不存在。 */
    paneList, warmupBars, computeFrame, summary, snapshot, reset, resetOne,
    revision: () => ns._revision
  });
  /* 见 indicatorColors.js 里的说明：三份文件共用同一块命名空间，
     每一份都确认 CS.indicators 指向它，谁先加载都不会留下 undefined。 */
  return { indicators: ns };
});
