/* ============ 订单预览线：图上唯一可拖的那条 ============
   旧实现把这一格放在账户状态里（account/orders.js 的 previewPrice / setPreviewPrice），
   带两条规则，这里逐字照搬：

     · 读：存的值离现价太远（不足 0.1× 或超过 10×）或压根没有 → 落回现价。
       委托线总得在一个看得见的地方 —— 否则读档回来可能是一条画布外的线。
     · 写：按该交易对的精度取整（画出来的价与输入框里的价必须是同一个），
       并同样夹在现价的 0.1×–10× 之间。

   ★ 它同时是下单面板「委托价格」那一格的数：拖线与填数字改的是同一处。
   ★ 只存一处、面板与图都读它（见 tradeModel 的 previewPrice / tradePriceLines）。

   为什么单独一个文件：`modes/classic/replay.js` 压不住**当时**的 400 行上限了
   （tools/validate-content.ps1 的硬规则）。这一段是**自洽的一块**：它只认识
   「当前价 / 精度 / 存下来的那一格」，与回放、时钟、存档格式都无关。 */
CS.define('modes/classic/previewLine', ["core/market/marketData"], function () {
  'use strict';

  /* deps: { ready, now, instrumentId } —— instrumentId 是**取值的函数**，
     因为交易页里换品种不会去改模式手里那一格（那是面板的私有 ui）。 */
  function create(deps) {
    const draft = { previewPrice: 0 };

    /* 现价：光标那一根的收。读不到就返回 0，调用方各自兜底。 */
    function spotOf() {
      const id = deps.instrumentId();
      const bar = CS.marketData.loadSeries(id, { from: CS.marketData.nowIndex, to: CS.marketData.nowIndex })[0];
      return { id, entry: bar ? bar.c : 0 };
    }

    function clamp(price) {
      if (!deps.ready()) return Number.isFinite(price) && price > 0 ? price : 0;
      const { id, entry } = spotOf();
      const digits = CS.marketData.digitsOf(id);
      const round = v => Math.round(v * Math.pow(10, digits)) / Math.pow(10, digits);
      if (!(entry > 0)) return round(Math.max(Number(price) || 0, 1e-8));
      return round(Math.max(entry * 0.1, Math.min(entry * 10, Number(price))));
    }

    function price() {
      if (!deps.ready()) return draft.previewPrice;
      const { entry } = spotOf();
      const stored = Number(draft.previewPrice);
      if (!(entry > 0)) return Number.isFinite(stored) && stored > 0 ? stored : 0;
      if (!Number.isFinite(stored) || stored <= 0 || stored < entry * 0.1 || stored > entry * 10) return clamp(entry);
      return stored;
    }

    function set(value) {
      const next = clamp(Number(value));
      if (!Number.isFinite(next) || next <= 0) return price();
      draft.previewPrice = next;
      return next;
    }

    return {
      clamp, price, set,
      /* 存档要写的那一格（save 里原样取用） */
      get stored() { return draft.previewPrice; },
      restore(value) {
        if (Number.isFinite(Number(value))) draft.previewPrice = clamp(Number(value));
        return draft.previewPrice;
      }
    };
  }

  return { classicPreviewLine: { create } };
});
