/* ============ 指标状态：默认值与归一 ============
   存在的理由：指标状态要跟着存档走，而老存档里可能是任何形状（少键、引用了已经不存在的指标、
   主图叠加开了超过 4 个、颜色串是上一版的写法）。normalize() 负责把任意输入补成一份完整的、
   夹取过的状态 —— 所以它是**唯一**允许修状态的入口，注册表里所有写操作都从它读出来的对象上改。

   ★ 状态从哪来：**宿主注入**（bind）。本文件不认识任何一个模式：
     故事模式 → 这一局的 state（跟着剧情存档走）
     模拟模式 → 账户存档那一个背包
   没绑宿主时退回模块内的一份默认状态，只有自检脚本会走到。

   它要读定义表（哪些指标、上限几个、默认参数是什么），所以 CS.indicators 已经建好之后才轮到它。
   由 game/js/indicators/registry.js 移植并拆分而来。 */
CS.define('core/indicators/indicatorState', ["core/indicators/indicatorColors"], function () {
  'use strict';
  /* 与另外两份一样拿同一块命名空间：CS.indicators 由注册表那份在末尾挂上，
     而本文件加载时它可能还没建好 —— 直接用 ns 才不会依赖加载顺序。 */
  const ns = CS.open('indicators');
  /* 定义表与夹取函数在 registry.js 里；这里只在**调用时**读，不在加载时取，
     所以两份文件谁先谁后都不会拿到 undefined（registry 先，定义已经注册完）。 */
  const R = () => CS.indicators;

  const blankState = () => ({ items: {}, panes: [] });
  /* 默认状态：全部关着、参数取定义里的默认值。
     新档 = normalize(null)，所以「新账号开局是什么样」在这一处就看得见。 */
  const defaultState = () => normalize(null);
  function normalize(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const srcItems = (src.items && typeof src.items === 'object') ? src.items : {};
    const out = blankState();
    ns.list().forEach(def => {
      const saved = srcItems[def.id] && typeof srcItems[def.id] === 'object' ? srcItems[def.id] : {};
      const maxLines = Math.max(1, Math.round(def.lines));
      const savedLines = Array.isArray(saved.lines) ? saved.lines : null;
      /* 条数：存档里有几条就用几条（夹在 1..maxLines 之间），没有就用定义的默认条数 */
      const wanted = savedLines
        ? Math.max(1, Math.min(maxLines, savedLines.length))
        : Math.max(1, Math.min(maxLines, def.defaults.length));
      const lines = [];
      for (let i = 0; i < wanted; i++) {
        const savedLine = savedLines && savedLines[i] && typeof savedLines[i] === 'object' ? savedLines[i] : null;
        const fallback = def.defaults[Math.min(i, def.defaults.length - 1)] || {};
        const line = {
          on: savedLine ? savedLine.on !== false : true,
          params: ns.cleanParams(def, savedLine && savedLine.params, fallback)
        };
        /* 自定义色：只认得出 #rrggbb / 旧版本写过的 [r,g,b] 才带上，认不出来的当作没改过色 */
        const color = savedLine ? ns.parseColor(savedLine.color) : null;
        if (color) line.color = ns.colorText(color);
        lines.push(line);
      }
      out.items[def.id] = { on: saved.on === true, lines };
    });
    /* 副图：按存档里的顺序收，最多三个、不许重复、id 必须真的是个 pane 指标 */
    (Array.isArray(src.panes) ? src.panes : []).forEach(id => {
      const def = ns.get(id);
      if (!def || def.kind !== 'pane' || out.panes.includes(id) || out.panes.length >= ns.MAX_PANES) return;
      out.panes.push(id);
      out.items[id].on = true;
    });
    /* 主图叠加：最多四个。老存档（或手改坏的存档）里多出来的按定义表的顺序留下前四个、
       其余关掉 —— 不静默丢弃、也不报错，玩家在指标栏里一眼看得到哪几个被关上了。 */
    let overlaysOn = 0;
    ns.list().forEach(def => {
      if (def.kind !== 'overlay' || !out.items[def.id].on) return;
      overlaysOn++;
      if (overlaysOn > ns.MAX_OVERLAYS) out.items[def.id].on = false;
    });
    return out;
  }
  /* 账户重置要保留指标设置时用：整份拷一份，免得新旧状态共用同一个对象 */
  const cloneState = raw => JSON.parse(JSON.stringify(normalize(raw)));

  /* 运行期读状态：账户存档还没建好时（只有测试脚本会碰到）退回一份默认状态 */
  /* 状态从哪来：**宿主注入**，本文件不认识任何一个模式。
     契约：host.state() 返回一个「背包」对象，指标的读写都落在 bag.indicators 上。
        故事模式 → 这一局的 state（跟着存档走）
        模拟模式 → 账户存档那一个背包
     没绑宿主（或宿主还没就绪）时退回一份模块内的默认状态，只有自检脚本会走到。
     这样指标引擎本身零依赖：不碰 DOM、不碰账户引擎、不碰任何模式。 */
  let fallbackState = blankState();
  let host = null;
  function bind(next) { host = next || null; return ns; }
  function state() {
    if (host && typeof host.state === 'function') {
      const bag = host.state();
      if (bag) {
        /* ★ 第一次拿到这个背包时，先用 normalize(null) 铺一份**完整的**默认状态，
           而不是 blankState()。两者的差别是致命的：blankState() 只有
           `{items:{}, panes:[]}`，而 setEnabled/itemOf 是按 id 去 items 里找那一格的 ——
           空 items 下每个指标都会被判成「unknown」，于是**一个指标都开不起来**、
           面板上全是关着的（而且不报错，只是点了没反应）。
           normalize(null) 会按定义表把 9 个指标的默认条目全部建出来。 */
        if (!bag.indicators || typeof bag.indicators !== 'object') bag.indicators = normalize(null);
        return bag.indicators;
      }
    }
    return fallbackState;
  }
  const itemOf = id => state().items[id] || null;
  const isEnabled = id => {
    const item = itemOf(id);
    return !!(item && item.on);
  };
  /* 现在主图上有几组叠加（= 开着的 overlay 指标个数）。上限判据与界面上那个「n / 4」都读它，
     所以「挡下第 5 个」与「面板上显示 4 / 4」永远是同一件事，不会各算各的。 */
  const overlayCount = () => {
    const current = state();
    return ns.overlayDefs().filter(def => current.items[def.id] && current.items[def.id].on).length;
  };
  /* 改状态一律走这几个入口：它们负责夹取与 revision，调用方只管存盘和重画 */
  const touch = () => { ns._revision++; ns._memo = null; };
  function setEnabled(id, on) {
    const def = ns.get(id);
    const item = itemOf(id);
    if (!def || !item) return { ok: false, reason: 'unknown' };
    const next = on !== false;
    if (!next) {
      if (def.kind === 'pane') {
        const panes = state().panes;
        const at = panes.indexOf(id);
        if (at >= 0) panes.splice(at, 1);
      }
      item.on = false;
      touch();
      return { ok: true, on: false };
    }
    if (def.kind === 'pane') {
      const panes = state().panes;
      if (!panes.includes(id)) {
        if (panes.length >= ns.MAX_PANES) return { ok: false, reason: 'max', max: ns.MAX_PANES };
        panes.push(id);
      }
    } else if (overlayCount() >= ns.MAX_OVERLAYS) {
      /* 主图叠加也封顶：第 5 个开不上，界面据此把勾选弹回去并说明原因 */
      return { ok: false, reason: 'max', max: ns.MAX_OVERLAYS };
    }
    item.on = true;
    touch();
    return { ok: true, on: true };
  }
  function setLineOn(id, index, on) {
    const item = itemOf(id);
    const line = item && item.lines[index];
    if (!line) return false;
    line.on = on !== false;
    touch();
    return true;
  }
  function setLineParam(id, index, key, value) {
    const def = ns.get(id);
    const item = itemOf(id);
    const line = item && item.lines[index];
    if (!def || !line) return false;
    line.params[key] = ns.clampParam(ns.specOf(def, key), value);
    touch();
    return true;
  }
  /* 改某一条线的颜色（用户自定义）。传任何 parseColor 认得的写法都行，存进去一律是 '#rrggbb'。 */
  function setLineColor(id, index, value) {
    const item = itemOf(id);
    const line = item && item.lines[index];
    const rgb = ns.parseColor(value);
    if (!line || !rgb) return false;
    line.color = ns.colorText(rgb);
    touch();
    return true;
  }
  /* 恢复默认色：把自定义色去掉，这一条线又回到调色板里它那个色号 */
  function resetLineColor(id, index) {
    const item = itemOf(id);
    const line = item && item.lines[index];
    if (!line) return false;
    if (line.color === undefined) return true;   /* 本来就没改过，不算失败 */
    delete line.color;
    touch();
    return true;
  }
  const lineColorOf = (id, index, itemIndex) => {
    const item = itemOf(id);
    return ns.lineColor(item && item.lines[index], itemIndex, index);
  };
  /* 加一条线：优先用「还没有人用过的那一组默认参数」（删掉 SMA5 再加回来就该是 SMA5），
     默认参数都用过了才退回照抄最后一条 —— 免得两条线标签一模一样、图例上分不清谁是谁。 */
  function addLine(id) {
    const def = ns.get(id);
    const item = itemOf(id);
    if (!def || !item) return false;
    if (item.lines.length >= Math.round(def.lines)) return false;
    const sameParams = (a, b) => (def.params || []).every(spec => Number(a[spec.key]) === Number(b[spec.key]));
    const used = item.lines.map(line => line.params);
    const fresh = def.defaults.find(candidate => !used.some(params => sameParams(params, candidate)));
    const last = item.lines[item.lines.length - 1];
    const fallback = def.defaults[Math.min(item.lines.length, def.defaults.length - 1)] || {};
    item.lines.push({ on: true, params: ns.cleanParams(def, fresh || (last ? last.params : null), fallback) });
    touch();
    return true;
  }
  function removeLine(id, index) {
    const item = itemOf(id);
    if (!item || item.lines.length <= 1) return false;   /* 至少留一条 */
    if (index < 0 || index >= item.lines.length) return false;
    item.lines.splice(index, 1);
    touch();
    return true;
  }
  /* 把第 index 条往前挪一格（+1）或往后挪一格（-1）。
     为什么要能挪：颜色是按「第几条线」取的（见 indicatorColors.colorSlots），
     而玩家心里那条线的顺序是「5 / 10 / 20 / 30 / 60」——
     想把第 5 条调成第 2 条时，只能删掉再加一条重填参数，而删掉会丢参数。
     只交换相邻两条，不动别的：一次一格，图上的顺序一眼看得出来。 */
  function moveLine(id, index, step) {
    const item = itemOf(id);
    if (!item) return false;
    const to = index + (step < 0 ? -1 : 1);
    if (index < 0 || index >= item.lines.length || to < 0 || to >= item.lines.length) return false;
    const moved = item.lines.splice(index, 1)[0];
    item.lines.splice(to, 0, moved);
    touch();
    return true;
  }
  /* 整组换掉一个指标的那几条线（页面内工具批量设置用）：
     按定义的上限截断、每条都过一遍参数夹取。list 里每项可以是 { period: 5 } 或 { on, params, color }。 */
  function setLines(id, list) {
    const def = ns.get(id);
    const item = itemOf(id);
    if (!def || !item || !Array.isArray(list) || !list.length) return false;
    const maxLines = Math.round(def.lines);
    const wanted = Math.max(1, Math.min(maxLines, list.length));
    const lines = [];
    for (let i = 0; i < wanted; i++) {
      const saved = list[i] && typeof list[i] === 'object' ? list[i] : {};
      const fallback = def.defaults[Math.min(i, def.defaults.length - 1)] || {};
      const line = { on: saved.on !== false, params: ns.cleanParams(def, saved.params || saved, fallback) };
      const color = ns.parseColor(saved.color);
      if (color) line.color = ns.colorText(color);
      lines.push(line);
    }
    item.lines = lines;
    touch();
    return true;
  }

  Object.assign(ns, {
    normalize, defaultState, cloneState, state, bind, blankState,
    /* 读/写「某条线现在是什么颜色」要问状态，所以归这一份：
       纯颜色的解析与色板在 indicatorColors.js。 */
    lineColorOf,
    /* 状态**改**的全部入口 + 它的读者。它们属于这一份，就在这里挂 ——
       别等 registry.js 去转（那份最后加载，而 CS.indicators 在它之前就发布了，
       晚挂上去的成员对「已经拿到引用的消费者」等于不存在）。 */
    isEnabled, overlayCount,
    setEnabled, setLineOn, setLineParam, setLineColor, resetLineColor,
    addLine, removeLine, moveLine, setLines,
    /* ★ touch 必须挂出来：它只做一件事 —— 版本号 +1 并清掉「这一帧算过了」的备忘。
       备忘录归 registry.js 算（computeFrame 拿版本号当缓存键），
       而**所有写状态的路都从本文件走** —— 少了这一格，registry.reset() 里那句
       `ns.touch()` 就是 undefined（现场实测：点「全部重置」抛
       TypeError: ns.touch is not a function）。后果不只是那一行崩掉：
       reset() 已经把 items / panes 换成了默认值（全关），但版本号没动、
       备忘也没清，于是**图表按缓存里的旧结果继续画** ——
       开关全弹回去了、设置确实清了，图上的线却一条不少地留着。
       这类「一半生效」的缺陷不报错、也不影响别的功能，最难被发现。 */
    touch
  });
  /* 见 indicatorColors.js 里的说明：三份文件共用同一块命名空间，
     每一份都确认 CS.indicators 指向它，谁先加载都不会留下 undefined。 */
  return { indicators: ns };
});
