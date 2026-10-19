/* ============ 模拟模式的设置面板（那一颗 ⚙ 打开的东西） ============
   旧教程页把这些拆成六块散在一张静态 HTML 里（GENERAL / 动画 / 图表 / 交易设置 /
   行情过滤 / 高级模式 / 悬浮窗与价格线），这一份把**已经搬进新引擎的那些**收在一处：
     一、这一局        数据集 / 期初现金 / 此刻可用余额 + 重置账户（底下还有「从头再学一遍」）
     二、动画设置      与故事模式共用同一块（ui/components/animSettings.js）
     三、图表          一屏几根 / 图表周期 / 一次「前进」走多久
     四、交易设置      开仓二次确认 / 强平弹窗通知 / 追保弹窗通知
     五、图上价格线    六条线各自开关 + 悬浮窗显示
   没搬过来的两块（行情过滤 skipDays/alignStart、高级模式 σ/VoV）**不在这里装作有** ——
   摆一排点了不算数的勾选框比不摆更糟。

   写入口只有一个：设置槽（modes/classic/settings.js 的 set）。
   它负责夹取、落盘、并广播一条事件，界面与交易页各自跟上 ——
   所以这一层不需要知道「改完之后谁要重画」。 */
CS.define('modes/classic/settingsPanel', ["core/base/money","core/base/util","core/events/events","core/market/filter","core/market/randomWalk","core/market/resample","modes/classic/settings","ui/components/bits","ui/components/modal"], function () {
  'use strict';

  const t = CS.uiBits.t;
  const { el } = CS.util;

  const BARS = [20, 30, 60, 120, 240];
  const STEPS = [{ h: 0, key: 'settings.step.auto' }, { h: 4, key: 'settings.step.4h' }, { h: 8, key: 'settings.step.8h' },
    { h: 12, key: 'settings.step.12h' }, { h: 24, key: 'settings.step.1d' }, { h: 72, key: 'settings.step.3d' }];
  const LINES = [
    ['showBreakEven', 'settings.line.breakEven'], ['showLiqLine', 'settings.line.liq'],
    ['showPendingLine', 'settings.line.pending'], ['showPreviewLine', 'settings.line.preview'],
    ['showLiqPreviewLine', 'settings.line.liqPreview'], ['showLiqPreviewOrder', 'settings.line.liqPreviewOrder']
  ];
  const TRADE = [
    ['confirmOpen', 'settings.trade.confirmOpen', 'settings.trade.confirmOpenHint'],
    ['liqNotice', 'settings.trade.liqNotice', 'settings.trade.liqNoticeHint'],
    ['marginCallNotice', 'settings.trade.marginCallNotice', 'settings.trade.marginCallNoticeHint']
  ];

  /* 一行勾选框：label 在左、开关在右。改完立刻生效（走设置槽），所以不必有「应用」键。 */
  function toggle(key, labelKey, hintKey, settings, onWrite) {
    const box = el('input', { type: 'checkbox', checked: settings.get(key) ? 'checked' : null });
    box.checked = !!settings.get(key);
    box.addEventListener('change', () => { settings.set(key, box.checked); if (onWrite) onWrite(key, box.checked); });
    return el('div', { class: 'set-row' }, [
      el('label', { class: 'set-label' }, [
        box,
        el('span', { text: t(labelKey) }),
        hintKey ? el('small', { class: 'set-hint', text: t(hintKey) }) : null
      ])
    ]);
  }
  /* 一排胶囊按钮：选中的那颗是 primary。value 与当前值相等就算选中。 */
  function pills(list, current, onPick) {
    return el('div', { class: 'set-pills' }, list.map(item => {
      const on = String(item.value) === String(current);
      const btn = el('button', { type: 'button', class: `btn ${on ? 'primary' : ''}`.trim(), text: item.label });
      btn.addEventListener('click', () => onPick(item.value));
      return btn;
    }));
  }
  function section(titleKey, children) {
    return el('section', { class: 'set-block' }, [el('h4', { text: t(titleKey) }), ...children]);
  }

  function open(deps) {
    const ns = deps.ns;
    const settings = CS.classicSettings;
    const bag = settings.bag();
    /* 改完要让交易页立刻重画（周期/根数/线开关都会换他画的东西） */
    const afterChange = () => { CS.events.bus.emit('trade.render', {}); };

    /* ---------- 一、本局信息 ----------
       ★ coin 版：数据集那一行（数据集 / 回放区间 / 复权口径）按需求去掉了 ——
       这一块只留能对账的数字（期初现金、可用余额、三项累计费用）与重置后果的说明。 */
    const thisRun = section('settings.group.run', [
      el('div', { class: 'grid-2' }, [
        CS.uiBits.kv(t('char.cashStart'), ns.host ? CS.money.format(ns.initialCash, 'USD') : '—'),
        /* 这一格显示的是**当前可用余额**，标签以前错用了 'trade.margin'（「投入保证金」）：
           同一个面板上面那行已经写了开局现金，这一行却把现金余额标成保证金。 */
        CS.uiBits.kv(t('trade.available'), ns.host ? CS.money.format(ns.host.account.getSnapshot().cash, 'USD') : '—'),
        CS.uiBits.kv(t('settings.lifetime.fee'), ns.host ? CS.money.format(ns.host.account.metrics().feesPaid, 'USD') : '—'),
        CS.uiBits.kv(t('settings.lifetime.funding'), ns.host ? CS.money.format(ns.host.account.metrics().fundingPaid, 'USD') : '—'),
        CS.uiBits.kv(t('settings.lifetime.liqFee'), ns.host ? CS.money.format(ns.host.account.metrics().liqFeesPaid || 0, 'USD') : '—')
      ]),
      el('p', { class: 'small muted', text: t('classic.settings.resetBody') })
    ]);

    /* ---------- 三、图表 ----------
       ★ 引导期间前两行（一屏 K 线根数 / 图表周期）**不画** —— 用户口径 2026-10-04：
       「教程模式的交易对选择、K 线周期、历史窗口长度都隐藏，其他模式不用」。
       这三样在引导里都是钉死的（课表按它们排、行情按它们铺），画出来就是一个
       改了也没用的开关。判据与交易页那两处同一份：session.uiVisible()，
       按下那颗 ⏏ 之后自动恢复（这一层拿到的是 ns.tutorial，不需要新的钩子）。
       「一次『前进』走多久」留着：它跟着周期走（跟随周期），不是被点名的那两样。 */
    const guideOn = !!(deps.tutorial && deps.tutorial.session && deps.tutorial.session.uiVisible());
    const chartBlock = section('settings.group.chart', [
      guideOn ? null : el('div', { class: 'set-row' }, [
        el('span', { class: 'set-label', text: t('settings.chart.bars') }),
        pills(BARS.map(n => ({ value: n, label: String(n) })), bag.bars, v => {
          settings.set('bars', Number(v)); afterChange(); reopen();
        })
      ]),
      guideOn ? null : el('div', { class: 'set-row' }, [
        el('span', { class: 'set-label', text: t('settings.chart.timeframe') }),
        pills(CS.resample.TIMEFRAMES.filter(tf => tf.tutorial !== false)
          .map(tf => ({ value: tf.id, label: tf.short })), bag.timeframe, v => {
          settings.set('timeframe', v); afterChange(); reopen();
        })
      ]),
      el('div', { class: 'set-row' }, [
        el('span', { class: 'set-label', text: t('settings.chart.step') }),
        pills(STEPS.map(s => ({ value: s.h, label: t(s.key) })), bag.stepHours, v => {
          settings.set('stepHours', Number(v)); afterChange(); reopen();
        })
      ])
      /* ★ coin 版：底部那句「以上三项只决定…」按需求去掉了（说明性长文案一律不画）。 */
    ]);

    /* ---------- 三b、行情过滤 ----------
       两个旋钮：过滤掉开头多少天、以及那几天从哪儿算起。
       它们改的是**可交易范围**（引擎会拒单），所以旁边的说明必须把后果写清楚。 */
    const filterBlock = section('settings.group.filter', [
      el('div', { class: 'set-row' }, [
        el('span', { class: 'set-label', text: t('settings.filter.days') }),
        pills(CS.marketFilter.SKIP_PRESETS.map(n => ({ value: n, label: n ? `${n} 天` : t('settings.filter.off') })),
          bag.skipDays, v => { settings.set('skipDays', Number(v)); afterChange(); reopen(); })
      ]),
      el('div', { class: 'set-row' }, [
        el('span', { class: 'set-label', text: t('settings.filter.origin') }),
        pills([{ value: true, label: t('settings.filter.align') }, { value: false, label: t('settings.filter.listing') }],
          bag.alignStart, v => { settings.set('alignStart', v === true || v === 'true'); afterChange(); reopen(); })
      ])
      /* ★ coin 版：底部那句「各交易对上市初期…」按需求去掉了（后果已由「隐藏开头 N 天」
         这个标签本身与拒单提示承担；说明性长文案一律不在面板里画）。 */
    ]);

    /* ---------- 三c、高级模式：随机波动 ----------
       在真实历史 K 线上再叠一层随机行情。改任一参数都**立刻重掷**（旧引擎同一套手感），
       「重新掷一次」就是把种子加一、换一条命运。 */
    const advBlock = section('settings.group.advanced', [
      toggle('randomOn', 'settings.adv.on', 'settings.adv.hint', settings, () => { afterChange(); reopen(); }),
      el('div', { class: 'set-row' }, [
        el('span', { class: 'set-label', text: t('settings.adv.sigma') }),
        pills(CS.randomWalk.SIGMA_PRESETS.map(v => ({ value: v, label: `${(v * 100).toFixed(1)}%` })),
          bag.sigma, v => { settings.set('sigma', Number(v)); afterChange(); reopen(); })
      ]),
      el('div', { class: 'set-row' }, [
        el('span', { class: 'set-label', text: t('settings.adv.vov') }),
        pills(CS.randomWalk.VOV_PRESETS.map(v => ({ value: v, label: String(v) })),
          bag.vov, v => { settings.set('vov', Number(v)); afterChange(); reopen(); })
      ]),
      el('div', { class: 'set-row' }, [
        el('span', { class: 'set-label', text: t('settings.adv.band') }),
        pills(CS.randomWalk.BAND_PRESETS.map(v => ({ value: v, label: v === 0 ? t('settings.adv.bandFree') : `${v}×` })),
          bag.randBand, v => { settings.set('randBand', Number(v)); afterChange(); reopen(); })
      ]),
      el('div', { class: 'set-row' }, [
        el('span', { class: 'set-label', text: t('settings.adv.seed', { n: bag.randSeed }) }),
        (() => {
          const btn = el('button', { type: 'button', class: 'btn', text: t('settings.adv.reroll') });
          btn.addEventListener('click', () => { settings.set('randSeed', bag.randSeed + 1); afterChange(); reopen(); });
          return btn;
        })()
      ]),
      el('p', { class: 'small muted', text: t('settings.adv.note') })
    ]);

    /* ---------- 四、交易设置 ---------- */
    const tradeBlock = section('settings.group.trade',
      TRADE.map(([key, labelKey, hintKey]) => toggle(key, labelKey, hintKey, settings, afterChange)));

    /* ---------- 五、图上价格线 ----------
       ★ 2026-10-19：交易悬浮窗整块删了，「显示交易悬浮窗」这一格跟着删 ——
       留给它只会变成「勾了没反应」的开关。 */
    const lineBlock = section('settings.group.lines',
      LINES.map(([key, labelKey]) => toggle(key, labelKey, null, settings, afterChange)));

    /* ---------- 二、动画设置（与故事模式共用同一块） ----------
       不再套一层 h4：animSettings 自己带标题，两个叠在一起会印出两行一样的字。 */
    const animBlock = el('section', { class: 'set-block' }, [
      ns.tick ? ns.tick.buildSettings() : el('div')
    ]);

    /* ---------- 六、新手引导：**面板里不画那一块**，但底下那颗「从头再学一遍」回来了 ----------
       ★ 2026-10-04 产品口径：引导不该在屏幕上留下「你在上课」的痕迹，而设置面板里
       那一段（标题 + 「离开新手引导」/「从头再学一遍」两颗按钮）正是最响的一句。
       于是 modes/classic/tutorial.js 的 `buildSettings()` 已经**整块删掉**了，
       这里也不再往面板里放那一格（原来那两行 `const guideBlock = null` 也一并去掉：
       留一个恒为 null 的变量在装配数组里，只会让下一个人以为那里本来有东西）。
       唯一的出口仍然是顶栏那颗 ⏏。
       ★ 2026-10-19：面板底部的 action 里补了一颗「从头再学一遍」（见下面 actions）——
         按过 ⏏ 的人没有任何别的路回到课表，用户报「教程没有渲染出来」时它能把人救回来。
         它只写六个字，不带「新手引导」这类标题，所以屏幕口径（CODE_RULES 第 10 条）没破。
       `deps.tutorial` 就是给这颗按钮用的（探针与自检也读它）。 */

    const body = el('div', { class: 'set-panel' }, [thisRun, animBlock, chartBlock, filterBlock, advBlock, tradeBlock, lineBlock]);
    /* 这几个块里有的按钮要求整张重画（胶囊按钮的选中态）—— 用同一个出口重开一次，
       而不是各自去改 class：只有一处知道「选中长什么样」。 */
    function reopen() { CS.uiModal.close(); open(deps); }
    CS.uiModal.open({
      title: t('classic.settings.title'),
      body,
      actions: [
        { label: t('ui.close'), cls: '' },
        /* 从头再学一遍：只动**教学进度**，不动账户余额（resetProgress 的语义）。
           ★ 2026-10-19 补回：按过 ⏏ 的人（left）没有任何别的入口能回到课表，
             用户报「教程没有渲染出来」时这就是那颗救回来的按钮。
             文案里不出现「新手引导 / 引导 / 教程」——那条屏幕口径还在（见 CODE_RULES 第 10 条）。 */
        {
          label: t('classic.settings.relearn'), cls: '',
          onClick: () => {
            const tut = deps.tutorial || (deps.ns && deps.ns.tutorial);
            if (!tut || !tut.restart) return;
            if (!tut.restart()) return;          /* 有持仓 / 挂单：restart 自己会说明原因 */
            CS.uiModal.close();
            CS.uiBits.toast(t('classic.settings.relearnDone'), 'pos', 5000);
          }
        },
        {
          label: t('classic.settings.reset'), cls: 'neg',
          onClick: () => {
            if (!ns.host) { CS.uiBits.toast(t('classic.loadFailed'), 'neg', 6000); return; }
            /* 不用 window.confirm：原生对话框样式不可控，而且会冻住渲染线程。
               走站内 modal，和追保 / 强平 / 授信同一套外观。 */
            CS.uiModal.confirm(
              t('classic.settings.reset'),
              t('classic.settings.resetConfirm'),
              () => {
                ns.replay.reset();
                CS.uiBits.toast(t('classic.settings.resetDone', { cash: CS.money.format(ns.initialCash, 'USD') }), 'pos', 6000);
                reopen();
              }
            );
          }
        }
      ]
    });
  }

  return { classicSettingsPanel: { open, BARS, STEPS, LINES, TRADE } };
});
