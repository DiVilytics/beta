// ── STATE ─────────────────────────────────────────────────────────────────────

let lbChars         = [];
let lbCharBoxMap    = {};
let lbNickAvatarMap = {};

let lbTab    = 'characters';   // 'characters' | 'players'
let lbMode   = 'matchups';     // 'pct' | 'count' | 'games' | 'chance', or 'matchups' (villains only) or 'xp' (players only)

// Each tab keeps its own ranking: villains open on Δ Wins, players on XP.
const _lbModeByTab = { characters: 'matchups', players: 'xp' };

// The table size, All / 2p…6p / Solo (size-filter.js), and the period, All
// time / Year / Month (period-filter.js): any change reloads. Solo ranks the
// solo games only (solo.js), of the level picked, never with the others.
const size = createSizeFilter('lbSize', {
  onChange: () => { lbDisplayLimit = LB_PAGE_SIZE; loadAndRender(); },
});
const period = createPeriodFilter('lbPeriod', {
  onChange: () => { lbDisplayLimit = LB_PAGE_SIZE; loadAndRender(); },
});

// The Players tab shows 30 at a time, Load more for the next 30, your own row
// pinned under them when it ranks lower; the Villains tab shows every villain.
const LB_PAGE_SIZE = 30;
let lbDisplayLimit = LB_PAGE_SIZE;

// Cache: key `${lbTab}:${size}:${level}:${period.id()}` → { rows, summary }.
// Avoids re-fetching when only the sort lbMode changes, or when going back to a
// period already seen.
const _lbCache = {};
const _lbKey = () => `${lbTab}:${size.value()}:${size.level()}:${period.id()}`;

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('leaderboard.html');
  await initAuth();

  const [chars, profiles] = await Promise.all([
    loadCharacters(),
    fetchAllProfiles(),
    period.load(),
  ]);

  lbChars         = chars;
  lbCharBoxMap    = Object.fromEntries(chars.map(c => [c.name, c.box]));
  lbNickAvatarMap = Object.fromEntries(
    profiles.filter(p => p.nickname).map(p => [p.nickname, resolveAvatar(p)])
  );

  // The tab is kept in the address (?tab=players), so a reload or a link
  // reopens it; a language switch also brings back the rankings, the table size,
  // the period and the rows loaded (keepViewState, lang.js).
  const saved = takeViewState();
  if (saved) {
    Object.assign(_lbModeByTab, saved.modes);
    lbMode = _lbModeByTab[lbTab];
  }
  if ((saved?.tab || new URLSearchParams(location.search).get('tab')) === 'players') _applyTab('players');
  if (saved) {
    size.set(saved.filter);
    size.setLevel(saved.level);
    period.set(saved.period);
    lbDisplayLimit = saved.limit || LB_PAGE_SIZE;
  }
  keepViewState(() => ({
    tab: lbTab, modes: { ..._lbModeByTab, [lbTab]: lbMode },
    filter: size.value(), level: size.level(), period: period.get(), limit: lbDisplayLimit,
  }));
  await loadAndRender();
  _loadXpLedger();   // in the background, so the Players tab opens at once
}

// ── CONTROLS ──────────────────────────────────────────────────────────────────

function setTab(t) {
  _applyTab(t);
  const url = new URL(location.href);
  if (t === 'players') url.searchParams.set('tab', 'players');
  else url.searchParams.delete('tab');
  history.replaceState(null, '', url);
  loadAndRender();
}

function _applyTab(t) {
  _lbModeByTab[lbTab] = lbMode;
  lbTab  = t;
  lbMode = _lbModeByTab[t];
  lbDisplayLimit = LB_PAGE_SIZE;
  document.getElementById('tabChars').classList.toggle('on',   t === 'characters');
  document.getElementById('tabPlayers').classList.toggle('on', t === 'players');
}

function setMode(m) {
  lbMode = m;
  const cached = _lbCache[_lbKey()];
  if (cached) _show(cached, ++_lbLoadToken);
}

function lbLoadMore() {
  lbDisplayLimit += LB_PAGE_SIZE;
  const cached = _lbCache[_lbKey()];
  if (cached) render(cached);
}

// ── DATA LOADING ──────────────────────────────────────────────────────────────

// A month change can be clicked through faster than it loads: only the latest
// request renders.
let _lbLoadToken = 0;

async function loadAndRender() {
  const key   = _lbKey();
  const token = ++_lbLoadToken;   // also on a cache hit, so an older fetch can't land after it

  const lb      = document.getElementById('lb');
  const summary = document.getElementById('summary');

  if (!_lbCache[key]) {
    lb.classList.add('lb-loading');
    summary.classList.add('lb-loading');
    const data = await (size.isSolo() ? _fetchSolo() : period.isAll() ? _fetchAllTime() : _fetchPeriod());
    if (token !== _lbLoadToken) return;
    if (!data) {
      summary.className = 'summary';
      summary.innerHTML = '';
      lb.className = '';
      lb.innerHTML = loadErrorHTML(t("Couldn't load the leaderboard"));
      return;
    }
    // The Villains tab lists every villain, also those without games here.
    if (lbTab === 'characters') {
      const present = new Set(data.rows.map(r => r.character));
      data.rows = data.rows.concat(lbChars.filter(c => !present.has(c.name)).map(c => ({ character: c.name, games: 0, wins: 0 })));
    }
    _lbCache[key] = data;
  }

  // Also clears the dimming an older, overtaken fetch left on.
  summary.className = 'summary';
  lb.className = '';
  _show(_lbCache[key], token);
}

// Draws the board, Matchups' games first when it shows them and they aren't
// in yet (only the latest request draws).
async function _show(data, token) {
  const lb = document.getElementById('lb');
  if (_showsMatchups() && !data.mu) {
    lb.classList.add('lb-loading');
    const ok = await _addMatchups(data);
    if (token !== _lbLoadToken) return;
    lb.className = '';
    if (!ok) { lb.innerHTML = loadErrorHTML(t("Couldn't load the leaderboard")); return; }
  }
  render(data);
}

async function _fetchAllTime() {
  const lbFilter = size.value();
  const isChar  = lbTab === 'characters';
  const view    = lbFilter === 'all'
    ? (isChar ? 'character_stats' : 'player_stats')
    : (isChar ? 'character_stats_by_size' : 'player_stats_by_size');

  // Paged past the ~1000-row response cap so a large player_stats board (or any
  // size-filtered view) isn't silently truncated. _fetchAllRows needs a fresh
  // builder each page.
  const buildRows = () => lbFilter === 'all'
    ? db.from(view).select('*')
    : db.from(view).select('*').eq('player_count', lbFilter);

  const [{ rows }, { data: summary }, xp, bySize] = await Promise.all([
    _fetchAllRows(buildRows),
    db.rpc('game_stats', lbFilter === 'all' ? {} : { player_count_filter: lbFilter }),
    _fetchXp(),
    // Δ Wins needs each row's games by table size: the rows themselves when a
    // size is picked.
    lbFilter === 'all' ? _fetchAllRows(() => db.from(isChar ? 'character_stats_by_size' : 'player_stats_by_size').select('*')) : null,
  ]);
  if (xp === null || bySize?.error) return null;

  let lbRows = rows;
  // Overall players board: also list registered players who've never played,
  // as 0/0/0 rows. The sort drops them below anyone who has games.
  if (lbTab === 'players' && lbFilter === 'all') {
    const present = new Set(lbRows.map(r => r.nickname));
    const missing = Object.keys(lbNickAvatarMap).filter(n => !present.has(n));
    lbRows = lbRows.concat(missing.map(nickname => ({ nickname, wins: 0, games: 0 })));
  }

  return {
    rows:    _addChance(_addXp(lbRows, xp), bySize ? bySize.rows : rows),
    summary: (summary || [])[0] || { games: 0, avg_duration: null, avg_turns: null },
  };
}

// A year or a month: the same numbers from the period_* RPCs, for the games
// played in it. A villain or player is listed only if they played then.
async function _fetchPeriod() {
  const lbFilter = size.value();
  const range = { player_count_filter: lbFilter === 'all' ? null : lbFilter, ...period.range() };
  // Δ Wins, every table size: each size's games apart.
  const sizes = lbFilter === 'all' ? CHANCE_SIZES : [lbFilter];
  const [stats, summary, xp, ...bySize] = await Promise.all([
    db.rpc('period_leaderboard', { kind: lbTab, ...range }),
    db.rpc('period_game_stats', range),
    _fetchXp(),
    ...sizes.map(k => k === lbFilter ? null : db.rpc('period_leaderboard', { kind: lbTab, ...range, player_count_filter: k })),
  ]);
  if (stats.error || summary.error || xp === null || bySize.some(b => b?.error)) return null;
  const nameKey = lbTab === 'characters' ? 'character' : 'nickname';
  const sized = sizes.flatMap((k, i) => ((bySize[i] || stats).data || []).map(r => ({ [nameKey]: r.name, player_count: k, games: r.games })));
  return {
    rows:    _addChance(_addXp((stats.data || []).map(r => ({ [nameKey]: r.name, wins: r.wins, games: r.games })), xp), sized),
    summary: (summary.data || [])[0] || { games: 0, avg_duration: null, avg_turns: null },
  };
}

// Solo: the same numbers from the solo games of the period and level
// (solo.js), no XP; the average rounds are those to win.
async function _fetchSolo() {
  const solo = await loadSoloGames();
  if (!solo) return null;
  const { games, players } = soloOfLevel(soloInPeriod(solo, period.range()), size.level());
  return {
    rows:    soloRankRows(players, lbTab === 'characters' ? 'character' : 'nickname'),
    summary: soloSummary(games, soloWonIds(players)),
  };
}

// ── CHANCE Δ ──────────────────────────────────────────────────────────────────
// Each villain's (or player's) wins against what equal chances would give
// (chanceDelta, stats-table.js). Their games by table size give E = Σ games / k
// and V = Σ games / k (1 - 1/k); with one size picked, that size's alone. A
// player's games are those where they claimed their villain, as everywhere.
const CHANCE_SIZES = [2, 3, 4, 5, 6];

function _addChance(rows, bySize) {
  const key = lbTab === 'characters' ? 'character' : 'nickname';
  const terms = {};
  for (const r of bySize) {
    const k = Number(r.player_count ?? size.value()), n = Number(r.games);
    if (!(k >= 2)) continue;
    const o = terms[r[key]] ||= { exp: 0, vari: 0 };
    o.exp  += n / k;
    o.vari += n / k * (1 - 1 / k);
  }
  return rows.map(r => ({ ...r, exp: 0, vari: 0, ...terms[r[key]] }));
}

// ── MATCHUPS ──────────────────────────────────────────────────────────────────
// Villains only: each villain against every other villain, its matchups by
// matchupClass (stats-table.js): winning, even, losing, too few, from the
// games of the table size and period picked, read as the Matchups chart reads
// them. Every game is loaded once (loadOfficialGames, db.js), the first time
// the mode shows; each filter's matchups then once. data.mu: { villain:
// { win, even, lose, few: [{ name, n, w, l }] } }; false if the games couldn't load.
const _showsMatchups = () => lbTab === 'characters' && lbMode === 'matchups' && !size.isSolo();

async function _addMatchups(data) {
  let all;
  try { all = await loadOfficialGames(); } catch (_) { return false; }
  const rec = pairRecords(gamesIn(all, period.range(), size.value()));
  data.mu = {};
  for (const a of lbChars) {
    const m = data.mu[a.name] = { win: [], even: [], lose: [], few: [] };
    for (const b of lbChars) {
      if (b.name === a.name) continue;
      const r = pairRecord(rec, a.name, b.name);
      m[matchupClass(r)].push({ name: b.name, ...r });
    }
  }
  return true;
}

// How Matchups is computed (How it's computed ›, under the switch).
function openMatchupsInfo() {
  const body = infoSheet('muInfoOverlay', t('Matchups'));
  const p = s => `<p class="modal-hint">${s}</p>`;
  body.innerHTML =
    p(t('Each villain against every other villain, in the games one of the two won (a game won by a third villain counts for neither).')) +
    p(t('<b>Winning</b>: it clearly beats them, the pair\'s Δ Wins above +{d}, rare by chance alone (about 1 in 20). <b>Losing</b>: they clearly beat it, below −{d}. <b>Even</b>: in between, no clear winner yet. <b>Too few</b>: fewer than {n} games won by one of the two.', { d: MATCHUP_CLEAR, n: MIN_PAIR_GAMES })) +
    p(t('<b>Ranking</b>: winning minus losing matchups. Ties are broken by the number of even matchups, then by their quality: the even ones leaning to winning (Δ above +{lean}) minus those leaning to losing (below −{lean}), then by games.', { lean: MATCHUP_LEAN })) +
    p(t('Ranked only with at least {n} matchups that aren\'t too few: a newer villain waits under the divider until it has the games.', { n: MIN_MATCHUPS }));
  openOverlay('muInfoOverlay');
}

// A villain's matchups (its row's numbers, tapped): its opponents in the four
// groups, the clearest first, each with its record (its wins - theirs).
let _lbMu = {};
function openMatchups(name) {
  const m = _lbMu[name];
  if (!m) return;
  const order = list => list.slice().sort((a, b) => pairDelta(b.w, b.l) - pairDelta(a.w, a.l) || b.n - a.n);
  const group = (key, label, list) => `
    <div class="section-label"><span class="mu-${key}">${label}</span> (${list.length})</div>
    ${list.length ? `<div class="mu-grid">${order(list).map(o => `
      <a class="mu-opp" href="villains.html?vil=${encodeURIComponent(o.name)}" title="${_esc(`${villainName(o.name)}: ${t('{a} won {w}, {b} won {l}', { a: villainName(name), w: o.w, b: villainName(o.name), l: o.l })} | ${tn(o.n, '{n} game together', '{n} games together')}`)}">
        ${charImgHTML(o.name)}<span>${o.w}–${o.l}</span>
      </a>`).join('')}</div>` : '<p class="results-hint">-</p>'}`;
  document.getElementById('muTitle').textContent = villainName(name);
  document.getElementById('muBody').innerHTML =
    `<p class="modal-hint">${t('Under each opponent: wins of {villain} – wins of the opponent. Games won by a third villain don\'t count.', { villain: `<b>${_esc(villainName(name))}</b>` })}</p>` +
    group('win',  t('Winning'), m.win) + group('even', t('Even'), m.even) +
    group('lose', t('Losing'),  m.lose) + group('few', t('Too few games'), m.few);
  openOverlay('muOverlay');
}

// ── XP ────────────────────────────────────────────────────────────────────────
// Every official game a player claimed a villain in earns them C + (C - 1) * W
// XP, C the players who claimed one in it (them included), W 1 if they won: a
// loss is worth claiming when the others claim too, a win more so, a game
// claimed alone gives 1 either way (Solo has no XP);
// plus the XP of the achievements that game unlocked (achievementXp, achievements.js:
// their achievements after it minus before it, in play order). So a table size
// or a period counts the XP of its own games, achievements included.
// The ledger, { nickname: [{ at, size, xp, ach }] } (ach: the part of xp from
// achievements), is built once from every game with a claim; null if it
// couldn't load.
let _xpLedger = null;

function _loadXpLedger() {
  return _xpLedger ||= (async () => {
    const { rows, error } = await _fetchAllRows(() => db.from('game_players').select('game_id').not('nickname', 'is', null));
    if (error) return null;
    const ids = [...new Set(rows.map(r => r.game_id))];
    const [{ games, players }, boxInfo] = await Promise.all([fetchGamesWithPlayers(ids), loadBoxInfo()]);

    const gameById = Object.fromEntries(games.map(g => [g.id, g]));
    const seats    = {};   // game id → its seats
    for (const p of players) (seats[p.game_id] ||= []).push(p);
    const claims = id => seats[id].filter(p => p.nickname).length;
    // Play order; games without a date first (they never fall in a period).
    const at = id => gameById[id]?.played_at ? new Date(gameById[id].played_at).getTime() : -Infinity;

    const mineByNick = {};
    for (const p of players) if (p.nickname) (mineByNick[p.nickname] ||= []).push(p);

    const ledger = {};
    for (const [nick, mine] of Object.entries(mineByNick)) {
      mine.sort((a, b) => at(a.game_id) - at(b.game_id) || (a.game_id < b.game_id ? -1 : 1));
      const isMine = p => p.nickname === nick;
      const sofar  = [];
      let achBefore = 0;
      ledger[nick] = mine.map(p => {
        sofar.push(p);
        const global   = computeGlobalAchievements(sofar.map(s => gameById[s.game_id]), sofar.flatMap(s => seats[s.game_id]), isMine, lbChars);
        const achAfter = achievementXp(computeCharacterAchievements(sofar), lbChars, boxInfo, global);
        const ach = achAfter - achBefore;
        achBefore = achAfter;
        const c = claims(p.game_id);
        return { at: gameById[p.game_id]?.played_at || null, size: seats[p.game_id].length, xp: gameXp(c, p.is_winner) + ach, ach };
      });
    }
    return ledger;
  })().then(l => { if (!l) _xpLedger = null; return l; });   // a failed load is retried
}

// Players only: each nickname's XP for the current table size and period, a
// { nickname: { xp, ach } } map; {} for villains, null on an error.
async function _fetchXp() {
  if (lbTab !== 'players') return {};
  const ledger = await _loadXpLedger();
  if (!ledger) return null;
  const { from_ts, to_ts } = period.range();
  const from = from_ts ? new Date(from_ts) : null, to = to_ts ? new Date(to_ts) : null;
  const out = {};
  for (const [nick, entries] of Object.entries(ledger)) {
    out[nick] = { xp: 0, ach: 0 };
    for (const e of entries) {
      if (size.value() !== 'all' && e.size !== size.value()) continue;
      if (from && !(e.at && new Date(e.at) >= from && new Date(e.at) < to)) continue;
      out[nick].xp  += e.xp;
      out[nick].ach += e.ach;
    }
  }
  return out;
}
const _addXp = (rows, xp) => lbTab === 'players'
  ? rows.map(r => ({ ...r, xp: xp[r.nickname]?.xp || 0, xpAch: xp[r.nickname]?.ach || 0 }))
  : rows;

// The XP table (XP table ›, under the explanation): what one game gives, C +
// (C - 1) * W, by the players who claimed their villain, you included (the table
// size doesn't count), lost in purple and won in gold.
function openXpTable() {
  const claims = [1, 2, 3, 4, 5, 6];
  const row = (label, cls, xp) =>
    `<tr><th>${label}</th>${claims.map(c => `<td class="${cls}">${xp(c)}</td>`).join('')}</tr>`;
  document.getElementById('xpBody').innerHTML = `
    <p class="modal-hint">${t('Every game where you claimed your villain gives you')}</p>
    <math display="block" displaystyle="true" class="math-block"><mi>XP</mi><mo>=</mo><mi>C</mi><mo>+</mo><mrow><mo>(</mo><mi>C</mi><mo>−</mo><mn>1</mn><mo>)</mo></mrow><mi>W</mi></math>
    <p class="modal-hint">${t('<b>C</b>: the players who claimed their villain, you included. <b>W</b>: 1 if you won, 0 if you lost. Claiming alone gives 1 either way; each other player who claims adds 1, and a win doubles what they add.')}</p>
    <p class="modal-hint">${t('The XP of one game, by how many players claimed their villain, you included.')}</p>
    <table class="xp-table">
      <colgroup><col class="xp-label-col"><col span="${claims.length}"></colgroup>
      <thead>
        <tr><th></th><th colspan="${claims.length}">${t('Players who claimed, you included')}</th></tr>
        <tr><th></th>${claims.map(c => `<th>${c}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${row(t('Lost'), 'xp-lost', c => c)}
        ${row(t('Won'),  'xp-won',  c => 2 * c - 1)}
      </tbody>
    </table>
    <p class="modal-hint">${t('Moreover, each achievement gives 1 XP.')}</p>`;
  openOverlay('xpOverlay');
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function render(data) {
  let { rows, summary } = data;
  const { games, avg_duration, avg_turns } = summary;
  const avgDur   = avg_duration != null ? Math.round(avg_duration) : null;
  const avgTurns = avg_turns    != null ? Math.round(avg_turns)    : null;

  document.getElementById('summary').innerHTML = statBoxesHTML([
    { val: games,                                  lbl: t('Games') },
    { val: avgDur   != null ? avgDur + 'm' : '-',  lbl: t('Avg duration') },
    { val: avgTurns != null ? avgTurns      : '-', lbl: size.isSolo() ? t('Avg rounds to win') : t('Avg rounds') },
  ]);

  // Solo: what it is, above its own ranking (which has no XP: % Wins instead).
  const solo     = size.isSolo();
  const soloHint = solo ? soloHintHTML() : '';
  const mode     = solo && (lbMode === 'xp' || lbMode === 'chance' || lbMode === 'matchups') ? 'pct' : lbMode;

  // No games at all (every table size, or on Solo every level, all time): the
  // card, as in the Game log, not a ranking of empty rows, on both tabs.
  if (!games && (size.value() === 'all' || (solo && size.level() === 'all')) && period.isAll()) {
    document.getElementById('lb').innerHTML = soloHint + (solo
      ? emptyStateHTML('⚔️', t('No solo games yet'), t('To record one, pick Solo in New Game, where you choose the number of players.'),
          `<a class="btn btn-primary btn-sm" href="new-game.html">${t('+ New Game')}</a>`)
      : emptyStateHTML('⚔️', t('No games yet'), t('Record your first game to get started.'),
          `<a class="btn btn-primary btn-sm" href="new-game.html">${t('+ New Game')}</a>`));
    return;
  }

  if (!rows.length) {
    // Players: there can be games with nobody signed in on them (imported ones).
    document.getElementById('lb').innerHTML = soloHint + (games && lbTab === 'players'
      ? emptyStateHTML('👤', t('No players to rank'), t('No player has claimed a villain in these games.'))
      : emptyStateHTML('🔍', t('No games for this filter'), t('Try adjusting the filters.')));
    return;
  }

  // % Wins only: a 1-2 game sample can sit at 100% (or 0%) purely by noise, so
  // those rows follow the ranking under a divider, unranked. # Wins / # Games
  // rank everyone, a low count there isn't misleading the same way.
  // Δ Wins ranks every villain with games (few games can't swing it far):
  // those without, under "No games". Players need the % Wins minimum there too:
  // one win at a table of 5 is already +2.0, and most players have few games.
  const minGames = mode === 'pct' || (mode === 'chance' && lbTab === 'players') ? MIN_GAMES_FOR_PCT
                 : mode === 'chance' || mode === 'matchups' ? 1 : 0;   // stats-table.js
  // Matchups: each villain's counts (the lists stay for its sheet).
  if (mode === 'matchups' && data.mu) {
    _lbMu = data.mu;
    const lean  = m => m.even.filter(o => pairDelta(o.w, o.l) > MATCHUP_LEAN).length - m.even.filter(o => pairDelta(o.w, o.l) < -MATCHUP_LEAN).length;
    const count = m => m && { win: m.win.length, even: m.even.length, lose: m.lose.length, few: m.few.length, lean: lean(m) };
    rows = rows.map(r => ({ ...r, mu: count(data.mu[r.character]) }));
  }
  // Registered players who never played have no % or Δ at all: only in the
  // counts. Villains are all listed, those without games under the divider ("-").
  if ((mode === 'pct' || mode === 'chance') && lbTab === 'players') rows = rows.filter(r => r.games > 0);
  // The note explains the divider, so it shows only when someone is under it.
  const hasUnranked = rows.some(r => !statRanked(r, mode, minGames));

  const isChar  = lbTab === 'characters';
  // Only the Players tab has a "you" to highlight.
  const selfKey = isChar ? null : (getCurrentProfile()?.nickname || null);
  const limit   = isChar ? Infinity : lbDisplayLimit;
  const hasMore = rows.length > limit;

  document.getElementById('lb').innerHTML = `
    ${soloHint}
    ${statModeSegHTML(mode, 'setMode', { xp: !isChar && !solo, chance: !solo, matchups: isChar && !solo })}
    ${statModeHintHTML(mode, { minGames, picks: isChar })}
    ${mode === 'chance' ? chanceHintHTML(t('With a number of players picked, only its games count.')) : ''}
    ${mode === 'chance' && !isChar && hasUnranked ? `<p class="results-hint">${t('Ranked only with at least {n} games.', { n: minGames })}</p>` : ''}
    ${mode === 'matchups' ? `<p class="results-hint">${t('Each villain against every other: how many it clearly beats, how many are even, how many clearly beat it. Tap the numbers for the opponents.')} <button class="char-guide-link" type="button" onclick="openMatchupsInfo()">${t('How it\'s computed')} ›</button></p>
      ${hasUnranked ? `<p class="results-hint">${t('Ranked only with at least {n} matchups.', { n: MIN_MATCHUPS })}</p>` : ''}
      <p class="results-hint">${muCountsHTML({ win: t('Winning'), even: t('Even'), lose: t('Losing') })} (${t('Too few')})</p>` : ''}
    ${mode === 'xp' ? `<p class="results-hint">${t('XP for every game where you claimed your villain and for the achievements.')} <button class="char-guide-link" type="button" onclick="openXpTable()">${t('XP table')} ›</button></p>` : ''}
    ${renderStatTableHTML(rows, {
      mode,
      headLabel:   isChar ? t('Villain') : t('Player'),
      getName:     key => isChar ? villainName(key) : key,
      getNameHTML: isChar ? villainNameInline : undefined,
      limit,
      selfKey,
      minGames,
      valAction:   mode === 'matchups' ? 'openMatchups' : undefined,
      getKey:      r   => isChar ? r.character : r.nickname,
      getHref:     key => isChar
        ? `villains.html?vil=${encodeURIComponent(key)}`
        : `players.html?nick=${encodeURIComponent(key)}`,
      getIdentity: key => isChar ? charImgHTML(key) : playerAvatarHTML(lbNickAvatarMap[key]),
      getSub:      key => isChar ? lbCharBoxMap[key] : '',
      getSubHref:  key => (isChar && lbCharBoxMap[key]) ? `villains.html?box=${boxAnchorId(lbCharBoxMap[key])}` : '',
    })}
    ${hasMore ? `<button class="btn-load-more" onclick="lbLoadMore()">${t('Load more')}</button>` : ''}`;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();
