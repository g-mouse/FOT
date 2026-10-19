/* ============ 图表的「动画零件」插座（两处接线，一处收口） ============
   三件零件都由模式通过 ctx 注入（不给就整段静态、成本为 0）：
     tick   盘中抖动：最新那一根按帧重画（价与实体的宽都跟着走）
     grow   「新 K 线长出来」：实体从极细长到满宽
     pulse  波纹：摸到折返点时从现价扩散一圈

   ★ 一个帧事件喂三件事，所以**只在这里订阅一次**（原来分散在两处：
     ui/components/tradeAnim.js 里给图表接一路、面板自己再接一路推进波纹与读数）：
       · 图表重画（核心：抖动要看得见）
       · 波纹推进（每帧一次、强度逐帧衰减 —— 放在绘图里的话，重画次数会改变观感）
       · 读数刷新（面板的现价那一行；按 80ms 节流，见下面 TICK_MS）
     分散订阅的代价是**调试时数不清「这一帧到底谁收到了」**，而这里的每一件
     都出过「引擎在动、屏幕不动」的毛病。

   为什么单独一个文件：ui/components/tradeChart.js 挨着当时「单文件 ≤ 400 行」那条硬约束，
   而这十几行是**契约翻译**、不是绘图。

   三条不许动的规矩，都是踩过的：
   1) **帧事件的订阅者不止一个**（这条链、模式那边的波纹/探针各一路），
      所以 onFrame 直接往下转，不去重、也不给固定 key —— 用同一个 key 订阅会让
      后来者把先来的顶掉（见 modes/classic/tick.js 里那段说明）。
   2) **动画走完那一帧也要画**（`done` → onIdle）：把它落回收盘价，
      否则图上停在抖动中的那一帧（看起来像「抖完没落定」）。
   3) **退订必须跟着图表一起收掉**：换模式/换页签时漏掉一个，
      旧图表会一直在后台按帧重画（而它那张画布已经不在文档里了）。 */
CS.define('ui/components/tradeChartAnim', ["lib/lodash"], function () {
  'use strict';

  /* 读数（现价那一行、涨跌幅、点差）刷新的节流：≈12fps。
     读数要看得见在跳，但不值得每帧重建 DOM —— 而 K 线本身是每帧画的。
     抖动期间刷新读数由面板自己接（见 modes/classic/tick.js 的帧事件说明）：
     那一路要的是 render({light:true})，而 chart.update() 已经在 light 那条路里了。 */
  const READOUT_MS = 80;

  function create(opts) {
    const o = opts || {};
    const onRedraw = typeof o.onRedraw === 'function' ? o.onRedraw : () => {};
    const onIdleDraw = typeof o.onIdleDraw === 'function' ? o.onIdleDraw : onRedraw;
    let tick = null, grow = null, pulse = null;
    let offFrame = null;

    return {
      /* 三件零件原样留着：图表按 { active, progress } 的形状读它们（见 tradeChart 的 draw） */
      get tick() { return tick; },
      get grow() { return grow; },
      get pulse() { return pulse; },
      /* 一个帧事件喂三件事（文件头）：波纹推进、图表重画、动画落定那一帧的重画。 */
      set(drivers) {
        const d = drivers || {};
        this.dispose();
        tick = d.tick || null;
        grow = d.grow || null;
        pulse = d.pulse || null;
        if (!tick || typeof tick.onFrame !== 'function') { onIdleDraw(); return this; }
        offFrame = tick.onFrame(payload => {
          if (!payload) return;
          const busy = payload.done ? false : (typeof tick.active === 'function' ? tick.active() : true);
          /* 波纹推进：不做的话屏幕上那一圈圈永远不会扩散（而它还看不出是谁的错） */
          if (busy && pulse && pulse.step) { try { pulse.step(); } catch (_) {} }
          if (busy) onRedraw(); else onIdleDraw();
        });
        return this;
      },
      dispose() { if (offFrame) { try { offFrame(); } catch (_) {} offFrame = null; } }
    };
  }

  return { tradeChartAnim: { create, READOUT_MS } };
});
