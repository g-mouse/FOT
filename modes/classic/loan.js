/* ============ 模拟模式的周转借款（装配 + 存档） ============
   引擎在 core/engine/loanEngine.js（零 DOM、不认识模式）。这一层做三件事：
     · 按这一局的账户建出那本账（USD，fx = 1）；
     · 把交易页要的那几件收成一个稳定的 ctx.loan（面板靠它决定画不画那一块、
       以及「借入 / 偿还」两个动作往哪儿落）；
     · 跟着模式的存档进出（刷新之后欠款与利率都还在）。

   ★ 计息**不在 host.step 里**：那是两个模式共用的装配，往里塞一本只有模拟模式用的账，
   等于让故事模式也跟着跑一段它不需要的代码。利息由模拟模式的推进循环按根累 ——
   与「推进才发生时间」这条口径也一致（不推进就不计息）。 */
CS.define('modes/classic/loan', ["core/base/money","core/engine/loanEngine","core/events/events","modes/classic/settings"], function () {
  'use strict';

  const ns = CS.open('classic');
  let engine = null;
  let ctx = null;
  /* 授信协议是否已签。它和欠款一起存档：刷新之后签过的协议仍然有效；
     重置账户（reset）时一并清掉，下一次要重新面签。 */
  let signed = false;

  /* 显示货币 ↔ 内部最小单位：模拟模式一律 USD（fx = 1），与交易页同一套换算 */
  const toDisplay = units => CS.money.toDisplay(units, 1);
  const fromDisplay = amount => CS.money.fromDisplay(amount, 1);

  function ensure() {
    if (!engine) {
      if (!ns.host || !ns.host.account) return null;
      engine = CS.loanEngine.create({ account: ns.host.account, toDisplay, fromDisplay });
      /* 交易页拿到的那个对象**只建一次**（面板在挂载时读 ctx.loan 决定画不画那一块） */
      ctx = {
        max: engine.maxUnits(),
        totals: () => Object.assign({}, engine.totals(), { signed }),
        rateText: () => engine.rateText(),
        tiers: engine.TIERS,
        signed: () => signed,
        sign: () => {
          if (!signed) {
            signed = true;
            CS.events.bus.emit('loan.changed', {});
          }
          return signed;
        },
        borrow: units => engine.borrow(units),
        repay: units => {
          const result = engine.repay(units);
          /* 全额结清后，这一笔授信就结束了：下一次借款重新走面签接待。
             这不是「签名丢了一次」，而是产品口径 —— 每笔授信都要重新面签。
             部分清偿（debt 仍 >0）不重置，协议继续有效。 */
          if (result && result.ok && Number(result.debt) <= 0) {
            signed = false;
            CS.events.bus.emit('loan.changed', {});
          }
          return result;
        }
      };
      /* ★ 账本一动就要让界面跟上，并且**落盘**。
         少了这一条：借完钱之后那一行字还是「可用余额不够时可以借一笔」，
         存档里也还是旧欠款 —— 而两者都不报错，只是刷新一次欠款就没了。
         走的是既有的两条广播：trade.render 重画、trade.changed 让模式去抖落盘
         （模式已经订阅了后者，这里不另开一条存档路径）。 */
      CS.events.bus.onKey('loan.changed', 'classicLoanUi', () => {
        CS.events.bus.emit('trade.render', {});
        CS.events.bus.emit('trade.changed', {});
      });
    }
    return engine;
  }
  /* 交易页的 ctx.loan：拿不到（宿主还没建）时给 false —— 面板据此整块不画 */
  const ctxOrFalse = () => (ensure() ? ctx : false);

  ns.loan = {
    ensure, ctx: ctxOrFalse,
    /* 推进一根之后累这一根的利息（小时数由推进的人给，换算只在一处） */
    accrue: hours => (ensure() ? engine.accrue(hours) : 0),
    debt: () => (ensure() ? engine.debt : 0),
    serialize: () => {
      const raw = engine ? engine.serialize() : null;
      return raw ? Object.assign({}, raw, { signed }) : null;
    },
    restore: raw => {
      if (!ensure()) return null;
      /* 旧存档只有 debt、没有 signed：有欠款就视为协议已生效，避免老局还款后再被要求面签。 */
      signed = !!(raw && (raw.signed || Number(raw.debt) > 0));
      return engine.restore(raw);
    },
    reset: () => {
      signed = false;
      return engine ? engine.reset() : null;
    }
  };
  return { classicLoan: ns.loan };
});
