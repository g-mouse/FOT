/* ============ 货币与定点数 ============
   铁律：内部一律以整数最小单位记账，绝不用浮点存钱。
   理由不是洁癖 —— 债务引擎要跑 60 个月 × 多笔贷款的复利与摊销，
   浮点误差会累积到报表上，玩家会看到「本金+利息 ≠ 还款总额」，
   而 §5.4 第 4 条的验收要求误差 < 0.01 基准单位。

   记账口径：
     · 基准货币 USD，内部单位 = 1e-4 USD（记为 1 「点」，够容纳小额加密资产手续费）
     · 每个国家的货币只存在于展示层，换算走 countries.fxToUSD 与当期汇率
     · 所有乘法一律先放大再取整（round-half-up），不留下中间浮点。 */
CS.define('core/base/money', [], function () {
  'use strict';

  const SCALE = 10000;           // 1 USD = 10000 内部单位
  const DECIMALS = 4;

  function fromNumber(usd) { return Math.round((Number(usd) || 0) * SCALE); }
  function toNumber(units) { return (Number(units) || 0) / SCALE; }
  /* 汇率口径：`fxToUSD` 的语义是「**1 单位本币 = 多少美元**」（countries.js 里就是这么写的）。
     所以
       本币 → 内部单位：units = amount × fxToUSD
       内部单位 → 本币：amount = units ÷ fxToUSD
     这两行早期写反了，后果是「铁屿线长的 8,000 元现金」被算成 5.8 万美元 ——
     角色的起点差异（也就是难度曲线）会整体失真，而且不会报任何错。 */
  function fromDisplay(amount, fxToUSD) {
    const fx = Number(fxToUSD) || 1;
    return fromNumber((Number(amount) || 0) * fx);
  }
  function toDisplay(units, fxToUSD) {
    const fx = Number(fxToUSD) || 1;
    return toNumber(units) / fx;
  }

  function add(a, b) { return (Number(a) || 0) + (Number(b) || 0); }
  function sub(a, b) { return (Number(a) || 0) - (Number(b) || 0); }
  /* 乘法：内部单位 × 无量纲比率 */
  function mul(units, ratio) { return Math.round((Number(units) || 0) * (Number(ratio) || 0)); }
  /* 按基点（1 bp = 0.01%）算利息，避免 0.0001 这类比率在浮点里失真 */
  function bp(units, basisPoints) { return Math.round((Number(units) || 0) * (Number(basisPoints) || 0) / 10000); }
  function div(units, n) { const d = Number(n) || 0; return d === 0 ? 0 : Math.round((Number(units) || 0) / d); }
  function abs(u) { return Math.abs(Number(u) || 0); }
  function min(a, b) { return Math.min(Number(a) || 0, Number(b) || 0); }
  function max(a, b) { return Math.max(Number(a) || 0, Number(b) || 0); }
  function neg(u) { return -(Number(u) || 0); }

  /* 等额本息月供：M = P·r·(1+r)^n / ((1+r)^n − 1)
     r=0 时退化成 P/n（不能除以 0，也不能返回 NaN —— 验收第 5 条）。
     注意 Math.round(Infinity) === Infinity、Math.round(NaN) === NaN：
     它们会沿着 dueOf → monthlyDueOf → dueThisMonth 一路写进存档变成 null，
     所以最后一道必须是 Number.isFinite。 */
  function annuityPayment(principal, monthlyRate, months) {
    const P = Number(principal) || 0, r = Number(monthlyRate) || 0, n = Math.max(0, Math.round(Number(months) || 0));
    if (!Number.isFinite(P) || P <= 0) return 0;
    if (n <= 0) return 0;
    if (!Number.isFinite(r) || r <= 0) return Math.round(P / n);
    const pow = Math.pow(1 + r, n);
    const denom = pow - 1;
    if (!Number.isFinite(pow) || denom <= 0) return Math.round(P / n + P * r);
    const result = P * r * pow / denom;
    return Number.isFinite(result) ? Math.round(result) : Math.round(P / n + P * r);
  }
  /* 等额本金第 k 期（k 从 1 开始）= P/n + 剩余本金·r */
  function equalPrincipalDue(principal, monthlyRate, months, k) {
    const P = Number(principal) || 0, r = Number(monthlyRate) || 0, n = Math.max(1, Math.round(Number(months) || 1));
    const principalPart = Math.round(P / n);
    const remaining = Math.max(0, P - principalPart * (Math.max(1, k) - 1));
    return principalPart + Math.round(remaining * r);
  }

  /* 摊销表：逐月本金/利息分列，最后一个月把取整残差一次性吃掉，
     保证 Σ(本金) 恰好等于 P、Σ(本金+利息) 恰好等于 Σ(月供)。 */
  function amortize(principal, monthlyRate, months, kind) {
    const P = Math.max(0, Math.round(Number(principal) || 0));
    const r = Math.max(0, Number(monthlyRate) || 0);
    const n = Math.max(1, Math.round(Number(months) || 1));
    const rows = [];
    let remaining = P;
    const flat = Math.round(P / n);
    for (let k = 1; k <= n; k++) {
      const interest = Math.round(remaining * r);
      let principalPart, due;
      if (kind === 'interest_only') { principalPart = (k === n) ? remaining : 0; due = principalPart + interest; }
      else if (kind === 'equal_principal') { principalPart = (k === n) ? remaining : flat; due = principalPart + interest; }
      else { due = annuityPayment(P, r, n); principalPart = due - interest; if (k === n) principalPart = remaining; }
      if (principalPart > remaining) principalPart = remaining;
      if (principalPart < 0) principalPart = 0;
      remaining -= principalPart;
      rows.push({ k, due: principalPart + interest, principal: principalPart, interest, remaining });
      if (remaining <= 0 && k < n) {
        /* 提前清零：剩下的月份不再计息（真实贷款也是提前结清就停止计息） */
        for (let j = k + 1; j <= n; j++) rows.push({ k: j, due: 0, principal: 0, interest: 0, remaining: 0 });
        break;
      }
    }
    return rows;
  }

  const CURRENCY_META = {
    USD: { symbol: '$', digits: 2, prefix: true },
    CNY: { symbol: '¥', digits: 2, prefix: true },
    JPY: { symbol: '¥', digits: 0, prefix: true },
    KRW: { symbol: '₩', digits: 0, prefix: true },
    EUR: { symbol: '€', digits: 2, prefix: true },
    GBP: { symbol: '£', digits: 2, prefix: true },
    INR: { symbol: '₹', digits: 2, prefix: true },
    BDT: { symbol: '৳', digits: 2, prefix: true },
    NGN: { symbol: '₦', digits: 2, prefix: true },
    BRL: { symbol: 'R$', digits: 2, prefix: true },
    RUB: { symbol: '₽', digits: 2, prefix: true },
    TRY: { symbol: '₺', digits: 2, prefix: true },
    EGP: { symbol: 'E£', digits: 2, prefix: true },
    AED: { symbol: 'AED ', digits: 2, prefix: true },
    IDR: { symbol: 'Rp', digits: 0, prefix: true },
    VND: { symbol: '₫', digits: 0, prefix: false },
    PLN: { symbol: 'zł', digits: 2, prefix: false },
    ARS: { symbol: '$', digits: 2, prefix: true },
    KES: { symbol: 'KSh', digits: 2, prefix: true },
    CAD: { symbol: 'C$', digits: 2, prefix: true },
    MXN: { symbol: 'MX$', digits: 2, prefix: true },
    ZAR: { symbol: 'R', digits: 2, prefix: true }
  };

  function group(intText) {
    const s = String(intText);
    if (s.length <= 3) return s;
    let out = '', count = 0;
    for (let i = s.length - 1; i >= 0; i--) { out = s[i] + out; if (++count % 3 === 0 && i > 0) out = ',' + out; }
    return out;
  }

  function formatNumber(amount, digits) {
    const d = digits == null ? 2 : digits;
    /* 非有限数不能进 toFixed：'Infinity'.toFixed(2) 得到字符串 'Infinity'，
       再被 group() 按字符插逗号就成了「In,fin,ity」。词法里所有地方都写着
       「不得出现 Infinity/NaN 直接展示」，这里必须兜住。 */
    const n = Number(amount);
    const safe = Number.isFinite(n) ? n : 0;
    const negative = safe < 0;
    const fixed = Math.abs(safe).toFixed(d);
    const parts = fixed.split('.');
    return (negative ? '-' : '') + group(parts[0]) + (parts[1] ? '.' + parts[1] : '');
  }

  /* 展示层：内部单位 → 「¥1,240,000」。rate 是「1 USD 换多少该币」的当期汇率，
     缺省时用国家的名义汇率 —— 「显示用当期汇率、记账用内部单位」这条不能反过来。 */
  function format(units, currency, options) {
    const opts = options || {};
    const meta = CURRENCY_META[currency] || CURRENCY_META.USD;
    const fx = opts.rate == null ? (opts.fxToUSD ? 1 / opts.fxToUSD : 1) : opts.rate;
    const value = toNumber(units) * fx;
    const text = formatNumber(value, opts.digits == null ? meta.digits : opts.digits);
    if (opts.sign && value > 0) return `+${meta.prefix ? meta.symbol + text : text + meta.symbol}`;
    return meta.prefix ? meta.symbol + text : text + meta.symbol;
  }
  function formatUSD(units, options) { return format(units, 'USD', options); }

  /* ---------- 内容里写的金额 = **角色所在国的本币面值** ----------
     这是内容契约里最容易踩错的一条，所以做成一个具名函数：
     邮件选项、窗口流程、buff 的月收支，作者写的都是「这个人手里的钱」
     （织城女工写 2400 就是 2,400 塔卡，冠港交易员写 118000 就是 11.8 万美元）。
     引擎内部一律整数最小单位，所以每个入口都要过这一层换算。
     早期漏了这一步的后果是：一条「押金 3,500」的诈骗信在账上只扣掉 $0.35。 */
  function fxOfState(state) {
    if (!state) return 1;
    if (Number.isFinite(state.fxToUSD) && state.fxToUSD > 0) return state.fxToUSD;
    const table = (CS.content && CS.content.countries) || {};
    const country = Object.keys(table).map(k => table[k]).find(c => c.code === state.country);
    return country && country.fxToUSD ? country.fxToUSD : 1;
  }
  function fromState(state, localAmount) { return fromDisplay(localAmount, fxOfState(state)); }
  function toState(state, units) { return toDisplay(units, fxOfState(state)); }

  /* 指定货币的换算：buff 的效果可以用 currency 声明它写的是哪国钱
     （例如一条 CNY 计价的持仓上限）。找不到该货币时退回角色所在国。 */
  function fxOfCurrency(currency, state) {
    if (!currency) return fxOfState(state);
    const table = (CS.content && CS.content.countries) || {};
    const country = Object.keys(table).map(k => table[k]).find(c => c.currency === currency);
    return country && country.fxToUSD ? country.fxToUSD : fxOfState(state);
  }
  function fromCurrency(amount, currency, state) { return fromDisplay(amount, fxOfCurrency(currency, state)); }

  /* 百分比：债务利率等一律以「基点」存储，展示时才转 % */
  function formatBp(basisPoints, digits) {
    return formatNumber((Number(basisPoints) || 0) / 100, digits == null ? 2 : digits) + '%';
  }
  function formatPct(ratio, digits) { return formatNumber((Number(ratio) || 0) * 100, digits == null ? 2 : digits) + '%'; }

  return {
    money: {
      SCALE, DECIMALS, CURRENCY_META,
      fromNumber, toNumber, fromDisplay, toDisplay, fromState, toState, fxOfState, fromCurrency, fxOfCurrency,
      add, sub, mul, bp, div, abs, min, max, neg,
      annuityPayment, equalPrincipalDue, amortize,
      format, formatUSD, formatNumber, formatBp, formatPct,
      /* 快捷判断：金额是否为 0（报表里用它决定要不要显示一行） */
      isZero: u => Math.round(Number(u) || 0) === 0
    }
  };
});
