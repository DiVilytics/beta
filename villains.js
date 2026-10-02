// ── STATE ─────────────────────────────────────────────────────────────────────
// Static character data (objectives, FAQ) is loaded from JSON via db.js.

// Currently-selected month for the roster report (first day of that month).
let csReportMonth = (() => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), 1);
})();

// Aggregates character stats from the games played in `monthStart`'s calendar
// month. Returns { stats, label, gameCount } where stats matches the shape
// used by the character_stats view ({ character, wins, games }).
//
// The per-character aggregation runs server-side (monthly_character_stats RPC)
// rather than pulling every game_players row for the month into the browser,
// consistent with the other stats surfaces, and immune to the ~1000-row cap.
async function _loadMonthCharacterStats(monthStart) {
  const start = new Date(monthStart.getFullYear(), monthStart.getMonth(),     1);
  const end   = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const iso   = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;

  const [{ data: stats }, { count }] = await Promise.all([
    db.rpc('monthly_character_stats', { month_start: iso }),
    db.from('games')
      .select('id', { count: 'exact', head: true })
      .gte('played_at', start.toISOString())
      .lt('played_at',  end.toISOString()),
  ]);

  return { stats: stats || [], label, gameCount: count || 0 };
}

function _isFutureMonth(d) {
  const now = new Date();
  return d.getFullYear() > now.getFullYear()
      || (d.getFullYear() === now.getFullYear() && d.getMonth() > now.getMonth());
}

async function csShiftMonth(delta) {
  const next = new Date(csReportMonth.getFullYear(), csReportMonth.getMonth() + delta, 1);
  if (delta > 0 && _isFutureMonth(next)) return;
  csReportMonth = next;
  await _renderMonthlyReport();
}

let _csPickerYear = null;

function csOpenMonthPicker(ev) {
  ev?.stopPropagation();
  const panel = document.getElementById('csMonthPickerPanel');
  if (!panel) return;
  const isOpen = panel.classList.contains('open');
  if (isOpen) { csCloseMonthPicker(); return; }
  _csPickerYear = csReportMonth.getFullYear();
  _renderMonthPickerPanel();
  panel.classList.add('open');
  setTimeout(() => document.addEventListener('click', _csOutsideClick), 0);
}

function csCloseMonthPicker() {
  const panel = document.getElementById('csMonthPickerPanel');
  if (!panel) return;
  panel.classList.remove('open');
  document.removeEventListener('click', _csOutsideClick);
}

function _csOutsideClick(e) {
  const panel = document.getElementById('csMonthPickerPanel');
  if (!panel || panel.contains(e.target)) return;
  csCloseMonthPicker();
}

function csPickerShiftYear(delta, ev) {
  ev?.stopPropagation();
  const now = new Date();
  const next = _csPickerYear + delta;
  if (next > now.getFullYear()) return;
  _csPickerYear = next;
  _renderMonthPickerPanel();
}

async function csPickerSelect(month, ev) {
  ev?.stopPropagation();
  const next = new Date(_csPickerYear, month, 1);
  if (_isFutureMonth(next)) return;
  csCloseMonthPicker();
  csReportMonth = next;
  await _renderMonthlyReport();
}

function _renderMonthPickerPanel() {
  const panel = document.getElementById('csMonthPickerPanel');
  if (!panel) return;
  const now      = new Date();
  const curY     = csReportMonth.getFullYear();
  const curM     = csReportMonth.getMonth();
  const nextYDis = _csPickerYear >= now.getFullYear();
  const months   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  panel.innerHTML = `
    <div class="cs-mp-year">
      <button class="cs-month-nav" type="button" onclick="csPickerShiftYear(-1, event)" title="Previous year">‹</button>
      <span class="cs-mp-year-text">${_csPickerYear}</span>
      <button class="cs-month-nav" type="button" onclick="csPickerShiftYear(1, event)" title="Next year"${nextYDis ? ' disabled' : ''}>›</button>
    </div>
    <div class="cs-mp-grid">
      ${months.map((mn, i) => {
        const disabled = _csPickerYear > now.getFullYear()
                      || (_csPickerYear === now.getFullYear() && i > now.getMonth());
        const selected = _csPickerYear === curY && i === curM;
        return `<button class="cs-mp-month${selected ? ' selected' : ''}" type="button" onclick="csPickerSelect(${i}, event)"${disabled ? ' disabled' : ''}>${mn}</button>`;
      }).join('')}
    </div>`;
}

let _csLoadToken = 0;

async function _renderMonthlyReport() {
  const host = document.getElementById('csSummary');
  if (!host) return;

  const label = csReportMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const token = ++_csLoadToken;

  // On a month change the cards already exist, keep them in place (dimmed) and
  // just retarget the header, so the layout never collapses while loading. Only
  // the very first load (no cards yet) shows the spinner scaffold.
  if (host.querySelector('.cs-summary')) {
    _setReportHeader(label, null);
    host.classList.add('cs-report-loading');
  } else {
    host.innerHTML = _renderRosterSummary([], label, null, true);
  }

  const monthly = await _loadMonthCharacterStats(csReportMonth);
  if (token !== _csLoadToken) return;   // a newer month was requested, ignore stale result
  host.classList.remove('cs-report-loading');
  host.innerHTML = _renderRosterSummary(monthly.stats, monthly.label, monthly.gameCount, false);
}

// Retarget the report header (month label + game count + next-nav state) in place,
// without rebuilding the cards below it.
function _setReportHeader(label, gameCount) {
  const host = document.getElementById('csSummary');
  if (!host) return;
  const btn = host.querySelector('.cs-month-text');
  if (btn) {
    const countTxt = gameCount == null ? '…' : `${gameCount} ${gameCount === 1 ? 'game' : 'games'}`;
    btn.textContent = `Monthly report: ${label} (${countTxt})`;
  }
  const navs = host.querySelectorAll('.cs-summary-header .cs-month-nav');
  if (navs[1]) navs[1].disabled = _isFutureMonth(
    new Date(csReportMonth.getFullYear(), csReportMonth.getMonth() + 1, 1)
  );
}

function _renderRosterSummary(rows, monthLabel, gameCount, loading = false) {
  const nextDisabled = _isFutureMonth(
    new Date(csReportMonth.getFullYear(), csReportMonth.getMonth() + 1, 1)
  );
  const countTxt = gameCount == null
    ? '…'
    : `${gameCount} ${gameCount === 1 ? 'game' : 'games'}`;
  const header = monthLabel
    ? `<div class="cs-summary-header">
         <button class="cs-month-nav" type="button" onclick="csShiftMonth(-1)" title="Previous month">‹</button>
         <span class="cs-month-picker-wrap">
           <button class="cs-month-text" type="button" onclick="csOpenMonthPicker(event)" title="Pick month">Monthly report: ${_esc(monthLabel)} (${countTxt})</button>
           <div class="cs-month-picker-panel" id="csMonthPickerPanel" role="dialog" aria-label="Pick month"></div>
         </span>
         <button class="cs-month-nav" type="button" onclick="csShiftMonth(1)" title="Next month"${nextDisabled ? ' disabled' : ''}>›</button>
       </div>`
    : '';

  // Loaded month with no games: keep the header, drop the cards for a short note.
  if (!loading && !rows.length) {
    return `${header}<div class="cs-summary-empty">No games recorded this month.</div>`;
  }

  const withPct = rows.map(r => ({
    name:  r.character,
    wins:  r.wins  || 0,
    games: r.games || 0,
    pct:   r.games ? r.wins / r.games : 0,
  }));

  const sortedPct   = [...withPct].sort((a, b) => b.pct   - a.pct   || b.wins - a.wins);
  const sortedWins  = [...withPct].sort((a, b) => b.wins  - a.wins  || b.pct  - a.pct);
  const sortedGames = [...withPct].sort((a, b) => b.games - a.games || b.wins - a.wins);

  const fmtPct   = r => Math.round(r.pct * 100) + '%';
  const fmtWins  = r => String(r.wins);
  const fmtGames = r => String(r.games);

  // While loading, the body is a skeleton with the same structure (Top/Bottom +
  // three rows each) so the card is already the right height, no first-load jump.
  const skelRow  = `<div class="cs-mini-row cs-skel"><span class="cs-skel-dot"></span><span class="cs-skel-bar"></span></div>`;
  const skelBody = `<div class="cs-mini-section-lbl">Top</div>${skelRow.repeat(3)}<div class="cs-mini-section-lbl">Bottom</div>${skelRow.repeat(3)}`;

  const card = (title, sortedRows, fmt) => {
    let body;
    if (loading) {
      body = skelBody;
    } else {
      const top    = sortedRows.slice(0, 3);
      const bottom = sortedRows.slice(-3).reverse();
      const row = r => `
        <a class="cs-mini-row" href="villains.html?vil=${encodeURIComponent(r.name)}" title="${_esc(r.name)}">
          <img class="char-portrait" src="${charImgSrc(r.name)}" onerror="this.src='asset/players/default.svg'" alt="${_esc(r.name)}">
          <span class="cs-mini-val">${fmt(r)}</span>
        </a>`;
      body = `
        <div class="cs-mini-section-lbl">Top</div>
        ${top.map(row).join('')}
        ${bottom.length ? `<div class="cs-mini-section-lbl">Bottom</div>${bottom.map(row).join('')}` : ''}`;
    }
    return `
      <div class="cs-summary-card">
        <div class="cs-summary-title">${title}</div>
        ${body}
      </div>`;
  };

  return `${header}
    <div class="cs-summary">
      ${card('% Wins',  sortedPct,   fmtPct)}
      ${card('# Wins',  sortedWins,  fmtWins)}
      ${card('# Games', sortedGames, fmtGames)}
    </div>`;
}

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
let csAvgDur    = null;      // avg game duration (minutes) across this character's games
let csAvgTurns  = null;      // avg rounds across this character's games

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('villains.html');
  await initAuth();

  const params   = new URLSearchParams(location.search);
  const charName = (params.get('vil') || '').trim();
  if (charName) { await renderDetailPage(charName); return; }

  // ?pace= opens the roster straight into pace view, scrolled to that band
  // (mirrors how ?box= scrolls to a box group).
  const pace = (params.get('pace') || '').trim().toLowerCase();
  if (['green', 'yellow', 'orange', 'red', 'gray'].includes(pace)) {
    csRosterView = 'pace';
    await renderRosterPage(`pace-${pace}`);
  } else {
    await renderRosterPage((params.get('box') || '').trim());
  }
}

// Roster grouping mode: 'box' (the curated default) or 'pace' (by the four
// objective paces). The seg in the controls row flips between them.
let csRosterView = 'box';

async function renderRosterPage(scrollBox) {
  document.title = 'DiVilytics | Villains';

  [csAllChars, csBoxInfo] = await Promise.all([loadCharacters(), loadBoxInfo()]);
  document.getElementById('csSearchInput').disabled = false;
  _attachCharSearch();

  const root = document.getElementById('csRoot');
  root.className = '';
  root.innerHTML =
    `<div id="csSummary"></div>
     <div class="cs-roster-controls">
       <span class="cs-roster-controls-lbl">Group by</span>
       ${_rosterViewSegHTML()}
     </div>
     <div id="csGroups">${_rosterGroupsHTML(csAllChars)}</div>`;

  // Wait for the monthly report (it fills #csSummary above the groups and
  // changes layout) before scrolling, so a ?box= jump lands at the right spot.
  await _renderMonthlyReport();
  if (scrollBox) {
    requestAnimationFrame(() => document.getElementById(scrollBox)?.scrollIntoView({ block: 'start' }));
  }
}

function _rosterViewSegHTML() {
  const btn = (v, label) => `<button class="seg-btn ${csRosterView === v ? 'on' : ''}" type="button" data-view="${v}" onclick="csSetRosterView('${v}')">${label}</button>`;
  return `<div class="seg cs-roster-seg">${btn('box', 'Box')}${btn('pace', 'Pace')}</div>`;
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

function _rosterBoxGroups(chars) {
  return Object.entries(groupByBox(chars, csBoxInfo, true)).map(([box, cs]) => ({
    id: boxAnchorId(box), header: _esc(box), chars: cs,
  }));
}

// Group by the four paces (in pace order); any character without a recognised
// pace falls into a trailing "Gray" group rather than vanishing.
function _rosterPaceGroups(chars) {
  const paces = [['green', 'Green'], ['yellow', 'Yellow'], ['orange', 'Orange'], ['red', 'Red']];
  const groups = paces.map(([pace, name]) => ({
    id: `pace-${pace}`,
    header: `<span class="pace-dot ${pace}"></span>${name}`,
    chars: chars.filter(c => c.pace === pace),
  })).filter(g => g.chars.length);
  const known = new Set(paces.map(p => p[0]));
  const rest = chars.filter(c => !known.has(c.pace));
  if (rest.length) groups.push({ id: 'pace-gray', header: `<span class="pace-dot gray"></span>Gray`, chars: rest });
  return groups;
}

function _rosterItemHTML(c) {
  return `
    <a class="char-roster-item" href="villains.html?vil=${encodeURIComponent(c.name)}">
      <img class="char-roster-portrait" src="${charImgSrc(c.name)}" alt="" onerror="this.src='asset/players/default.svg'">
      <div class="char-roster-name">${_esc(c.name)}</div>
    </a>`;
}

function _showCsEmpty(html) {
  const el = document.getElementById('csRoot');
  el.className = '';
  el.innerHTML = html;
}

async function renderDetailPage(charName) {
  document.title = `DiVilytics | ${charName}`;

  csAllChars = await loadCharacters();
  csChar     = csAllChars.find(c => c.name === charName);

  if (!csChar) {
    _showCsEmpty(`<div class="empty"><h3>Villain not found</h3><p>${_esc(charName)}</p></div>`);
    return;
  }

  await _renderCharIdentity();
  document.getElementById('csSearchInput').disabled = false;
  _attachCharSearch();
  renderDeck(charName);
  renderFaqLink(charName);

  // Load bucketed stats via server-side aggregation (one RPC, no row-limit risk)
  const { data: buckets, error } = await db.rpc('character_bucket_stats', { char_name: charName });

  if (error) {
    _showCsEmpty(`<div class="empty"><p>Error: ${_esc(error.message)}</p></div>`);
    return;
  }

  if (!buckets || !buckets.length) {
    _showCsEmpty(`<div class="empty"><div class="empty-icon">🎭</div><h3>No games yet</h3><p>${_esc(csChar.name)} hasn't been played in any recorded games.</p></div>`);
    return;
  }

  csBuckets = _foldBuckets(buckets);

  // Avg duration / rounds across every game this character was played in (one
  // row per game), plus its head-to-head record vs every other character (one
  // RPC). Fetched together. _fetchAllRows pages past the ~1000-row cap so a
  // heavily-played character's averages aren't computed from a truncated sample.
  const [{ rows: dgames }, { data: adv }] = await Promise.all([
    _fetchAllRows(() => db
      .from('game_players')
      .select('games(duration_minutes, num_turns)')
      .eq('character', charName)),
    db.rpc('character_adversary_stats', { char_name: charName }),
  ]);
  csAvgDur     = avg(dgames.map(r => r.games?.duration_minutes));
  csAvgTurns   = avg(dgames.map(r => r.games?.num_turns));
  csAdversaries = (adv || []).map(a => ({
    opponent: a.opponent, wins: Number(a.wins), losses: Number(a.losses), games: Number(a.games),
  }));

  render();
}

async function _renderCharIdentity() {
  const objectives = await loadObjectives();
  const objective  = objectives[csChar.name];
  const paceDot    = csChar.pace
    ? `<a class="pace-dot ${csChar.pace}" href="villains.html?pace=${csChar.pace}" title="View ${_esc(csChar.pace)}-pace villains"></a>`
    : `<a class="pace-dot gray" href="villains.html?pace=gray" title="Pace not yet set"></a>`;
  document.getElementById('csIdentity').innerHTML =
    `<div class="pf-identity"><img class="char-portrait identity-portrait zoomable" src="${charImgSrc(csChar.name)}" alt="" onerror="this.src='asset/players/default.svg'" onclick="showAvatarLightbox(this.src, 'asset/players/default.svg')"><span class="pf-name-block"><span class="pf-nick">${_esc(csChar.name)}</span>${csChar.box ? `<a class="pf-since pf-since-link" href="villains.html?box=${boxAnchorId(csChar.box)}" title="View ${_esc(csChar.box)} villains">${_esc(csChar.box)}</a>` : ''}</span></div>${objective ? `<p class="char-objective">${paceDot}${_esc(objective)}</p>` : ''}`;
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

// ── SEARCH / AUTOCOMPLETE ─────────────────────────────────────────────────────

function _attachCharSearch() {
  attachSearchBox({
    inputId:    'csSearchInput',
    dropdownId: 'csDropdown',
    fetchOptions: q => {
      const lower = q.toLowerCase();
      return csAllChars.filter(c => c.name.toLowerCase().includes(lower)).slice(0, 8);
    },
    renderOption: c => `
      <div class="cs-option" data-name="${_esc(c.name)}">
        <img class="char-portrait" src="${charImgSrc(c.name)}" alt="">
        <span>${_esc(c.name)}</span>
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
    { label: 'Overall', key: 'all' },
    { label: '2p', key: 2 },
    { label: '3p', key: 3 },
    { label: '4p', key: 4 },
    { label: '5p', key: 5 },
    { label: '6p', key: 6 },
  ];

  const maxVal = Math.max(...rows.map(r => statValue(csBuckets[r.key], csMode))) || 1;

  const overall  = csBuckets.all;
  const csWinPct = overall.games ? Math.round((overall.wins / overall.games) * 100) : 0;

  root.innerHTML = `
    <div class="summary">
      ${statBoxesHTML([
        { val: overall.games,   lbl: 'Games' },
        { val: csAvgDur   != null ? Math.round(csAvgDur) + 'm' : '-', lbl: 'Avg duration' },
        { val: csAvgTurns != null ? Math.round(csAvgTurns)     : '-', lbl: 'Avg rounds' },
        { val: csWinPct + '%',  lbl: 'Win rate' },
        { val: overall.wins,    lbl: 'Wins' },
      ])}
    </div>
    ${statModeSegHTML(csMode, 'csSetMode')}
    <div class="lb-table cs-table mb-1-25">
      <div class="lb-head">
        <span>Players</span>
        <span></span>
        <span class="text-right">${statValueLabel(csMode)}</span>
        <span class="text-right">${statSecondaryLabel(csMode)}</span>
      </div>
      ${rows.map(r => {
        const b         = csBuckets[r.key];
        const barW      = b.games ? statBarWidth(b, csMode, maxVal) : 0;
        const dispVal   = b.games ? statValueDisplay(b, csMode) : '-';
        const secondary = statSecondaryValue(b, csMode);
        return `
          <div class="lb-row">
            <div class="row-label">${r.label}</div>
            <div class="bar-cell">
              <div class="bar-bg">
                <div class="bar-fill" style="width:${barW}%"></div>
              </div>
            </div>
            <div class="row-val">${dispVal}</div>
            <div class="row-games">${secondary}</div>
          </div>`;
      }).join('')}
    </div>
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

  // % = wins or losses / games vs that opponent (third-player wins mean
  // win% + loss% can be < 100%). The seg also picks the ranking key.
  const pct     = (n, g) => g ? Math.round((n / g) * 100) : 0;
  const winKey  = a => csRivalMode === 'pct' ? pct(a.wins,   a.games) : a.wins;
  const lossKey = a => csRivalMode === 'pct' ? pct(a.losses, a.games) : a.losses;

  const byWins = adversaries.filter(a => a.wins > 0)
    .sort((a, b) => winKey(b) - winKey(a) || b.wins - a.wins || a.opponent.localeCompare(b.opponent)).slice(0, 5);
  const byLoss = adversaries.filter(a => a.losses > 0)
    .sort((a, b) => lossKey(b) - lossKey(a) || b.losses - a.losses || a.opponent.localeCompare(b.opponent)).slice(0, 5);
  if (!byWins.length && !byLoss.length) return '';

  // Row label: the selected metric first, the other after a "|".
  const winsTxt = a => {
    const c = `${a.wins} ${a.wins === 1 ? 'win' : 'wins'}`, p = `${pct(a.wins, a.games)}%`;
    return csRivalMode === 'pct' ? `${p} | ${c}` : `${c} | ${p}`;
  };
  const lossTxt = a => {
    const c = `${a.losses} ${a.losses === 1 ? 'loss' : 'losses'}`, p = `${pct(a.losses, a.games)}%`;
    return csRivalMode === 'pct' ? `${p} | ${c}` : `${c} | ${p}`;
  };
  const seg = `<div class="seg cs-adv-seg">
    <button class="seg-btn ${csRivalMode === 'pct'   ? 'on' : ''}" type="button" onclick="csSetRivalMode('pct')" title="Rank by win/loss %">%</button>
    <button class="seg-btn ${csRivalMode === 'count' ? 'on' : ''}" type="button" onclick="csSetRivalMode('count')" title="Rank by win/loss count">#</button>
  </div>`;
  const row = (opponent, countText) => `
    <a class="cs-adv-row" href="villains.html?vil=${encodeURIComponent(opponent)}">
      ${charImgHTML(opponent)}
      <span class="cs-adv-name">${_esc(opponent)}</span>
      <span class="cs-adv-count">${countText}</span>
    </a>`;
  const col = (title, rowsHTML) => `
    <div class="cs-adv-col">
      <div class="cs-adv-title">${title}</div>
      ${rowsHTML || '<div class="cs-adv-empty">-</div>'}
    </div>`;

  return `
    <div class="pf-games-header">
      <span class="pf-games-title">Rivalries</span>
      ${seg}
    </div>
    <div class="cs-adv">
      ${col('Beaten most',  byWins.map(a => row(a.opponent, winsTxt(a))).join(''))}
      ${col('Lost to most', byLoss.map(a => row(a.opponent, lossTxt(a))).join(''))}
    </div>`;
}

// ── DECKS ─────────────────────────────────────────────────────────────────────

// Card types in display order, coloured like the cards' type banner; anything
// else (Titan, Curse, Witch, Maui, ...) follows in purple.
const DECK_TYPES  = ['Ally', 'Hero', 'Effect', 'Item', 'Condition'];
const DECK_PLURAL = { Ally: 'Allies', Hero: 'Heroes', Witch: 'Witches', 'Ally/Item': 'Ally/Item', 'Hero/Effect': 'Hero/Effect' };

function _deckTypeClass(type) {
  return DECK_TYPES.includes(type) ? `deck-${type.toLowerCase()}` : 'deck-other';
}

const _cardTotal = cards => cards.reduce((n, c) => n + c.count, 0);

// One deck: a header with its total, an optional note, then one column per
// card type. Main decks sort by copies then name; extras (`keepOrder`) keep the
// wiki's order (e.g. Omnidroid v.X8, v.X9, v.10). Tiles count as tiles.
function _deckHTML(title, cards, { note = '', unit = 'card', keepOrder = false } = {}) {
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
      <span class="pf-games-title">${_esc(title)}</span>
      <span class="cs-deck-total">${total} ${unit}${total === 1 ? '' : 's'}</span>
    </div>
    ${note ? `<p class="cs-deck-note">${_esc(note)}</p>` : ''}
    <div class="cs-deck">
      ${types.map(t => {
        const list = keepOrder ? byType.get(t) : byType.get(t).slice().sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        const n    = _cardTotal(list);
        const lbl  = n === 1 ? t : (DECK_PLURAL[t] || `${t}s`);
        return `
          <div class="cs-adv-col cs-deck-col ${_deckTypeClass(t)}">
            <div class="cs-adv-title"><span class="cs-deck-dot"></span>${_esc(lbl)} | ${n}</div>
            ${list.map(c => `
              <div class="cs-deck-row">
                <span class="cs-deck-name">${_esc(c.name)}</span>
                <span class="cs-deck-count">×${c.count}</span>
              </div>`).join('')}
          </div>`;
      }).join('')}
    </div>`;
}

// Villain deck, Fate deck, then any extra deck or tile (Maui deck, Merlin's
// Transformation deck, Omnidroids, ...). Data: villain-decks.json.
async function renderDeck(charName) {
  const el = document.getElementById('csDeck');
  if (!el) return;
  const deck = (await loadVillainDecks())[charName];
  if (!deck) { el.innerHTML = ''; return; }
  el.innerHTML = _deckHTML('Villain deck', deck.villain)
    + _deckHTML('Fate deck', deck.fate)
    + (deck.extra || []).map(e => _deckHTML(e.title, e.cards, {
        note: e.note, unit: /^Tiles?$/.test(e.title) ? 'tile' : 'card', keepOrder: true,
      })).join('')
    + `<p class="cs-deck-src">Card lists from the <a href="https://disney-villainous.fandom.com/wiki/Villain" target="_blank" rel="noopener">Disney Villainous Wiki</a>.</p>`;
}

// ── RULES FAQ LINK ────────────────────────────────────────────────────────────

// The villain's rules clarifications live on faq.html; link there when it has
// any. [TAG] reworks (e.g. "Ursula [I2E]") share their base villain's entries.
async function renderFaqLink(charName) {
  const el = document.getElementById('csFaq');
  if (!el) return;
  const base  = charName.replace(/\s*\[[^\]]+\]$/, '');
  const rules = (await loadFaq()).villains?.[base] || [];
  if (!rules.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <a class="home-section-link mt-1-5" href="faq.html?topic=${encodeURIComponent(base)}">
      <span class="home-section-icon">📜</span>
      <div class="home-section-text">
        <span class="home-section-name">Rules FAQ</span>
        <span class="home-section-desc">${rules.length} ${rules.length === 1 ? 'clarification' : 'clarifications'} for ${_esc(base)}</span>
      </div>
    </a>`;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();

