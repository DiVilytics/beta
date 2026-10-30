// ── STATS TABLE ────────────────────────────────────────────────────────────────
// The shared "rank | identity | bar | value | sub" stat table used by the
// leaderboard and the player profile, plus the summary stat-box trio and the
// sort/rank/bar maths behind them. Depends on `_esc` (db.js).

// Renders the standard summary trio: e.g.
//   statBoxesHTML([{ val: '12', lbl: 'Games' }, { val: '23m', lbl: 'Avg duration' }])
// Returns an HTML string of three `.stat-box` divs (no wrapping element).
// A box may set `hot: true` (+ an optional `title` tooltip) to be highlighted,
// for a stat that is currently sitting at its record.
function statBoxesHTML(boxes) {
  return boxes.map(b =>
    `<div class="stat-box${b.hot ? ' hot' : ''}"${b.title ? ` title="${_esc(b.title)}"` : ''}><div class="stat-val">${b.val}</div><div class="stat-lbl">${b.lbl}</div></div>`
  ).join('');
}

// A character/player with only a couple of games can sit at 100% (or 0%) win
// rate purely by small-sample noise. In % Wins they're grayed out: listed after
// everyone else, unranked, on the Leaderboard; dimmed, without the gold bar, in
// a villain's table (raw # Wins / # Games stay unaffected, a low count there
// isn't misleading the same way). Intentionally not user-configurable.
const MIN_GAMES_FOR_PCT = 5;

// ── STAT MODE: the pct | count | games metric shared by every win-rate surface ──
// (plus 'xp', the players' Leaderboard only: rows then carry `xp` and `xpAch`,
// the part from achievements, shown in parentheses instead of the games; and
// 'chance', the villains' Leaderboard and a villain's page: rows carry `exp`
// and `vari`, see chanceDelta)
// statValue → the numeric metric (pct is a 0..1 fraction); statValueDisplay →
// the formatted value; statCellHTML → the table cell, "40% (12)" / "5 (12)" with
// the games played in parentheses (two right-aligned sub-columns, so the digits
// line up row to row), or just "12" when ranking by games; statGamesWidth → the
// width of the "(games)" sub-column for a table, from its largest count;
// statValueLabel → its column header. statModeSegHTML renders the toggle
// control (`fn` is the global handler name the buttons call, e.g. 'setMode').
// Δ Wins: how far the wins are from what equal chances would give, in
// standard deviations, (W - E) / √V, with E = Σ 1/k (the wins expected by
// chance) and V = Σ 1/k (1 - 1/k) (their variance) over the games, k the
// players in each. 0 is exactly as expected; null without games.
function chanceDelta(r) {
  return r.vari > 0 ? (r.wins - r.exp) / Math.sqrt(r.vari) : null;
}
const fmtChance = v => v == null ? '-'
  : v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });

function statValue(r, mode) {
  if (mode === 'chance') return chanceDelta(r) ?? 0;
  if (mode === 'xp')    return r.xp || 0;
  if (mode === 'count') return r.wins;
  if (mode === 'games') return r.games;
  return r.games ? r.wins / r.games : 0;
}
function statValueDisplay(r, mode) {
  if (mode === 'chance') return fmtChance(chanceDelta(r));
  if (mode === 'xp')    return r.xp || 0;
  if (mode === 'count') return r.wins;
  if (mode === 'games') return r.games;
  return (r.games ? Math.round((r.wins / r.games) * 100) : 0) + '%';
}
// Table header text: the full label, plus a short form for narrow screens when
// the language has one ('% Wins (short)' in the dictionary); CSS shows one.
function _headLabel(key) {
  const full = t(key), short = t(`${key} (short)`);
  return short === `${key} (short)` || short === full ? full
    : `<span class="stat-lbl-full">${full}</span><span class="stat-lbl-short">${short}</span>`;
}
function statValueLabel(mode) {
  if (mode === 'games') return _headLabel('# Games');
  if (mode === 'xp') return `${_headLabel('XP')} <span class="lb-head-sub">(${_headLabel('Achievements')})</span>`;
  if (mode === 'chance') return `${_headLabel('Δ Wins')} <span class="lb-head-sub">(${_headLabel('Games')})</span>`;
  return `${_headLabel(mode === 'count' ? '# Wins' : '% Wins')} <span class="lb-head-sub">(${_headLabel('Games')})</span>`;
}
// The number in parentheses: the games, or for XP the XP from achievements.
const _statSub = (r, mode) => mode === 'xp' ? (r.xpAch || 0) : r.games;
function statCellHTML(r, mode) {
  if ((mode === 'pct' || mode === 'chance') && !r.games) return '-';   // no games, no win rate
  const v = `<span class="sv-main">${statValueDisplay(r, mode)}</span>`;
  return `<span class="sv">${mode === 'games' ? v : `${v}<span class="sv-games">(${_statSub(r, mode)})</span>`}</span>`;
}
// Tabular digits are 0.6em wide in the app font, the two parentheses 0.6em together.
function statGamesWidth(rows, mode) {
  const digits = String(Math.max(0, ...rows.map(r => _statSub(r, mode)))).length;
  return `--sv-games: calc(${digits} * 0.6em + 0.65em)`;
}

// `xp: true` adds XP first (the players' Leaderboard), `chance: true` Δ Wins
// first (the villains' Leaderboard, a villain's page). Each label also has a short form ('% Wins:short' in
// i18n: "% Vitt."), shown only where a row is too tight for the full ones
// (.seg-short on a parent: the villain page with its All / Solo menu); without
// one, the full label.
const _statShortLabel = key => { const s = t(key + ':short'); return s.endsWith(':short') ? t(key) : s; };
function statModeSegHTML(mode, fn, { xp = false, chance = false } = {}) {
  const btn = (m, key) =>
    `<button class="seg-btn ${mode === m ? 'on' : ''}" type="button" onclick="${fn}('${m}')"><span class="stat-lbl-full">${t(key)}</span><span class="stat-lbl-short">${_statShortLabel(key)}</span></button>`;
  return `<div class="controls mb-1"><div class="seg stat-mode-seg">${xp ? btn('xp', 'XP') : ''}${chance ? btn('chance', 'Δ Wins') : ''}${btn('pct', '% Wins')}${btn('count', '# Wins')}${btn('games', '# Games')}</div></div>`;
}

function sortStatRows(rows, mode) {
  const sorted = [...rows];
  if (mode === 'chance') return sorted.sort((a, b) => (chanceDelta(b) ?? -Infinity) - (chanceDelta(a) ?? -Infinity) || b.games - a.games);
  if (mode === 'xp')    return sorted.sort((a, b) => (b.xp || 0) - (a.xp || 0) || b.wins - a.wins || b.games - a.games);
  if (mode === 'count') return sorted.sort((a, b) => b.wins - a.wins || b.games - a.games);
  if (mode === 'games') return sorted.sort((a, b) => b.games - a.games || b.wins - a.wins);
  return sorted.sort((a, b) => {
    const pa = a.games ? a.wins / a.games : 0;
    const pb = b.games ? b.wins / b.games : 0;
    // Tiebreak by wins then games, so e.g. 0% with games ranks above 0 games.
    return pb - pa || b.wins - a.wins || b.games - a.games;
  });
}

function computeRanks(rows, mode) {
  const primaryVal = r => statValue(r, mode);
  const ranks = [];
  for (let i = 0; i < rows.length; i++) {
    ranks.push(i === 0 || primaryVal(rows[i]) !== primaryVal(rows[i - 1]) ? i + 1 : ranks[i - 1]);
  }
  return ranks;
}

// Bar width as a % of the largest value across rows in the current mode, capped
// at 100 (unranked rows can be above the ranked maximum).
function statBarWidth(r, mode, maxVal) {
  return Math.min(100, Math.round((statValue(r, mode) / (maxVal || 1)) * 100));
}

// Δ Wins's bar starts from the middle (0, as expected by chance): to the
// right above it, to the left below it, scaled to the largest distance.
function chanceBarHTML(r, maxAbs, gold) {
  const v = chanceDelta(r) ?? 0;
  const w = Math.min(50, Math.round(Math.abs(v) / (maxAbs || 1) * 50));
  return `<div class="bar-bg bar-diverge"><div class="bar-fill${v < 0 ? ' neg' : gold ? ' gold' : ''}" style="${v < 0 ? 'right' : 'left'}:50%;width:${w}%"></div></div>`;
}

// Under a Δ Wins table: what the numbers mean, and How it's computed ›,
// which opens the math; note, at its end: what the page's table counts.
let _chanceNote = '';
function chanceHintHTML(note = '') {
  _chanceNote = note;
  return `<p class="results-hint">${t('0 is the score you would get by picking the winners at random; above 0 is better than chance, below 0 worse.')} <button class="char-guide-link" type="button" onclick="openChanceInfo()">${t('How it\'s computed')} ›</button></p>`;
}

// How Δ Wins is computed: a sheet made the first time it opens.
function openChanceInfo() {
  if (!document.getElementById('chanceOverlay')) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.id = 'chanceOverlay';
    overlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h3>${t('Δ Wins')}</h3>
          <button class="sheet-close" type="button" aria-label="${t('Close')}">×</button>
        </div>
        <div class="sheet-body" id="chanceBody"></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay('chanceOverlay'); });
    overlay.querySelector('.sheet-close').addEventListener('click', () => closeOverlay('chanceOverlay'));
  }
  // The formulas in MathML, the browser's own math typesetting.
  const math = x => `<math display="block" displaystyle="true" class="math-block">${x}</math>`;
  const frac = (top, bottom) => `<mfrac>${top}${bottom}</mfrac>`;
  const kg   = '<msub><mi>k</mi><mi>g</mi></msub>';
  const inv  = frac('<mn>1</mn>', kg);
  const sum  = x => `<munderover><mo largeop="true" movablelimits="false">∑</mo><mrow><mi>g</mi><mo>=</mo><mn>1</mn></mrow><mi>N</mi></munderover>${x}`;
  document.getElementById('chanceBody').innerHTML = `
    <p class="modal-hint">${t('Δ Wins compares a villain\'s wins with the wins it would have if everyone at the table had the same chance to win.')}</p>
    ${math(`<mi mathvariant="normal">Δ</mi><mo>=</mo>${frac('<mrow><mi>W</mi><mo>−</mo><mi>E</mi></mrow>', '<msqrt><mi>V</mi></msqrt>')}`)}
    ${math(`<mi>E</mi><mo>=</mo>${sum(inv)}`)}
    ${math(`<mi>V</mi><mo>=</mo>${sum(`${inv}<mrow><mo stretchy="true">(</mo><mn>1</mn><mo>−</mo>${inv}<mo stretchy="true">)</mo></mrow>`)}`)}
    <p class="modal-hint">${t('<b>W</b>: its wins. <b>N</b>: its games. <b>k<sub>g</sub></b>: the players in game g. <b>E</b>: expected number of wins, 1/k<sub>g</sub> per game (a game of 4 expects a quarter of a win). <b>V</b>: their variance, how much the wins vary by chance alone.')}</p>
    <p class="modal-hint">${t('W − E compares the number of wins with the number of wins one would get by picking a random winner; dividing by √V, the standard deviation, puts villains with many games and with few on the same scale, so a lucky run in a few games doesn\'t stand out the way it does in % Wins.')}</p>
    <p class="modal-hint">${t('<b>Reading it</b>: 0 is exactly as expected. Between −1 and +1 is ordinary luck: about 2 villains in 3 would land there by chance alone. Beyond ±2 is rare by chance alone, about 1 in 20.')}</p>
    <p class="modal-hint">${t('<b>For example</b>: 10 wins in 20 games at tables of 4. E = 20 × 1/4 = 5, V = 20 × 1/4 × 3/4 = 3.75, so Δ = (10 − 5) / √3.75 ≈ +2.58.')}</p>
    <p class="modal-hint">${t('Every game counts by its number of players: a win at 6 players is worth more than one at 2.')}${_chanceNote ? ` ${_chanceNote}` : ''}</p>`;
  openOverlay('chanceOverlay');
}

// Anchor id for a character's box group on the characters roster page.
function boxAnchorId(box) {
  return 'box-' + String(box || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Renders the rank | identity | bar | value | sub stat table. Used by the
// leaderboard and the player profile (the character-detail stat table has a
// different shape and is built inline in villains.js).
//
// Required opts:
//   mode          : 'pct' | 'count' | 'games' | 'xp'
//   headLabel     : column header for the identity column ("Character" | "Player")
//   getKey(r)     : returns the row's key (villain name or nickname)
//   getName(key)  : optional, the name shown for a key (villainName for villains)
//   getNameHTML(key): optional markup instead (villainNameInline: small [TAG])
//   getHref(key)  : returns the link target
//   getIdentity(key): returns the inline HTML for the row's avatar/portrait
//   getSub(key)   : optional, returns small gray sub-text under the name
//   wrapClass     : optional extra class on the `lb-table` wrapper
//   limit         : render only the top N rows (default: all).
//   selfKey       : highlight the row whose key matches; if that row falls beyond
//                   `limit`, pin it at the bottom under a "Your position" divider
//                   so the viewer always sees their standing for the current sort.
//   minGames      : optional; rows with fewer games aren't ranked: they follow
//                   the others under a "Fewer than {n} games" divider, dimmed and
//                   with no position (for % Wins, where 1-2 games can sit at 100%
//                   by luck).
function renderStatTableHTML(rows, opts) {
  const { mode, headLabel, getKey, getName = k => k, getNameHTML, getHref, getIdentity, getSub, getSubHref,
          wrapClass = '', limit = Infinity, selfKey = null, minGames = 0 } = opts;
  const all      = sortStatRows(rows, mode);
  const ranked   = all.filter(r => r.games >= minGames);
  const unranked = all.filter(r => r.games <  minGames);
  const sorted   = ranked.concat(unranked);

  // Bars scale to the ranked rows (an unranked 100% shouldn't shrink them all).
  const maxVal = Math.max(...(ranked.length ? ranked : unranked).map(r => statValue(r, mode))) || 1;
  const maxAbs = Math.max(...(ranked.length ? ranked : unranked).map(r => Math.abs(statValue(r, mode)))) || 1;

  const ranks      = computeRanks(ranked, mode);
  const medalClass = rank => rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';

  const rowHTML = (r, i) => {
    const rank    = i < ranked.length ? ranks[i] : null;
    const key     = getKey(r);
    const barW    = statBarWidth(r, mode, maxVal);
    const dispVal = statCellHTML(r, mode);
    const sub     = getSub ? (getSub(key, r) || '') : '';
    const subHref = (sub && getSubHref) ? (getSubHref(key, r) || '') : '';
    const selfCls = (selfKey != null && key === selfKey) ? ' lb-row-self' : '';
    // The name and the box are each their own link (to the character/player and to
    // the box), rather than one row-wide anchor, so each is independently clickable.
    return `
      <div class="lb-row${selfCls}${rank == null ? ' lb-row-unranked' : ''}">
        <div class="rank-num ${medalClass(rank)}">${rank ?? '-'}</div>
        <div class="row-identity">
          ${getIdentity(key, r)}
          <div class="row-id-text">
            <a class="row-name row-name-link" href="${getHref(key, r)}">${getNameHTML ? getNameHTML(key) : _esc(getName(key))}</a>
            ${sub ? (subHref
              ? `<a class="row-sub row-sub-link" href="${_esc(subHref)}" title="${_esc(t('View {box} villains', { box: sub }))}">${_esc(sub)}</a>`
              : `<div class="row-sub">${_esc(sub)}</div>`) : ''}
          </div>
        </div>
        <div class="row-val row-val-stack">
          ${dispVal}
          ${mode === 'chance' ? chanceBarHTML(r, maxAbs, rank === 1)
            : `<div class="bar-bg"><div class="bar-fill${rank === 1 ? ' gold' : ''}" style="width:${barW}%"></div></div>`}
        </div>
      </div>`;
  };

  const unrankedSep = `<div class="lb-row-sep lb-row-sep-muted">${minGames === 1 ? t('No games') : t('Fewer than {n} games', { n: minGames })}</div>`;
  let body = sorted.slice(0, limit)
    .map((r, i) => (i === ranked.length ? unrankedSep : '') + rowHTML(r, i)).join('');

  // Pin the viewer's row if it ranks below the visible cut.
  const selfIdx = selfKey != null ? sorted.findIndex(r => getKey(r) === selfKey) : -1;
  if (selfIdx >= limit) {
    body += `<div class="lb-row-sep">${t('Your position')}</div>${rowHTML(sorted[selfIdx], selfIdx)}`;
  }

  return `
    <div class="lb-table${wrapClass ? ' ' + wrapClass : ''}" style="${statGamesWidth(sorted, mode)}">
      <div class="lb-head">
        <span>#</span>
        <span>${headLabel}</span>
        <span class="text-right">${statValueLabel(mode)}</span>
      </div>
      ${body}
    </div>`;
}
