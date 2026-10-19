/* ============ 图表周期选择器（4h / 8h / 12h / 1d / 3d / 1w） ============
   一排小按钮，点了就把图表切到那个周期。摆在图上方那一行（与原交易页一致）。

   ★ 周期表**不写在这里**：它从 CS.resample.TIMEFRAMES 读，所以加一档周期
     只要改 core/market/resample.js，这一排按钮自动多一个。
   ★ tutorial: false 的两档（3天 / 1周）默认不摆出来 —— 旧教程页就是这么做的
     （那两档太慢，教学里看不出东西）。要全部显示传 { all: true }。

   切换本身不动时间、不动价格、不影响成交：它只改「一根 K 线代表多久」。
   所以这一层只往外喊 onPick(id)，由交易页走意图层落状态。 */
CS.define('ui/components/tradeTimeframe', ["core/base/util","core/market/resample","ui/components/bits"], function () {
  'use strict';
  const { el } = CS.util;
  /* 文案取词走共享那一份（原先是 8 个面板各写一遍同样的包装） */
  const t = CS.uiBits.t;

  function mount(host, options) {
    const o = options || {};
    const root = el('div', { class: 'st-tf', role: 'group', 'aria-label': t('st.tf.aria') });
    const buttons = {};
    const list = CS.resample.TIMEFRAMES.filter(tf => o.all || tf.tutorial !== false);
    let current = CS.resample.tfOf(o.current || CS.resample.DEFAULT_TF).id;

    function sync() {
      list.forEach(tf => {
        const btn = buttons[tf.id];
        if (!btn) return;
        const on = tf.id === current;
        btn.classList.toggle('primary', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    list.forEach(tf => {
      const btn = el('button', {
        type: 'button', class: 'st-tf-btn', dataset: { tf: tf.id },
        /* 短名（4H / 1D）给按钮，完整名（4小时 / 1天）给 title 与读屏 ——
           窄屏下按钮只有二十几个像素，塞不下「12小时」 */
        text: tf.short,
        title: tf.label,
        'aria-label': tf.label,
        onClick: () => { current = tf.id; sync(); if (o.onPick) o.onPick(tf.id); }
      });
      buttons[tf.id] = btn;
      root.appendChild(btn);
    });
    sync();
    if (host) host.appendChild(root);

    return {
      root,
      /* 外部改了周期（读档、键位）时把按钮状态追回来 */
      /* 外部只用到 root / set / current：buttons 与 list 是本文件内部的零件，
         摆出来只会让人以为外面在用（原来是「导出了但没人调」）。 */
      set(id) { current = CS.resample.tfOf(id).id; sync(); },
      current: () => current
    };
  }

  return { tradeTimeframe: { mount } };
});
