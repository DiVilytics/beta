// ── STATE ─────────────────────────────────────────────────────────────────────

let lbChars         = [];
let lbCharBoxMap    = {};
let lbNickAvatarMap = {};

let lbTab    = 'characters';   // 'characters' | 'players'
let lbMode   = 'pct';          // 'pct' | 'count' | 'games', or 'xp' (players only)

// Each tab keeps its own ranking: villains open on % Wins, players on XP.
const _lbModeByTab = { characters: 'pct', players: 'xp' };

// The table size, All / 2p…6p / Solo (size-filter.js), and the period, All
// time / Year / Month (period-filter.js): any change reloads. Solo ranks the
// solo games only (solo.js), never with the others.
const size = createSizeFilter('lbSize', {
  onChange: () => { lbDisplayLimit = LB_PAGE_SIZE; loadAndRender(); },
});
const period = createPeriodFilter('lbPeriod', {
  onChange: () => { lbDisplayLimit = LB_PAGE_SIZE; loadAndRender(); },
});

const LB_PAGE_SIZE = 35;
let lbDisplayLimit = LB_PAGE_SIZE;

// A character/player with only a couple of games can sit at 100% (or 0%) win
// rate purely by small-sample noise; in the percentage ranking they're listed
// after everyone else, unranked (raw # Wins / # Games stay unaffected, a low
// count there isn't misleading the same way). Intentionally not user-configurable.
const MIN_GAMES_FOR_PCT = 5;

// Cache: key `${lbTab}:${size}:${period.id()}` → { rows, summary }. Avoids
// re-fetching when only the sort lbMode changes, or when going back to a
// period already seen.
const _lbCache = {};
const _lbKey = () => `${lbTab}:${size.value()}:${period.id()}`;

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
    period.set(saved.period);
    lbDisplayLimit = saved.limit || LB_PAGE_SIZE;
  }
  keepViewState(() => ({
    tab: lbTab, modes: { ..._lbModeByTab, [lbTab]: lbMode },
    filter: size.value(), period: period.get(), limit: lbDisplayLimit,
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
  if (cached) render(cached);
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
      lb.innerHTML = `<div class="empty-state">${t("Couldn't load the leaderboard.")}</div>`;
      return;
    }
    _lbCache[key] = data;
  }

  // Also clears the dimming an older, overtaken fetch left on.
  summary.className = 'summary';
  lb.className = '';
  render(_lbCache[key]);
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

  const [{ rows }, { data: summary }, xp] = await Promise.all([
    _fetchAllRows(buildRows),
    db.rpc('game_stats', lbFilter === 'all' ? {} : { player_count_filter: lbFilter }),
    _fetchXp(),
  ]);
  if (xp === null) return null;

  let lbRows = rows;
  // Overall players board: also list registered players who've never played,
  // as 0/0/0 rows. The sort drops them below anyone who has games.
  if (lbTab === 'players' && lbFilter === 'all') {
    const present = new Set(lbRows.map(r => r.nickname));
    const missing = Object.keys(lbNickAvatarMap).filter(n => !present.has(n));
    lbRows = lbRows.concat(missing.map(nickname => ({ nickname, wins: 0, games: 0 })));
  }

  return {
    rows:    _addXp(lbRows, xp),
    summary: (summary || [])[0] || { games: 0, avg_duration: null, avg_turns: null },
  };
}

// A year or a month: the same numbers from the period_* RPCs, for the games
// played in it. A villain or player is listed only if they played then.
async function _fetchPeriod() {
  const lbFilter = size.value();
  const range = { player_count_filter: lbFilter === 'all' ? null : lbFilter, ...period.range() };
  const [stats, summary, xp] = await Promise.all([
    db.rpc('period_leaderboard', { kind: lbTab, ...range }),
    db.rpc('period_game_stats', range),
    _fetchXp(),
  ]);
  if (stats.error || summary.error || xp === null) return null;
  const nameKey = lbTab === 'characters' ? 'character' : 'nickname';
  return {
    rows:    _addXp((stats.data || []).map(r => ({ [nameKey]: r.name, wins: r.wins, games: r.games })), xp),
    summary: (summary.data || [])[0] || { games: 0, avg_duration: null, avg_turns: null },
  };
}

// Solo: the same numbers from the solo games of the period (solo.js), no XP.
async function _fetchSolo() {
  const solo = await loadSoloGames();
  if (!solo) return null;
  const { games, players } = soloInPeriod(solo, period.range());
  return {
    rows:    soloRankRows(players, lbTab === 'characters' ? 'character' : 'nickname'),
    summary: soloSummary(games),
  };
}

// ── XP ────────────────────────────────────────────────────────────────────────
// Every game a player claimed a villain in earns them XP: 1 for each other
// player who claimed one in that game, 2 if they won (so a loss is worth
// claiming when the others claim too, and a game claimed alone gives none);
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
        const others = claims(p.game_id) - 1;
        return { at: gameById[p.game_id]?.played_at || null, size: seats[p.game_id].length, xp: others * (p.is_winner ? 2 : 1) + ach, ach };
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

// ── RENDER ────────────────────────────────────────────────────────────────────

function render({ rows, summary }) {
  const { games, avg_duration, avg_turns } = summary;
  const avgDur   = avg_duration != null ? Math.round(avg_duration) : null;
  const avgTurns = avg_turns    != null ? Math.round(avg_turns)    : null;

  document.getElementById('summary').innerHTML = statBoxesHTML([
    { val: games,                                  lbl: t('Games') },
    { val: avgDur   != null ? avgDur + 'm' : '-',  lbl: t('Avg duration') },
    { val: avgTurns != null ? avgTurns      : '-', lbl: t('Avg rounds') },
  ]);

  // Solo: what it is, above its own ranking (which has no XP: % Wins instead).
  const solo     = size.isSolo();
  const soloHint = solo ? soloHintHTML() : '';
  const mode     = solo && lbMode === 'xp' ? 'pct' : lbMode;

  if (!rows.length) {
    // Players: there can be games with nobody signed in on them (imported ones).
    const msg = games && lbTab === 'players'
      ? t('No player has claimed a villain in these games.')
      : t('No games match this filter.');
    document.getElementById('lb').innerHTML = `${soloHint}<div class="empty-state">${msg}</div>`;
    return;
  }

  // % Wins only: a 1-2 game sample can sit at 100% (or 0%) purely by noise, so
  // those rows follow the ranking under a divider, unranked. # Wins / # Games
  // rank everyone, a low count there isn't misleading the same way.
  const minGames = mode === 'pct' ? MIN_GAMES_FOR_PCT : 0;
  // Registered players who never played have no % at all: only in the counts.
  if (mode === 'pct') rows = rows.filter(r => r.games > 0);
  // The note explains the divider, so it shows only when someone is under it.
  const hasUnranked = rows.some(r => r.games < minGames);

  const isChar  = lbTab === 'characters';
  // Only the Players tab has a "you" to highlight.
  const selfKey = isChar ? null : (getCurrentProfile()?.nickname || null);
  const hasMore = rows.length > lbDisplayLimit;

  document.getElementById('lb').innerHTML = `
    ${soloHint}
    ${statModeSegHTML(mode, 'setMode', { xp: !isChar && !solo })}
    ${hasUnranked ? `<p class="results-hint">${t('Ranked only with at least {n} games.', { n: minGames })}</p>` : ''}
    ${mode === 'xp' ? `<p class="results-hint">${t('For every game where you claimed your villain: 1 XP for each other player who claimed theirs, doubled if you won. Plus 1 for each achievement.')}</p>` : ''}
    ${renderStatTableHTML(rows, {
      mode,
      headLabel:   isChar ? t('Villain') : t('Player'),
      getName:     key => isChar ? villainName(key) : key,
      getNameHTML: isChar ? villainNameInline : undefined,
      limit:       lbDisplayLimit,
      selfKey,
      minGames,
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
