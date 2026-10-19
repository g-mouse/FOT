/* ============ 弹窗的正文渲染器（分节 / 明细行 / 输入框） ============
   旧教程页的强平说明、追保提示、开仓确认单都是同一个形状：
     icon + title + message + sections[{title, text} | {title, rows:[[标签, 值, 类]]}] + input + confirm
   这一层只把那个形状画成 DOM，**不做任何判断**（什么时候弹、按了什么按钮是调用方的事）。

   为什么单独一个文件：ui/components/modal.js 要管焦点、Esc、遮罩、队列，
   再塞进分节渲染会超过**当时**的单文件上限（400 行）；而且这两件事本来也可以分开看 ——
   一个「弹窗怎么开」，一个「弹窗里长什么样」。

   ★ 两列都用 textContent 写，**不拼 HTML**：明细行的值里有交易对与金额，
     拼字符串就等于把内容里的尖括号当成标签解释（旧实现也是这么做的，理由一样）。 */
CS.define('ui/components/modalBody', ["core/base/util","core/text/i18n"], function () {
  'use strict';
  const { el } = CS.util;

  /* sections: [{ title, text }] 或 [{ title, rows: [[label, value, cls]] }]，
     一行里也可以 { text } —— 与 rows 混着写 */
  function sections(list) {
    const box = el('div', { class: 'modal-sections' });
    (list || []).forEach(sec => {
      if (!sec) return;
      const block = el('section', { class: 'modal-section' });
      if (sec.title) block.appendChild(el('h3', { text: sec.title }));
      if (sec.text) block.appendChild(el('p', { class: 'modal-text', text: sec.text }));
      (sec.rows || []).forEach(row => {
        if (!row) return;
        const value = Array.isArray(row) ? row[1] : '';
        const cls = Array.isArray(row) && row[2] ? String(row[2]) : '';
        block.appendChild(el('div', { class: 'modal-row' }, [
          el('span', { text: Array.isArray(row) ? String(row[0] == null ? '' : row[0]) : '' }),
          el('strong', { class: `${cls} mono`.trim(), text: String(value == null ? '' : value) })
        ]));
      });
      box.appendChild(block);
    });
    return box;
  }

  /* 输入框：旧契约是 { label, value, min, max, step }，返回 { wrap, input } ——
     调用方要读它的值（确认键收到的就是 Number(input.value)）。 */
  function input(spec) {
    const s = spec || {};
    const node = el('input', {
      type: 'number', inputmode: 'decimal',
      value: s.value == null ? '' : String(s.value),
      min: s.min == null ? '1' : String(s.min),
      max: s.max == null ? '' : String(s.max),
      step: s.step == null ? '1' : String(s.step),
      'aria-label': s.label || ''
    });
    const wrap = el('label', { class: 'modal-input' }, [
      el('span', { text: s.label || '' }),
      el('div', { class: 'modal-input-shell' }, [node])
    ]);
    return { wrap, input: node };
  }

  /* 把一份 options 折成「正文 + 底部按钮」两块。返回值里的 inputNode 由 modal.js 读值。
     actions 的每一项 { label, cls, onClick, keepOpen } —— 与 modal.js 原有的约定一致。 */
  function build(options) {
    const o = options || {};
    const head = [];
    if (o.icon) head.push(el('span', { class: `modal-icon ${o.loss ? 'loss' : ''}`.trim(), text: String(o.icon) }));
    if (o.title) head.push(el('h2', { text: String(o.title) }));
    const body = el('div', { class: 'modal-body' }, [
      head.length ? el('div', { class: 'modal-head' }, head) : null,
      o.message ? el('p', { class: 'modal-message', text: String(o.message) }) : null,
      o.sections && o.sections.length ? sections(o.sections) : null,
      o.detail ? el('p', { class: `modal-detail ${o.preline ? 'preline' : ''}`.trim(), text: String(o.detail) }) : null
    ]);
    const inputSpec = o.input ? input(o.input) : null;
    if (inputSpec) body.appendChild(inputSpec.wrap);

    const actions = [];
    if (o.riskActions) {
      /* 追保那一档的两颗按钮（追加保证金 / 借款补仓）：文案与禁用判据由调用方给 ——
         这一层不知道账户上有多少钱，也不该知道 */
      body.appendChild(el('div', { class: 'modal-risk-actions' }, [
        el('button', {
          type: 'button', class: 'btn', text: o.riskActions.addLabel || '追加保证金',
          disabled: !!o.riskActions.addDisabled,
          onClick: () => o.riskActions.onAdd && o.riskActions.onAdd(inputValue(inputSpec))
        }),
        o.riskActions.onBorrow ? el('button', {
          type: 'button', class: 'btn', text: o.riskActions.borrowLabel || '授信提款',
          disabled: !!o.riskActions.borrowDisabled,
          onClick: () => o.riskActions.onBorrow && o.riskActions.onBorrow(inputValue(inputSpec))
        }) : null
      ]));
    }
    if (o.action) {
      actions.push({ label: o.cancelLabel || CS.i18n.t('ui.cancel'), cls: '' });
      actions.push({
        label: o.confirm || CS.i18n.t('ui.confirm'), cls: 'primary',
        onClick: () => o.action(inputValue(inputSpec))
      });
    } else {
      actions.push({ label: o.confirm || CS.i18n.t('ui.close'), cls: 'primary' });
    }
    return { body, actions, inputNode: inputSpec ? inputSpec.input : null };
  }
  const inputValue = spec => {
    if (!spec) return undefined;
    const n = Number(spec.input.value);
    return Number.isFinite(n) ? n : undefined;
  };

  return { modalBody: { sections, input, build } };
});
