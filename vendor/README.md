# vendor/ —— 第三方库落盘层

这一层是**构建产物**：由 `node tools/build-vendor.mjs` 从旁边的 MIT 库池 `../../js-mod` 生成，
不要手改（手改会在下一次构建时被覆盖，`--verify` 会报出来）。

| 库 | 版本 | 许可证 | 全局名 | 文件 | 无 DOM 可装 | 用途 |
|---|---|---|---|---|---|---|
| `lib/lodash` | 4.18.1 | MIT | `_` | `lodash/lodash.min.js` | 是 | 通用工具：clamp / cloneDeep / get / set / keyBy / groupBy / uniq / sumBy / debounce / throttle。core/base/util.js 的每一个小工具都建立在它上面。 |
| `lib/dayjs` | 1.11.23 | MIT | `dayjs` | `dayjs/dayjs.min.js` | 是 | 日期算术与格式化：dateKey / daysBetween / addDays / addMonths。刻度日期、存档日期、账期都走它。 |
| `lib/he` | 1.2.0 | MIT | `he` | `he/he.js` | 是 | HTML 实体转义。util.escapeHtml 就是它（useNamedReferences + decimal 两个开关是为了与旧口径逐字相同）。 |
| `lib/i18next` | 26.4.2 | MIT | `i18next` | `i18next/i18next.min.js` | 是 | 语言表引擎：插值、回退语言、复数。core/text/i18n.js 的查找内核是它，缺键账本是项目自己加的一层。 |
| `lib/validator` | 13.15.35 | MIT | `validator` | `validator/validator.min.js` | 是 | 格式校验：邮箱 / URL / ISO 日期。core/text/sensitive.js 的联系方式与链接识别用它。 |
| `lib/fflate` | 0.8.3 | MIT | `fflate` | `fflate/index.js` | 是 | 存档压缩（gzip/deflate）与解压。core/save/save.js 的压缩存档走它。 |
| `lib/loadjs` | 4.3.0 | MIT | `loadjs` | `loadjs/loadjs.umd.js` | 是 | 内容脚本注入（经典 <script> + 保序 + 成功/失败回调 + 重试）。core/base/contentLoader.js 的注入引擎。 |
| `lib/tinycolor2` | 1.6.0 | MIT | `tinycolor` | `tinycolor2/tinycolor-min.js` | 是 | 颜色解析 / 校验 / 明暗变换。**替换 vanilla-picker**（ISC，进不了池子）：取色控件改用平台原生的 <input type="color">，颜色本身的合法性、对比与派生交给 tinycolor2。 |
| `lib/clipboard` | 2.0.11 | MIT | `ClipboardJS` | `clipboard/clipboard.min.js` | 否 | 复制到剪贴板（结局卡复制分享串、调试面板复制状态）。**替换 copy-to-clipboard**：池子里那份 v4 没有可用的分发文件。 |
| `lib/simplex-noise` | 4.0.3 | MIT | `SimplexNoise` | `simplex-noise/simplex-noise.js` | 是 | 抖动噪声层：core/animation/jitterPlan.js 的路径扰动（纯数学、无 DOM，Node 侧工具也装）。池子里是 v4，只有 CJS 分发文件，所以构建时包一层全局壳；v4 的 API 是 createNoise2D()，jitterPlan 里用一个 6 行适配器接上（旧的 v2 构造式 API）。 |
| `lib/floating-ui-core` | 1.8.0 | MIT | `FloatingUICore` | `floating-ui__core/floating-ui.core.umd.min.js` | 否 | @floating-ui/dom 的外部依赖（它的 UMD 读全局 FloatingUICore），必须排在前面。 |
| `lib/floating-ui-dom` | 1.8.0 | MIT | `FloatingUIDOM` | `floating-ui__dom/floating-ui.dom.umd.min.js` | 否 | 浮层定位与夹取（图表读数气泡、悬浮窗避让）：placement / flip / shift 不再手写。 |
| `lib/tabbable` | 6.5.0 | MIT | `tabbable` | `tabbable/index.umd.min.js` | 否 | focus-trap 的外部依赖（它的 UMD 读全局 tabbable）。少了它，Esc 关不掉弹窗。 |
| `lib/focus-trap` | 8.2.2 | MIT | `focusTrap` | `focus-trap/focus-trap.umd.min.js` | 否 | 弹窗焦点圈定、Esc 关闭、焦点还原。ui/components/modal.js 的无障碍行为由它兜底。 |
| `lib/toastify-js` | 1.12.0 | MIT | `Toastify` | `toastify-js/toastify.js` | 否 | 浮动通知（下单成交、爆仓、存档提示）的入队/出场/自动消失。ui/components/bits.js 的 toast 走它，装了才用、没装退回自绘。 |
| `lib/file-saver` | 2.0.5 | MIT | `saveAs` | `file-saver/FileSaver.min.js` | 否 | 战报 / 存档导出（Blob → 下载）。modes/story/persist.js 的 exportRun 用它。 |
| `lib/interact.js` | 1.2.8 | MIT | `interact` | `interact.js/interact.min.js` | 否 | 悬浮窗拖动：指针四件套（pointerdown/move/up/cancel）+ 窗口级监听交给它。夹取与避让几何仍留在项目里（那是玩法，不是库的事）。 |
| `lib/superstruct` | 2.0.2 | MIT | `Superstruct` | `superstruct/index.js` | 是 | **结构化的存档**：core/save/save.js 的读与写各有一道 schema（老存档要能升上来、坏存档要能说出坏在哪）。它替掉的是手写的字段白名单与类型强制转换 —— 那种代码的失败方式是「悄悄塞进一个字符串」，而不是报错。落盘改名 index.js，是因为 file:// 下 .cjs 的 MIME 可能被判成不可执行而静默不跑。 |
| `lib/minisearch` | 7.2.0 | MIT | `MiniSearch` | `minisearch/index.js` | 是 | **倒排索引**：内容库（923 条新闻 / 91 封邮件 / 窗口 / 结局 / buff）装完之后建一次索引，查询走索引，而不是每次线性扫全库 —— 与全仓库那 117 处 indexOf / 68 处 find 是同一类问题的正解。 |
| `lib/memoize-one` | 6.0.0 | MIT | `memoizeOne` | `memoize-one/memoize-one.min.js` | 是 | **最后一值缓存**：交易页每帧拿同一份 state 算派生结果（订单表 / 市场观察 / 图表视图），手写的那几个 `xxxCache` 变量干的就是这件事 —— 但没有相等判断、也没有失效语义。它替掉的是「记一下上次的输入」，那类代码最典型的 bug 是忘了清缓存。 |
| `lib/animejs` | 4.5.0 | MIT | `anime` | `animejs/anime.umd.min.js` | 否 | 开场动画引擎（anime.js v4 UMD）：老鼠出洞、啃奶酪、转为 8-bit 图标的 timeline。 |

共 21 个库；许可证分布：MIT × 21。

## 「无 DOM 可装」是什么意思

标**是**的库在加载时只碰纯 JS 对象，Node 侧的工具（校验、parity、无头自检）可以把它们装进一个
没有 `document` 的最小宿主；标**否**的库在加载时就会碰 DOM（`vanilla-picker` 要往 `<head>` 插一段样式），
只应该在真实浏览器（或带假 DOM 的宿主）里加载 —— 否则会抛一条与业务毫无关系的
`ReferenceError: document is not defined`，看起来像引擎坏了。

## 顺序

只有两条硬依赖：`lib/floating-ui-dom` 的 UMD 读全局 `FloatingUICore`，
`lib/focus-trap` 的 UMD 读全局 `tabbable` —— 所以它们各自排在依赖的后面。
`tools/build-vendor.mjs` 会检查 `dependsOn` 的顺序，反了直接失败。
