/* ============ 安全条件表达式求值器（附录 A） ============
   禁止 eval / new Function。这里有两套东西：

   1) 字符串表达式（邮件触发条件、事件条件里写的 "maxDrawdown > 0.3"）
      —— 手写词法 + 递归下降，算子白名单（算术 / 比较 / 逻辑 / 少量函数）。
   2) 对象式条件（结局 requires、选项 visibleIf 用的就是它）
      —— {all/any/none/not} + {stat|flag|fact|mail|buff, op, value}。

   两者都返回 {ok, unmet[]}：unmet 是「还差哪个条件」，
   结局判定器的 trace 面板（§2.7）与邮件为何不出现的调试面板（§2.2）直接读它。 */
CS.define('core/text/expr', ["core/base/util","lib/lodash"], function () {
  'use strict';
  const { path } = CS.util;

  /* ---------- 统计源白名单（附录 A 的 stat 表） ---------- */
  const STATS = [
    'Y', 'sharpe', 'calmar', 'nTrades', 'maxDrawdown', 'winRate', 'monthsSurvived',
    'equity', 'cash', 'debt.totalRemaining', 'debt.weightedRate', 'obsessionStage', 'age',
    'discoveredFlaws', 'fakeNewsSeen', 'realized', 'unrealized', 'socialCapital',
    'creditScore', 'infoEdge', 'health', 'sleepHours', 'netMonthlyCashflow'
  ];

  /* ---------- 字符串表达式 ---------- */
  const FUNCS = {
    abs: x => Math.abs(x), min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
    round: (x, d) => { const m = Math.pow(10, d || 0); return Math.round(x * m) / m; },
    floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt, sign: Math.sign,
    pow: Math.pow, len: x => (x == null ? 0 : (x.length != null ? x.length : Object.keys(x).length))
  };
  const NAMES = Object.keys(FUNCS);

  function tokenize(text) {
    const out = [];
    const src = String(text);
    let i = 0;
    const two = ['==', '!=', '>=', '<=', '&&', '||'];
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        let j = i; while (j < src.length && /[0-9._]/.test(src[j])) j++;
        out.push({ t: 'num', v: Number(src.slice(i, j).replace(/_/g, '')) }); i = j; continue;
      }
      if (/[A-Za-z_$\u4e00-\u9fa5]/.test(c)) {
        let j = i; while (j < src.length && /[A-Za-z0-9_$.\u4e00-\u9fa5]/.test(src[j])) j++;
        out.push({ t: 'name', v: src.slice(i, j) }); i = j; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1, buf = '';
        while (j < src.length && src[j] !== c) { if (src[j] === '\\') { buf += src[j + 1]; j += 2; } else { buf += src[j]; j++; } }
        out.push({ t: 'str', v: buf }); i = j + 1; continue;
      }
      const pair = src.slice(i, i + 2);
      if (two.indexOf(pair) >= 0) { out.push({ t: 'op', v: pair }); i += 2; continue; }
      if ('+-*/%()!,<>'.indexOf(c) >= 0) { out.push({ t: 'op', v: c }); i++; continue; }
      throw new Error(`表达式里有不认识的字符「${c}」：${text}`);
    }
    return out;
  }

  function parse(text) {
    const tk = tokenize(text);
    let p = 0;
    const peek = () => tk[p];
    const eat = value => {
      const cur = tk[p];
      if (!cur || (value != null && cur.v !== value)) throw new Error(`表达式语法错误：期望「${value}」，实际「${cur ? cur.v : '结尾'}」`);
      p++; return cur;
    };
    function primary() {
      const cur = peek();
      if (!cur) throw new Error('表达式意外结束');
      if (cur.t === 'num') { p++; return { k: 'num', v: cur.v }; }
      if (cur.t === 'str') { p++; return { k: 'str', v: cur.v }; }
      if (cur.t === 'op' && cur.v === '(') { eat('('); const e = or(); eat(')'); return e; }
      if (cur.t === 'op' && cur.v === '!') { p++; return { k: 'not', a: primary() }; }
      if (cur.t === 'op' && cur.v === '-') { p++; return { k: 'neg', a: primary() }; }
      if (cur.t === 'name') {
        p++;
        if (peek() && peek().t === 'op' && peek().v === '(') {
          if (NAMES.indexOf(cur.v) < 0) throw new Error(`表达式调用了白名单外的函数「${cur.v}」`);
          eat('(');
          const args = [];
          if (!(peek() && peek().v === ')')) { args.push(or()); while (peek() && peek().v === ',') { eat(','); args.push(or()); } }
          eat(')');
          return { k: 'call', name: cur.v, args };
        }
        if (cur.v === 'true') return { k: 'num', v: 1 };
        if (cur.v === 'false') return { k: 'num', v: 0 };
        if (cur.v === 'null' || cur.v === 'undefined') return { k: 'str', v: '' };
        return { k: 'ref', name: cur.v };
      }
      throw new Error(`表达式里有不能作为值的记号「${cur.v}」`);
    }
    function mul() {
      let a = primary();
      while (peek() && peek().t === 'op' && '*/%'.indexOf(peek().v) >= 0) { const op = eat().v; a = { k: 'bin', op, a, b: primary() }; }
      return a;
    }
    function add() {
      let a = mul();
      while (peek() && peek().t === 'op' && '+-'.indexOf(peek().v) >= 0) { const op = eat().v; a = { k: 'bin', op, a, b: mul() }; }
      return a;
    }
    function cmp() {
      let a = add();
      while (peek() && peek().t === 'op' && ['==', '!=', '>', '>=', '<', '<='].indexOf(peek().v) >= 0) {
        const op = eat().v; a = { k: 'bin', op, a, b: add() };
      }
      return a;
    }
    function and() {
      let a = cmp();
      while (peek() && peek().t === 'op' && peek().v === '&&') { eat(); a = { k: 'and', a, b: cmp() }; }
      return a;
    }
    function or() {
      let a = and();
      while (peek() && peek().t === 'op' && peek().v === '||') { eat(); a = { k: 'or', a, b: and() }; }
      return a;
    }
    const ast = or();
    if (p < tk.length) throw new Error(`表达式尾部有多余内容「${tk[p].v}」：${text}`);
    return ast;
  }

  function evalAst(node, scope) {
    switch (node.k) {
      case 'num': case 'str': return node.v;
      case 'ref': {
        const scope2 = scope || {};
        let v;
        if (Object.prototype.hasOwnProperty.call(scope2, node.name)) v = scope2[node.name];
        else v = path(scope2, node.name, undefined);
        if (v === undefined && STATS.indexOf(node.name) < 0) {
          const err = new Error(`表达式引用了不存在的量「${node.name}」`);
          err.unknown = node.name;
          throw err;
        }
        return v === undefined ? 0 : v;
      }
      case 'not': return evalAst(node.a, scope) ? 0 : 1;
      case 'neg': return -Number(evalAst(node.a, scope) || 0);
      case 'and': return (evalAst(node.a, scope) && evalAst(node.b, scope)) ? 1 : 0;
      case 'or': return (evalAst(node.a, scope) || evalAst(node.b, scope)) ? 1 : 0;
      case 'call': return FUNCS[node.name].apply(null, node.args.map(a => evalAst(a, scope)));
      case 'bin': {
        const a = evalAst(node.a, scope), b = evalAst(node.b, scope);
        switch (node.op) {
          case '+': return (typeof a === 'string' || typeof b === 'string') ? String(a) + String(b) : Number(a) + Number(b);
          case '-': return Number(a) - Number(b);
          case '*': return Number(a) * Number(b);
          case '/': return Number(b) === 0 ? 0 : Number(a) / Number(b);
          case '%': return Number(b) === 0 ? 0 : Number(a) % Number(b);
          case '==': return a == b ? 1 : 0;   // eslint-disable-line eqeqeq
          case '!=': return a != b ? 1 : 0;   // eslint-disable-line eqeqeq
          case '>': return a > b ? 1 : 0;
          case '>=': return a >= b ? 1 : 0;
          case '<': return a < b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0;
          default: throw new Error(`不支持的算子 ${node.op}`);
        }
      }
      default: throw new Error(`不支持的表达式节点 ${node.k}`);
    }
  }

  function evalString(text, scope) {
    return !!evalAst(parse(text), scope || {});
  }

  /* ---------- 对象式条件 ---------- */
  /* ★ 这里必须先查**字面键**，再退回点路径。
     原因：`state.flags` 是**扁平**对象，键名本身就带点（'story.left_job'），
     而 `scope.stats` / `scope.facts` 也是按带点的名字建的（'debt.totalRemaining'）。
     早期实现直接走 CS.util.path（按 '.' 拆），于是
       {flag:'story.left_job', op:'==', value:true}  → 读 flags['story']['left_job'] → undefined → 恒假
       {fact:'debt.totalRemaining', op:'<=', value:0} → 同样恒假
     结局与邮件里所有带点的条件因此**全部失效**（而且不报错，只是永远不成立）。
     字面优先的写法同时兼容两种数据形状，是唯一安全的做法。 */
  function readSpec(bag, name) {
    if (bag == null || name == null) return undefined;
    if (Object.prototype.hasOwnProperty.call(bag, name)) return bag[name];
    return path(bag, name, undefined);
  }
  function resolveOperand(spec, scope) {
    if (spec.stat !== undefined) return { label: `stat:${spec.stat}`, value: readSpec(scope.stats || scope, spec.stat) };
    if (spec.flag !== undefined) return { label: `flag:${spec.flag}`, value: readSpec(scope.flags || scope, spec.flag) };
    if (spec.fact !== undefined) return { label: `fact:${spec.fact}`, value: readSpec(scope.facts || scope, spec.fact) };
    if (spec.metric !== undefined) return { label: `metric:${spec.metric}`, value: readSpec(scope.metrics || scope, spec.metric) };
    return { label: '?', value: undefined };
  }

  function compare(op, actual, want) {
    switch (op) {
      case '==': case 'is': return actual === want || (want === true && !!actual) || (want === false && !actual);
      case '!=': case 'isNot': return !(actual === want);
      case '>': return Number(actual) > Number(want);
      case '>=': return Number(actual) >= Number(want);
      case '<': return Number(actual) < Number(want);
      case '<=': return Number(actual) <= Number(want);
      case 'between': return Array.isArray(want) && Number(actual) >= Number(want[0]) && Number(actual) <= Number(want[1]);
      case 'in': return Array.isArray(want) && want.indexOf(actual) >= 0;
      case 'notIn': return Array.isArray(want) && want.indexOf(actual) < 0;
      case 'isNull': return actual == null;                                  // eslint-disable-line eqeqeq
      case 'notNull': return actual != null;                                 // eslint-disable-line eqeqeq
      case 'contains': return Array.isArray(actual) ? actual.indexOf(want) >= 0 : String(actual == null ? '' : actual).indexOf(String(want)) >= 0;
      case 'has': return Array.isArray(actual) ? actual.indexOf(want) >= 0 : !!actual;
      case 'truthy': return !!actual;
      case 'falsy': return !actual;
      default: return false;
    }
  }

  function describe(spec, op, actual, want) {
    const head = spec.stat ? `stat ${spec.stat}` : spec.flag ? `flag ${spec.flag}` : spec.fact ? `fact ${spec.fact}` :
      spec.metric ? `metric ${spec.metric}` : spec.mail ? `mail ${spec.mailId}=${spec.state}` : spec.buff ? `buff ${spec.id}` :
        spec.expr ? `expr ${spec.expr}` : JSON.stringify(spec);
    const shown = a => (a === undefined ? '(未定义)' : (typeof a === 'object' ? JSON.stringify(a) : String(a)));
    return `${head} ${op || ''} ${want === undefined ? '' : shown(want)}  当前=${shown(actual)}`.trim();
  }

  /* evaluate 返回 {ok, unmet[]}。unmet 里的每一行都是「人话」，
     直接可以贴到 debug 面板上（[R5] 结局 trace 验收要求）。 */
  function evaluate(cond, scope) {
    const unmet = [];
    const ok = test(cond, scope || {}, unmet, '');
    return { ok, unmet };
  }

  function test(cond, scope, unmet, tag) {
    if (cond == null) return true;
    if (typeof cond === 'boolean') return cond;
    if (typeof cond === 'string') {
      try { const r = evalString(cond, scope); if (!r) unmet.push(`${tag}表达式不成立：${cond}`); return r; }
      catch (error) { unmet.push(`${tag}表达式无法求值：${cond}（${error.message}）`); return false; }
    }
    if (Array.isArray(cond)) return cond.every(c => test(c, scope, unmet, tag));
    /* ★ 关键字**不再并列早退**：一个条件对象可以同时带 all / any / none
       （内容里 40 处 `none:` 全部与 `all:` 写在同一个对象里）。
       早先的写法是 `if (cond.all) { … return r; } if (cond.any) { … return r; } if (cond.none) { … }` ——
       带 all 的对象在第一个分支就返回了，**同一层的 none 永远不会被求值**：
       于是「这笔结局不该出现的前置」整条失效（例如 end.family_reconciled 在
       story.family_broken 已经写上的那一局照样给出「家人和解」）。
       现在逐个求值、逻辑与合并，全部通过才算通过。
       none 先判：它是**排除**条件，先看它才能给出准确的那一条 unmet。 */
    if (cond.all || cond.any || cond.none) {
      let ok = true;
      if (cond.none) {
        const noneBag = [];
        const hit = (cond.none || []).filter(c => test(c, scope, noneBag, tag));
        if (hit.length) { unmet.push(`${tag}none 被命中：${noneBag.slice(0, 3).join(' / ')}`); ok = false; }
      }
      if (cond.any) {
        const sub = [];
        const r = (cond.any || []).some(c => { const bag = []; const v = test(c, scope, bag, tag); if (!v) sub.push(...bag); return v; });
        if (!r) { unmet.push(`${tag}any 全部不成立，最接近的差：${sub.slice(0, 3).join(' / ') || '(无)'}`); ok = false; }
      }
      if (cond.all) {
        let allOk = true;
        for (const c of (cond.all || [])) if (!test(c, scope, unmet, tag)) allOk = false;
        if (!allOk) { if (!unmet.length) unmet.push(`${tag}all 条件不成立`); ok = false; }
      }
      return ok;
    }
    if (cond.not) { const bag = []; const v = test(cond.not, scope, bag, tag); return !v; }
    if (cond.expr) {
      try { const r = evalString(cond.expr, scope); if (!r) unmet.push(`${tag}expr 不成立：${cond.expr}`); return r; }
      catch (error) { unmet.push(`${tag}expr 无法求值：${cond.expr}（${error.message}）`); return false; }
    }
    if (cond.mail) {
      const state = scope.mailState ? scope.mailState(cond.mailId) : undefined;
      const r = state === cond.state;
      if (!r) unmet.push(`${tag}邮件 ${cond.mailId} 需要状态 ${cond.state}，实际 ${state || '(不存在)'}`);
      return r;
    }
    if (cond.buff) {
      const has = scope.hasBuff ? scope.hasBuff(cond.buff) : (scope.buffIds || []).indexOf(cond.buff) >= 0;
      const r = cond.op === 'notHas' ? !has : has;
      if (!r) unmet.push(`${tag}buff ${cond.buff} ${cond.op === 'notHas' ? '不该存在但存在' : '不存在'}`);
      return r;
    }
    if (cond.stat !== undefined || cond.flag !== undefined || cond.fact !== undefined || cond.metric !== undefined || cond.value !== undefined) {
      const { label, value } = resolveOperand(cond, scope);
      /* ★ 没写 op 的**裸引用**（`{flag:'story.ill'}`、`{stat:'nTrades'}`）语义是
         「它成立吗」，即 truthy —— 不是「等于 undefined」。
         早先 op 缺省成 '=='，而 want 是 undefined，于是 compare('==', actual, undefined)
         退化成 `actual === undefined`：**旗标写上了反而判不成立**，语义整个反了。
         内容里有 33 处这种裸引用（多数在 none: 里），而 none: 以前根本不被求值，
         两个缺陷叠在一起才没炸出来。endingResolver.fillLeaf 按 `value === undefined → true`
         推导要填什么，也证明约定就是 truthy。
         注意：显式写了 op:'is' + value:true/false 的照旧按相等判。 */
      const op = cond.op || ((cond.value === undefined) ? 'truthy' : '==');
      let actual = value;
      let want = cond.value;
      /* 关系值的刻度容错：`relations.*` 在引擎里是 0–100 的分数，
         但内容作者可能按 0–1 的比率写门槛（两套写法在仓库里都真实存在：
         全局结局库写 0.6，角色包写 60）。两边都接受 —— 只要有一边 <= 1，
         就把两边统一到 0–1 再比。这条容错写在引擎里，而不是去改几十个内容文件。

         ★ 两处修正：
         1) 判据必须看**带前缀的 label**（resolveOperand 产出的是 'fact:relations.…'）——
            早先 `label.indexOf('relations.') === 0` 恒不成立，整块容错从来没执行过；
         2) 只把 actual 归一化，**不能同时改 want** ——
            早先 `actual = a*scale; want = w/scale` 把阈值推到了相反的刻度上：
            a=5、w=0.6 时 scale=1/100 → actual=0.05、want=60，
            于是「好感度 5」被判成「>= 0.6 成立」。 */
      if (label.indexOf('relations.') >= 0 && op !== 'isNull' && op !== 'notNull') {
        const a = Number(actual), w = Number(want);
        if (Number.isFinite(a) && Number.isFinite(w)) {
          if (a > 1.5 && w <= 1.5) actual = a / 100;
          else if (a <= 1.5 && w > 1.5) actual = a * 100;
        }
      }
      const r = compare(op, actual, want);
      if (!r) unmet.push(`${tag}${describe(cond, op, value, cond.value)}`);
      return r;
    }
    return true;
  }

  /* 静态检查用：把一棵条件树里引用到的 stat / flag / fact / 邮件 id 全部列出来 */
  function references(cond, out) {
    const bag = out || { stats: [], flags: [], facts: [], metrics: [], mails: [], buffs: [], exprs: [], unknowns: [] };
    const walk = node => {
      if (node == null) return bag;
      if (typeof node === 'string') {
        try {
          const ast = parse(node);
          const refs = [];
          (function scan(n) { if (!n || typeof n !== 'object') return; if (n.k === 'ref') refs.push(n.name); ['a', 'b'].forEach(k => scan(n[k])); (n.args || []).forEach(scan); })(ast);
          refs.forEach(r => {
            if (STATS.indexOf(r) < 0) bag.unknowns.push(r);
            else if (bag.stats.indexOf(r) < 0) bag.stats.push(r);
          });
          if (bag.exprs.indexOf(node) < 0) bag.exprs.push(node);
        } catch (_) { bag.unknowns.push(node); }
        return bag;
      }
      if (Array.isArray(node)) { node.forEach(walk); return bag; }
      if (node.all || node.any || node.none) { (node.all || []).forEach(walk); (node.any || []).forEach(walk); (node.none || []).forEach(walk); }
      if (node.not) walk(node.not);
      if (node.stat && bag.stats.indexOf(node.stat) < 0) bag.stats.push(node.stat);
      if (node.flag && bag.flags.indexOf(node.flag) < 0) bag.flags.push(node.flag);
      if (node.fact && bag.facts.indexOf(node.fact) < 0) bag.facts.push(node.fact);
      if (node.metric && bag.metrics.indexOf(node.metric) < 0) bag.metrics.push(node.metric);
      if (node.mailId && bag.mails.indexOf(node.mailId) < 0) bag.mails.push(node.mailId);
      if (node.buff && bag.buffs.indexOf(node.buff) < 0) bag.buffs.push(node.buff);
      if (node.id && node.buff === undefined && node.op === 'has') bag.buffs.push(node.id);
      if (node.expr) walk(node.expr);
      return bag;
    };
    return walk(cond);
  }

  return { expr: { parse, evalString, evaluate, test, references, STATS, FUNCS, compare } };
});
