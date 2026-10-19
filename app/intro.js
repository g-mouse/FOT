/* ============ 开场动画：老鼠出洞 → 啃奶酪 → 8-bit 图标 ============
   依赖：vendor/animejs（UMD 全局 `anime`，v4 的 createTimeline/stagger）。
   加载位置在 index.html 的 vendor 之后、模块之前；只做界面，不碰 CS。

   三条产品口径：
   1) **只在第一次进游戏时自动播一次**（localStorage: cs.intro.seen.v1）；
   2) 8-bit 图标出来后**停留 5 秒**再淡出（手动重播也一样）；
   3) 死局彩蛋里的「重播开场」可以随时再放一次（`CSIntro.play()`）。

   ★ 无头 / 减少动态 / 无 CSS 的垫片环境自动跳过；`?intro=1` 可强制（探针截图用）。
   ★ 切页/刷新中途不会把「已看过」写丢：自动播放一开始就落标记。 */
(function () {
  'use strict';

  const q = String((typeof location !== 'undefined' && location.search) || '');
  const force = /(?:\?|&)intro=1(?:&|$)/.test(q);
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const A = window.anime;
  const SEEN_KEY = 'cs.intro.seen.v1';
  const PIXEL_AT = 2520;
  const HOLD_AFTER_PIXEL = 5600;   // 图标完全弹出后 5 秒；再留 0.56s 给淡出

  const MOUSE = `
    <svg viewBox="0 0 208 174" aria-hidden="true">
      <g class="intro-mouse-body" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M50 135 C12 118 16 176 62 151" fill="none" stroke="#8d9aa7" stroke-width="6"/>
        <ellipse cx="94" cy="128" rx="54" ry="38" fill="#c8d3de" stroke="#071018" stroke-width="4"/>
        <ellipse cx="74" cy="154" rx="17" ry="8" fill="#aab7c3" stroke="#071018" stroke-width="3"/>
        <ellipse cx="122" cy="156" rx="18" ry="8" fill="#aab7c3" stroke="#071018" stroke-width="3"/>
      </g>
      <g class="intro-mouse-head">
        <circle cx="118" cy="52" r="22" fill="#c8d3de" stroke="#071018" stroke-width="4"/>
        <circle cx="118" cy="52" r="12" fill="#ff6b9a"/>
        <circle cx="166" cy="56" r="20" fill="#c8d3de" stroke="#071018" stroke-width="4"/>
        <circle cx="166" cy="56" r="10" fill="#ff6b9a"/>
        <ellipse cx="145" cy="96" rx="46" ry="36" fill="#d6e0e9" stroke="#071018" stroke-width="4"/>
        <circle cx="130" cy="86" r="5" fill="#071018"/>
        <circle cx="132" cy="84" r="1.6" fill="#f4fff9"/>
        <circle cx="159" cy="84" r="5" fill="#071018"/>
        <circle cx="161" cy="82" r="1.6" fill="#f4fff9"/>
        <ellipse cx="169" cy="100" rx="8" ry="6" fill="#ff6b9a" stroke="#071018" stroke-width="3"/>
        <path d="M151 110 L151 120 M160 110 L160 120" stroke="#071018" stroke-width="3"/>
        <path d="M120 106 L96 100 M121 113 L94 113 M124 120 L98 127" stroke="#8d9aa7" stroke-width="2"/>
        <path d="M180 106 L198 100 M181 113 L201 113 M178 120 L196 127" stroke="#8d9aa7" stroke-width="2"/>
      </g>
    </svg>`;

  const CHEESE = `
    <svg viewBox="0 0 140 120" aria-hidden="true">
      <path d="M10 104 L130 104 L116 20 Z" fill="#ffd166" stroke="#071018" stroke-width="4" stroke-linejoin="round"/>
      <path d="M10 104 L130 104 L124 82 Z" fill="#e3a338"/>
      <circle cx="76" cy="72" r="8" fill="#c7861d"/>
      <circle cx="101" cy="88" r="5" fill="#c7861d"/>
      <circle cx="48" cy="90" r="4" fill="#c7861d"/>
      <circle cx="94" cy="42" r="4" fill="#c7861d"/>
    </svg>`;

  /* 16×16 的 8-bit 鼠脸：X=描边 G=灰 P=耳粉 E=眼绿 N=鼻/牙红
     ★ 与 assets/8bit-rat.png / icon.png 同一张图；改这里时同步换 assets。 */
  const PIXEL_ROWS = [
    '................',
    '....XX....XX....',
    '...XPPX..XPPX...',
    '...XPPX..XPPX...',
    '..XGGGGXXGGGGX..',
    '..XGGGGGGGGGGX..',
    '.XGGXXGGGGXXGGX.',
    '.XGGEEGGGGEEGGX.',
    '.XGGEEGGGGEEGGX.',
    '.XGGGGGNNGGGGGX.',
    '.XGGGGNNNNGGGGX.',
    '..XGGGNNNNGGGX..',
    '...XGGGGGGGGX...',
    '....XXGGGGXX....',
    '......XXXX......',
    '................'
  ];
  const PIXEL_COLOR = { X: '#071018', G: '#c6d5e2', P: '#ff5d9e', E: '#5dffc8', N: '#ff3b5c' };

  function pixelIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    PIXEL_ROWS.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === '.') continue;
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', '1');
        rect.setAttribute('height', '1');
        rect.setAttribute('fill', PIXEL_COLOR[ch] || '#c6d5e2');
        svg.appendChild(rect);
      }
    });
    return svg;
  }

  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (_) { return false; }
  }
  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (_) {}
  }
  function canPlay() {
    return !!A && typeof A.createTimeline === 'function' && typeof A.stagger === 'function';
  }
  function envSkip() {
    if (reduce) return true;
    if (/HeadlessChrome/i.test(ua) || (typeof navigator !== 'undefined' && navigator.webdriver)) return true;
    if (typeof window.innerWidth === 'number' && window.innerWidth < 2) return true;
    if (!window.CSS || typeof window.CSS.supports !== 'function' || !window.CSS.supports('display', 'grid')) return true;
    return false;
  }

  let root = null;
  let tl = null;
  let active = false;
  let onKey = null;

  function build() {
    root = document.createElement('div');
    root.className = 'intro';
    root.id = 'intro';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '开场动画');
    root.innerHTML = `
      <div class="intro-stage">
        <div class="intro-hole"></div>
        <div class="intro-mouse">${MOUSE}</div>
        <div class="intro-cheese">${CHEESE}</div>
        <div class="intro-crumbs">
          <i class="intro-crumb"></i><i class="intro-crumb"></i><i class="intro-crumb"></i>
          <i class="intro-crumb"></i><i class="intro-crumb"></i><i class="intro-crumb"></i>
        </div>
        <div class="intro-pixel"></div>
        <div class="intro-caption">
          <strong>天才的陨落</strong>
          <span>FALL OF A TRADER</span>
          <em>DERIVATIVES EXECUTION SIMULATION</em>
        </div>
      </div>
      <button type="button" class="intro-skip">跳过</button>`;
    root.querySelector('.intro-pixel').appendChild(pixelIcon());
    document.body.appendChild(root);
    document.documentElement.classList.add('intro-open');
  }

  function finish() {
    if (!active) return;
    active = false;
    try { if (tl && typeof tl.pause === 'function') tl.pause(); } catch (_) {}
    if (onKey) { window.removeEventListener('keydown', onKey); onKey = null; }
    document.documentElement.classList.remove('intro-open');
    const node = root;
    root = null;
    if (!node) return;
    node.style.pointerEvents = 'none';
    node.style.transition = 'opacity 220ms ease';
    node.style.opacity = '0';
    setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 240);
  }

  function startTimeline() {
    const $ = sel => root.querySelector(sel);
    const mouse = $('.intro-mouse');
    const head = $('.intro-mouse-head');
    const hole = $('.intro-hole');
    const cheese = $('.intro-cheese');
    const crumbs = Array.from(root.querySelectorAll('.intro-crumb'));
    const pixel = $('.intro-pixel');
    const cells = Array.from(root.querySelectorAll('.intro-pixel rect'));
    const caption = $('.intro-caption');

    tl = A.createTimeline({ defaults: { ease: 'outQuad' } });
    tl.add(root, { opacity: [0, 1], duration: 260 }, 0);
    tl.add(hole, { opacity: [0, 1], scale: [.2, 1], duration: 460, ease: 'outBack' }, 120);
    tl.add(mouse, { opacity: [0, 1], translateY: [92, 0], duration: 680, ease: 'outBack' }, 320);
    tl.add(mouse, { rotate: [0, -2.5, 0], duration: 520, ease: 'inOutSine' }, 920);
    tl.add(mouse, { translateX: [0, 66], rotate: [0, -9], duration: 480, ease: 'inOutQuad' }, 1120);
    tl.add(head, { rotate: [0, -18, 2, -18, 0], duration: 760, ease: 'inOutQuad' }, 1450);
    tl.add(cheese, { rotate: [-2, 2, -2], scale: [1, 1.04, 1], duration: 640, ease: 'inOutSine' }, 1450);
    tl.add(cheese, { scaleY: [1, .82], duration: 240, ease: 'inOutQuad' }, 1980);
    tl.add(crumbs, {
      opacity: [0, 1], translateX: [-8, 18], translateY: [6, -26],
      duration: 360, delay: A.stagger(55)
    }, 1980);
    tl.add(crumbs, { opacity: 0, duration: 220 }, 2300);
    tl.add([cheese, hole], { opacity: 0, duration: 320, ease: 'inQuad' }, 2400);
    tl.add(mouse, { opacity: 0, scale: [1, .86], duration: 220, ease: 'inQuad' }, 2460);
    tl.add(pixel, { opacity: 1, scale: [.25, 1], rotate: [-14, 0], duration: 560, ease: 'outBack' }, PIXEL_AT);
    tl.add(cells, { opacity: 1, duration: 220, delay: A.stagger(5, { from: 'center' }) }, PIXEL_AT + 40);
    tl.add(caption, { opacity: 1, translateY: [14, 0], duration: 440 }, 2920);
    /* 图标完全弹出（PIXEL_AT + 560）后再停 5 秒，然后才淡出。 */
    tl.add(pixel, { scale: [1, 1.035, 1], duration: 2400, ease: 'inOutSine' }, PIXEL_AT + 700);
    tl.add(root, { opacity: 0, duration: 420 }, PIXEL_AT + HOLD_AFTER_PIXEL);
    tl.call(finish, PIXEL_AT + HOLD_AFTER_PIXEL + 450);
  }

  function play(manual) {
    if (active || !canPlay()) return false;
    if (!manual && !force) {
      if (seen() || envSkip()) return false;
      markSeen();
    }
    build();
    active = true;
    const $ = sel => root.querySelector(sel);
    const skip = () => finish();
    root.addEventListener('click', skip);
    $('.intro-skip').addEventListener('click', event => { event.stopPropagation(); skip(); });
    onKey = event => {
      if (event.key !== 'Escape' && event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      skip();
    };
    window.addEventListener('keydown', onKey);
    try { startTimeline(); } catch (_) { finish(); }
    return true;
  }

  window.CSIntro = {
    play: () => play(true),
    seen,
    reset: () => { try { localStorage.removeItem(SEEN_KEY); } catch (_) {} }
  };

  /* 第一次自动播。`?intro=1` 强制播，方便截图/回归；强制不写「已看过」。 */
  if (force) play(false);
  else if (!seen() && !envSkip()) play(false);
})();
