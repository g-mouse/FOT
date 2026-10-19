/* ============ 指标栏（勾选 / 参数 / 条数 / 颜色 / 顺序） ============
   教程页那张交易界面右侧有一栏指标开关，这一层就是它。
   零件只有它自己：一块 DOM 列（`.st-ind`），每行一个指标，结构照旧实现：

     行：            [✓] 名称 中文全称 ········  ↺(恢复默认)  +(展开)
        └ 展开后：说明
                  条数：显示 n / max 条  +  −
                  每条线一行：[✓ 第 n 条] [颜色] [↺ 恢复默认色] [周期: 输入框] [↑] [↓] [✕]

   ★ 指标**一项都不写死**：行、参数控件、条数上限、颜色全部按 CS.indicators 的定义表生成。
     加一个新指标只要往 core/indicators/ 丢一个文件、在 index.html 插一行，
     这一栏自动多出一行。

   ★ 写状态只走 CS.indicators 的入口（setEnabled / setLineOn / setLineParam /
     setLineColor / resetLineColor / addLine / removeLine / moveLine / lines /
     resetOne / reset）：本文件不自己改存档，也不自己算钱。
     改完调 onDirty()：交易页据此重算这一帧并落盘。

   ★ 取色控件用**平台原生的 <input type="color">**，颜色的解析/归一交给 **tinycolor2**（vendor/，MIT）：
     原生那个拖的时候看不到线上颜色在变，也不会吃设计令牌。接线的三条契约
     （类名/条数、'#rrggbb' 口径、拖动中只 dirty 不重画这一栏）写在 colorControl 上面。

   ★★ 那个「+ / −」按钮**必须与名字标签平级**，不能浮在它上面。
     原来的写法是 `.st-ind-more { float: right; margin: -22px 3px 0 0 }`，而同一行里
     名字那一段是 `flex: 1` 的标签（label，铺满整行）—— 实测结果：
     按钮 18×18 的矩形有 16×18 被标签盖住，`elementFromPoint` 打在按钮中心
     命中的是 `span.st-ind-cn`，**按钮只有最右边 2 像素可点**。
     同一行的 checkbox 正常可点，所以看上去「这一栏是好的」，只有展开参数点不动。
     现在行结构是 grid：`[label(checkbox+名字+中文全称) 撑杆] [按钮组 ↺ +]`，
     标签不再铺满、按钮组整块露出来（实测按钮四角与中心五点全部命中）。

   为什么要有「状态归属」这一层（attach）：
   引擎本身不认识任何模式，它要一个「背包」才读得到状态。所以每个模式在自己那边
   准备一格（故事模式 = 这一局的 state；模拟模式 = 回放存档那一格），
   由这里统一绑上去 —— 两个模式各写一遍绑定很容易漂移，
   而漂移的表现是「指标设置不跟着存档走」，不报错。 */
CS.define('ui/components/tradeIndicators', ["core/base/util","core/indicators/indicatorColors","core/indicators/indicatorState","core/indicators/registry","lib/lodash","lib/tinycolor2","ui/components/bits","ui/components/modal"], function () {
  'use strict';
  const { el, clear } = CS.util;
  /* 文案取词走共享那一份（原先是 8 个面板各写一遍同样的包装） */
  const t = CS.uiBits.t;

  /* 绑引擎与背包。host 给的是一个「背包」对象（引擎会往它上面挂 indicators）。
     ★ 宿主返回 null 时**不能**把 null 交回去：引擎在拿到空背包时会退回
       「模块内的一份默认状态」，于是指标栏点了有反应、界面也变了，
       但写进去的是那份**临时状态** —— 存档里什么都没有、图表也算不出东西。
       所以这里兜一个稳定的本地对象：实在没有归属时，至少这一局之内是自洽的。
     宿主还没就绪（比如模式状态比交易页晚建）也走这条兜底，等它好了再 attach 一次。 */
  const localBag = { indicators: null };
  let currentHost = null;
  let currentBag = localBag;

  function attach(host) {
    currentHost = host || null;
    /* ★ 绑定**之前**先把宿主的背包建起来（若它还是空的）。
       原因：引擎只在「背包.indicators 不是对象」时才自己铺默认状态，
       而它铺完是挂在**它拿到的那一个对象**上。先建一次，
       接下来所有写入就都落在这个真正会被存档带走的对象上；
       不先建的话，第一次写发生在引擎内部那份临时状态里，
       存档里永远是空的、图上永远没有线 —— 而点击是有反应的，最难查的那种。 */
    try {
      const bag = currentHost && typeof currentHost.state === 'function' ? currentHost.state() : null;
      if (bag && typeof bag === 'object' && (!bag.indicators || typeof bag.indicators !== 'object')) {
        bag.indicators = CS.indicators.normalize(bag.indicators);
      }
    } catch (_) { /* 宿主那一侧抛错就照旧走下面的兜底，不让指标栏把交易页带崩 */ }
    CS.indicators.bind({
      state: () => {
        try {
          const bag = currentHost && typeof currentHost.state === 'function' ? currentHost.state() : null;
          if (bag && typeof bag === 'object') { currentBag = bag; return bag; }
        } catch (_) { /* 同上：退回上一份可用的背包 */ }
        return currentBag;
      }
    });
    return CS.indicators.state();
  }

  /* 现在这一格「装备」在哪：调试与自动化用得着（例如确认设置落在了存档那一格） */
  function bag() { return currentBag; }

  /* 「这次重画之后要把焦点还给谁」。
     ★ 用模块级一格，而不是挂在每次 render 私有的对象上。
     踩过的坑（现场实测）：这类「待还焦点」原来是 render 里的局部对象，
     而一次改动会先通知交易页（重算 + 落盘，中间可能再触发一次重画），
     那一次重画读到的对象与「输入框事件里写下焦点的那一个」不是同一个 ——
     于是要还的焦点永远是 null、焦点静默丢失，表现就是「参数只能改一位」。
     写在一格上就没有这个歧义：谁最后改的，下一次重画就用谁的。 */
  let pendingFocus = null;
  const noop = () => {};
  /* 「改完的收尾」= 通知交易页 + 重画这一栏。
     ★ 它必须是**模块级的一格**，不能写成 mount 里的函数声明：
     render / lineControls / makeRow 是**模块级函数**（为了让 mount 短一点），
     它们按词法作用域根本看不到 mount 内部的名字 —— 在里面写 `function commit(){}`
     之后，render 里那句 `commit()` 会直接抛
     `ReferenceError: commit is not defined`（现场实测：一改参数就报这个，
     而且异常发生在一串 try/catch 中间，表现只是「图表不重画」）。
     所以：模块级一格，mount 的时候把它指到本实例的 render 上。 */
  let commit = noop;

  /* 一个按钮：`类名 + 记号 + 说明`。三处（展开、条数增减、每条线上那排小按钮）用同一份，
     免得每处各写一遍 title / aria-label —— 漏一个就是「读屏念不出这颗按钮在干什么」。 */
  function iconBtn(cls, glyph, label, onClick, extra) {
    const o = extra || {};
    return el('button', Object.assign({
      type: 'button', class: cls, text: glyph, title: label, 'aria-label': label,
      disabled: !!o.disabled, onClick
    }, o.attrs || {}));
  }

  /* 一条线的参数输入框们（按定义表的 params 生成）。
     ★ 绑 `input` 而不是 `change`：`change` 只在失焦时触发，而这里要的是
       「敲一个字符就生效、但**别**把玩家的手从键盘上甩开」——
       所以每个字符都写一次状态、并重画这一栏（重画之后把焦点还回去）。
       不还回去的后果实测过：改一位数 → 整栏重建 → 焦点掉到 body，
       第二个数字得重新点一次输入框，等于「参数只能改一位」。
       重画还有一个理由：夹取之后要把最终值写回输入框
       （输入 999 会看到 999，而引擎用的是 200 —— 界面与生效值必须是同一个数），
       以及「显示 n / max 条」这类文案要跟着变。 */
  function lineControls(def, line, lineIndex) {
    return (def.params || []).map(spec => {
      const input = el('input', {
        type: 'number', class: 'st-ind-param', dataset: { param: spec.key },
        value: String(line.params[spec.key]),
        min: spec.min == null ? '' : String(spec.min),
        max: spec.max == null ? '' : String(spec.max),
        step: spec.step == null ? (spec.int ? '1' : '0.01') : String(spec.step),
        title: spec.label || spec.key,
        'aria-label': `${def.name} ${t('st.ind.lineN', { n: lineIndex + 1 })} ${spec.label || spec.key}`,
        onInput: e => {
          CS.indicators.setLineParam(def.id, lineIndex, spec.key, Number(e.target.value));
          /* 记下「改完把焦点还到哪个输入框」——重画之后照它还回去。
             存的是**节点引用**：重画之后它已经被摘掉（isConnected 为假），
             所以它只当「哪个输入框」的坐标用，不能再 focus 它。 */
          pendingFocus = { id: def.id, line: lineIndex, key: spec.key, node: e.target };
          commit();
        }
      });
      return el('label', { class: 'st-ind-field' }, [
        el('span', { class: 'st-ind-field-k', text: spec.label || spec.key }),
        input
      ]);
    });
  }

  /* 哪些指标是展开的 —— 跨重画保留（那是「玩家的视线」，不该被一次重画收起来） */
  const expanded = new Set();

  /* 指标栏本体。api 是交易页那张契约（见 tradePanel.js 的文件头）；
     它只用到其中两样：ui() 读界面状态、refresh 相关由 onChanged 回调承担。 */
  function mount(api, host, options) {
    const o = options || {};
    /* ★ 「改完了要通知谁」是**每个实例自己的**，不能用模块级变量。
       踩过的坑（现场实测）：它原来是模块级一格，而 mount() 可能被调用多次
       （切模式、页签重建…），最后一次 mount 的参数会把前面那次的覆盖掉 ——
       于是指标栏的写入落在这一格上、而这一格指向的是**另一个实例**的回调，
       表现是「设置改了、界面也对，但图表不重画」。
       现在把回调随实例一起放进闭包：每个 mount 有自己的 onDirty。 */
    /* ★ 回调名是 **onChange**（单数）：交易页传的就是这个名字。
       这里曾经按 `onChanged` 取 —— 于是永远取不到、静默退回 noop，
       而它造成的现象极具误导性：勾选/改参数/全部重置**全都生效**
       （状态确实改了、界面也重画了），唯独**图表不重算**：
       图上的线一直停在上一帧（点「全部重置」后开关全弹回去，线却还在），
       而且一条错误都不报。所以这里两个名字都收，主用 onChange。 */
    const cb = typeof o.onChange === 'function' ? o.onChange
      : (typeof o.onChanged === 'function' ? o.onChanged : null);
    const onDirty = cb || noop;
    /* 一次改动的统一收尾：改状态（调用方做）→ 通知交易页重算落盘 → 重画这一栏。
       顺序不能反：先渲染再通知的话，界面上显示的是新值而图还是旧的（反过来也一样）。
       通知那一步兜住异常：指标这一栏出问题不该把交易页带下去（账目与下单照常）。 */
    const dirty = () => { try { onDirty(); } catch (_) {} };
    /* 把模块级那一格指向本实例（见文件里 noop 旁边的说明）。
       顺序不能反：先渲染再通知的话，界面上显示的是新值而图还是旧的（反过来也一样）。 */
    commit = () => { dirty(); render(); };

    /* ---------- 取色控件（原生 <input type="color"> + tinycolor2） ----------
       ★ 换掉的是什么：旧版用 vanilla-picker（ISC），按 js-mod 的纯 MIT 口径它进不了池子；
         池子里也没有 MIT 的取色器。所以这一格改用**平台自己的**取色控件 —— 它不是退路，
         而是正解：系统取色器在桌面与移动端都是玩家最熟的那一个。
       ★ tinycolor2（MIT，池子里有）接的是**颜色本身**：解析 / 归一 / 合法性。
         契约 2 要求写回 '#rrggbb' 小写 —— 旧版靠一条正则，现在交给 toHexString()
         （天然小写、天然六位），非法输入给 null 而不是写出一个坏颜色。
       ★ 三条必须保留的旧契约（与旧版逐字相同）：
         1) 类名仍然是 .st-ind-color，而且**每条线一颗** ——
            tools/trade-panel-probe.mjs 按这个类数控件数（colorInputs）。
         2) 写回的颜色仍然是 '#rrggbb' 小写（indicatorColors.js 的存档口径）。
         3) 拖动中只 dirty()（重画图）**不** commit()（重画这一栏）：
            后者会把正在拖的这个控件连同 DOM 一起换掉，松手就没了；
            松手（change）才 commit()。原生控件用 input 事件就能拿到拖动中的实时值 ——
            这正是旧版当初放弃原生控件的那条理由，现在它不成立了。 */
    function colorControl(def, index, rgb) {
      const hex = normalizeHex(CS.indicators.colorText(rgb)) || '#888888';
      const label = t('st.ind.color', { n: index + 1 });
      return el('input', {
        type: 'color', class: 'st-ind-color', value: hex,
        title: label, 'aria-label': label, dataset: { color: hex },
        /* 拖动中：只重画图。状态写不进去就别改界面 —— 界面与生效值必须是同一个数 */
        onInput: e => {
          const next = normalizeHex(e.target.value);
          if (!next) return;
          if (!CS.indicators.setLineColor(def.id, index, next)) return;
          e.target.dataset.color = next;
          dirty();
        },
        /* 松手：这一栏跟着重画（旧版是 picker.onDone） */
        onChange: e => {
          const next = normalizeHex(e.target.value);
          if (next) CS.indicators.setLineColor(def.id, index, next);
          commit();
        }
      });
    }

    /* 颜色归一：任何输入 → '#rrggbb' 小写；认不出来就 null（调用方自己决定退路） */
    function normalizeHex(value) {
      try {
        const c = tinycolor(String(value || ''));
        return c.isValid() ? c.toHexString() : null;
      } catch (_) { return null; }
    }

    const root = el('aside', { class: 'st-ind', 'aria-label': t('st.ind.aria') });
    /* 手机上的「展开 / 收起」：默认只露一行指标胶囊（开关直接可点），
       展开才是完整的参数 / 颜色 / 重置那一套 —— 2026-10-19 口径是
       「手机上要同时放下主图、副图和下单」，指标面板不能一上来就占 400px。
       桌面端这颗按钮被 CSS 藏掉，行为与原来完全一样。 */
    const toggle = el('button', {
      type: 'button', class: 'st-ind-toggle', 'aria-expanded': 'false', text: t('st.ind.expand'),
      onClick: () => {
        const open = root.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = t(open ? 'st.ind.collapse' : 'st.ind.expand');
      }
    });
    const head = el('div', { class: 'st-ind-head' }, [
      el('span', { class: 'st-kicker', text: t('st.ind.kicker') }),
      toggle,
      el('button', {
        type: 'button', class: 'st-ind-reset', text: t('st.ind.resetAll'), title: t('st.ind.resetAll'),
        onClick: () => CS.uiModal.confirm(t('st.ind.resetAll'), t('st.ind.resetAll.confirm'),
          () => { CS.indicators.reset(); dirty(); render(); })
      })
    ]);
    root.appendChild(head);
    const body = el('div', { class: 'st-ind-body' });
    root.appendChild(body);

    /* 重画之后按「哪个指标的哪条线的哪个参数」把输入框找回来。
       ★ 这里**不用**拼一长串属性选择器（`.st-ind-row[data-ind="x"] .st-ind-line[data-line="0"] …`）：
       实测它不成立 —— 属性值里的纯数字（`[data-line=0]`）在没有引号时是**非法选择器**，
       而带着引号拼字符串一旦被谁转义一次就变成 `[data-line=\"0\"]`（同样非法）；
       失败时 querySelector 抛异常、焦点静默丢失，表现就是「参数只能改一位」。
       所以改成「先取行、再逐层取」：每一层都按 dataset 比，不拼字符串。 */
    function findParamInput(id, lineIndex, key) {
      const row = Array.from(body.querySelectorAll('.st-ind-row')).find(n => n.dataset.ind === id);
      if (!row) return null;
      const line = Array.from(row.querySelectorAll('.st-ind-line')).find(n => Number(n.dataset.line) === Number(lineIndex));
      if (!line) return null;
      return Array.from(line.querySelectorAll('.st-ind-param')).find(n => n.dataset.param === key) || null;
    }
    /* 重画之后把焦点还回去（见 lineControls 的说明）。
       优先用原来那个节点的引用；它已经被 clear() 摘掉时按 dataset 回查。 */
    function restoreFocus() {
      const want = pendingFocus;
      if (!want) return;
      pendingFocus = null;
      const node = (want.node && want.node.isConnected) ? want.node : findParamInput(want.id, want.line, want.key);
      if (!node) return;
      try {
        node.focus();
        /* 数字输入框**不支持** setSelectionRange（会抛 InvalidStateError），
           所以光标位置那一步单独包一层 try：与 focus() 混在一起的话，
           抛错会把「已经聚焦成功」也当成失败，而且看不出是哪一步的问题。 */
        const caret = Math.min(node.value.length, Math.max(0, Number(want.caret) || 0));
        try { node.setSelectionRange(caret, caret); } catch (_) { /* number 类型：光标不可设，忽略 */ }
      } catch (_) { /* 拿不到焦点不算错：下一次点进来照常能改 */ }
    }

    function render() {
      /* 展开区的横向滚动位置：重画会把 DOM 换掉，不还回去就跳回最左边。
         必须在 clear() **之前**量 —— 量完就没了。 */
      const scrolls = {};
      Array.from(body.querySelectorAll('.st-ind-row')).forEach(row => {
        const box = row.querySelector('.st-ind-params');
        if (box) scrolls[row.dataset.ind] = box.scrollLeft;
      });
      /* 手机上这一栏是一行横向滚动的指标胶囊：点一颗就重画，不把滚动位置还回去
         会跳回最左边（想连开 MACD / RSI 时特别难受）。 */
      const bodyScroll = body.scrollLeft;
      clear(body);
      const I = CS.indicators;
      const list = I.list();

      /* ---------- 一行指标 ----------
         原来的实现把这一段直接写在 forEach 里；分成「主图叠加 / 副图」两组之后
         两处都要用它，所以抽成函数 —— 复制一份的话，改参数区就得记得改两处。 */
      function makeRow(def) {
        const item = I.state().items[def.id] || null;
        if (!item) return null;
        const isPane = def.kind === 'pane';
        const maxed = I.overlayCount() >= I.MAX_OVERLAYS;
        const blocked = !item.on && !isPane && maxed;
        const open = expanded.has(def.id);
        const check = el('input', {
          type: 'checkbox', class: 'st-ind-check', checked: !!item.on, disabled: blocked,
          'aria-label': def.name,
          onChange: e => {
            const r = I.setEnabled(def.id, e.target.checked);
            if (r && r.ok === false && r.reason === 'max') {
              /* 主图叠加 / 副图是两套上限，提示不能共用「主图」那一句；
                 副图满时说副图，避免把玩家引到错误的开关上。 */
              const key = def.kind === 'pane' ? 'st.ind.limitPane' : 'st.ind.limit';
              CS.uiBits.toast(t(key, { n: r.max }), 'neg', 5000);
            }
            commit();
          }
        });
        const row = el('div', {
          class: `st-ind-row${item.on ? ' on' : ''}${blocked ? ' blocked' : ''}`.trim(),
          dataset: { ind: def.id }
        }, [
          el('label', { class: 'st-ind-main' }, [
            check,
            /* 名字与中文全称都带 title：这一栏只有 176–208px，
               「指数平滑异同移动平均」这类长名字一定会被省略号截掉 ——
               截掉之后至少鼠标停上去要看得到全称（不然两个指标分不清谁是谁）。 */
            el('span', { class: 'st-ind-name', text: def.name, title: `${def.name} ${def.cn || ''}`.trim() }),
            /* 中文全称：「副图」这个标记没有了 —— 它现在由**分组标题**说明（主图叠加 / 副图），
               一行里再挂一个同义的标签是重复的（旧教程页就是这么分的两组）。
               ★ 撑杆是这一列的**最后一个**子元素，它吃满剩下的宽度，把中文全称挤到左边；
               它必须留在 label 里面 —— label 是第一列的唯一子元素。
               踩过的坑：把撑杆与按钮组平铺在 row 上时，grid 的 auto 列会按**每个子元素**
               各切一列（实测 `grid-template-columns: 71.19px 79.81px`），
               于是按钮组被当成「第二列的普通内容」、被挤成两行（行高从 29 变 47）。 */
            el('span', { class: 'st-ind-cn tiny muted', text: def.cn || '', title: def.cn || '' }),
            el('span', { class: 'st-ind-spacer', 'aria-hidden': 'true' })
          ]),
          /* 按钮组与主标签平级、占第二列（`auto`）：flex + nowrap 保证它整块、不折行。
             见文件头那段「+ 按钮被标签盖住」的说明。 */
          el('div', { class: 'st-ind-row-tools' }, [
            iconBtn('st-ind-icon', '↺', t('st.ind.resetOne'), () => {
              CS.uiModal.confirm(t('st.ind.resetOne'), t('st.ind.resetOne.confirm', { name: def.name }),
                () => { I.resetOne(def.id); expanded.delete(def.id); dirty(); render(); });
            }, { attrs: { dataset: { act: 'reset-one' } } }),
            iconBtn('st-ind-more', open ? '−' : '+', t('st.ind.params', { name: def.name }), () => {
              if (open) expanded.delete(def.id); else expanded.add(def.id);
              render();
            }, { attrs: { 'aria-expanded': open ? 'true' : 'false', dataset: { act: 'expand' } } })
          ])
        ]);
        /* 展开区：说明 + 条数 + 每条线一行（颜色 + 参数 + 顺序）。
           关着的指标也能展开看参数 —— 玩家常常是先调好再打开。 */
        if (open) {
          const box = el('div', { class: 'st-ind-params' });
          if (def.desc) box.appendChild(el('p', { class: 'st-ind-desc tiny muted', text: def.desc }));
          if (def.lines > 1) {
            box.appendChild(el('div', { class: 'st-ind-lines' }, [
              el('span', { class: 'tiny muted', text: t('st.ind.lineCount', { n: item.lines.length, max: def.lines }) }),
              iconBtn('st-ind-mini', '+', t('st.ind.addLine', { max: def.lines }), () => {
                I.addLine(def.id); commit();
              }, { disabled: item.lines.length >= def.lines }),
              iconBtn('st-ind-mini', '−', t('st.ind.removeLine', { n: item.lines.length }), () => {
                I.removeLine(def.id, item.lines.length - 1); commit();
              }, { disabled: item.lines.length <= 1 })
            ]));
          }
          item.lines.forEach((line, index) => {
            const colorInput = colorControl(def, index, I.lineColorOf(def.id, index, 0));
            const lineRow = el('div', { class: 'st-ind-line', dataset: { line: String(index) } }, [
              el('label', { class: 'st-ind-line-on' }, [
                el('input', {
                  type: 'checkbox', class: 'st-ind-line-check', checked: line.on !== false,
                  'aria-label': t('st.ind.lineN', { n: index + 1 }),
                  onChange: e => {
                    /* 这条线开不开 —— **不重画**：重画会把刚点的框换成新节点，
                       连点两下就有一半的点击落在已经被替换掉的节点上。 */
                    I.setLineOn(def.id, index, e.target.checked); dirty();
                  }
                }),
                el('span', { class: 'tiny', text: t('st.ind.lineN', { n: index + 1 }) })
              ]),
              colorInput,
              line.color ? iconBtn('st-ind-mini', '↺', t('st.ind.colorReset'), () => {
                I.resetLineColor(def.id, index); commit();
              }, { attrs: { dataset: { act: 'color-reset' } } }) : null,
              ...lineControls(def, line, index),
              /* 多线指标才有「上移 / 下移 / 删掉」：只有一条时这三颗按钮没有意义，
                 画出来反而让人以为可以删空。 */
              def.lines > 1 ? el('div', { class: 'st-ind-line-tools' }, [
                iconBtn('st-ind-mini', '↑', t('st.ind.moveUp', { n: index + 1 }), () => {
                  I.moveLine(def.id, index, -1); commit();
                }, { disabled: index === 0, attrs: { dataset: { act: 'up' } } }),
                iconBtn('st-ind-mini', '↓', t('st.ind.moveDown', { n: index + 1 }), () => {
                  I.moveLine(def.id, index, 1); commit();
                }, { disabled: index === item.lines.length - 1, attrs: { dataset: { act: 'down' } } }),
                iconBtn('st-ind-mini', '✕', t('st.ind.removeLine', { n: index + 1 }), () => {
                  I.removeLine(def.id, index); commit();
                }, { disabled: item.lines.length <= 1, attrs: { dataset: { act: 'remove' } } })
              ]) : null
            ]);
            box.appendChild(lineRow);
          });
          row.appendChild(box);
        }
        return row;
      }

      /* ---------- 两组：主图叠加 / 副图 ----------
         与旧教程页同一个分组（那一版的指标栏就是这两块，各带一个 `已开 / 上限` 的计数）。
         分组不是装饰：主图有 4 个的上限、副图有 3 个的上限，**两套上限互不相干** ——
         混在一列里玩家看不出「我还能再开几个、剩的是哪一类」。 */
      const groups = [
        { key: 'overlay', label: t('st.ind.group.overlay'), on: I.overlayCount(), max: I.MAX_OVERLAYS,
          items: list.filter(def => def.kind !== 'pane') },
        { key: 'pane', label: t('st.ind.group.pane'), on: I.state().panes.length, max: I.MAX_PANES,
          items: list.filter(def => def.kind === 'pane') }
      ];
      groups.forEach(group => {
        if (!group.items.length) return;
        const listNode = el('div', { class: 'st-ind-list', dataset: { group: group.key } });
        group.items.forEach(def => { const row = makeRow(def); if (row) listNode.appendChild(row); });
        body.appendChild(el('div', { class: 'st-ind-group', dataset: { group: group.key } }, [
          el('div', { class: 'st-ind-group-head' }, [
            el('span', { text: group.label }),
            el('i', { class: 'mono', text: `${group.on} / ${group.max}` })
          ]),
          listNode
        ]));
      });
      restoreFocus();
      Object.keys(scrolls).forEach(id => {
        const box = body.querySelector(`.st-ind-row[data-ind="${id}"] .st-ind-params`);
        if (box) box.scrollTop = scrolls[id];
      });
      if (bodyScroll) body.scrollLeft = bodyScroll;
    }

    host.appendChild(root);
    render();
    return {
      root,
      /* 状态可能在别处被改（重置、读档、模式切换），所以给一个显式重画入口 */
      refresh: render,
      setExpanded(id, on) { if (on) expanded.add(id); else expanded.delete(id); render(); }
    };
  }

  return { uiTradeIndicators: { mount, attach, bag } };
});
