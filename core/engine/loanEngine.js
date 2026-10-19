/* ============ 周转借款（模拟模式的那一本债，零 DOM） ============
   旧教程页的 account/loan.js + config/account.js 的 LOAN_MAX / loanDailyRate 搬过来。
   它是一本**独立的账**：借进来的是可用余额、欠出去的是这一笔本金加利息，
   改钱的唯一入口仍然是 account.applyDelta（这一层不许自己动 cash）。

   ============ 与故事模式那本债的分工 ============
   故事模式的债是**剧情**驱动的（分期、催收、逾期、影响结局，在 modes/story/debtEngine）。
   模拟模式没有剧情，需要的只是「周转」：借一笔、按日计息、随时还。
   两本账互不相干 —— 所以这一层不放进 core/engine/host.js 的共用装配里，
   而是由模拟模式自己建、自己推进、自己存档（故事模式一个字节都不受影响）。

   ============ 三条口径（与旧引擎逐条对齐）============
     · **同时只允许一笔**：还没还清时不能再借（旧实现的判据就是 state.debt > 0）；
     · **阶梯日利率**：借得越多利率越高（1 万以内万分之一，十万以上万分之四）——
       这条是教学内容的一部分（「周转的成本随规模上升」）；
     · **按小时累加、每满 24 小时折算一次**：`利息 = 欠款 × 日利率 × 小时/24`。
       推进是逐根 4 小时 K 线，所以每根累 4 小时，一天正好累满一次。 */
CS.define('core/engine/loanEngine', ["core/events/events"], function () {
  'use strict';

  /* 阶梯：按**显示货币**的借款额定档（与旧引擎同一张表） */
  const TIERS = [
    { max: 10000, daily: 0.0001 },
    { max: 50000, daily: 0.0002 },
    { max: 100000, daily: 0.0003 },
    { max: Infinity, daily: 0.0004 }
  ];
  const MAX_DISPLAY = 200000;      // LOAN_MAX：一笔最多借多少（显示货币）

  /* deps = { account, fromDisplay(n) -> 内部单位, toDisplay(units) -> 显示数 } */
  function create(deps) {
    const toDisplay = deps.toDisplay || (u => u);
    const fromDisplay = deps.fromDisplay || (d => d);
    let debt = 0, principal = 0, dailyRate = 0, seq = 0;

    const rateOfDisplay = amount => {
      const tier = TIERS.find(x => amount <= x.max);
      return tier ? tier.daily : TIERS[TIERS.length - 1].daily;
    };
    const rateOfUnits = units => rateOfDisplay(toDisplay(units));
    const maxUnits = () => Math.round(fromDisplay(MAX_DISPLAY));

    /* 借：钱进可用余额，欠款记在这一本账上。没还清时不许再借。 */
    function borrow(units) {
      const amount = Math.round(Number(units) || 0);
      if (!(amount > 0)) return { ok: false, why: '提款金额不合法。' };
      if (debt > 0) return { ok: false, why: '存在未结清授信：单笔授信存续期内不得再次提款。' };
      if (amount > maxUnits()) return { ok: false, why: `单笔提款不得超过 ${MAX_DISPLAY.toLocaleString('en-US')} USDT。` };
      const result = deps.account.applyDelta({
        amount, category: 'loan', reasonKey: 'reason.loanBorrow'
      });
      if (!result || result.ok === false) return { ok: false, why: (result && result.why) || '授信提款失败。' };
      debt = amount;
      principal = amount;
      dailyRate = rateOfUnits(amount);
      seq++;
      CS.events.bus.emit('loan.changed', { debt, principal, dailyRate });
      return { ok: true, debt, dailyRate };
    }
    /* 还：从可用余额里扣。还得起的部分先还本金，欠款降到 0 就是还清了。 */
    function repay(units) {
      const amount = Math.round(Number(units) || 0);
      if (!(amount > 0)) return { ok: false, why: '清偿金额不合法。' };
      if (debt <= 0) return { ok: false, why: '当前无未偿本息。' };
      const cash = deps.account.getSnapshot().cash;
      const pay = Math.min(amount, debt, cash);
      if (!(pay > 0)) return { ok: false, why: '可用余额不足以清偿，请先平仓释放保证金。' };
      const result = deps.account.applyDelta({
        amount: -pay, category: 'loan', reasonKey: 'reason.loanRepay'
      });
      if (!result || result.ok === false) return { ok: false, why: (result && result.why) || '授信清偿失败。' };
      debt = Math.round(debt - pay);
      /* 内部最小单位 100 = 1 美分；不足 1 美分的尾差直接核销。
         否则会出现「显示 $0.00、却因为 debt>0 不能再借」的死角
         （自动播放继续计息时，弹窗里预填的旧金额尤其容易留下这种尾差）。 */
      if (debt <= 100) { debt = 0; principal = 0; dailyRate = 0; }
      CS.events.bus.emit('loan.changed', { debt, principal, dailyRate });
      return { ok: true, paid: pay, debt };
    }
    /* 计息：按小时累加，四舍五入到内部最小单位。
       欠款为 0 时**什么都不做**（不 emit、不写盘）—— 绝大多数局是这一档。 */
    function accrue(hours) {
      const h = Number(hours) || 0;
      if (debt <= 0 || h <= 0) return 0;
      const interest = Math.round(debt * dailyRate * (h / 24));
      if (!interest) return 0;
      debt += interest;
      CS.events.bus.emit('loan.changed', { debt, principal, dailyRate });
      return interest;
    }
    const totals = () => ({
      totalRemaining: debt,
      principal,
      dailyRate,
      /* 与故事模式那份 debtTotals 同名同义：账户条那一格两个模式都读它 */
      monthlyInterest: Math.round(debt * dailyRate * 30),
      count: debt > 0 ? 1 : 0
    });
    const rateText = () => (((debt > 0 || dailyRate > 0 ? dailyRate : rateOfDisplay(toDisplay(Math.max(1, debt)))) * 100)
      .toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '% / 天');

    return {
      borrow, repay, accrue, totals, rateText, rateOfUnits, maxUnits, MAX_DISPLAY, TIERS,
      get debt() { return debt; },
      /* 存档：这一本是独立的账，跟随模式的存档走 */
      serialize: () => ({ debt, principal, dailyRate, seq }),
      restore(raw) {
        const d = raw && typeof raw === 'object' ? raw : {};
        debt = Math.max(0, Math.round(Number(d.debt) || 0));
        principal = Math.max(0, Math.round(Number(d.principal) || 0));
        dailyRate = Number(d.dailyRate) > 0 ? Number(d.dailyRate) : rateOfUnits(Math.max(1, debt || maxUnits()));
        seq = Math.max(0, Math.floor(Number(d.seq) || 0));
        return totals();
      },
      reset() { debt = 0; principal = 0; dailyRate = 0; return totals(); }
    };
  }

  return { loanEngine: { create, MAX_DISPLAY, TIERS } };
});
