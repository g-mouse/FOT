/* ============ 引导期间的那一整套设置：改什么、什么时候还原 ============
   引导要一个**干净、可读**的画面：固定的交易对、粗一点的 K 线、没有二次确认弹窗。
   旧教程页把这一套存在账户存档里（pair / timeframe / stepHours / playMs / chartWindow /
   margin / leverage / confirmOpen / orderType），所以做法是：
   进来之前抄一份、按引导的需要改掉，退出时逐项写回。

   新引擎里这一套设置**分两个地方**（这是有意的）：
     · 交易页自己的界面状态（交易对 / 周期 / 一屏根数 / 保证金 / 杠杆 / 下单方式）
       在面板的 ui 上，由模式经 ctx 交出来读写；
     · 动画那三项（抖动 / 随机次数 / 播放间隔）在回放存档的 anim 里。
   两者都通过下面的 KEYS 名单进出 —— **加一项只改一处**。

   两条规矩（照旧）：
    1. **引导期间不落盘**。改完只改内存里的那一份，不调 save() ——
       否则玩家在引导里关掉页面，下次打开看到的是「交易对变成 BTC、杠杆变成 20×」，
       而他从没改过这些；真实交易的偏好也不该被一次教学改掉。
    2. **只改这一个名单**。

   ★ 规矩 1 只挡住了「引导自己去存档」这一条路，**挡不住别人存档**：
   成交、平仓、撤单、改设置都会触发 save()，而 save() 写的是**当时内存里的值** ——
   也就是引导改过的那一套。于是课上随手成交一单，存档里就永久留下
   `jitter:false / playMs:700 / confirmOpen:false / bars:40 / 12h / stepHours:12`：
   退出引导时内存还原了，**刷新一次又被读档覆盖回去**，玩家再也拿不回抖动与二次确认。
   （实测：引导期间 save() 一次 → 刷新 → jitter 仍然是 false。）
   所以存档那一步要过一遍 patchForSave()：把引导改过的格子换成**玩家自己那一份**。
   SAVE_MAP 就是「存档里的哪个格子 ← 哪一个引导键」，一处写死。

   还有一件事与「设置」同源：**引导期间要锁住那几个控件**
   （周期 / 步长 / 下单方式 / 杠杆 / 保证金；交易对那一行是允许玩家换的）。它们在引导里都是固定的，
   「看得见、点得动、但点了不算数」最让人恼火，所以直接置灰。
   锁的实现交给模式（它才知道界面长什么样），这一层只决定**什么时候**锁。
   ★ 第五课（挂单）与第六课（杠杆）分别解锁「下单方式」与「杠杆」——
    课表的 allow 决定锁哪几格，见下面的 applyLesson。 */
CS.define('core/tutorial/sessionSettings', ["core/tutorial/tune"], function () {
  'use strict';

  const TUNE = CS.tutorialTune.TUNE;

  /* 引导期间生效的设置。每一项都是一个 read（从模式那套界面状态里读）/ write（写回去）。
     旧实现直接读写账户 state 的同名字段；新引擎里这几个字段分散在面板 ui 与 anim 上，
     所以由模式的 ctx.settings 提供一对取值/写值口，名单本身仍然只写一处。 */
  const KEYS = [
    { key: 'pair', guided: () => TUNE.pair },
    { key: 'timeframe', guided: () => TUNE.timeframe },
    /* 步长：课表按小时写，引导把它定成与周期一致 —— 点一次「前进」正好长出一根新 K 线。
       步长比周期小时，图上最右那根就成了**整格的聚合**：一次「前进」只走完它的一部分，
       课上「点一下 = 长出一根新 K 线」的节奏就没了。 */
    { key: 'stepHours', guided: () => TUNE.stepHours },
    { key: 'playMs', guided: () => TUNE.playMs },
    { key: 'chartWindow', guided: () => TUNE.chartWindow },
    { key: 'margin', guided: () => TUNE.guidedMargin },
    { key: 'leverage', guided: () => TUNE.guidedLeverage },
    /* 开仓二次确认：**与设置里的默认值一致（开着）** —— 产品口径是「默认值在所有模式、
       包括新手教程里都生效」。引导里每一单会多一张确认单，那正是这个开关开着的样子；
       想少点一下就自己到设置⚙ 的「交易设置」里关掉。退出引导时按玩家自己那一份还原。 */
    { key: 'confirmOpen', guided: () => true },
    /* 抖动：**与设置里的默认值一致（开着）**。
       ★ 上一版这里是 `false`，理由是「抖动每帧给的价不一样，与引导按根铺的价打架」。
       那一条的理由已经**不成立**：新引擎里抖动只作用于显示 —— 成交读的是这一根的收盘价
       （core/engine/marketEngine.js 的报价就是 `bar.c`），资金费与强平同理，
       所以读数在盘中跳不会让任何一笔成交价跑掉（见 core/animation/tickEngine.js 文件头）。
       代价只是「你看到的价」在动画里会来回跳，落定仍是引导铺的那个收盘价。 */
    { key: 'jitter', guided: () => true },
    /* 下单方式：默认市价（引导讲的是「成交价 = 你看到的价」）；
       **第五课自己会把它改成限价**（课表 order='limit'，见 applyLesson） */
    { key: 'orderType', guided: () => 'market' }
  ];

  /* 存档里的哪个格子 ← 哪一个引导键。**只列会被引导改掉、又真的会落盘的那些**：
     一对一的清单，加一项只改这一行（写漏了就等于那个偏好会被教学改掉）。
     路径最多两层（`anim.jitter` 这种），patchForSave 也只按两层处理。 */
  const SAVE_MAP = [
    ['anim.jitter', 'jitter'],
    ['anim.playMs', 'playMs'],
    ['settings.confirmOpen', 'confirmOpen'],
    ['settings.stepHours', 'stepHours'],
    ['settings.timeframe', 'timeframe'],
    ['settings.bars', 'chartWindow'],       /* 设置槽里叫 bars，引导名单里叫 chartWindow */
    ['ui.instrumentId', 'pair'],
    ['ui.playMs', 'playMs']
  ];

  function create(ctx, hooks) {
    const settings = ctx.settings;          /* { read(key), write(key, value), afterApply() } */
    const locks = key => { if (ctx.onLocks) ctx.onLocks(key); };
    /* 这一课是哪一课（课表里 order / leverage / allow 三格就读它）。
       由 session 递进来 —— 这一层不认识课表，也不该认识。 */
    const lessonOf = () => (hooks && hooks.lesson ? hooks.lesson() : null) || null;
    let saved = null;

    /* 这一格在**这一课**该是多少：
       · 下单方式：挂单课（order = 'limit'）切成限价，其余课一律市价；
       · 杠杆：课表给了倍数就按课表（第六课是 TUNE.lessonLeverage），否则 guidedLeverage。
       只有这两格随课变 —— 它们也正是最后两课（挂单 / 杠杆）要解锁的那两格。 */
    const orderTypeOf = plan => (plan && plan.order === 'limit' ? 'limit' : 'market');
    const leverageOf = plan => {
      const lev = plan ? Number(plan.leverage) : 0;
      return Number.isFinite(lev) && lev > 0 ? lev : TUNE.guidedLeverage;
    };
    function guidedOf(item) {
      if (item.key === 'orderType') return orderTypeOf(lessonOf());
      if (item.key === 'leverage') return leverageOf(lessonOf());
      return item.guided();
    }
    /* 这一课该解锁哪几格（课表的 allow；其余课是空数组 = 全锁） */
    const allowOf = plan => (plan && Array.isArray(plan.allow) ? plan.allow : []);
    /* 换课：把这一课的两格引导值写下去 + 按 allow 重新上锁。
       换课时必须走它：只写值不重锁，上一课解锁的那一格会一直亮着；
       只重锁不写值，倒挂的是「杠杆课还停在 20×」。
       ★ 这里**只写 orderType / leverage**（加上挂单课的委托价），不把 KEYS 整份重写一遍 ——
       每结算一单就把人家换过去的交易对拽回来，等于「允许换品种」那条不存在。
       ★ 委托价由 session 用 hooks.draft 算（这一层不认识行情与价格层），0 = 不写。 */
    function applyLesson(plan) {
      const target = plan === undefined ? lessonOf() : plan;
      settings.write('orderType', orderTypeOf(target));
      settings.write('leverage', leverageOf(target));
      if (hooks && hooks.draft && target && target.order === 'limit') {
        const price = Number(hooks.draft(target)) || 0;
        if (price > 0) settings.write('limitPrice', price);
      }
      if (ctx.onLockControls) ctx.onLockControls(true, allowOf(target));
      if (settings.afterApply) settings.afterApply();
      return { orderType: orderTypeOf(target), leverage: leverageOf(target), allow: allowOf(target) };
    }

    const sessionApplied = () => !!saved;
    /* 抄一份出来并改成引导的那一套 */
    function sessionApply() {
      if (!saved) {
        saved = {};
        KEYS.forEach(item => { saved[item.key] = settings.read(item.key); });
        /* 引导里不用自动播放：每一步都由玩家自己点「前进」，那样才看得见自己在按什么。
           这一条**不还原** —— 退出引导之后玩家自己按「自动播放」就行；
           替他重新开启一个会自己跑钱的开关，比不开启更不合适。 */
        if (ctx.stopAutoPlay) ctx.stopAutoPlay();
      }
      /* ★ 整份 KEYS 都要写下去（保证金 / 交易对 / 周期 / 步长 / 一屏根数 / 二次确认…）：
         少了这一句，玩家进课时的保证金是 0，点「做多」只得到一句「请先填写保证金」——
         而屏幕上一切正常、一条异常都不报（实测：这是把 applyLesson 加进来时踩掉的）。 */
      KEYS.forEach(item => settings.write(item.key, guidedOf(item)));
      applyLesson(lessonOf());
      void locks;
      /* ★ 老版本在这里单独调一次 onLockControls(true)。现在锁与值都收进 applyLesson：
         两者必须**同时**更新（哪一课锁哪几格由课表定），分两处写迟早会漂。 */
      return KEYS.map(item => item.key);
    }
    /* 还原：逐项写回，并把锁打开 */
    function sessionRestore() {
      if (!saved) return false;
      KEYS.forEach(item => settings.write(item.key, saved[item.key]));
      saved = null;
      if (settings.afterApply) settings.afterApply();
      if (ctx.onLockControls) ctx.onLockControls(false);
      return true;
    }
    /* ★ 存档要过这一道：把引导改过的格子换成**玩家自己那一份**。
       没在引导里（saved 为空）就原样返回 —— 不复制、不改写，零开销。
       只克隆被改到的那一层（`anim` / `settings` / `ui`），不做整份深拷贝：
       存档里有账户与指标状态，每 400ms 深拷一次不值当。 */
    function patchForSave(payload) {
      if (!saved || !payload) return payload;
      let out = null;
      SAVE_MAP.forEach(([path, key]) => {
        const original = saved[key];
        if (original === undefined) return;
        const dot = path.indexOf('.');
        if (dot < 0) {
          if (!out) out = Object.assign({}, payload);
          out[path] = original;
          return;
        }
        const head = path.slice(0, dot), leaf = path.slice(dot + 1);
        if (!payload[head] || typeof payload[head] !== 'object') return;
        if (!out) out = Object.assign({}, payload);
        if (out[head] === payload[head]) out[head] = Object.assign({}, payload[head]);   /* 只克隆这一层 */
        out[head][leaf] = original;
      });
      return out || payload;
    }
    /* 引导期间玩家自己那一份是什么（探针与自检要能读到「该写回什么」） */
    const originalOf = key => (saved ? saved[key] : undefined);

    return {
      sessionApply, sessionRestore, applyLesson, sessionApplied, patchForSave, originalOf,
      keys: KEYS.map(i => i.key), saveMap: SAVE_MAP
    };
  }

  return { tutorialSettings: { create, KEYS, SAVE_MAP } };
});
