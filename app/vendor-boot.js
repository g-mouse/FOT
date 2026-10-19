/* ============ vendor 接线（**由 tools/build-vendor.mjs 生成，不要手改**）============
   这一层把 UMD/IIFE 库挂出来的全局名（window._、window.dayjs…）注册成内核认识的模块 id
   （lib/lodash、lib/dayjs…），于是业务模块可以写：
     CS.define('某个模块', ['lib/lodash', 'core/text/i18n'], function () { … })
   依赖缺一个，内核在装配那一刻就抛，并报出是哪个模块要它、要的是哪一个库。
   清单（tools/vendor.manifest.json）→ 落盘（vendor/）→ 这一份，三者同源，不会漂移。
   ============================================================== */
(function () {
  'use strict';
  const CS = window.CS;
  /* 给探针/调试面板看的账：哪个库、什么版本、挂的什么全局名、装的时候碰不碰 DOM */
  CS.vendor = [
    { lib: "lib/lodash", global: "_", file: "vendor/lodash/lodash.min.js", version: "4.18.1", license: "MIT", headlessSafe: true },
    { lib: "lib/dayjs", global: "dayjs", file: "vendor/dayjs/dayjs.min.js", version: "1.11.23", license: "MIT", headlessSafe: true },
    { lib: "lib/he", global: "he", file: "vendor/he/he.js", version: "1.2.0", license: "MIT", headlessSafe: true },
    { lib: "lib/i18next", global: "i18next", file: "vendor/i18next/i18next.min.js", version: "26.4.2", license: "MIT", headlessSafe: true },
    { lib: "lib/validator", global: "validator", file: "vendor/validator/validator.min.js", version: "13.15.35", license: "MIT", headlessSafe: true },
    { lib: "lib/fflate", global: "fflate", file: "vendor/fflate/index.js", version: "0.8.3", license: "MIT", headlessSafe: true },
    { lib: "lib/loadjs", global: "loadjs", file: "vendor/loadjs/loadjs.umd.js", version: "4.3.0", license: "MIT", headlessSafe: true },
    { lib: "lib/tinycolor2", global: "tinycolor", file: "vendor/tinycolor2/tinycolor-min.js", version: "1.6.0", license: "MIT", headlessSafe: true },
    { lib: "lib/clipboard", global: "ClipboardJS", file: "vendor/clipboard/clipboard.min.js", version: "2.0.11", license: "MIT", headlessSafe: false },
    { lib: "lib/simplex-noise", global: "SimplexNoise", file: "vendor/simplex-noise/simplex-noise.js", version: "4.0.3", license: "MIT", headlessSafe: true },
    { lib: "lib/floating-ui-core", global: "FloatingUICore", file: "vendor/floating-ui__core/floating-ui.core.umd.min.js", version: "1.8.0", license: "MIT", headlessSafe: false },
    { lib: "lib/floating-ui-dom", global: "FloatingUIDOM", file: "vendor/floating-ui__dom/floating-ui.dom.umd.min.js", version: "1.8.0", license: "MIT", headlessSafe: false },
    { lib: "lib/tabbable", global: "tabbable", file: "vendor/tabbable/index.umd.min.js", version: "6.5.0", license: "MIT", headlessSafe: false },
    { lib: "lib/focus-trap", global: "focusTrap", file: "vendor/focus-trap/focus-trap.umd.min.js", version: "8.2.2", license: "MIT", headlessSafe: false },
    { lib: "lib/toastify-js", global: "Toastify", file: "vendor/toastify-js/toastify.js", version: "1.12.0", license: "MIT", headlessSafe: false },
    { lib: "lib/file-saver", global: "saveAs", file: "vendor/file-saver/FileSaver.min.js", version: "2.0.5", license: "MIT", headlessSafe: false },
    { lib: "lib/interact.js", global: "interact", file: "vendor/interact.js/interact.min.js", version: "1.2.8", license: "MIT", headlessSafe: false },
    { lib: "lib/superstruct", global: "Superstruct", file: "vendor/superstruct/index.js", version: "2.0.2", license: "MIT", headlessSafe: true },
    { lib: "lib/minisearch", global: "MiniSearch", file: "vendor/minisearch/index.js", version: "7.2.0", license: "MIT", headlessSafe: true },
    { lib: "lib/memoize-one", global: "memoizeOne", file: "vendor/memoize-one/memoize-one.min.js", version: "6.0.0", license: "MIT", headlessSafe: true },
    { lib: "lib/animejs", global: "anime", file: "vendor/animejs/anime.umd.min.js", version: "4.5.0", license: "MIT", headlessSafe: false },
  ];

  /* 每个库登记成一个外部模块。getter 在**取用那一刻**才读全局名 ——
     这样「库没装」的报错会指向真正要用它的那个模块，而不是装配到一半的某处。 */
  function defineLib(lib, globalName) {
    CS.external(lib, function () {
      const value = window[globalName];
      if (value === undefined || value === null) {
        throw new Error(
          `vendor 没装齐：${lib} 需要 window.${globalName}。` +
          '检查 index.html 的 vendor 段（由 tools/build-index.mjs 生成）与 vendor/versions.json；' +
          '重跑：node tools/build-vendor.mjs'
        );
      }
      return value;
    });
  }

  defineLib("lib/lodash", "_");
  defineLib("lib/dayjs", "dayjs");
  defineLib("lib/he", "he");
  defineLib("lib/i18next", "i18next");
  defineLib("lib/validator", "validator");
  defineLib("lib/fflate", "fflate");
  defineLib("lib/loadjs", "loadjs");
  defineLib("lib/tinycolor2", "tinycolor");
  defineLib("lib/clipboard", "ClipboardJS");
  defineLib("lib/simplex-noise", "SimplexNoise");
  defineLib("lib/floating-ui-core", "FloatingUICore");
  defineLib("lib/floating-ui-dom", "FloatingUIDOM");
  defineLib("lib/tabbable", "tabbable");
  defineLib("lib/focus-trap", "focusTrap");
  defineLib("lib/toastify-js", "Toastify");
  defineLib("lib/file-saver", "saveAs");
  defineLib("lib/interact.js", "interact");
  defineLib("lib/superstruct", "Superstruct");
  defineLib("lib/minisearch", "MiniSearch");
  defineLib("lib/memoize-one", "memoizeOne");
  defineLib("lib/animejs", "anime");
})();
