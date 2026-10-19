/* ============ 通用小工具 ============
   ★ 这一层现在**建立在三个第三方库上**（vendor/，都是宽松许可）：
       lodash  —— clamp / cloneDeep / escape / keyBy / groupBy / uniq / sumBy / get / set
       he      —— HTML 实体转义
       dayjs   —— UTC 日期算术与格式化（pad2 / dateKey / daysBetween / addDays / addMonths）
     为什么不自己写：这几件是「人人都要、人人都写得不一样」的那一类，
     自己写只会到处长出略有差异的第二份（这个仓库里已经有过 `t` 抄八遍的先例）。
     库的语义是公开、有测试、有文档的；自己写的那一份只有我们自己知道边界在哪。

   ★ 但**有三样东西刻意留在本地**，不许换成库里的对应物：
     · stableStringify / fingerprint —— 它们是**存档与金标语料的身份**，
       被 artifacts/seed-matrix.json（2.4 MB 的 h 值）与 validate-content.mjs 的
       「加了角色之后旧种子的哈希不许漂移」钉着。
       换 json-stable-stringify 会变：它会把 undefined 值的键整个去掉，
       而这一份要吐出字面量 "key":undefined —— 哈希就全变了。
     · smoothStep —— 被 parity-jitter / check-grow 逐点比对（下面有实测读数）。
     · deepFreeze / readonly —— 共享内容库只读护栏，Proxy 语义要自己说了算。
   ================================================= */
CS.define('core/base/util', ["lib/dayjs","lib/he","lib/lodash"], function () {
  'use strict';

  /* 三个全局名来自 vendor/：装不上就直接抛。
     宁可开局就炸也不要「有一半函数是 undefined」——
     后者会在某个面板里表现成「点了没反应」，查半天查不到这里。 */
  const _ = window._;
  const dayjs = window.dayjs;
  const he = window.he;
  if (!_ || !dayjs || !he) {
    throw new Error('vendor 没装齐：core/base/util.js 需要 window._（lodash）、window.dayjs、window.he。见 index.html 的 vendor 段与 tools/check-vendor.mjs');
  }

  const clamp = (x, lo, hi) => _.clamp(x, lo, hi);
  const lerp = (a, b, t) => a + (b - a) * t;
  const num = (x, fallback) => (Number.isFinite(Number(x)) ? Number(x) : (fallback === undefined ? 0 : fallback));

  /* 深拷贝：内容库是「共享只读」，引擎必须拷贝后再改，
     否则一个角色的剧情改动会污染另一个角色（校验脚本会检测共享库被改写）。
     lodash 的 cloneDeep 比手写那份更强：循环引用、Date、Map/Set 都能处理。 */
  const clone = value => _.cloneDeep(value);

  function deepFreeze(value) {
    if (value === null || typeof value !== 'object') return value;
    Object.getOwnPropertyNames(value).forEach(k => deepFreeze(value[k]));
    return Object.freeze(value);
  }

  /* 内容库「共享只读」的运行时护栏：登记时冻结，
     谁想改就抛错，配合 tools/validate-content.ps1 的静态检查形成两道防线。 */
  function readonly(value, what) {
    deepFreeze(value);
    return new Proxy(value, {
      set() { throw new Error(`共享内容库是只读的：不许改写 ${what || '该条目'}`); },
      deleteProperty() { throw new Error(`共享内容库是只读的：不许删除 ${what || '该条目'} 的字段`); }
    });
  }

  /* ★ 不许换成 json-stable-stringify 之类的库：见文件头。
     口径：Object.keys().sort() 的代码单元序；undefined / 函数值**照原样参与拼接**。 */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }

  /* 简易哈希：只用于「把一段状态折成一个可比较的指纹」（验收要用逐字节一致的哈希）。 */
  function fingerprint(value) {
    const text = typeof value === 'string' ? value : stableStringify(value);
    let h1 = 0x811c9dc5, h2 = 0xc2b2ae35;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
    }
    return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
  }

  /* ---------- 日期：走 dayjs 的**本地时区**格式化 ----------
     ★ 为什么不用 dayjs.utc()：那是 dayjs 的 **UTC 插件**，而 vendor 里落地的只有
       核心（dayjs.min.js）。实测症状很典型 —— Node 侧的验收工具照常全绿
       （那些路径没走到日期），而真实浏览器里每一处日期都抛
       `dayjs.utc is not a function`，run-tests 的浏览器侧一次报出 14 条运行期异常。
       要么多 vendor 一个插件文件，要么用核心自带的 API：后者少一个文件、少一层
       版本耦合，而且**与旧实现同一口径**（旧的就是本地时区的 getFullYear/getMonth）。
     口径：`2025-01-14`（YYYY-MM-DD），与旧实现逐字相同；add/diff 也是核心 API。 */
  const pad2 = n => String(n).padStart(2, '0');
  const dateKey = d => dayjs(d).format('YYYY-MM-DD');
  const daysBetween = (a, b) => Math.round(dayjs(b).diff(dayjs(a), 'day', true));
  const addDays = (d, n) => dayjs(d).add(n, 'day').toDate();
  /* 加月份：dayjs 的 add(n,'month') 会把 1/31 + 1 个月**夹到月末**（2/28），
     而 Date.setMonth 会溢出到 3/2 —— 两者语义不同，这里取「夹到月末」，
     因为调用方（如果有）要的是「一个月之后」而不是「六十天之后」。 */
  const addMonths = (d, n) => dayjs(d).add(n, 'month').toDate();

  /* ============ 动画的两个公共零件（盘中抖动与「新 K 线长出来」共用） ============
     smoothStep —— 缓入缓出的那一条曲线：t²(3−2t)。
       两个动画共用同一条曲线是**故意的**：一拍里「实体长宽」与「价格跳动」要看起来同源，
       一条用线性、一条用缓动的话，两边在同一拍里各走各的节奏，观感是「两件事」。
       ★ 它**刻意不换成动画库的缓动函数**。试过 anime.js 的
         `cubicBezier(0.5, 0, 0.5, 1)`：直觉上「对称控制点 = smoothstep」，
         实测逐点最大偏差 0.056（t = 0.314）—— 因为三次贝塞尔的 x 分量本身要先解一次
         x(t)=u，y 并不等于 t²(3−2t)。而 tools/parity-jitter.mjs 拿这条曲线逐点比
         401 个采样点（容差 1e-9），换掉就是「动画看着差不多、数全变了」。
         这条路已经验过，别再试第二遍（读数见 docs/VENDOR.md）。
     nowMs —— 动画的时钟。**可以被注入**（`window.__chartClock`）：
       自动化探针要在逐帧检查动画时喂一个假时间（不然只能靠 sleep 撞帧率，测不稳）；
       没有注入时用 performance.now()。
       这两件都是从旧教程页 game/js/core/util.js 移植过来的 ——
       新引擎原先只有 Date.now()，于是「动画走到哪儿了」在探针里不可控。 */
  const nowMs = () => (Number.isFinite(window.__chartClock) ? window.__chartClock : performance.now());
  const smoothStep = t => t * t * (3 - 2 * t);

  /* HTML 转义：交给 he。语义与手写正则链一致（& < > " ' 五个）。
     ★ 两个参数都要，缺一个就变字面：
       · useNamedReferences:true —— `& < > "` 用**命名**实体
         （`&amp; &lt; &gt; &quot;`，全都是 HTML4 就有的）。
         关掉它 he 会输出 `&#38;` `&#60;` —— 浏览器等价，但这不是旧口径。
       · decimal:true —— 单引号走**数字**实体 `&#39;`；
         不然 he 会给 `&apos;`（HTML4 里不存在，HTML5 才有），
         而这里是逐字可比的位置（boot 的错误 HTML、shell 的 gate 文案）。
       两个开关合起来正好是旧实现那五条替换。这一条是 tools/check-util.mjs 抓出来的。 */
  const escapeHtml = text => he.encode(String(text == null ? '' : text), {
    useNamedReferences: true,
    decimal: true
  });

  const $ = id => document.getElementById(id);
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        /* ★ 事件名必须转小写。DOM 事件名是大小写敏感的，而内容与组件统一写
           `onClick` / `onInput` / `onKeyDown`；直接 `k.slice(2)` 会得到 'Click'，
           `addEventListener('Click', …)` **不报错、也不生效**。
           后果不是某个按钮失灵，而是**整个界面所有交互全死**：每一个按钮、
           每一个输入框都点不动、打不进字，而且控制台一声不响。
           这个 bug 能活这么久，是因为所有逻辑测试都不碰 DOM，而浏览器探针只用
           `window.__cs.switchMode()` 编程式切模式 —— 它渲染得出界面，但从不点按钮。 */
        node.addEventListener(k.slice(2).toLowerCase(), v);
      }
      else node.setAttribute(k, v === true ? '' : v);
    }
    /* ★ children 必须**任意深度**摊平，不能只摊一层。
       组件里 `el('div', {}, [a, X.map(...)])` 与 `el('div', {}, [[...]])` 都写得出来，
       而只摊一层的后果不是「多一层没画」，是 appendChild(Array) **当场抛 TypeError**：
       调用方常常是 ui/windows/index.js 里那个「先 clear(host) 再 .map 一整列窗口」的回调，
       异常一抛，整层窗口（银行/IM/浏览器）全没了，玩家连一条报错都看不到。
       flat(Infinity) 顺带把 null / false / undefined 也一并去掉（原行为一致）。 */
    if (children != null) (Array.isArray(children) ? children : [children])
      .flat(Infinity)
      .forEach(c => { if (c != null && c !== false) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

  /* 二维数组 → 稳定顺序的对象表（内容作者习惯写数组，引擎要 O(1) 查）。
     lodash 的 keyBy 同名同义，所以这里直接就是它。 */
  const indexBy = _.keyBy;

  /* 去抖：lodash 的 debounce（默认 trailing，与手写的「clearTimeout + 重新 setTimeout」
     逐字同义）。换它的理由不是少写两行 —— 是「取消」这件事从此有一个名字（.cancel()）：
     两个模式里那段手写版本各自要在卸载时再判一次 saveTimer 是不是 null，
     漏一处就是「已经离开这一局了，400ms 后还往 localStorage 写一次」。
     实测口径不变：400ms 静默窗口，连点下单只落一次盘。 */
  const debounce = (fn, wait, options) => _.debounce(fn, wait, options);

  const unique = _.uniq;
  function sum(list, pick) { return _.sumBy(list || [], item => num(pick ? pick(item) : item)); }
  function groupBy(list, pick) {
    /* lodash 的 groupBy 接受「属性名或回调」两种写法，行为与这里的旧实现一致：
       传字符串时按该字段分组，传函数时按返回值分组。 */
    return _.groupBy(list || [], pick);
  }

  /* ============ 键位归一：**全站唯一一份** ============
     两个模式共用同一张交易页，键位也必须逐字相同（空格前进 / ↑↓ 换交易对 / A 自动播放）。
     这里以前各写了一份：modes/story/keys.js 与 modes/classic/replay.js 各有一套
     KEY_ALIAS / keyOf / normalizeKey / isEntryTarget / layerOpen / KEY_LABEL ——
     而两份**已经漂移了**：replay 那份的 keyOf 少了 Digit 分支、KEY_ALIAS 少了
     spacebar/esc/enter/tab，于是同一个键在不同模式下的表现不一样。
     这条注释不是为了「少几行」，是为了让「同一个键在哪都一样」有个单一的落点。 */
  const KEY_ALIAS = {
    ' ': 'Space', space: 'Space', spacebar: 'Space',
    up: 'ArrowUp', arrowup: 'ArrowUp', '↑': 'ArrowUp',
    down: 'ArrowDown', arrowdown: 'ArrowDown', '↓': 'ArrowDown',
    esc: 'Escape', escape: 'Escape', enter: 'Enter', tab: 'Tab'
  };
  /* event → 规范键名（`event.code` 优先，与键盘布局无关） */
  function keyOf(event) {
    const code = String((event && event.code) || '');
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (code) return code;
    const key = String((event && event.key) || '');
    if (!key) return '';
    const alias = KEY_ALIAS[key.toLowerCase()];
    if (alias) return alias;
    return key.length === 1 ? key.toUpperCase() : key;
  }
  /* 键位表里写的那一行 → 规范键名（' ' → 'Space'、'a' → 'A'） */
  function normalizeKey(raw) {
    const text = String(raw == null ? '' : raw);
    const alias = KEY_ALIAS[text.toLowerCase()];
    if (alias) return alias;
    if (/^key[a-z]$/i.test(text)) return text.slice(3).toUpperCase();
    if (/^digit[0-9]$/i.test(text)) return text.slice(5);
    if (text.length === 1) return text.toUpperCase();
    return text;
  }
  /* 提示行里怎么念这三个键：两门语言里都是这三个写法，所以**不查语言包**是有意的 */
  const KEY_LABEL = { Space: '空格', ArrowUp: '↑', ArrowDown: '↓' };
  const keyLabelOf = key => KEY_LABEL[key] || key;
  /* 正在输入框里打字时不接管键位（回信文本框、保证金、委托价） */
  function isEntryTarget(node) {
    if (!node || !node.tagName) return false;
    const tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
  }
  /* 有整页遮罩开着（设置面板 / 结局卡 / 确认框）时不接管键位 */
  const layerOpen = () => !!document.querySelector('[class*="backdrop"]:not(.hidden)');

  return {
    util: {
      clamp, lerp, num, clone, deepFreeze, readonly, stableStringify, fingerprint,
      pad2, dateKey, daysBetween, addDays, addMonths, escapeHtml,
      /* 动画的两个公共零件：缓动曲线 + 可注入的时钟（见上面那段说明） */
      nowMs, smoothStep,
      $, el, clear, indexBy, unique, sum, groupBy, debounce,
      /* 键位归一（两个模式共用这一份，见上面的说明） */
      keyOf, normalizeKey, KEY_ALIAS, KEY_LABEL, keyLabelOf, isEntryTarget, layerOpen,
      /* 安全取点路径：'debt.totalRemaining' → state.debt.totalRemaining。
         用 lodash 的 get（语义一致：读不到就是 fallback，undefined 也当读不到）。
         ★ 调用方若要「先查字面键再退回点路径」，那是**调用方的**事：
           state.flags 是扁平对象、键名自带点（'story.left_job'），
           core/text/expr.js 的 readSpec 已经先做过 hasOwnProperty —— 别在这里加。 */
      path(obj, dotted, fallback) { return _.get(obj, dotted, fallback); },
      setPath(obj, dotted, value) { _.set(obj, dotted, value); return obj; }
    }
  };
});
