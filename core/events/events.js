/* ============ EventBus ============
   模块之间唯一的广播通道：业务模块只负责喊一声（收到邮件、债务逾期、推进了一天），
   谁关心谁自己来听。on/off/once/emitOnce 四个口子。
   emit 期间订阅者可以退订，所以派发前先复制一份监听表。 */
CS.define('core/events/events', [], function () {
  'use strict';

  function createBus(name) {
    const handlers = new Map();     // topic -> [{fn, once, key}]
    let depth = 0;
    const deferred = [];

    function table(topic) {
      if (!handlers.has(topic)) handlers.set(topic, []);
      return handlers.get(topic);
    }

    function on(topic, fn) {
      if (typeof fn !== 'function') return () => {};
      const entry = { fn, once: false, key: null };
      table(topic).push(entry);
      return () => off(topic, fn);
    }

    function once(topic, fn) {
      if (typeof fn !== 'function') return () => {};
      const entry = { fn, once: true, key: null };
      table(topic).push(entry);
      return () => off(topic, fn);
    }

    /* 「同 key 只留一个」的订阅：重复注册同 key 时替换旧的，
       用于面板重挂载（切模式/切页签）时不会越订越多。 */
    function onKey(topic, key, fn) {
      const list = table(topic);
      const at = list.findIndex(e => e.key === key);
      if (at >= 0) list.splice(at, 1);
      const entry = { fn, once: false, key };
      list.push(entry);
      return () => off(topic, fn);
    }

    function off(topic, fn) {
      const list = handlers.get(topic);
      if (!list) return;
      const at = list.findIndex(e => e.fn === fn);
      if (at >= 0) list.splice(at, 1);
    }

    function offTopic(topic) { handlers.delete(topic); }

    function fire(topic, payload) {
      let count = 0;
      const list = handlers.get(topic);
      if (list && list.length) {
        for (const entry of list.slice()) {
          if (entry.once) off(topic, entry.fn);
          try { entry.fn(payload); count++; } catch (error) {
            CS.errors.push({ message: `事件 ${topic} 的订阅者抛错：${error && error.message}`, stack: error && error.stack });
          }
        }
      }
      /* 通配订阅：「*」上的监听者收到所有事件（debug / 时间线 / 自动化探针用） */
      const all = handlers.get('*');
      if (all && all.length) for (const entry of all.slice()) {
        if (entry.once) off('*', entry.fn);
        try { entry.fn({ topic, payload }); count++; } catch (error) {
          CS.errors.push({ message: `通配订阅者抛错：${error && error.message}`, stack: error && error.stack });
        }
      }
      return count;
    }

    function emit(topic, payload) {
      if (depth > 0) { deferred.push([topic, payload]); return 0; }
      depth++;
      let count = 0;
      try {
        count = fire(topic, payload);
      } finally {
        depth--;
        /* 重入保护：订阅者在回调里再 emit 时先排队，避免无限递归把栈打爆 */
        while (depth === 0 && deferred.length) {
          const [t, p] = deferred.shift();
          depth++;
          try { fire(t, p); } finally { depth--; }
        }
      }
      return count;
    }
    /* 立即派发、不排队。★ 也必须走 fire()：这一条是**重入事件唯一的出口**
       （上面那个 deferred 队列就是从这里放出来的），早先它只遍历主题自己的监听者，
       于是「通配订阅收到所有事件」这条契约对重入事件不成立 ——
       tools/lib/player-probe.mjs 的 '*' 监听者会漏掉这一段，
       而它正是「结局之后不许再交易」这类断言赖以观察的窗口。 */
    emit.now = fire;

    function reset() { handlers.clear(); deferred.length = 0; depth = 0; }
    function topics() { return Array.from(handlers.keys()); }

    return { name, on, once, onKey, off, offTopic, emit, reset, topics, listenerCount: t => (handlers.get(t) || []).length };
  }

  return { events: { createBus, bus: createBus('main') } };
});
