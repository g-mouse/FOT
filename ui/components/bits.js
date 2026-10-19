/* ============ UI 公共零件 ============
   ui/components/* 里的每个文件都只做一件事：把状态画成 DOM，把点击变成意图。
   规矩（§5.1 架构洁净度）：
     · 面板层只读状态、只发意图（dispatch(action)），不许直接改 state.cash
     · 所有钱都通过 CS.money.format 展示，不在面板里做算术
     · 需要钱变动的按钮一律走回调，由故事模式去 applyDelta */
CS.define('ui/components/bits', ["core/base/money","core/base/util","core/content/index","core/text/i18n","lib/lodash","lib/toastify-js"], function () {
  'use strict';
  const { el, clear, escapeHtml, clamp } = CS.util;

  function card(title, children, extraClass) {
    return el('div', { class: `card ${extraClass || ''}`.trim() }, [
      title ? el('h3', { text: title }) : null,
      ...(Array.isArray(children) ? children : [children])
    ]);
  }
  function row(children, cls) { return el('div', { class: `row ${cls || ''}`.trim() }, children); }
  function grid(children, cols) { return el('div', { class: `grid-${cols || 2}` }, children); }
  /* tag(text, title)：title 用于「显示名是中文、原始 id 是英文」的场合（buff 标签）——
     鼠标停在上面能看到原始 id，方便对着内容库查。省略时行为与以前完全一样。 */
  function tag(text, title) {
    return el('span', { class: 'tag', text, title: title || null });
  }
  function pill(text, cls) { return el('span', { class: `pill ${cls || ''}`.trim(), text }); }
  function muted(text, cls) { return el('span', { class: `muted ${cls || ''}`.trim(), text }); }
  function button(label, onClick, cls) {
    return el('button', { type: 'button', class: `btn ${cls || ''}`.trim(), text: label, onClick });
  }
  function kv(label, value, valueClass) {
    return el('div', { class: 'row between small' }, [
      el('span', { class: 'muted', text: label }),
      el('span', { class: `mono ${valueClass || ''}`.trim(), text: value })
    ]);
  }
  function empty(text) { return el('p', { class: 'muted small', text }); }

  /* 正负号 + 颜色 + 符号三重表达（色盲友好：不只靠红绿） */
  function signed(units, formatter) {
    const text = (formatter || (u => String(u)))(units);
    const cls = units > 0 ? 'pos' : units < 0 ? 'neg' : 'muted';
    const mark = units > 0 ? '▲ ' : units < 0 ? '▼ ' : '— ';
    return el('span', { class: `${cls} mono`, text: mark + text });
  }

  /* 折叠块：明细一律可展开（「为什么这个月少了 4,120」） */
  function details(summaryText, buildBody, open) {
    const node = el('details', open ? { open: true } : {});
    node.appendChild(el('summary', { text: summaryText }));
    node.appendChild(el('div', { class: 'details-body' }, buildBody()));
    return node;
  }

  function table(headers, rows) {
    const t = el('table', { class: 'ui-table' });
    const thead = el('thead');
    const tr = el('tr');
    headers.forEach(h => tr.appendChild(el('th', { text: h })));
    thead.appendChild(tr);
    t.appendChild(thead);
    const tbody = el('tbody');
    rows.forEach(r => {
      const rowEl = el('tr');
      r.forEach(cell => rowEl.appendChild(el('td', {}, [typeof cell === 'string' ? document.createTextNode(cell) : cell])));
      tbody.appendChild(rowEl);
    });
    t.appendChild(tbody);
    return t;
  }

  function progress(value, max, cls) {
    /* 夹取走 CS.util.clamp（lodash）—— 与 modes/ 里那几处同一个语义 */
    const pct = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
    return el('div', { class: 'statbar-track' }, [
      el('div', { class: `statbar-fill ${cls || ''}`.trim(), style: `width:${pct.toFixed(1)}%` })
    ]);
  }

  /* 通知条：入队 / 出场 / 自动消失交给 **Toastify**（vendor/，MIT）。
     为什么换：原先这 8 行里有三件手写的小事 —— 追加节点、setTimeout 摘掉节点、
     多条同时来时的堆叠 —— 每加一处调用点都要重新想一遍「它会不会叠在一起」。
     库把这三件收在一处，并且带「鼠标停在上面时不消失」（stopOnFocus），
     对「刚点完就没看到提示」这类抱怨是直接有效的。

     ★ 两条**必须**保留的旧契约：
       1) duration 默认 4200ms（十几处调用点依赖它，有的显式传 8000）
       2) 仍然挂在 #toastRoot 上（index.html 那句 aria-live="polite" 是屏幕阅读器的入口）
       3) 视觉仍然走 .toast / .toast.pos / .toast.neg 这一套类与设计令牌
          （shell.css 里那 4px 左边框、180ms 滑入都不动），所以观感与旧实现一致。 */
  function toast(text, kind, duration) {
    const root = document.getElementById('toastRoot');
    if (!root) return null;
    const ms = duration == null ? 4200 : duration;
    if (window.Toastify) {
      const node = window.Toastify({
        text: String(text == null ? '' : text),
        duration: ms,
        className: `toast ${kind || ''}`.trim(),
        selector: root,
        gravity: 'bottom',
        position: 'right',
        stopOnFocus: true
        /* ★ 这里**不再**传 style 覆盖。
           原来传的是 `{ background: 'transparent', boxShadow: 'none', padding: '0', borderRadius: '0' }`，
           注释写的理由是「关掉库自带的那一段配色与投影，观感由 .toast 那一套令牌说了算」。
           可是这一份 vendor 里的 toastify **根本没有自带外观**（见它的 defaults：
           `backgroundColor: ''`、`style: {background: ''}`，也不注入任何样式表），
           而库把 className **和** style 都加在**同一个元素**上（toastify.js:114 与 :140）——
           内联样式永远赢过类规则。于是那一段实际干的事是**反过来的**：
           它把 .toast 的 `background: var(--card)`、`border-radius`、`padding`、`box-shadow`
           全压成了空 —— 通知框变成透明的一张纸（用户报的「这个类别的对话框是透明的」）。
           去掉之后 .toast / .toast.pos / .toast.neg 那一套令牌原样生效：不透明、有圆角、
           有左边那道 4px 的语义色边。 */
      });
      node.showToast();
      return node.toastElement || node;
    }
    /* vendor 缺失时的退路：原来那 5 行 */
    const fallback = el('div', { class: `toast ${kind || ''}`.trim(), text });
    root.appendChild(fallback);
    setTimeout(() => { if (fallback.parentNode) fallback.parentNode.removeChild(fallback); }, ms);
    return fallback;
  }

  function fmtMoney(units, state) {
    /* ★ 这一行原来写的是 `Object.values(CS.content.countries).find(c => c.code === state.country)` ——
       而 fmtMoney 是**每次渲染金额**都会走到的路径：每次调用都新建一个 22 元素的数组再线性找。
       同样的写法在 statBar.js 与 tradeModel.js 里各还有一份。
       现在走 core/content/index.js 建一次的 O(1) 索引。 */
    const country = state ? CS.contentIndex.country(state.country) : null;
    return CS.money.format(units, (state && state.currency) || 'USD', { fxToUSD: country ? country.fxToUSD : 1 });
  }

  /* 文案取词的**统一入口**。原来 8 个面板各自写一遍
     `const t = (key, params) => CS.i18n.t(key, params);` —— 一样的东西抄八遍，
     想加个「缺键时记一条」之类的行为就得改八个地方。面板里写 `const { t } = CS.uiBits;` 即可。 */
  const t = (key, params) => CS.i18n.t(key, params);

  /* localStorage 里存一小块 JSON（悬浮窗位置、开合状态…）。
     每一个都要「解析失败当作没有」+「写入失败不抛」—— 这两条兜底原来在
     mailFloat / tradeFloat / persist 各写了一遍（读两处、写三处）。
     ★ 兜底是**必须**的：localStorage 在隐私模式、或者配额满时会直接抛，
       而「存不下一个浮窗位置」绝不该把整个界面带崩。 */
  function storage(key) {
    return {
      get() {
        try {
          const raw = localStorage.getItem(key);
          const parsed = raw ? JSON.parse(raw) : null;
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) { return {}; }
      },
      set(value) {
        try { localStorage.setItem(key, JSON.stringify(value || {})); } catch (_) {}
      }
    };
  }

  return {
    uiBits: {
      card, row, grid, tag, pill, muted, button, kv, empty, signed, details, table, progress, toast, fmtMoney,
      t, storage
    }
  };
});
