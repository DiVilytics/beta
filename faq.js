// F.A.Q. page: rules clarifications translated from the Villainous Italia F.A.Q.
// (asset/data/faq.json). faq.html shows the topic menu, ?topic=general the
// general rules and ?topic=<villain> one villain's entries. The search box
// filters every entry across all topics; clearing it goes back to that view.

const FAQ_GENERAL = 'general';

let faqData  = null;
let faqTopic = null;   // null = menu | FAQ_GENERAL | villain name | undefined = unknown

function _faqHref(topic) {
  return `faq.html?topic=${encodeURIComponent(topic)}`;
}

// ?topic= is case-insensitive, and [TAG] reworks (e.g. "Ursula [I2E]") share
// their base villain's entries.
function _resolveTopic(raw) {
  if (!raw) return null;
  if (raw.toLowerCase() === FAQ_GENERAL) return FAQ_GENERAL;
  const base  = raw.replace(/\s*\[[^\]]+\]$/, '').toLowerCase();
  return Object.keys(faqData.villains).find(v => v.toLowerCase() === base);
}

// ── HIGHLIGHT / MATCH ─────────────────────────────────────────────────────────

function _searchTerms(q) {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

function _termsRegex(terms) {
  if (!terms.length) return null;
  return new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
}

// Escape `str` and wrap the parts matching `re` in <mark>.
function _hl(str, re) {
  if (!re) return _esc(str);
  return str.split(re).map((part, i) => i % 2 ? `<mark>${_esc(part)}</mark>` : _esc(part)).join('');
}

// Every term must appear somewhere in the entry or its section's name.
function _matches(item, section, terms) {
  const hay = [item.term, item.villain, item.text, section].filter(Boolean).join(' ').toLowerCase();
  return terms.every(t => hay.includes(t));
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function _entryHTML(item, re) {
  return `
    <div class="home-faq-item faq-item">
      <strong>${_hl(item.term, re)}${item.villain ? `<span class="faq-vil"> | ${_hl(item.villain, re)}</span>` : ''}</strong>
      <span>${_hl(item.text, re)}</span>
      ${item.source ? `<span class="faq-src">Source: ${_esc(item.source)}</span>` : ''}
    </div>`;
}

function _listHTML(items, re) {
  return `<div class="home-faq-list">${items.map(it => _entryHTML(it, re)).join('')}</div>`;
}

function _villainNames() {
  return Object.keys(faqData.villains).sort((a, b) => a.localeCompare(b));
}

function _menuHTML() {
  const generalCount = faqData.general.reduce((n, g) => n + g.items.length, 0);
  return `
    <a class="home-section-link faq-general-link" href="${_faqHref(FAQ_GENERAL)}">
      <span class="home-section-icon">⚖️</span>
      <div class="home-section-text">
        <span class="home-section-name">General</span>
        <span class="home-section-desc">Core rules and cards that work the same way across villains (${generalCount} entries)</span>
      </div>
    </a>
    <h2 class="home-faq-title">Villains</h2>
    <div class="char-roster">
      ${_villainNames().map(v => `
        <a class="char-roster-item" href="${_faqHref(v)}">
          <img class="char-roster-portrait" src="${charImgSrc(v)}" alt="" onerror="this.src='asset/players/default.svg'">
          <div class="char-roster-name">${_esc(v)}</div>
          <div class="faq-roster-sub">${faqData.villains[v].length} ${faqData.villains[v].length === 1 ? 'entry' : 'entries'}</div>
        </a>`).join('')}
    </div>
    <p class="faq-credit">Translated from the F.A.Q. by <a href="https://www.instagram.com/villainousitalia/" target="_blank" rel="noopener">Villainous Italia</a> (version 6.0, September 2026). Each entry names its source: the rulebook, the card text, the Villain Guide, a designer or a playtester.</p>`;
}

const _BACK_HTML = `<a class="back-link" href="faq.html">← All topics</a>`;

function _generalHTML() {
  return _BACK_HTML + faqData.general.map(g => `
    <div class="faq-group">
      <h2 class="home-faq-title">${_esc(g.title)}</h2>
      ${g.intro ? `<p class="faq-group-intro">${_esc(g.intro)}</p>` : ''}
      ${_listHTML(g.items, null)}
    </div>`).join('');
}

function _villainHTML(v) {
  return `${_BACK_HTML}
    <div class="pf-identity faq-identity">
      <img class="char-portrait identity-portrait" src="${charImgSrc(v)}" alt="" onerror="this.src='asset/players/default.svg'">
      <span class="pf-name-block">
        <span class="pf-nick">${_esc(v)}</span>
        <a class="pf-since pf-since-link" href="villains.html?vil=${encodeURIComponent(v)}">View stats</a>
      </span>
    </div>
    ${_listHTML(faqData.villains[v], null)}`;
}

function _resultsHTML(q) {
  const terms = _searchTerms(q);
  const re    = _termsRegex(terms);
  const groups = [];
  for (const g of faqData.general) {
    const items = g.items.filter(it => _matches(it, `General ${g.title}`, terms));
    if (items.length) groups.push({ title: `<a class="faq-title-link" href="${_faqHref(FAQ_GENERAL)}">General</a> <span>${_esc(g.title)}</span>`, items });
  }
  for (const v of _villainNames()) {
    const items = faqData.villains[v].filter(it => _matches(it, v, terms));
    if (items.length) groups.push({ title: `<a class="faq-title-link" href="${_faqHref(v)}">${_hl(v, re)}</a>`, items });
  }
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) return `<div class="empty"><h3>No results</h3><p>Nothing in the FAQ matches “${_esc(q.trim())}”.</p></div>`;
  return `<p class="faq-count">${total} ${total === 1 ? 'result' : 'results'}</p>` + groups.map(g => `
    <div class="faq-group">
      <h2 class="home-faq-title">${g.title}</h2>
      ${_listHTML(g.items, re)}
    </div>`).join('');
}

function render() {
  const root = document.getElementById('faqRoot');
  root.className = '';
  const q = document.getElementById('faqSearchInput').value;
  if (q.trim())                   root.innerHTML = _resultsHTML(q);
  else if (faqTopic === null)     root.innerHTML = _menuHTML();
  else if (faqTopic === FAQ_GENERAL) root.innerHTML = _generalHTML();
  else if (faqTopic)              root.innerHTML = _villainHTML(faqTopic);
  else root.innerHTML = `${_BACK_HTML}<div class="empty"><h3>Topic not found</h3><p>${_esc(new URLSearchParams(location.search).get('topic') || '')}</p></div>`;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('faq.html');
  initAuth();

  faqData = await loadFaq();
  if (!faqData.general || !faqData.villains) {
    const root = document.getElementById('faqRoot');
    root.className = '';
    root.innerHTML = `<div class="empty"><h3>Couldn't load the FAQ</h3><p>Try reloading the page.</p></div>`;
    return;
  }

  faqTopic = _resolveTopic((new URLSearchParams(location.search).get('topic') || '').trim());
  if (faqTopic === FAQ_GENERAL) document.title = 'DiVilytics | F.A.Q. | General';
  else if (faqTopic)            document.title = `DiVilytics | F.A.Q. | ${faqTopic}`;

  const input = document.getElementById('faqSearchInput');
  input.disabled = false;
  input.addEventListener('input', render);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape' && input.value) { input.value = ''; render(); }
  });
  render();
}

init();
