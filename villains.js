// ── STATE ─────────────────────────────────────────────────────────────────────
// Static character data (objectives, FAQ) is loaded from JSON via db.js.

let csMode    = 'pct';   // 'pct' | 'count' | 'games'
let csChar    = null;      // character record from DB
let csBuckets = null;      // computed stats per player count
let csAdversaries = [];    // head-to-head rows from the character_adversary_stats RPC
let csRivalMode   = 'pct';   // rivalries metric (also the ranking key): 'pct' (% dominance) | 'count' (# wins/losses)
// A head-to-head record needs at least this many shared games to count as a
// rivalry; a 1-2 game sample would otherwise top "Beaten most" at 100% by luck.
const MIN_GAMES_FOR_RIVALRY = 5;
let csAllChars  = [];        // full character list for search
let csBoxInfo   = {};        // loadBoxInfo(), used to order box groups by release date

// "Box name (year)" for display, the year from box-info.json when known.
function _boxLabelHTML(box) {
  const year = csBoxInfo[box]?.year;
  return `${_esc(box)}${year ? ` <span class="cs-box-year">(${year})</span>` : ''}`;
}
let csAvg       = {};        // avg duration / rounds per table size: { all: { dur, turns }, 2: …, … }
let csLoading   = false;     // stats requested but not in yet: render() draws the layout with '-' values
// The table's rows: Overall, 2p…6p and, dashed under them, Solo (solo.js: this
// villain's solo games, never counted in Overall). Tapping a row shows its
// numbers in the boxes on top; Overall at first.
let csRow       = 'all';     // 'all' | 2…6 | 'solo'
let csSoloStats = null;      // { games, wins, dur, turns }; null until loaded or if they couldn't load

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('villains.html');
  const params   = new URLSearchParams(location.search);
  const charName = (params.get('vil') || '').trim();
  // Detail view: show the way back to the roster right away, before any data loads.
  if (charName) document.getElementById('csBack').classList.remove('hidden');
  await initAuth();

  // A language switch brings back the grouping and the switches (lang.js).
  const saved = takeViewState();
  if (saved) { csMode = saved.mode; csRivalMode = saved.rivalMode; csRow = saved.row ?? 'all'; }
  keepViewState(() => ({ rosterView: csRosterView, mode: csMode, rivalMode: csRivalMode, row: csRow }));

  if (charName) { await renderDetailPage(charName); return; }

  // ?pace= opens the roster straight into pace view, scrolled to that band
  // (mirrors how ?box= scrolls to a box group).
  const pace = (params.get('pace') || '').trim().toLowerCase();
  if (['green', 'yellow', 'orange', 'red', 'gray'].includes(pace)) {
    csRosterView = 'pace';
    await renderRosterPage(`pace-${pace}`);
  } else {
    if (saved) csRosterView = saved.rosterView;
    await renderRosterPage((params.get('box') || '').trim());
  }
}

// Roster grouping mode: 'box' (the curated default) or 'pace' (by the four
// objective paces). The seg in the controls row flips between them.
let csRosterView = 'box';

async function renderRosterPage(scrollBox) {
  document.title = `DiVilytics | ${t('Villains')}`;

  [csAllChars, csBoxInfo] = await Promise.all([loadCharacters(), loadBoxInfo()]);
  document.getElementById('csSearchInput').disabled = false;
  _attachCharSearch();

  const root = document.getElementById('csRoot');
  root.className = '';
  root.innerHTML =
    `<div class="cs-roster-controls">
       <span class="cs-roster-controls-lbl">${t('Group by')}</span>
       ${_rosterViewSegHTML()}
     </div>
     <div id="csGroups">${_rosterGroupsHTML(csAllChars)}</div>`;
  // Under the roster, the whole F.A.Q. (a villain's page links to its own topic).
  document.getElementById('csFaq').innerHTML = `
    <a class="home-section-link mt-1-5" href="faq.html">
      <span class="home-section-icon">📜</span>
      <div class="home-section-text">
        <span class="home-section-name">${t('Disney Villainous F.A.Q.')}</span>
        <span class="home-section-desc">${t('The official rules, plus clarifications, general and villain by villain.')}</span>
      </div>
    </a>`;

  if (scrollBox) {
    requestAnimationFrame(() => document.getElementById(scrollBox)?.scrollIntoView({ block: 'start' }));
  }
}

function _rosterViewSegHTML() {
  const btn = (v, label) => `<button class="seg-btn ${csRosterView === v ? 'on' : ''}" type="button" data-view="${v}" onclick="csSetRosterView('${v}')">${label}</button>`;
  return `<div class="seg cs-roster-seg">${btn('box', t('Box'))}${btn('pace', t('Pace'))}</div>`;
}

// Flip the grouping without reloading: re-render only the groups + seg state.
function csSetRosterView(v) {
  if (v === csRosterView) return;
  csRosterView = v;
  const groups = document.getElementById('csGroups');
  if (groups) groups.innerHTML = _rosterGroupsHTML(csAllChars);
  document.querySelectorAll('.cs-roster-seg .seg-btn')
    .forEach(b => b.classList.toggle('on', b.dataset.view === v));
}

function _rosterGroupsHTML(chars) {
  const groups = csRosterView === 'pace' ? _rosterPaceGroups(chars) : _rosterBoxGroups(chars);
  return groups.map(g => `
    <div class="char-roster-group" id="${g.id}">
      <div class="char-roster-group-name">${g.header}</div>
      <div class="char-roster">${g.chars.map(_rosterItemHTML).join('')}</div>
    </div>`).join('');
}

// Primary box only: reprint boxes (e.g. Darkness Brewing, which only repackages
// villains listed elsewhere) don't get a group of their own here.
function _rosterBoxGroups(chars) {
  return Object.entries(groupByBox(chars, csBoxInfo)).map(([box, cs]) => ({
    id: boxAnchorId(box), header: _boxLabelHTML(box), chars: cs,
  }));
}

// Group by the four paces (in pace order); any character without a recognized
// pace falls into a trailing "Gray" group rather than vanishing.
function _rosterPaceGroups(chars) {
  const paces = [['green', t('Green')], ['yellow', t('Yellow')], ['orange', t('Orange')], ['red', t('Red')]];
  const groups = paces.map(([pace, name]) => ({
    id: `pace-${pace}`,
    header: `<span class="pace-dot ${pace}"></span>${name}`,
    chars: chars.filter(c => c.pace === pace),
  })).filter(g => g.chars.length);
  const known = new Set(paces.map(p => p[0]));
  const rest = chars.filter(c => !known.has(c.pace));
  if (rest.length) groups.push({ id: 'pace-gray', header: `<span class="pace-dot gray"></span>${t('Gray')}`, chars: rest });
  return groups;
}

function _rosterItemHTML(c) {
  return `
    <a class="char-roster-item" href="villains.html?vil=${encodeURIComponent(c.name)}">
      <img class="char-roster-portrait" src="${charImgSrc(c.name)}" alt="" onerror="this.src='asset/players/default.svg'">
      <div class="char-roster-name">${villainNameInline(c.name)}</div>
    </a>`;
}

function _showCsEmpty(html) {
  const el = document.getElementById('csRoot');
  el.className = '';
  el.innerHTML = html;
}

async function renderDetailPage(charName) {
  document.title = `DiVilytics | ${villainName(charName)}`;

  [csAllChars, csBoxInfo] = await Promise.all([loadCharacters(), loadBoxInfo()]);
  csChar     = csAllChars.find(c => c.name === charName);

  if (!csChar) {
    _showCsEmpty(`<div class="empty"><h3>${t('Villain not found')}</h3><p>${_esc(charName)}</p></div>`);
    return;
  }

  await _renderCharIdentity();
  document.getElementById('csSearchInput').disabled = false;
  _attachCharSearch();

  // While the stats load, draw their final layout with '-' values (same boxes,
  // seg and table rows) so nothing shifts when the numbers arrive. Rivalries,
  // decks and the FAQ link only go in afterwards, below, so they never get
  // pushed down by content loading above them.
  csBuckets = _foldBuckets([]); csAdversaries = []; csAvg = {}; csSoloStats = null;
  csLoading = true;
  render();
  const renderExtras = () => { renderDeck(charName); renderFaqLink(charName); };

  // Load bucketed stats via server-side aggregation (one RPC, no row-limit risk)
  const { data: buckets, error } = await db.rpc('character_bucket_stats', { char_name: charName });

  if (error) {
    csLoading = false;
    _showCsEmpty(`<div class="empty"><p>${t('Error: {message}', { message: _esc(error.message) })}</p></div>`);
    renderExtras();
    return;
  }

  csBuckets = _foldBuckets(buckets || []);

  // Avg duration / rounds of every official game this character was played in
  // (one row per game, with its number of seats, so each table size gets its
  // own), its head-to-head record vs every other character (one RPC) and its
  // solo games. Fetched together. _fetchAllRows pages past the ~1000-row cap so
  // a heavily-played character's averages aren't computed from a truncated sample.
  const [{ rows: dgames }, { data: adv }, solo] = await Promise.all([
    _fetchAllRows(() => db
      .from('game_players')
      .select('games!inner(duration_minutes, num_turns, game_players(count))')
      .eq('character', charName)
      .is('games.variant', null)),   // official games only
    db.rpc('character_adversary_stats', { char_name: charName }),
    loadSoloGames(),
  ]);
  const bySize = {};   // 'all' | size → { dur: [], turns: [] }
  for (const { games: g } of dgames) {
    for (const k of ['all', g?.game_players?.[0]?.count]) {
      const b = bySize[k] ||= { dur: [], turns: [] };
      b.dur.push(g?.duration_minutes);
      b.turns.push(g?.num_turns);
    }
  }
  csAvg = Object.fromEntries(Object.entries(bySize).map(([k, b]) => [k, { dur: avg(b.dur), turns: avg(b.turns) }]));
  csAdversaries = (adv || []).map(a => ({
    opponent: a.opponent, wins: Number(a.wins), losses: Number(a.losses), games: Number(a.games),
  }));
  if (solo) {
    const seats = solo.players.filter(p => p.character === charName);
    const ids   = new Set(seats.map(p => p.game_id));
    const games = solo.games.filter(g => ids.has(g.id));
    csSoloStats = {
      games: seats.length, wins: seats.filter(p => p.is_winner).length,
      dur: avg(games.map(g => g.duration_minutes)), turns: avg(games.map(g => g.num_turns)),
    };
  }

  csLoading = false;
  render();
  renderExtras();
}

async function _renderCharIdentity() {
  const [objectives, guides] = await Promise.all([loadObjectives(), loadVillainGuides()]);
  // The objective lives in the guide sheet; every villain with an objective or a
  // guide gets the link, even if the sheet holds only the objective for now.
  const guideLink  = objectives[csChar.name] || guides[csChar.name]
    ? `<span class="char-meta-sep"> | </span><button class="char-guide-link" type="button" onclick="openGuide()">${t('Villain guide')} ›</button>`
    : '';
  const paceDot    = csChar.pace
    ? `<a class="pace-dot ${csChar.pace}" href="villains.html?pace=${csChar.pace}" title="${_esc(t('View {pace} pace villains', { pace: t(csChar.pace[0].toUpperCase() + csChar.pace.slice(1)) }))}"></a>`
    : `<a class="pace-dot gray" href="villains.html?pace=gray" title="${t('Pace not yet set')}"></a>`;
  document.getElementById('csIdentity').innerHTML =
    `<div class="pf-identity"><img class="char-portrait identity-portrait zoomable" src="${charImgSrc(csChar.name)}" alt="" onerror="this.src='asset/players/default.svg'" onclick="showAvatarLightbox(this.src, 'asset/players/default.svg')"><span class="pf-name-block"><span class="pf-nick">${villainNameInline(csChar.name)}</span>${csChar.box ? `<a class="pf-since pf-since-link" href="villains.html?box=${boxAnchorId(csChar.box)}" title="${_esc(t('View {box} villains', { box: csChar.box }))}">${_boxLabelHTML(csChar.box)}</a>` : ''}</span></div><p class="char-meta">${t('Pace')}: ${paceDot}${guideLink}</p>`;
}

function _foldBuckets(buckets) {
  const out = {
    all: { games: 0, wins: 0 },
    2:   { games: 0, wins: 0 },
    3:   { games: 0, wins: 0 },
    4:   { games: 0, wins: 0 },
    5:   { games: 0, wins: 0 },
    6:   { games: 0, wins: 0 },
  };
  for (const b of buckets) {
    const n = b.player_count;
    const g = Number(b.games);
    const w = Number(b.wins);
    out.all.games += g;
    out.all.wins  += w;
    if (n >= 2 && n <= 6) out[n] = { games: g, wins: w };
  }
  return out;
}

// ── CONTROLS ──────────────────────────────────────────────────────────────────

function csSetMode(m) {
  csMode = m;
  render();
}

function csSetRivalMode(m) {
  csRivalMode = m;
  render();
}

// A row of the table: its numbers go in the boxes on top.
function csSelectRow(key) {
  csRow = key;
  render();
}

// ── SEARCH / AUTOCOMPLETE ─────────────────────────────────────────────────────

function _attachCharSearch() {
  attachSearchBox({
    inputId:    'csSearchInput',
    dropdownId: 'csDropdown',
    fetchOptions: q => {
      // Matches the names shown in the current language only.
      const lower = q.toLowerCase();
      return csAllChars.filter(c => villainName(c.name).toLowerCase().includes(lower)).slice(0, 8);
    },
    renderOption: c => `
      <div class="cs-option" data-name="${_esc(c.name)}">
        <img class="char-portrait" src="${charImgSrc(c.name)}" alt="">
        <span>${villainNameInline(c.name)}</span>
        <span class="cs-option-box">${_esc(c.box)}</span>
      </div>`,
    onSelect: opt => { location.href = `villains.html?vil=${encodeURIComponent(opt.dataset.name)}`; },
  });
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function render() {
  const root = document.getElementById('csRoot');
  root.className = '';

  const rows = [
    { label: t('Overall'), key: 'all' },
    { label: '2p', key: 2 },
    { label: '3p', key: 3 },
    { label: '4p', key: 4 },
    { label: '5p', key: 5 },
    { label: '6p', key: 6 },
  ];
  const solo  = csSoloStats || { games: 0, wins: 0 };
  const stats = key => key === 'solo' ? solo : csBuckets[key];
  const keys  = [...rows.map(r => r.key), 'solo'];
  const maxVal = Math.max(...keys.map(k => statValue(stats(k), csMode))) || 1;
  // Both tables size their games column alike, so their columns line up.
  const widths = statGamesWidth(keys.map(stats));

  // The boxes on top: the selected row's numbers.
  const sel  = stats(csRow);
  const avgs = csRow === 'solo' ? solo : (csAvg[csRow] || {});
  const v = val => csLoading ? '-' : val;
  const rowHTML = (label, key) => {
    const b       = stats(key);
    const barW    = b.games ? statBarWidth(b, csMode, maxVal) : 0;
    const dispVal = b.games ? statCellHTML(b, csMode) : '-';
    const arg     = typeof key === 'number' ? key : `'${key}'`;
    return `
      <div class="lb-row cs-row${csRow === key ? ' on' : ''}" role="button" tabindex="0" aria-pressed="${csRow === key}"
           onclick="csSelectRow(${arg})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();csSelectRow(${arg})}">
        <div class="row-label">${label}</div>
        <div class="bar-cell">
          <div class="bar-bg">
            <div class="bar-fill" style="width:${barW}%"></div>
          </div>
        </div>
        <div class="row-val">${csLoading ? '-' : dispVal}</div>
      </div>`;
  };

  root.innerHTML = `
    <div class="summary">
      ${statBoxesHTML([
        { val: v(sel.games), lbl: t('Games') },
        { val: avgs.dur   != null ? Math.round(avgs.dur) + 'm' : '-', lbl: t('Avg duration') },
        { val: avgs.turns != null ? Math.round(avgs.turns)     : '-', lbl: t('Avg rounds') },
        { val: v(sel.games ? Math.round((sel.wins / sel.games) * 100) + '%' : '-'), lbl: t('Win rate') },
        { val: v(sel.wins), lbl: t('Wins') },
      ])}
    </div>
    ${statModeSegHTML(csMode, 'csSetMode')}
    <div class="lb-table cs-table" style="${widths}">
      <div class="lb-head">
        <span>${t('Players')}</span>
        <span></span>
        <span class="text-right">${statValueLabel(csMode)}</span>
      </div>
      ${rows.map(r => rowHTML(r.label, r.key)).join('')}
    </div>
    <div class="lb-table cs-table cs-solo-table mb-1-25" style="${widths}">
      ${rowHTML(t('Solo'), 'solo')}
    </div>
    ${csRow === 'solo' ? soloHintHTML() : ''}
    ${_adversariesSectionHTML()}`;
}

// "Rivalries": the opponents this character has beaten most / lost to most,
// from the character_adversary_stats RPC. Top-5 per column (a character can
// appear in both: a close rivalry). The %/# seg ranks AND labels each column by
// win/loss rate or raw count; the selected metric shows first, the other after
// a "|". Only opponents with at least MIN_GAMES_FOR_RIVALRY shared games count.
// Empty when there is no such record yet (or the RPC is not installed).
function _adversariesSectionHTML() {
  const adversaries = csAdversaries.filter(a => a.games >= MIN_GAMES_FOR_RIVALRY);
  if (!adversaries.length) return '';

  // Beaten / Lost to: % = wins or losses / games vs that opponent (third-player
  // wins mean win% + loss% can be < 100%); the seg also picks the ranking key.
  // Faced most: always ranked by games together; % = share of this villain's
  // games with that opponent at the table (sums past 100% with 3+ players).
  const pct     = (n, g) => g ? Math.round((n / g) * 100) : 0;
  const total   = csBuckets.all.games;
  const isPct   = csRivalMode === 'pct';
  const winKey  = a => isPct ? pct(a.wins,   a.games) : a.wins;
  const lossKey = a => isPct ? pct(a.losses, a.games) : a.losses;
  const top5    = (list, key, tie) => list.slice()
    .sort((a, b) => key(b) - key(a) || tie(b) - tie(a) || a.opponent.localeCompare(b.opponent)).slice(0, 5);

  const byWins  = top5(adversaries.filter(a => a.wins > 0),   winKey,  a => a.wins);
  const byLoss  = top5(adversaries.filter(a => a.losses > 0), lossKey, a => a.losses);
  const byGames = top5(adversaries, a => a.games, a => a.games);

  // Rows show only the opponent's portrait and the selected value; the name
  // and both values are in the tooltip.
  const winsCol  = a => ({ val: isPct ? `${pct(a.wins, a.games)}%`   : a.wins,   tip: t('{wins} in {games} games ({pct}%)', { wins: tn(a.wins, '{n} win', '{n} wins'), games: a.games, pct: pct(a.wins, a.games) }) });
  const lossCol  = a => ({ val: isPct ? `${pct(a.losses, a.games)}%` : a.losses, tip: t('{wins} in {games} games ({pct}%)', { wins: tn(a.losses, '{n} loss', '{n} losses'), games: a.games, pct: pct(a.losses, a.games) }) });
  const gamesCol = a => ({ val: isPct ? `${pct(a.games, total)}%`    : a.games,  tip: t('{games} of {total} games ({pct}%)', { games: a.games, total, pct: pct(a.games, total) }) });
  const seg = `<div class="seg cs-adv-seg">
    <button class="seg-btn ${isPct  ? 'on' : ''}" type="button" onclick="csSetRivalMode('pct')" title="${t('Show and rank by %')}">%</button>
    <button class="seg-btn ${!isPct ? 'on' : ''}" type="button" onclick="csSetRivalMode('count')" title="${t('Show and rank by count')}">${t('#')}</button>
  </div>`;
  const row = (a, fmt) => {
    const { val, tip } = fmt(a);
    return `
      <a class="cs-adv-row" href="villains.html?vil=${encodeURIComponent(a.opponent)}" title="${_esc(`${villainName(a.opponent)}: ${tip}`)}">
        <img class="char-portrait" src="${charImgSrc(a.opponent)}" onerror="this.src='asset/players/default.svg'" alt="${_esc(villainName(a.opponent))}">
        <span class="cs-adv-count">${val}</span>
      </a>`;
  };
  const col = (title, list, fmt) => `
    <div class="cs-adv-col">
      <div class="cs-adv-title">${title}</div>
      ${list.length ? list.map(a => row(a, fmt)).join('') : '<div class="cs-adv-empty">-</div>'}
    </div>`;

  return `
    <div class="pf-games-header">
      <span class="pf-games-title">${t('Rivalries')}</span>
      ${seg}
    </div>
    <p class="results-hint">${t('Only opponents faced in at least {n} games.', { n: MIN_GAMES_FOR_RIVALRY })}</p>
    <div class="cs-adv">
      ${col(t('Beaten most'),  byWins,  winsCol)}
      ${col(t('Lost to most'), byLoss,  lossCol)}
      ${col(t('Faced most'),   byGames, gamesCol)}
    </div>`;
}

// ── DECKS ─────────────────────────────────────────────────────────────────────

// Card types in display order; any other type (Titan, Curse, Witch, ...) follows.
const DECK_TYPES  = ['Ally', 'Hero', 'Effect', 'Item', 'Condition'];
// Each type's banner color on the physical cards (as the wiki colors them),
// a deck-<color> class. Unlisted types fall back to purple. An extra deck can
// override it with its `banner` (Merlin's Transformations are gold like Heroes,
// while Mim's own are red).
const DECK_TYPE_COLOR = {
  Ally: 'ally', 'Ally/Item': 'ally', Transformation: 'ally',
  Hero: 'hero', 'Hero/Effect': 'hero', Guardian: 'hero',
  Effect: 'effect', Maui: 'effect',
  Item: 'item', Omnidroid: 'item', Remote: 'item',
  Condition: 'condition', Prince: 'condition', Relic: 'condition',
  Curse: 'curse', Ingredient: 'ingredient', Titan: 'titan', Witch: 'witch',
  Cheat: 'gray', Prisoner: 'gray',
};
const DECK_PLURAL = { Ally: 'Allies', Hero: 'Heroes', Witch: 'Witches', 'Ally/Item': 'Ally/Item', 'Hero/Effect': 'Hero/Effect' };
// A card type's label for a count, in the current language: Ally / Allies.
const _typeLabel = (type, n) => t(n === 1 ? type : (DECK_PLURAL[type] || `${type}s`));

function _deckTypeClass(type, banner) {
  return `deck-${banner || DECK_TYPE_COLOR[type] || 'other'}`;
}

const _cardTotal = cards => cards.reduce((n, c) => n + c.count, 0);

// Cards of the rendered decks, indexed by the rows' openCardSheet(i).
let _deckCards = [];

// The shown villain's card names in the current language (loadCardNames). A
// [TAG] rework is a separate villain with its own entries (shared cards are
// duplicated in the data), never borrowing from its base villain.
let _cardNameMap = {};
const _cardName = name => _cardNameMap[name] || name;
// Same for card texts: the Italian text when transcribed, else the wiki's English.
// "<name> (versions)", "(cost)" and "(strength)" translate a card's versions note
// and per-version values (Binding Contract, Card Guard's suits).
let _cardTextMap = {};

// Row summary of a cost/strength value: Card Guard's "1 (Club and Diamond) |
// 2 (Spade and Heart)" shortens to "1/2"; the sheet shows the full value.
function _shortStat(v) {
  return v.includes(' | ') ? v.split(' | ').map(p => p.split(' ')[0]).join('/') : v;
}

function _cardMetaHTML(c) {
  const parts = [];
  if (c.cost     != null) parts.push(`${t('Cost')} ${_esc(_shortStat(c.cost))}`);
  if (c.strength != null) parts.push(`${t('Strength')} ${_esc(_shortStat(c.strength))}`);
  return parts.length ? `<span class="cs-deck-meta">${parts.join(' | ')}</span>` : '';
}

// Card type keywords in card texts, singular and plural, English and Italian,
// colored like their card type (as on the printed cards). Capitalized only, the
// way the cards write them, so plain words stay as they are. The five base types
// are colored for every villain; a special type (Witch, Titan, Prince…) only for
// the villain whose deck has it. Ally/Item and Hero/Effect are covered by their
// parts. A keyword inside a mentioned card name ("Le Streghe di Morva", "Il
// Principe", "Omnidroide v.10") stays plain: it names a card, not a type.
const BASE_CARD_TYPES = ['Ally', 'Hero', 'Effect', 'Item', 'Condition'];
let _keywordRe    = null;
let _keywordClass = {};
let _cardNameRe   = null;   // the shown deck's card names that contain a keyword

const _reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The shown villain's keywords (each type's English and current-language forms)
// and the card names to leave plain (English and shown, with or without article).
function _setCardKeywords(deck) {
  const types = new Set(BASE_CARD_TYPES);
  const cards = [...(deck.villain || []), ...(deck.fate || []), ...(deck.extra || []).flatMap(e => e.cards)];
  // A special type with a single card ("Syndrome's Remote", "The Prince") names
  // that card even on its own ("…rispetto al Telecomando"), so it stays plain.
  const perType = {};
  for (const c of cards) perType[c.type] = (perType[c.type] || 0) + 1;
  for (const c of cards) if (!c.type.includes('/') && (BASE_CARD_TYPES.includes(c.type) || perType[c.type] > 1)) types.add(c.type);
  _keywordClass = {};
  for (const type of types) {
    const plural = DECK_PLURAL[type] || `${type}s`;
    for (const w of [type, plural, t(type), t(plural)]) _keywordClass[w] = DECK_TYPE_COLOR[type] || 'other';
  }
  const words = Object.keys(_keywordClass).sort((a, b) => b.length - a.length);
  _keywordRe = new RegExp(`(?<!\\p{L})(${words.join('|')})(?!\\p{L})`, 'gu');

  const anyCase = new RegExp(_keywordRe.source, 'giu');
  const names = new Set();
  for (const c of cards) for (const n of [c.name, _cardName(c.name)]) {
    if (!anyCase.test(n)) continue;
    anyCase.lastIndex = 0;
    names.add(_esc(n));
    const bare = n.replace(/^(the|il|lo|la|i|gli|le)\s+|^l'/i, '');
    if (bare !== n) names.add(_esc(bare));
  }
  _cardNameRe = names.size
    ? new RegExp(`(?<!\\p{L})(${[...names].sort((a, b) => b.length - a.length).map(_reEsc).join('|')})(?!\\p{L})`, 'giu')
    : null;
}

// Merlin's Transformations are Fate cards, so they take the Hero color, as
// printed: "Merlin Transformation", "Trasformazione di Merlino".
const _isMerlinForm = (w, at, str) => /^Trasformazion|^Transformation/.test(w)
  && (str.slice(Math.max(0, at - 7), at) === 'Merlin ' || str.startsWith(' di Merlino', at + w.length));

function _colorKeywords(html) {
  if (!_keywordRe) return html;
  const names = _cardNameRe ? [...html.matchAll(_cardNameRe)].map(m => [m.index, m.index + m[0].length]) : [];
  const inName = at => names.some(([a, b]) => at >= a && at < b);
  return html.replace(_keywordRe, (w, _, at, str) => inName(at) ? w
    : `<span class="cs-kw deck-${_isMerlinForm(w, at, str) ? 'hero' : _keywordClass[w]}">${w}</span>`);
}

const _cardTextHTML = text => text
  ? text.split('\n\n').map(p => `<p>${_colorKeywords(_esc(p)).replace(/\n/g, '<br>')}</p>`).join('')
  : `<p class="cs-card-empty">${t('No ability text.')}</p>`;

function openCardSheet(i) {
  const c = _deckCards[i];
  if (!c) return;
  const stat = (lbl, v) => v != null ? `<div class="cs-card-stat"><span>${lbl}</span><strong>${_esc(v.replace(/ \| /g, ', '))}</strong></div>` : '';
  document.getElementById('cardTitle').textContent = _cardName(c.name);
  document.getElementById('cardBody').innerHTML = `
    <div class="cs-card-stats">
      <div class="cs-card-stat"><span>${t('Type')}</span><strong class="${_deckTypeClass(c.type, c.banner)} cs-deck-type">${_esc(_typeLabel(c.type, 1))}</strong></div>
      <div class="cs-card-stat"><span>${t('Copies')}</span><strong>${c.count}</strong></div>
      ${stat(t('Cost'), _cardTextMap[`${c.name} (cost)`] ?? c.cost)}
      ${stat(t('Strength'), _cardTextMap[`${c.name} (strength)`] ?? c.strength)}
    </div>
    <div class="cs-card-text">${_cardTextHTML(_cardTextMap[c.name] ?? c.text)}</div>
    ${c.back ? `<div class="cs-card-back"><div class="cs-card-sub">${t('Other side: {name}', { name: _esc(_cardName(c.back.name)) })}</div><div class="cs-card-text">${_cardTextHTML(_cardTextMap[c.back.name] ?? c.back.text)}</div></div>` : ''}
    ${c.versions ? `<p class="cs-card-versions">${_esc(_cardTextMap[`${c.name} (versions)`] ?? c.versions)}</p>` : ''}`;
  openOverlay('cardOverlay');
}

// One deck: a header with its total, an optional note, then one column per
// card type. Main decks sort by copies then shown name; extras (`keepOrder`) keep the
// wiki's order (e.g. Omnidroid v.X8, v.X9, v.10). Tiles count as tiles.
function _deckHTML(title, cards, { note = '', unit = 'card', keepOrder = false, banner = null } = {}) {
  const byType = new Map();
  for (const c of cards) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type).push(c);
  }
  const rank  = t => DECK_TYPES.includes(t) ? DECK_TYPES.indexOf(t) : DECK_TYPES.length;
  const types = [...byType.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const total = _cardTotal(cards);
  return `
    <div class="pf-games-header mt-1-5">
      <span class="pf-games-title">${_esc(t(title))}</span>
      <span class="cs-deck-total">${unit === 'tile' ? tn(total, '{n} tile', '{n} tiles') : tn(total, '{n} card', '{n} cards')}</span>
    </div>
    ${note ? `<p class="cs-deck-note">${_esc(t(note))}</p>` : ''}
    <div class="cs-deck">
      <div class="cs-deck-stack">
      ${types.map((type, i) => {
        const list = keepOrder ? byType.get(type) : byType.get(type).slice().sort((a, b) => b.count - a.count || _cardName(a.name).localeCompare(_cardName(b.name), LOCALE));
        const n    = _cardTotal(list);
        const lbl  = _typeLabel(type, n);
        return `
          <div class="cs-adv-col cs-deck-col ${_deckTypeClass(type, banner)}" data-i="${i}">
            <div class="cs-adv-title cs-deck-title"><span class="cs-deck-type">${_esc(lbl)}</span><span>×${n}</span></div>
            ${list.map(c => `
              <button class="cs-deck-row" type="button" onclick="openCardSheet(${_deckCards.push({ ...c, banner }) - 1})">
                <span class="cs-deck-card">
                  <span class="cs-deck-name">${_esc(_cardName(c.name))}</span>
                  ${_cardMetaHTML(c)}
                </span>
                <span class="cs-deck-count">×${c.count}</span>
              </button>`).join('')}
          </div>`;
      }).join('')}
      </div>
      <div class="cs-deck-stack"></div>
    </div>`;
}

// Spread each deck's type boxes over its two stacks so the columns end up as
// even as possible. A deck has at most a handful of types, so every split is
// tried (the first box always on the left) and the one with the shortest
// taller column wins; each column keeps the boxes in display order. Heights are
// the rendered ones, so wrapped names count.
const DECK_STACK_GAP = 12;   // matches .cs-deck-stack gap
function _balanceDecks(root) {
  if (!root) return;
  for (const deck of root.querySelectorAll('.cs-deck')) {
    const [left, right] = deck.querySelectorAll(':scope > .cs-deck-stack');
    const boxes = [...deck.querySelectorAll('.cs-deck-col')].sort((a, b) => a.dataset.i - b.dataset.i);
    const heights = boxes.map(b => b.offsetHeight + DECK_STACK_GAP);   // same width in either stack
    let best = null;
    for (let mask = 0; mask < (1 << boxes.length); mask += 2) {      // bit i set = box i on the right
      let hl = 0, hr = 0;
      heights.forEach((h, i) => { if (mask & (1 << i)) hr += h; else hl += h; });
      const score = [Math.max(hl, hr), Math.abs(hl - hr)];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) best = { mask, score };
    }
    boxes.forEach((b, i) => (best.mask & (1 << i) ? right : left).appendChild(b));
  }
}
let _deckResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_deckResizeTimer);
  _deckResizeTimer = setTimeout(() => _balanceDecks(document.getElementById('csDeck')), 150);
});

// Villain deck, Fate deck, then any extra deck or tile (Maui deck, Merlin's
// Transformation deck, Omnidroids, ...). Data: villain-decks.json.
async function renderDeck(charName) {
  const el = document.getElementById('csDeck');
  if (!el) return;
  const [decks, names, texts] = await Promise.all([loadVillainDecks(), loadCardNames(), loadCardTexts()]);
  const deck = decks[charName];
  if (!deck) { el.innerHTML = ''; return; }
  _cardNameMap = names[charName] || {};
  _cardTextMap = texts[charName] || {};
  _setCardKeywords(deck);
  _deckCards = [];
  el.innerHTML = _deckHTML('Villain deck', deck.villain)
    + _deckHTML('Fate deck', deck.fate)
    + (deck.extra || []).map(e => _deckHTML(e.title, e.cards, {
        note: e.note, unit: /^Tiles?$/.test(e.title) ? 'tile' : 'card', keepOrder: true, banner: e.banner,
      })).join('');
  _balanceDecks(el);
}

// ── VILLAIN GUIDE ─────────────────────────────────────────────────────────────

// The Villain Guide of the shown villain in a sheet: the objective first
// (objectives.json, then the guide's explanation of it), then one heading per
// guide section (villain-guides.json). Card names in the text open that card's sheet: the first
// mention per section, as the shown name or the English one (an English guide
// in the Italian site), plurals included, possessives ("Sultan's Palace") not.
async function openGuide() {
  const [guides, objectives, decks] = await Promise.all([loadVillainGuides(), loadObjectives(), loadVillainDecks()]);
  const guide     = guides[csChar.name] || {};
  const objective = objectives[csChar.name];
  if (!objective && !guide.sections) return;
  const deck  = decks[csChar.name] || {};
  const cards = [...(deck.villain || []), ...(deck.fate || []), ...(deck.extra || []).flatMap(e => e.cards)];
  const byShown = new Map();
  // Matched ignoring case, since guides capitalize names freely ("Dadi Truccati"
  // for "Dadi truccati"), but only mentions starting with a capital count, so
  // plain words ("greed") are never linked.
  // Names also match without an Italian article ("il Genio" for "Il genio").
  for (const c of cards) for (const n of [c.name, _cardName(c.name)]) {
    for (const k of [n, n.replace(/^(il|lo|la|i|gli|le) |^l'/i, '')]) {
      if (!byShown.has(k.toLowerCase())) byShown.set(k.toLowerCase(), c);
    }
  }
  const names = [...byShown.keys()].sort((a, b) => b.length - a.length)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Not after "del/della…": that's a place ("Palazzo del Sultano"), like the
  // English possessive; not before "Transformation(s)" ("Merlin Transformations"
  // are Merlin's cards, not the Merlin card).
  const re = names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?<!\\b(?:del|della|dello|dei|degli|delle) )(${names.join('|')})((?:e?s)?)(?![\\p{L}\\p{N}'’])(?!\\s+Transformations?\\b)`, 'giu') : null;
  const NOTE = /^(Note|Important|Beware|Example|Nota|Importante|Attenzione|Esempio):\s*/;

  // "• text" is a list item; "• Name: text" also puts the name in bold (Davy
  // Jones's treasures).
  const ITEM = /^• (?:([^:]+):\s*)?/;
  const paraHTML = (p, sectionLinked) => {
    const item = ITEM.exec(p);
    // List items link their own cards, even ones already linked in the section.
    const linked = item ? new Set() : sectionLinked;
    const m = item ? null : NOTE.exec(p);
    const body = item ? p.slice(item[0].length) : m ? p.slice(m[0].length) : p;
    let html = '', last = 0, hit;
    if (re) re.lastIndex = 0;
    while (re && (hit = re.exec(body))) {
      const c = byShown.get(hit[1].toLowerCase());
      // A lowercase start ("il Genio") retries one letter later, to find "Genio".
      if (!/^\p{Lu}/u.test(hit[1])) { re.lastIndex = hit.index + 1; continue; }
      if (linked.has(c.name)) continue;
      linked.add(c.name);
      html += _esc(body.slice(last, hit.index))
        + `<button class="guide-card ${_deckTypeClass(c.type)}" type="button" data-card="${_esc(c.name)}">${_esc(hit[0])}</button>`;
      last = hit.index + hit[0].length;
    }
    html += _esc(body.slice(last));
    if (item) return `<p class="guide-item">${item[1] ? `<strong>${_esc(item[1])}:</strong> ` : ''}${html}</p>`;
    return m ? `<p class="guide-note"><strong>${_esc(m[1])}:</strong> ${html}</p>` : `<p>${html}</p>`;
  };

  document.getElementById('guideTitle').textContent = `${t('Villain guide')} | ${villainName(csChar.name)}`;
  const body = document.getElementById('guideBody');
  const sectionHTML = (title, text, lead = '') => {
    const linked = new Set();
    return `<h4 class="guide-title">${_esc(title)}</h4>${lead}${text ? text.split('\n\n').map(p => paraHTML(p, linked)).join('') : ''}`;
  };
  body.innerHTML =
    (objective ? sectionHTML(t('Objective'), guide.objective, `<p class="guide-objective">${_esc(objective)}</p>`) : '')
    + (guide.sections || []).map(sec => sectionHTML(sec.title, sec.text)).join('');
  body.scrollTop = 0;
  openOverlay('guideOverlay');
}

// A card name in the guide opens its sheet on top (once the decks are drawn).
document.addEventListener('click', e => {
  const b = e.target.closest('.guide-card');
  if (!b) return;
  const i = _deckCards.findIndex(c => c.name === b.dataset.card);
  if (i >= 0) openCardSheet(i);
});

// ── RULES FAQ LINK ────────────────────────────────────────────────────────────

// The villain's rules clarifications live on faq.html; link there when it has
// any. [TAG] reworks (e.g. "Ursula [I2E]") are separate villains: they only
// get entries filed under their own full name.
async function renderFaqLink(charName) {
  const el = document.getElementById('csFaq');
  if (!el) return;
  const base  = charName;
  const rules = (await loadFaq()).villains?.[base] || [];
  if (!rules.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <a class="home-section-link mt-1-5" href="faq.html?topic=${encodeURIComponent(base)}">
      <span class="home-section-icon">📜</span>
      <div class="home-section-text">
        <span class="home-section-name">${t('Rules F.A.Q.')}</span>
        <span class="home-section-desc">${_esc(tn(rules.length, '{n} clarification for {villain}.', '{n} clarifications for {villain}.', { villain: villainName(base) }))}</span>
      </div>
    </a>`;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();

