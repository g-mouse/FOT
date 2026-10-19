/* ============ 上课期间锁住那几个开关 ============
   旧实现锁的是六个 id（交易对列表、周期、步长、下单方式、保证金、杠杆）。
   新面板没有那些 id，所以按**类名**找同一批控件。

   ★ 两个必须守住的细节（都是踩出来的）：
     · **记下原来就灰着的那些**：解锁时不能把本来该灰的按钮点亮
       （「限价委托」在引擎没接 placeLimit 时本来就是灰的，那不是引导锁的）；
     · 悬停提示也得中性 —— 课走完那一档屏幕上不该出现「引导」这两个字，
       所以那句 title 里一个字都不提教程。
   ★ 最后两课（挂单 / 杠杆）会**只解锁一格**（`set(on, allow)`）：课表里 allow 写了谁，
     这一课就不锁谁。换课时一定走 apply()（先全解、再按新名单锁）。

   为什么单独一个文件：`modes/classic/tutorial.js` 压不住**当时**的 400 行上限了
   （那一条是 tools/validate-content.ps1 的硬规则）。这一段与状态机、界面都无关，
   它只认识 DOM 与一组选择器，搬出去两边都更清楚。 */
CS.define('core/tutorial/lockControls', [], function () {
  'use strict';

  /* 上课期间固定住的控件：周期按钮，以及下单表单里那几格
     （加一个控件只改这一处）。
     ★ 注意：`.st-pair-row`（交易对行）已从列表中移除 —— 
     允许学员在教程期间自由切换交易对，以便在不同交易对上练习。 */
  const LOCK_SELECTORS = [
    '.st-tf-btn',
    '[data-tut-lock]'
  ];

  function create() {
    /* 被锁的控件与它们**原来的**状态：解锁要一项一项还回去 */
    let locked = [];

    /* on = 锁上；allow = **这一课要解锁的那几格**（`data-tut-lock` 的值，见课表的 allow）。
       为什么要有它：挂单课得让玩家点「限价委托」、杠杆课得让他拖滑块 ——
       而这两格在其余几课上是置灰的（固定成市价 / 20×）。
       ★ 改 allow 必须**先解锁再锁**（走 apply）：`was` 记的是「锁之前本来是不是灰的」，
       直接拿新名单再锁一遍，会把上一次自己锁出来的灰当成原本的状态记住 ——
       课走完之后那颗按钮就再也亮不回来了。 */
    function set(on, allow) {
      if (on) {
        const keep = new Set(allow || []);
        locked = [];
        LOCK_SELECTORS.forEach(sel => {
          Array.from(document.querySelectorAll(sel)).forEach(node => {
            const key = node.dataset ? node.dataset.tutLock : null;
            if (key && keep.has(key)) return;        /* 这一课要教它 → 不锁 */
            locked.push({ node, was: !!node.disabled, title: node.getAttribute('title') });
            node.disabled = true;
            node.title = '当前阶段固定：这个开关暂时不可调，之后可以自由调整';
            node.classList.add('tut-locked');
          });
        });
        return locked.length;
      }
      locked.forEach(({ node, was, title }) => {
        node.disabled = was;
        if (title) node.setAttribute('title', title); else node.removeAttribute('title');
        node.classList.remove('tut-locked');
      });
      locked = [];
      return 0;
    }
    /* 换一课的解锁名单：先把上一课锁住的还回去，再按新名单锁上 */
    function apply(allow) { set(false); return set(true, allow); }

    return { set, apply, count: () => locked.length };
  }

  return { tutorialLock: { create, LOCK_SELECTORS } };
});
