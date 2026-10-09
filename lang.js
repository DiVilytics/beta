// ── LANGUAGE ──────────────────────────────────────────────────────────────────
// English / Italian. Until the user picks one with the home page switch, the
// browser's language decides; once picked, the choice is kept in localStorage
// (like the theme). Loaded in <head> on every page, before every other script,
// together with the dictionaries (i18n/it.js).
//
// Only what's shown is translated: everything stored (DB rows, links such as
// ?vil=Horned%20King) stays in English. Anything without a translation falls
// back to English.

const LANGS = ['en', 'it'];

const LANG = (() => {
  let saved = null;
  try { saved = localStorage.getItem('lang'); } catch (_) {}
  if (LANGS.includes(saved)) return saved;
  const first = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
  return /^it\b/i.test(first) ? 'it' : 'en';
})();

// Locale for dates and numbers in the chosen language.
const LOCALE = LANG === 'it' ? 'it-IT' : 'en-US';

document.documentElement.lang = LANG;

// Text size (Settings: Small / Large), applied here because this is the one
// script every page loads in <head>, so the page never paints at the wrong size.
// setTextSize() lives in shared.js.
try { if (localStorage.getItem('textSize') === 'large') document.documentElement.dataset.text = 'large'; } catch (_) {}

// The beta: divilytics.github.io/beta/, the next version, tried out before it
// replaces this one. A browser that joined it (the account page, BETA_KEY)
// opens it in place of the release: any page of the release goes to the same
// page of the beta before anything shows.
const IS_BETA  = location.pathname.startsWith('/beta/');
const BETA_KEY = 'betaOptIn';
function betaJoined() {
  try { return localStorage.getItem(BETA_KEY) === '1'; } catch (_) { return false; }
}
if (!IS_BETA && location.hostname === 'divilytics.github.io' && betaJoined()) {
  location.replace(`/beta${location.pathname}${location.search}${location.hash}`);
}

// Pick a language (home page switch): remember it and redraw every page in it.
// The page reloads; nothing else should change (see THE PAGE ACROSS A SWITCH).
function setLang(lang) {
  if (!LANGS.includes(lang) || lang === LANG) return;
  try { localStorage.setItem('lang', lang); } catch (_) {}
  let state = null;
  try { state = _viewStateSave ? _viewStateSave() : null; } catch (_) {}
  try {
    sessionStorage.setItem(VIEW_STATE_KEY, JSON.stringify({ page: _viewPage(), state, scroll: Math.round(scrollY) }));
  } catch (_) {}
  location.reload();
}

// ── THE PAGE ACROSS A SWITCH ──────────────────────────────────────────────────
// Switching the language reloads the page, which would lose what it shows: a
// tab, the filters, a period, a search. A page with state of its own hands it
// over with keepViewState(() => ({ ...plain values })); setLang stores it for
// this browser tab with the scroll position, and after the reload the page
// takes it back once with takeViewState() (null otherwise) and applies it
// before its first render. The scroll position is restored here, once the page
// is tall enough again (its content loads after it).
const VIEW_STATE_KEY = 'viewState';
const _viewPage = () => location.pathname + location.search;
let _viewStateSave = null;
let _viewSaved = null;   // { page, state, scroll }, from the switch that reloaded this page
try {
  _viewSaved = JSON.parse(sessionStorage.getItem(VIEW_STATE_KEY) || 'null');
  sessionStorage.removeItem(VIEW_STATE_KEY);
  if (_viewSaved && _viewSaved.page !== _viewPage()) _viewSaved = null;
} catch (_) { _viewSaved = null; }

function keepViewState(save) { _viewStateSave = save; }

function takeViewState() {
  const state = _viewSaved?.state || null;
  if (_viewSaved) _viewSaved.state = null;
  return state;
}

// Back to the same scroll position: re-applied while the content loads (up to
// a few seconds), and dropped as soon as the reader scrolls or taps themselves.
if (_viewSaved?.scroll > 0) {
  try { history.scrollRestoration = 'manual'; } catch (_) {}
  const y = _viewSaved.scroll, until = Date.now() + 4000;
  let stop = false;
  for (const ev of ['wheel', 'touchstart', 'mousedown', 'keydown']) {
    addEventListener(ev, () => { stop = true; }, { once: true, passive: true, capture: true });
  }
  const keep = () => {
    if (stop || Date.now() > until) { try { history.scrollRestoration = 'auto'; } catch (_) {} return; }
    if (document.documentElement.scrollHeight - innerHeight >= y && Math.round(scrollY) !== y) scrollTo(0, y);
    setTimeout(keep, 100);
  };
  addEventListener('DOMContentLoaded', keep);
}

// The dictionary for the current language ({} for English).
function _dict(name) {
  return (LANG !== 'en' && window.I18N && window.I18N[LANG] && window.I18N[LANG][name]) || {};
}

// Interface text: t('Save game') → "Salva partita" in Italian, the English text
// itself when there's no translation. `{name}` placeholders are filled from
// `vars`: t('{n} games', { n: 3 }).
function t(text, vars) {
  let s = _dict('ui')[text] || text;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return s;
}

// Singular / plural: tn(n, '{n} game', '{n} games'). English and Italian both
// use the singular only for exactly 1.
function tn(n, one, many, vars) {
  return t(n === 1 ? one : many, Object.assign({ n }, vars));
}

// A villain's name in the current language. Names are stored in English (they
// are the key everywhere); a [TAG] rework keeps its tag: "Ursula [I2E]".
function villainName(name) {
  if (!name) return name;
  const m = /^(.*?)(\s*\[[^\]]+\])$/.exec(name);
  const base = m ? m[1] : name, tag = m ? m[2] : '';
  return (_dict('villains')[base] || base) + tag;
}

// The same, as markup for places that truncate long names: only the name gets
// the "…", the [TAG] stays whole after it, so "Capitan Uncino" and "Capitan
// Uncino [I2E]" can't be mistaken for each other. Style: .vn (style.css).
function villainNameHTML(name) {
  if (!name) return '';
  const m = /^(.*?)\s*(\[[^\]]+\])$/.exec(name);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!m) return `<span class="vn"><span class="vn-name">${esc(villainName(name))}</span></span>`;
  return `<span class="vn"><span class="vn-name">${esc(villainName(m[1]))}</span><span class="vn-tag">${esc(m[2])}</span></span>`;
}

// Inline version for names that never get cut: "Capitan Uncino [I2E]" with the
// tag in the same small style (.vn-tag), already escaped.
function villainNameInline(name) {
  if (!name) return '';
  const m = /^(.*?)\s*(\[[^\]]+\])$/.exec(name);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return m ? `${esc(villainName(m[1]))} <span class="vn-tag">${esc(m[2])}</span>` : esc(villainName(name));
}

// Static HTML: elements marked data-i18n get their content translated (the
// key is the element's own HTML, so inline markup like <em> can be kept), and
// data-i18n-attr="title placeholder" translates those attributes. Runs on
// DOMContentLoaded; call it again on markup added later that uses the markers.
function applyI18n(root = document) {
  if (LANG === 'en') return;
  root.querySelectorAll('[data-i18n]').forEach(el => {
    if (!el.dataset.i18nSrc) el.dataset.i18nSrc = el.innerHTML.replace(/\s+/g, ' ').trim();
    const tr = _dict('ui')[el.dataset.i18nSrc];
    if (tr) el.innerHTML = tr;
  });
  root.querySelectorAll('[data-i18n-attr]').forEach(el => {
    for (const attr of el.dataset.i18nAttr.split(/\s+/)) {
      const v = el.getAttribute(attr);
      if (v) el.setAttribute(attr, t(v));
    }
  });
}
document.addEventListener('DOMContentLoaded', () => applyI18n());
