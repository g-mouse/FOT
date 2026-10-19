/* ============ 动画设置（两个模式共用的一块界面） ============
   三件东西：自动播放间隔（一拍走多久）、模拟抖动开关、K线抖动随机次数（1×–5×）。

   ============ 为什么抽出来 ============
   这一块原本只存在于故事模式的设置面板里（modes/story/ui.js 的 animBlock），
   而模拟模式那一份在旧 iframe 的设置面板里（game/index.html 的 .animation-panel）——
   两处各写一遍，文案与档位表都在慢慢漂：旧那一边的档位是
   PLAY_OPTIONS（100…5000，八档），新这一边原本写死在同一段界面代码里。
   合并之后两个模式共用同一份，改档位/文案只动这里。

   ★ 这一层只造 DOM 与读设置，**不存设置**：
     设置住在哪由模式决定（故事在这局的 state.settings.anim，模拟在回放的存档里），
     改完由 onChange 交回模式 —— 落盘与「当场重起一轮抖动」都是模式的事。
     这样它就不必认识任何一个模式，也不必认识 localStorage。 */
CS.define('ui/components/animSettings', ["core/base/util","ui/components/bits"], function () {
  'use strict';
  const { el } = CS.util;
  const { button, muted } = CS.uiBits;
  const t = CS.uiBits.t;

  /* 档位表与旧引擎同一份（game/js/config/constants.js 的 PLAY_OPTIONS）；
     夹取区间在 core/animation/tickEngine.js 的 normalizeAnim 里（100–5000ms）。 */
  const PLAY_OPTIONS = [100, 300, 500, 1000, 1500, 2000, 3000, 5000];
  const JITTER_COUNTS = [1, 2, 3, 4, 5];

  /* 1000 → 1s、1500 → 1.5s、300 → 300ms（与旧面板同一套写法） */
  function msLabel(ms) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s` : `${ms}ms`;
  }

  /* options:
       anim      { jitter, jitterCount, playMs }   当前值（只读）
       onChange  patch => void                     改完交回模式（落盘 + 当场生效）
       resync    () => void                        可选：改完重开一次设置面板
                   （档位按钮要当场换高亮，而弹窗里的内容是快照 ——
                    不重开的话玩家会以为没点上。故事模式以前就是这么做的）
       note      可选：覆盖底部那行说明 */
  function build(options) {
    const o = options || {};
    const anim = o.anim || {};
    const set = patch => { if (o.onChange) o.onChange(patch); };
    const pick = n => {
      set({ jitterCount: n });
      if (o.resync) o.resync();
    };
    return el('div', { class: 'story-anim' }, [
      el('h4', { text: t('settings.anim') }),
      el('div', { class: 'row' }, [
        el('label', { class: 'small' }, [
          el('span', { text: t('settings.anim.playMs') }),
          el('select', {
            'aria-label': t('settings.anim.playMs'),
            onChange: e => set({ playMs: Number(e.target.value) })
          }, PLAY_OPTIONS.map(ms => el('option', {
            value: String(ms), text: msLabel(ms), selected: ms === anim.playMs
          })))
        ]),
        el('label', { class: 'small' }, [
          el('input', {
            type: 'checkbox', checked: anim.jitter !== false,
            onChange: e => set({ jitter: e.target.checked })
          }),
          el('span', { text: t('settings.anim.jitter') })
        ])
      ]),
      el('div', { class: 'row' }, [
        el('span', { class: 'small', text: t('settings.anim.jitterCount') }),
        el('div', { class: 'row' }, JITTER_COUNTS.map(n => button(
          `${n}×`, () => pick(n), anim.jitterCount === n ? 'primary' : ''
        )))
      ]),
      /* ★ 说明那一段只由调用方给（o.note）。coin 版没有任何调用方给，所以这一格
         整段不画 —— 设置面板里不再有说明性长文案。留这个口子是为了别把「可选说明」
         这件事从这里删干净（以后要加回一句，传 o.note 即可）。 */
      o.note ? muted(o.note, 'tiny') : null
    ]);
  }

  return { animSettings: { build, msLabel, PLAY_OPTIONS, JITTER_COUNTS } };
});
