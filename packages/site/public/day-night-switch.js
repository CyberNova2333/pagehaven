(function (global) {
  // 独立版昼夜开关（与文档站同源：内嵌参考实现 Day-night-toggle-button 4.0 的原始 DOM/CSS）
  // mount(container, { isDark, onToggle }) —— 应用负责切换与持久化，本组件管视觉与转场。
  // 结构：外层 .dn-host 可点击(69x27) > 缩放装饰层(pointer-events:none) > 影子宿主
  var REF_CSS = "* { margin: 0; padding: 0; transition: 0.7s; -webkit-tap-highlight-color:rgba(0,0,0,0); } .container { position: absolute;top: 50%;left: 50%;margin-top: -35em;margin-left: -90em;width: 180em; height: 70em; display: inline-block; vertical-align: bottom; transform: translate3d(0, 0, 0); } .components{ position:fixed; width: 180em; height: 70em; background-color: rgba(70, 133, 192,1); border-radius: 100em; box-shadow: inset 0 0 5em 3em rgba(0, 0, 0, 0.5); overflow: hidden; transition: 0.7s; transition-timing-function: cubic-bezier( 0,0.5, 1,1); cursor: pointer; } .main-button{ margin: 7.5em 0 0 7.5em; width: 55em; height:55em; background-color: rgba(255, 195, 35,1); border-radius: 50%; box-shadow:3em 3em 5em rgba(0, 0, 0, 0.5), inset -3em -5em 3em -3em rgba(0, 0, 0, 0.5), inset 4em 5em 2em -2em rgba(255, 230, 80,1); transition: 1.0s; transition-timing-function: cubic-bezier(0.56, 1.35, 0.52, 1.00); } .moon{ position: absolute; background-color: rgba(150, 160, 180, 1); box-shadow:inset 0em 0em 1em 1em rgba(0, 0, 0, 0.3) ; border-radius: 50%; transition: 0.5s; opacity: 0; } .moon:nth-child(1){ top: 7.5em; left: 25em; width: 12.5em; height: 12.5em; } .moon:nth-child(2){ top: 20em; left: 7.5em; width: 20em; height: 20em; } .moon:nth-child(3){ top: 32.5em; left: 32.5em; width: 12.5em; height: 12.5em; } .daytime-background { position: absolute; border-radius: 50%; transition: 1.0s; transition-timing-function: cubic-bezier(0.56, 1.35, 0.52, 1.00); } .daytime-background:nth-child(2){ top: -20em; left: -20em; width: 110em; height:110em; background-color: rgba(255, 255, 255,0.2); z-index: -2; } .daytime-background:nth-child(3){ top: -32.5em; left: -17.5em; width: 135em; height:135em; background-color: rgba(255, 255, 255,0.1); z-index: -3; } .daytime-background:nth-child(4){ top: -45em; left: -15em; width: 160em; height:160em; background-color: rgba(255, 255, 255,0.05); z-index: -4; } .cloud,.cloud-light{ transform: translateY(10em); transition: 1.0s; transition-timing-function: cubic-bezier(0.56, 1.35, 0.52, 1.00); } .cloud-son{ position: absolute; background-color: #fff; border-radius: 50%; z-index: -1; transition: transform 6s,right 1s,bottom 1s; } .cloud-son:nth-child(6n+1){ right: -20em; bottom: 10em; width: 50em; height: 50em; } .cloud-son:nth-child(6n+2) { right: -10em; bottom: -25em; width: 60em; height: 60em; } .cloud-son:nth-child(6n+3) { right: 20em; bottom: -40em; width: 60em; height: 60em; } .cloud-son:nth-child(6n+4) { right: 50em; bottom: -35em; width: 60em; height: 60em; } .cloud-son:nth-child(6n+5) { right: 75em; bottom: -60em; width: 75em; height: 75em; } .cloud-son:nth-child(6n+6) { right: 110em; bottom: -50em; width: 60em; height: 60em; } .cloud{ z-index: -2; } .cloud-light{ position: absolute; right: 0em; bottom: 25em; opacity: 0.5; z-index: -3; /*transform: rotate(-5deg);*/ } .stars{ transform: translateY(-125em); z-index: -2; transition: 1.0s; transition-timing-function: cubic-bezier(0.56, 1.35, 0.52, 1.00); } .big { --size: 7.5em; } .medium { --size: 5em; } .small { --size: 3em; } .star { position: absolute; width: calc(2*var(--size)); height: calc(2*var(--size)); } .star:nth-child(1){ top: 11em; left: 39em; animation-name: star; animation-duration: 3.5s; } .star:nth-child(2){ top: 39em; left: 91em; animation-name: star; animation-duration: 4.1s; } .star:nth-child(3){ top: 26em; left: 19em; animation-name: star; animation-duration: 4.9s; } .star:nth-child(4){ top: 37em; left: 66em; animation-name: star; animation-duration: 5.3s; } .star:nth-child(5){ top: 21em; left: 75em; animation-name: star; animation-duration: 3s; } .star:nth-child(6){ top: 51em; left: 38em; animation-name: star; animation-duration: 2.2s; } @keyframes star { 0%,20%{ transform: scale(0); } 20%,100% { transform: scale(1); } } .star-son{ float: left; } .star-son:nth-child(1) { --pos: left 0; } .star-son:nth-child(2) { --pos: right 0; } .star-son:nth-child(3) { --pos: 0 bottom; } .star-son:nth-child(4) { --pos: right bottom; } .star-son { width: var(--size); height: var(--size); background-image: radial-gradient(circle var(--size) at var(--pos), transparent var(--size), #fff); } .star{ transform: scale(1); transition-timing-function: cubic-bezier(0.56, 1.35, 0.52, 1.00); transition: 1s; animation-iteration-count:infinite; animation-direction: alternate; animation-timing-function: linear; } .twinkle { transform: scale(0); }";
  var REF_HTML = "<div class=\"components\"><div class=\"main-button\"><div class=\"moon\"></div><div class=\"moon\"></div><div class=\"moon\"></div></div><div class=\"daytime-background\"></div><div class=\"daytime-background\"></div><div class=\"daytime-background\"></div><div class=\"cloud\"><div class=\"cloud-son\"></div><div class=\"cloud-son\"></div><div class=\"cloud-son\"></div><div class=\"cloud-son\"></div><div class=\"cloud-son\"></div><div class=\"cloud-son\"></div></div><div class=\"cloud-light\"><div class=\"cloud-son\"></div><div class=\"cloud-son\"></div><div class=\"cloud-son\"></div><div class=\"cloud-son\"></div><div class=\"cloud-son\"></div><div class=\"cloud-son\"></div></div><div class=\"stars\"><div class=\"star big\"><div class=\"star-son\"></div><div class=\"star-son\"></div><div class=\"star-son\"></div><div class=\"star-son\"></div></div><div class=\"star big\"><div class=\"star-son\"></div><div class=\"star-son\"></div><div class=\"star-son\"></div><div class=\"star-son\"></div></div><div class=\"star medium\"><div class=\"star-son\"></div><div class=\"star-son\"></div><div class=\"star-son\"></div><div class=\"star-son\"></div></div><div class=\"star medium\"><div class=\"star-son\"></div><div class=\"star-son\"></div><div class=\"star-son\"></div><div class=\"star-son\"></div></div><div class=\"star small\"><div class=\"star-son\"></div><div class=\"star-son\"></div><div class=\"star-son\"></div><div class=\"star-son\"></div></div><div class=\"star small\"><div class=\"star-son\"></div><div class=\"star-son\"></div><div class=\"star-son\"></div><div class=\"star-son\"></div></div></div></div>";
  var EXTRA_CSS = "\n.dn-plane, .dn-bear { position: absolute; left: 0; top: 0; z-index: -1; opacity: 0;\n  pointer-events: none; transition: opacity 0.8s ease; }\n.dn-plane svg, .dn-bear svg { display: block; overflow: visible; }\n.dn-plane svg { width: 24em; height: 14.5em; }\n.dn-bear svg { width: 30em; height: 30em; }\n.is-day .dn-plane { opacity: 0.95; }\n.is-night .dn-bear { opacity: 0.95; }\n.dn-plane { animation: dn-plane-fly 9.5s linear infinite; }\n.dn-bear { animation: dn-bear-float 17s linear infinite; }\n@keyframes dn-plane-fly {\n  0% { transform: translate(-28em, 14em) rotate(-4deg); }\n  35% { transform: translate(70em, 9em) rotate(2deg); }\n  70% { transform: translate(150em, 15em) rotate(-2deg); }\n  100% { transform: translate(196em, 10em) rotate(4deg); }\n}\n@keyframes dn-bear-float {\n  0% { transform: translate(-30em, 34em) rotate(-10deg); }\n  30% { transform: translate(50em, 27em) rotate(6deg); }\n  55% { transform: translate(112em, 33em) rotate(-6deg); }\n  80% { transform: translate(160em, 26em) rotate(8deg); }\n  100% { transform: translate(200em, 32em) rotate(-10deg); }\n}\n@media (prefers-reduced-motion: reduce) {\n  .dn-plane, .dn-bear { animation: none !important; opacity: 0 !important; }\n}\n";
  var EXTRA_HTML = "\n<div class=\"dn-plane\" aria-hidden=\"true\">\n  <svg viewBox=\"0 0 30 18\">\n    <path d=\"M30 9 L1 0.5 L11 9 Z\" fill=\"#fff\"/>\n    <path d=\"M30 9 L11 9 L1 17.5 Z\" fill=\"rgba(0,0,0,0.16)\"/>\n    <path d=\"M30 9 L6 9\" stroke=\"rgba(0,0,0,0.10)\" stroke-width=\"1\" fill=\"none\"/>\n  </svg>\n</div>\n<div class=\"dn-bear\" aria-hidden=\"true\">\n  <svg viewBox=\"-20 -20 40 40\">\n    <rect x=\"-9\" y=\"2\" width=\"18\" height=\"14\" rx=\"5\" fill=\"#b9c4d4\"/>\n    <ellipse cx=\"0\" cy=\"9\" rx=\"7.5\" ry=\"8\" fill=\"#e6ecf5\"/>\n    <ellipse cx=\"-7.6\" cy=\"7\" rx=\"2.8\" ry=\"2.2\" fill=\"#cfd9e6\"/>\n    <ellipse cx=\"7.6\" cy=\"7\" rx=\"2.8\" ry=\"2.2\" fill=\"#cfd9e6\"/>\n    <circle cx=\"-6.2\" cy=\"-8\" r=\"3.4\" fill=\"#a8845c\"/>\n    <circle cx=\"6.2\" cy=\"-8\" r=\"3.4\" fill=\"#a8845c\"/>\n    <circle cx=\"-6.2\" cy=\"-8\" r=\"1.7\" fill=\"#c9a583\"/>\n    <circle cx=\"6.2\" cy=\"-8\" r=\"1.7\" fill=\"#c9a583\"/>\n    <circle cx=\"0\" cy=\"-1.5\" r=\"8\" fill=\"#a8845c\"/>\n    <ellipse cx=\"0\" cy=\"2.2\" rx=\"3.6\" ry=\"2.7\" fill=\"#d8b894\"/>\n    <circle cx=\"0\" cy=\"1.3\" r=\"1.1\" fill=\"#4a3628\"/>\n    <circle cx=\"-3\" cy=\"-3\" r=\"1.15\" fill=\"#2b2b3a\"/>\n    <circle cx=\"3\" cy=\"-3\" r=\"1.15\" fill=\"#2b2b3a\"/>\n    <circle cx=\"0\" cy=\"-1\" r=\"13.5\" fill=\"rgba(255,255,255,0.16)\" stroke=\"#fff\" stroke-width=\"1.6\"/>\n    <path d=\"M-9.5 -8.5 a10.5 10.5 0 0 1 6.5 -7\" fill=\"none\" stroke=\"rgba(255,255,255,0.75)\" stroke-width=\"1.4\" stroke-linecap=\"round\"/>\n  </svg>\n</div>";


  function colorShift() {
    if (global.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var r = document.documentElement;
    r.classList.add('dn-color-shift');
    setTimeout(function () { r.classList.remove('dn-color-shift'); }, 760);
  }
  function mount(container, options) {
    options = options || {};
    var isDark = options.isDark || function () { return false; };
    var onToggle = options.onToggle || function () {};
    if (!container || container.querySelector('.dn-host')) return null;

    var host = document.createElement('div');
    host.className = 'dn-host';
    host.setAttribute('role', 'switch');
    host.setAttribute('tabindex', '0');
    host.setAttribute('aria-label', '深色配色');
    host.style.cssText = 'position:relative;display:inline-block;width:90px;height:35px;vertical-align:middle;cursor:pointer;pointer-events:auto;margin:0 6px';

    var wrap = document.createElement('div');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.cssText = 'position:absolute;left:50%;top:50%;width:180px;height:70px;margin-left:-90px;margin-top:-35px;transform:scale(0.5);transform-origin:center;pointer-events:none';

    var scene = document.createElement('div');
    scene.style.cssText = 'position:absolute;inset:0;width:180px;height:70px';

    var shadow = scene.attachShadow({ mode: 'closed' });
    var box = document.createElement('div');
    box.className = 'container';
    box.style.fontSize = '1px';
    box.innerHTML = REF_HTML;
    var comp = box.querySelector('.components');
    if (comp && EXTRA_HTML) comp.insertAdjacentHTML('beforeend', EXTRA_HTML);
    var style = document.createElement('style');
    // Shadow DOM 不会继承页面的减弱动效规则，星星和所有转场也必须在这里关闭。
    style.textContent = REF_CSS + EXTRA_CSS + '\n@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }';
    shadow.appendChild(style);
    shadow.appendChild(box);
    wrap.appendChild(scene);
    host.appendChild(wrap);
    container.appendChild(host);

    function apply(dark) {
      host.setAttribute('aria-checked', dark ? 'true' : 'false');
      box.classList.remove('is-day', 'is-night');
      box.classList.add(dark ? 'is-night' : 'is-day');
      var knob = shadow.querySelector('.main-button');
      var bgs = shadow.querySelectorAll('.daytime-background');
      var cloud = shadow.querySelector('.cloud');
      var cloudLight = shadow.querySelector('.cloud-light');
      var track = shadow.querySelector('.components');
      var moons = shadow.querySelectorAll('.moon');
      var stars = shadow.querySelector('.stars');
      if (dark) {
        knob.style.transform = 'translateX(110em)';
        knob.style.backgroundColor = 'rgba(195, 200, 210, 1)';
        knob.style.boxShadow = '3em 3em 5em rgba(0,0,0,0.5), inset -3em -5em 3em -3em rgba(0,0,0,0.5), inset 4em 5em 2em -2em rgba(255,255,210,1)';
        if (bgs[0]) bgs[0].style.transform = 'translateX(110em)';
        if (bgs[1]) bgs[1].style.transform = 'translateX(80em)';
        if (bgs[2]) bgs[2].style.transform = 'translateX(50em)';
        cloud.style.transform = 'translateY(80em)'; cloudLight.style.transform = 'translateY(80em)';
        track.style.backgroundColor = 'rgba(25,30,50,1)';
        for (var i = 0; i < moons.length; i++) moons[i].style.opacity = '1';
        stars.style.transform = 'translateY(-62.5em)'; stars.style.opacity = '1';
      } else {
        knob.style.transform = 'translateX(0)';
        knob.style.backgroundColor = 'rgba(255,195,35,1)';
        knob.style.boxShadow = '3em 3em 5em rgba(0,0,0,0.5), inset -3em -5em 3em -3em rgba(0,0,0,0.5), inset 4em 5em 2em -2em rgba(255,230,80,1)';
        for (var j = 0; j < bgs.length; j++) bgs[j].style.transform = 'translateX(0)';
        cloud.style.transform = 'translateY(10em)'; cloudLight.style.transform = 'translateY(10em)';
        track.style.backgroundColor = 'rgba(70,133,192,1)';
        for (var m = 0; m < moons.length; m++) moons[m].style.opacity = '0';
        stars.style.transform = 'translateY(-125em)'; stars.style.opacity = '0';
      }
    }

    var comp0 = shadow.querySelector('.components');
    comp0.style.transition = 'none';
    apply(isDark());
    var transitionTimer = setTimeout(function () { comp0.style.removeProperty('transition'); }, 60);

    function trigger() {
      var next = !isDark();
      colorShift();
      // 先更新应用状态，再展示实际结果；延迟写入会覆盖期间发生的系统或跨标签变化。
      onToggle(next);
      apply(isDark());
    }
    host.addEventListener('click', trigger);
    function onKey(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); }
    }
    host.addEventListener('keydown', onKey);

    var reducedMotion = global.matchMedia('(prefers-reduced-motion: reduce)');
    var knob2 = shadow.querySelector('.main-button');
    var cloud2 = shadow.querySelector('.cloud');
    function onEnter() {
      if (!reducedMotion.matches) {
        knob2.style.transform = isDark() ? 'translateX(100em)' : 'translateX(10em)';
        cloud2.style.transform = 'translateY(14em)';
      }
    }
    function onLeave() { apply(isDark()); }
    host.addEventListener('mouseenter', onEnter);
    host.addEventListener('mouseleave', onLeave);
    var sons = shadow.querySelectorAll('.cloud-son');
    var dirs = ['2em', '-2em'];
    var cloudTimer;
    function animateClouds() {
      if (document.hidden || reducedMotion.matches) return;
      for (var i = 0; i < sons.length; i++) {
        sons[i].style.transform = 'translate(' + dirs[Math.floor(Math.random() * 2)] + ', ' + dirs[Math.floor(Math.random() * 2)] + ')';
      }
    }
    function updateMotion() {
      clearInterval(cloudTimer);
      if (!reducedMotion.matches) cloudTimer = setInterval(animateClouds, 1000);
      else {
        for (var i = 0; i < sons.length; i++) sons[i].style.transform = '';
        apply(isDark());
      }
    }
    updateMotion();
    if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', updateMotion);
    else if (reducedMotion.addListener) reducedMotion.addListener(updateMotion);
    return {
      apply: apply, host: host,
      destroy: function () {
        clearTimeout(transitionTimer);
        clearInterval(cloudTimer);
        if (reducedMotion.removeEventListener) reducedMotion.removeEventListener('change', updateMotion);
        else if (reducedMotion.removeListener) reducedMotion.removeListener(updateMotion);
        host.removeEventListener('click', trigger);
        host.removeEventListener('keydown', onKey);
        host.removeEventListener('mouseenter', onEnter);
        host.removeEventListener('mouseleave', onLeave);
        host.remove();
      }
    };
  }

  global.DayNightSwitch = { mount: mount };
})(window);
