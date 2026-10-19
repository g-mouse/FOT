/* ============ 引导的文案（COPY） ============
   ★ 2026-10-04：产品口径改成「引导要看起来就是在主游戏里」，所以这一份**只剩中性文案**：
     结算横幅只说钱（不带点评腔），也没有任何一句写着「教程 / 引导 / 第几课」。
     老师的话、进度条读数、毕业卡、离开确认那一整套文案**都删掉了** ——
     对应的界面也已经不画（见 ui/components/tutorialGuide.js 的文件头）。
     底下保留的那几个键是**横幅与探针**还在读的（键名不能变，否则读的人拿到 undefined）。
   ★ 由 game/js/config/guide.js 按行区间**逐字搬来**（只换命名空间与文件头）。 */

CS.define('core/tutorial/copy', [], function () {
'use strict';

  /* ============ 文案 ============ */
  const COPY = {
    /* 结算横幅：**只说钱**。这一格是空串 —— 横幅上不出现任何「漂亮」「稳」这类点评，
       玩家要的判断依据是数字本身（明细在「结算记录」里照样查得到）。
       settledWin/settledLoss 仍是「按已下单数挑一句」的数组（session 用 pickCopy 读它），
       所以这里留一个空串而不是删掉整格。 */
    settledWin: [''],
    settledLoss: [''],
    hud: {
      /* 还在被读的几格 */
      equity: '账户权益',
      cash: '可用余额',
      funding: '资金费（预估）',
      /* ★ 下面两条**已经不会被念出来**了（对应的两处拦截按产品口径拿掉了：
         「有未平仓仓位时点 ⏏」不再拦、「该平仓时批量推进」不再拦）。
         留着键是为了不让老调用点读到 undefined —— 它们只影响一句 toast 的文案。 */
      closeFirst: '还有未平仓的仓位：先点持仓行右边的「平仓」把它平掉，再走。',
      closeBeforeAdvance: '先点持仓行右边的「平仓」结算，再往下推。'
    },
    /* 结算之后的点评：同样只说钱 */
    result: {
      win: (money, ratio) => `+${money}（保证金的 ${ratio}）`,
      loss: (money, ratio) => `${money}（保证金的 ${ratio}）`,
      liquidated: (money, ratio) => `${money}（保证金的 ${ratio}）：价格扫过强平价。`
    }
  };

  return { tutorialCopy: { COPY } };
});
