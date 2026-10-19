/* ============ 交易页与「动画零件」之间的接线（两个模式共用） ============
   三件零件，都由模式通过 ctx 注入（不给就整段静态、成本为 0）：
     ctx.ticks / ctx.displayPrice   盘中抖动：最新那根的价与影线逐帧在走
     ctx.grow                       新 K 线长出来：实体从极细长到满宽
     ctx.pulse                      波纹：摸到折返点时从现价扩散一圈

   为什么单独一个文件：这三条接线住在 ui/components/tradePanel.js 里，
   而那个文件挨着「当时单文件 ≤ 400 行」那条硬约束（加完就 408 行）。
   更实际的理由是**它本来就不是装配层的事**：装配层负责「把界面挂上去」，
   而这里做的是两个契约之间的翻译 ——
     模式给的  displayBar(品种, 那根 K 线)   它要按品种查这一根的动画
     图表问的  displayBar(那根 K 线)        它一次只画屏幕上这一个品种
   翻译收在一处，改契约时只动这一个文件。

   ★ 波纹的**推进**（每帧一次）也在这里：它是唯一同时拿得到帧事件与脉冲驱动的地方。
   推进不放在绘图里 —— 画一帧就把强度衰减一次的话，重画次数会改变观感
   （窗口缩放、切页签都会多画几帧，波纹就会提前消失）。
   订阅回调自己兜住异常：抛出去会被事件总线吞掉，表现是「波纹不动」而没有任何错。 */
CS.define('ui/components/tradeAnim', ["lib/lodash"], function () {
  'use strict';

  /* 读数刷新（抖动期间）的节流：≈25fps。K 线本身是每帧画的；
     2026-10-19 用户口径要求「现价跟着 K 线抖动变化」，80ms（12fps）看着还是一顿一顿，
     收到 40ms 之后行情列表与图表标题都能贴着蜡烛跳。 */
  const READOUT_MS = 40;

  /* ctx         模式的上下文（读 ticks / grow / pulse / displayPrice）
     chart       交易页的图表零件（有没有 setAnimDrivers 由它决定）
     instrumentId()  当前品种（图表一次只画一个品种，模式那边按品种查动画）
     listeners   面板的退订清单（推进订阅要跟着页面一起收掉）
     返回：是否接上了 */
  function attach(ctx, chart, instrumentId, listeners) {
    const c = ctx || {};
    if (!chart || typeof chart.setAnimDrivers !== 'function') return false;
    const ticks = c.ticks || null;
    chart.setAnimDrivers({
      tick: ticks ? {
        active: () => ticks.active(),
        displayBar: bar => ticks.displayBar(instrumentId(), bar),
        /* ★ 直接把回调转下去，**不要**在这里给固定 key 或去重：
           帧事件的订阅者不止一个（图表重画一路、模式那边一路、探针一路），
           用同一个 key 订阅会让后来者把先来的顶掉（见 modes/classic/tick.js 里那段说明）。 */
        onFrame: cb => ticks.onFrame(cb)
      } : null,
      grow: c.grow || null,
      pulse: c.pulse || null
    });
    return true;
  }

  /* ============ 价格线的命中与拖动（接线） ============
     三件事都由模式通过 ctx.priceLine 给（不给就整段不接，图上只剩静态的线）：
       current()      拖动从哪条线开始（当前预览价）
       set(price)     拖动中把价落到预览线上（模式负责按精度取整并重画）
       pick(kind)     点在一条非预览线上时做什么（旧实现：切到限价委托 + 聚焦委托价输入框）
       dropped(price) 松手时告诉玩家一声（旧实现会弹一句「可以按这个价挂单了」）
     拖动这一条链**只有真的发 pointer 事件才验得到**，所以探针会直接派发事件。 */
  function attachLines(ctx, chart) {
    const c = ctx || {};
    const p = c.priceLine;
    if (!chart || typeof chart.setLineDriver !== 'function') return false;
    if (!p || typeof p.set !== 'function') { chart.setLineDriver(null); return false; }
    chart.setLineDriver({
      onDragTo: price => {
        const next = p.set(price);
        return Number.isFinite(next) ? next : price;
      },
      onDrop: price => { if (p.dropped) { try { p.dropped(price); } catch (_) {} } },
      onPick: kind => { if (p.pick) { try { p.pick(kind); } catch (_) {} } }
    });
    return true;
  }

  /* ============ 抖动期间让「读数」也跟着走 ============
     K 线那一路由图表按帧重画，但**读数**（现价那一行、涨跌幅、点差）在 tradePanel 的
     chart.update() 里，只有每 400ms 那一拍会走它 —— 抖动的一秒多里画布在跳、数字不动，
     直到落定那一拍才跳到收盘价（实测：画布墨迹变了 9 次、图表读数只变了 2 次）。
     按 80ms（≈12fps）节流：读数要看得见在跳，但不值得每帧重建 DOM。

     `onTick` 是**模式搭这趟车**的位置（可选）：模拟模式用它做「抖动扫到强平线就强平」。
     放在同一条订阅里的理由是那个钩子同样「一次别太久、但要跟着帧走」——
     各接一条就会各写一份节流，两份迟早不一致（而那种不一致只在观感上露头，最难查）。 */
  function mountReadouts(ticks, render, isDisposed, onTick) {
    const noop = () => {};
    if (!ticks || typeof ticks.onFrame !== 'function' || typeof render !== 'function') return noop;
    let lastAt = 0;
    return ticks.onFrame(payload => {
      if (!payload || payload.done) return;
      if (typeof isDisposed === 'function' && isDisposed()) return;
      const now = Date.now();
      if (now - lastAt < READOUT_MS) return;
      lastAt = now;
      if (typeof onTick === 'function') {
        try { onTick(payload); } catch (error) {
          CS.errors.push({ message: `逐帧钩子失败（图照常画）：${error && error.message}` });
        }
      }
      try { render({ light: true }); } catch (error) {
        CS.errors.push({ message: `读数逐帧刷新失败（图照常画）：${error && error.message}` });
      }
    });
  }

  return { tradeAnim: { attach, attachLines, mountReadouts, READOUT_MS } };
});
