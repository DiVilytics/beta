// ── THEME ─────────────────────────────────────────────────────────────────────
// Light / dark / auto theme: applied before first paint, persisted in
// localStorage, and reflected into the nav logo, favicon and mobile address-bar
// color. `_updateThemeBtn` / `_updateThemeIcons` are called by shared.js when it
// (re)paints the nav, so theme.js must load before shared.js.

(function () {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else if (saved === 'dark') {
    // forced dark: no attribute needed
  } else {
    // 'auto' or unset (first visit): follow the device preference
    if (!window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.setAttribute('data-theme', 'light');
  }
})();

let _autoMql = null;

function _onAutoChange(e) {
  if (e.matches) document.documentElement.removeAttribute('data-theme');
  else           document.documentElement.setAttribute('data-theme', 'light');
  _updateThemeBtn();
  _updateThemeIcons();
}

function _applyTheme(state) {
  if (_autoMql) { _autoMql.removeEventListener('change', _onAutoChange); _autoMql = null; }
  if (state === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else if (state === 'dark') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    if (mql.matches) document.documentElement.removeAttribute('data-theme');
    else             document.documentElement.setAttribute('data-theme', 'light');
    _autoMql = mql;
    _autoMql.addEventListener('change', _onAutoChange);
  }
  localStorage.setItem('theme', state);
  _updateThemeBtn();
  _updateThemeIcons();
}

// Re-attach auto listener on page load when following the device (explicit
// 'auto', or unset on first visit) so live system theme changes are reflected.
if ((localStorage.getItem('theme') || 'auto') === 'auto') {
  _autoMql = window.matchMedia('(prefers-color-scheme: dark)');
  _autoMql.addEventListener('change', _onAutoChange);
}

function _updateThemeIcons() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const asset = isLight ? 'asset/logos/logo-w.svg' : 'asset/logos/logo-b.svg';
  const navImg = document.querySelector('.nav-brand img');
  if (navImg) navImg.src = asset;
  _updateFavicon();
  _updateThemeColor();
}

// Match the mobile browser address-bar color to the app theme (the page
// background), so the chrome isn't stuck on the default/dark value.
function _updateThemeColor() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const color = isLight ? '#ffffff' : '#000000';
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  if (meta.getAttribute('content') !== color) meta.setAttribute('content', color);
}

// Drive the SVG favicon from the app's own theme (the in-page light/dark
// toggle), not the OS `prefers-color-scheme`, otherwise it only follows the
// system and ignores the user's choice.
function _updateFavicon() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const V = '?v=20260603b';

  // SVG favicon (Chrome / Firefox / Edge).
  let svg = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
  if (!svg) {
    svg = document.createElement('link');
    svg.rel = 'icon'; svg.type = 'image/svg+xml';
    document.head.appendChild(svg);
  }
  const svgHref = (isLight ? '/asset/favicon/favicon-light.svg' : '/asset/favicon/favicon-dark.svg') + V;
  if (svg.getAttribute('href') !== svgHref) svg.setAttribute('href', svgHref);

  // PNG fallback favicon, default file is the dark one; swap to the light
  // variant on light theme. If a browser ignores this, the dark default stays.
  const png = document.querySelector('link[rel="icon"][type="image/png"]');
  if (png) {
    const pngHref = (isLight ? '/asset/favicon/favicon-96x96-light.png' : '/asset/favicon/favicon-96x96.png') + V;
    if (png.getAttribute('href') !== pngHref) png.setAttribute('href', pngHref);
  }
}

// Match the favicon + address-bar color to the theme resolved on initial load.
_updateFavicon();
_updateThemeColor();

function _nextTheme(current) {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (current === 'auto') return systemDark ? 'light' : 'dark';
  if (systemDark)         return current === 'light' ? 'dark' : 'auto';
  return                         current === 'dark'  ? 'light' : 'auto';
}

function toggleTheme() {
  _applyTheme(_nextTheme(localStorage.getItem('theme') || 'auto'));
}

function _updateThemeBtn() {
  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;
  const current = localStorage.getItem('theme') || 'auto';
  const next    = _nextTheme(current);
  const icons   = { dark: '🌙', light: '☀️', auto: '🌗' };
  const titles  = { dark: 'Force dark', light: 'Force light', auto: 'Follow system' };
  btn.textContent = icons[current];
  btn.title       = titles[next];
}
