// F.A.Q. page: rules clarifications translated from the Villainous Italia F.A.Q.
// (asset/data/faq.json), plus the official rulebooks summarized. faq.html shows
// the topic menu, ?topic=<rulebook id> a rulebook (e.g. ?topic=rules),
// ?topic=general the general rules and ?topic=<villain> one villain's entries.
// The search box filters every entry across all topics; clearing it goes back
// to that view.

const FAQ_GENERAL = 'general';

let faqData  = null;
let faqTopic = null;   // null = menu | rulebook id | FAQ_GENERAL | villain name | undefined = unknown

function _faqHref(topic) {
  return `faq.html?topic=${encodeURIComponent(topic)}`;
}

// ?topic= is case-insensitive. [TAG] reworks (e.g. "Ursula [I2E]") are separate
// villains and only match entries filed under their own full name.
function _resolveTopic(raw) {
  if (!raw) return null;
  if (raw.toLowerCase() === FAQ_GENERAL) return FAQ_GENERAL;
  const base  = raw.toLowerCase();
  return Object.keys(_rulebooks()).find(id => id === base)
    || Object.keys(faqData.villains).find(v => v.toLowerCase() === base);
}

// The official rulebooks, summarized: { id: { title, desc, intro, groups } }.
function _rulebooks() {
  return faqData.rulebooks || {};
}

function _countItems(groups) {
  return groups.reduce((n, g) => n + g.items.length, 0);
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

// An entry's villain field, shown in the current language. It can list several
// villains ("Prince John, Evil Queen"), each translated on its own.
function _entryVillains(item) {
  return item.villain ? item.villain.split(', ').map(villainName).join(', ') : '';
}

// Every term must appear somewhere in the entry or its section's name, as shown
// in the current language (so "bau bau" only finds Oogie Boogie in Italian).
function _matches(item, section, terms) {
  const hay = [item.term, _entryVillains(item), item.text, section].filter(Boolean).join(' ').toLowerCase();
  return terms.every(t => hay.includes(t));
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function _entryHTML(item, re) {
  return `
    <div class="home-faq-item faq-item">
      <strong>${_hl(item.term, re)}${item.villain ? `<span class="faq-vil"> | ${_hl(_entryVillains(item), re)}</span>` : ''}</strong>
      <span>${_hl(item.text, re)}</span>
      ${item.source ? `<span class="faq-src">${_esc(t('Source: {source}', { source: item.source }))}</span>` : ''}
    </div>`;
}

function _listHTML(items, re) {
  return `<div class="home-faq-list">${items.map(it => _entryHTML(it, re)).join('')}</div>`;
}

// The villains with entries, sorted by their name in the current language.
function _villainNames() {
  return Object.keys(faqData.villains).sort((a, b) => villainName(a).localeCompare(villainName(b), LOCALE));
}

function _menuHTML() {
  const generalCount = _countItems(faqData.general);
  return `
    ${Object.entries(_rulebooks()).map(([id, rb]) => `
      <a class="home-section-link faq-rulebook-link" href="${_faqHref(id)}">
        <span class="home-section-icon">📖</span>
        <div class="home-section-text">
          <span class="home-section-name">${_esc(rb.title)}</span>
          <span class="home-section-desc">${_esc(rb.desc)} (${tn(_countItems(rb.groups), '{n} entry', '{n} entries')})</span>
        </div>
      </a>`).join('')}
    <a class="home-section-link faq-general-link" href="${_faqHref(FAQ_GENERAL)}">
      <span class="home-section-icon">⚖️</span>
      <div class="home-section-text">
        <span class="home-section-name">${t('General')}</span>
        <span class="home-section-desc">${t('Core rules and cards that work the same way across villains ({n} entries)', { n: generalCount })}</span>
      </div>
    </a>
    <h2 class="home-faq-title">${t('Villains')}</h2>
    <div class="char-roster">
      ${_villainNames().map(v => `
        <a class="char-roster-item" href="${_faqHref(v)}">
          <img class="char-roster-portrait" src="${charImgSrc(v)}" alt="" onerror="this.src='asset/players/default.svg'">
          <div class="char-roster-name">${villainNameInline(v)}</div>
          <div class="faq-roster-sub">${tn(faqData.villains[v].length, '{n} entry', '{n} entries')}</div>
        </a>`).join('')}
    </div>
    <p class="faq-credit">${t('Translated from the F.A.Q. by {link} (version 6.0, September 2026). Each entry names its source: the rulebook, the card text, the Villain Guide, a designer or a playtester.', { link: '<a href="https://www.instagram.com/villainousitalia/" target="_blank" rel="noopener">Villainous Italia</a>' })}</p>`;
}

// Back to the page you came from (a villain's "Rules F.A.Q." link, the topic
// menu…), or the topic menu when the page was opened cold.
const _BACK_HTML = `<a class="back-link" href="faq.html" onclick="goBack('faq.html'); return false;">${t('← Back')}</a>`;

function _groupsHTML(groups) {
  return groups.map(g => `
    <div class="faq-group">
      <h2 class="home-faq-title">${_esc(g.title)}</h2>
      ${g.intro ? `<p class="faq-group-intro">${_esc(g.intro)}</p>` : ''}
      ${_listHTML(g.items, null)}
    </div>`).join('');
}

function _generalHTML() {
  return _BACK_HTML + _groupsHTML(faqData.general);
}

function _rulebookHTML(id) {
  const rb = _rulebooks()[id];
  return `${_BACK_HTML}
    <h2 class="faq-rulebook-title">${_esc(rb.title)}</h2>
    ${rb.intro ? `<p class="faq-rulebook-intro">${_esc(rb.intro)}</p>` : ''}
    ${_groupsHTML(rb.groups)}`;
}

function _villainHTML(v) {
  return `${_BACK_HTML}
    <div class="pf-identity faq-identity">
      <img class="char-portrait identity-portrait" src="${charImgSrc(v)}" alt="" onerror="this.src='asset/players/default.svg'">
      <span class="pf-name-block">
        <span class="pf-nick">${villainNameInline(v)}</span>
        <a class="pf-since pf-since-link" href="villains.html?vil=${encodeURIComponent(v)}">${t('View stats')}</a>
      </span>
    </div>
    ${_listHTML(faqData.villains[v], null)}`;
}

function _resultsHTML(q) {
  const terms = _searchTerms(q);
  const re    = _termsRegex(terms);
  const groups = [];
  for (const [id, rb] of Object.entries(_rulebooks())) {
    for (const g of rb.groups) {
      const items = g.items.filter(it => _matches(it, `${rb.title} ${g.title}`, terms));
      if (items.length) groups.push({ title: `<a class="faq-title-link" href="${_faqHref(id)}">${_esc(rb.title)}</a> <span>${_esc(g.title)}</span>`, items });
    }
  }
  for (const g of faqData.general) {
    const items = g.items.filter(it => _matches(it, `${t('General')} ${g.title}`, terms));
    if (items.length) groups.push({ title: `<a class="faq-title-link" href="${_faqHref(FAQ_GENERAL)}">${t('General')}</a> <span>${_esc(g.title)}</span>`, items });
  }
  for (const v of _villainNames()) {
    const items = faqData.villains[v].filter(it => _matches(it, villainName(v), terms));
    if (items.length) groups.push({ title: `<a class="faq-title-link" href="${_faqHref(v)}">${_hl(villainName(v), re)}</a>`, items });
  }
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) return `<div class="empty"><h3>${t('No results')}</h3><p>${t('Nothing in the FAQ matches “{query}”.', { query: _esc(q.trim()) })}</p></div>`;
  return `<p class="faq-count">${tn(total, '{n} result', '{n} results')}</p>` + groups.map(g => `
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
  else if (_rulebooks()[faqTopic])   root.innerHTML = _rulebookHTML(faqTopic);
  else if (faqTopic)              root.innerHTML = _villainHTML(faqTopic);
  else root.innerHTML = `${_BACK_HTML}<div class="empty"><h3>${t('Topic not found')}</h3><p>${_esc(new URLSearchParams(location.search).get('topic') || '')}</p></div>`;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('faq.html');
  initAuth();

  faqData = await loadFaq();
  if (!faqData.general || !faqData.villains) {
    const root = document.getElementById('faqRoot');
    root.className = '';
    root.innerHTML = `<div class="empty"><h3>${t("Couldn't load the FAQ")}</h3><p>${t('Try reloading the page.')}</p></div>`;
    return;
  }

  faqTopic = _resolveTopic((new URLSearchParams(location.search).get('topic') || '').trim());
  if (faqTopic === FAQ_GENERAL) document.title = `DiVilytics | F.A.Q. | ${t('General')}`;
  else if (_rulebooks()[faqTopic]) document.title = `DiVilytics | F.A.Q. | ${_rulebooks()[faqTopic].title}`;
  else if (faqTopic)            document.title = `DiVilytics | F.A.Q. | ${villainName(faqTopic)}`;

  const input = document.getElementById('faqSearchInput');
  input.disabled = false;
  input.addEventListener('input', render);
  input.addEventListener('keydown', e => {
    // A first Escape clears the search, a second one leaves the box (shared.js).
    if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; render(); }
  });
  render();
}

init();
