/* ============ 键位分发（模拟模式与故事模式共用） ============
   两个模式的操作是**同一套**（空格推进一根 4h、↑↓ 换交易对、A 开关自动播放），
   因为它们共用同一个交易界面 —— 键位不该是另一套。

   这一层原来在两个模式里各写了一遍，实测 `press` 有 **96% 逐字重合**：
   守卫、查表、拦默认、连发处理、异常兜底全都一样，只有三处不同。
   复制两份的代价不是行数，而是「改一处漏一处」：比如给连发加一条规则，
   只改了故事那边，模拟模式就会抖成一串 —— 而那种不一致没人会去测。

   两个模式真正不同的只有三件事，全部通过参数进来：
     mode()        当前模式名（键位只在它前台时接管）
     canRun()      现在这一下能不能执行（各自的「就绪 / 已结束」判据）
     onRepeat()    长按连发要不要理（故事允许连发推进，模拟模式自己决定）

   ★ 模式名那一道判断不是可选项：这一层是全局 keydown（挂上就不摘），
     而键位驱动的是**那个模式的时钟**。少了它，在模拟模式里按空格会推进故事那一局，
     玩家回来发现过了一个月。
   ========================================================================== */
CS.define('core/base/keyDispatch', ["core/base/util","core/text/i18n"], function () {
  'use strict';

  /* opts = { mode: () => string, bindings: [...], canRun: (binding) => bool,
              onRepeat?: (binding, e) => string|void, onError?: (e, binding) => void } */
  function create(opts) {
    const o = opts || {};
    const { keyOf, normalizeKey, keyLabelOf: labelOf, isEntryTarget, layerOpen } = CS.util;
    const bindings = Array.isArray(o.bindings) ? o.bindings : [];
    /* 键名归一 → 绑定。归一规则住在 core/base/util.js（两个模式共用那一份），
       所以「同一个键在两个模式下是同一个键」这件事由它保证。 */
    const byKey = Object.create(null);
    bindings.forEach(b => { byKey[normalizeKey(b.key)] = b; });
    let mounted = false;

    function press(event) {
      if (!event || event.isComposing) return null;
      /* 只有本模式前台时才接管 */
      if (o.mode && CS.modes.current !== o.mode()) return null;
      /* 让路：整页弹层开着（那时空格是操作对话框的）、或者正在输入框里打字 */
      if (layerOpen() || isEntryTarget(event.target)) return null;
      const binding = byKey[keyOf(event)];
      if (!binding) return null;
      /* ★ 拦默认行为的判据是 `!== false`，所以**没写 preventDefault 的键也会被拦**。
         这不是笔误，是原实现（classic/replay.js 与 story/keys.js 两份都一样）就有的行为，
         合并时**逐字保留**了：改它等于顺手改掉两个模式的按键手感，那不在这次合并的范围内。
         实际后果：绑定的四个键都会 preventDefault —— 其中 Space 本来就该拦（否则页面往下滚），
         ↑↓ 则会连带拦掉「方向键滚页面」。要不要放宽到「只有显式声明 true 才拦」是**产品决定**，
         要改请单独开一次改动并一起测两个模式。
         `typeof` 那道守卫是防「事件对象没有这个方法」：真实 KeyboardEvent 一定有，
         但这是全局 keydown 的唯一入口 —— 在这里抛出去等于键盘整个失灵，代价不对等。 */
      if (binding.preventDefault !== false && typeof event.preventDefault === 'function') event.preventDefault();
      /* 长按连发默认只给「前进」：换交易对与开关自动播放连发起来会抖成一串。
         模式可以覆盖这条（onRepeat 返回键名表示「这一下也照常处理」）。 */
      if (event.repeat) {
        const overridden = o.onRepeat ? o.onRepeat(binding, event) : null;
        if (!overridden) {
          if (binding !== byKey[normalizeKey('Space')]) return binding.key;
        }
      }
      if (o.canRun && !o.canRun(binding)) return binding.key;
      try { binding.run(event); }
      catch (error) {
        if (o.onError) o.onError(error, binding);
        else CS.errors.push({ message: `键位 ${binding.key} 执行失败：${error && error.message}`, stack: error && error.stack });
      }
      return binding.key;
    }

    function mount() {
      if (mounted) return false;
      mounted = true;
      document.addEventListener('keydown', press);
      return true;
    }

    /* 键位提示那一行：界面照着它画（两个模式的页脚读的是同一套） */
    const hints = () => bindings.map(b => ({ key: b.key, label: CS.i18n.t(b.label) }));

    return {
      press, mount, hints, bindings, byKey,
      keyOf, normalizeKey, labelOf,
      isMounted: () => mounted
    };
  }

  return { keyDispatch: { create } };
});
