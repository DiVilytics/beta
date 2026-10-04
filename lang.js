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

// Pick a language (home page switch): remember it and redraw every page in it.
function setLang(lang) {
  if (!LANGS.includes(lang) || lang === LANG) return;
  try { localStorage.setItem('lang', lang); } catch (_) {}
  location.reload();
}

// The dictionary for the current language ({} for English).
function _dict(name) {
  return (LANG !== 'en' && window.I18N && window.I18N[LANG] && window.I18N[LANG][name]) || {};
}

// Interface text: t('Save Game') → "Salva partita" in Italian, the English text
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
