// ── STATE ─────────────────────────────────────────────────────────────────────

let lbCharBoxMap    = {};
let lbNickAvatarMap = {};

let lbTab    = 'characters';   // 'characters' | 'players'
let lbMode   = 'pct';          // 'pct' | 'count' | 'games'
let lbFilter = 'all';          // 'all' | 2 | 3 | 4 | 5 | 6

const LB_PAGE_SIZE = 35;
let lbDisplayLimit = LB_PAGE_SIZE;

// A character/player with only a couple of games can sit at 100% (or 0%) win
// rate purely by small-sample noise; hide them from the percentage ranking
// specifically (raw # Wins / # Games stay unaffected, a low count there isn't
// misleading the same way). Intentionally not user-configurable.
const MIN_GAMES_FOR_PCT = 5;

// Cache: key `${lbTab}:${lbFilter}` → { rows, summary }
// Avoids re-fetching when only the sort lbMode changes.
const _lbCache = {};

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('leaderboard.html');
  await initAuth();

  const [chars, profiles] = await Promise.all([
    loadCharacters(),
    fetchAllProfiles(),
  ]);

  lbCharBoxMap    = Object.fromEntries(chars.map(c => [c.name, c.box]));
  lbNickAvatarMap = Object.fromEntries(
    profiles.filter(p => p.nickname).map(p => [p.nickname, resolveAvatar(p)])
  );

  await loadAndRender();
}

// ── CONTROLS ──────────────────────────────────────────────────────────────────

function setTab(t) {
  lbTab = t;
  lbDisplayLimit = LB_PAGE_SIZE;
  document.getElementById('tabChars').classList.toggle('on',   t === 'characters');
  document.getElementById('tabPlayers').classList.toggle('on', t === 'players');
  loadAndRender();
}

function setMode(m) {
  lbMode = m;
  const cached = _lbCache[`${lbTab}:${lbFilter}`];
  if (cached) render(cached);
}

function setFilter(f) {
  lbFilter = f;
  lbDisplayLimit = LB_PAGE_SIZE;
  updateFilterPills('#filterPills .pill', f);
  loadAndRender();
}

function lbLoadMore() {
  lbDisplayLimit += LB_PAGE_SIZE;
  const cached = _lbCache[`${lbTab}:${lbFilter}`];
  if (cached) render(cached);
}

// ── DATA LOADING ──────────────────────────────────────────────────────────────

async function loadAndRender() {
  const key = `${lbTab}:${lbFilter}`;

  if (!_lbCache[key]) {
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

    const [{ rows }, { data: summary }] = await Promise.all([
      _fetchAllRows(buildRows),
      db.rpc('game_stats', lbFilter === 'all' ? {} : { player_count_filter: lbFilter }),
    ]);

    let lbRows = rows;
    // Overall players board: also list registered players who've never played,
    // as 0/0/0 rows. The sort drops them below anyone who has games.
    if (lbTab === 'players' && lbFilter === 'all') {
      const present = new Set(lbRows.map(r => r.nickname));
      const missing = Object.keys(lbNickAvatarMap).filter(n => !present.has(n));
      lbRows = lbRows.concat(missing.map(nickname => ({ nickname, wins: 0, games: 0 })));
    }

    _lbCache[key] = {
      rows:    lbRows,
      summary: (summary || [])[0] || { games: 0, avg_duration: null, avg_turns: null },
    };
  }

  document.getElementById('lb').className = '';
  render(_lbCache[key]);
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function render({ rows, summary }) {
  const { games, avg_duration, avg_turns } = summary;
  const avgDur   = avg_duration != null ? Math.round(avg_duration) : null;
  const avgTurns = avg_turns    != null ? Math.round(avg_turns)    : null;

  document.getElementById('summary').innerHTML = statBoxesHTML([
    { val: games,                                  lbl: 'Games' },
    { val: avgDur   != null ? avgDur + 'm' : '-',  lbl: 'Avg duration' },
    { val: avgTurns != null ? avgTurns      : '-', lbl: 'Avg rounds' },
  ]);

  if (!rows.length) {
    document.getElementById('lb').innerHTML =
      `<div class="empty-state">No games match this filter.</div>`;
    return;
  }

  // % Wins ranking only: a 1-2 game sample can sit at 100% (or 0%) purely by
  // noise, so it's excluded from that specific ranking. # Wins / # Games stay
  // unaffected, a low count there isn't misleading the same way.
  const rankRows = lbMode === 'pct' ? rows.filter(r => r.games >= MIN_GAMES_FOR_PCT) : rows;
  if (!rankRows.length) {
    document.getElementById('lb').innerHTML = `
      ${statModeSegHTML(lbMode, 'setMode')}
      <div class="empty-state">Nobody has played at least ${MIN_GAMES_FOR_PCT} games yet.</div>`;
    return;
  }

  const isChar  = lbTab === 'characters';
  // Only the Players tab has a "you" to highlight.
  const selfKey = isChar ? null : (getCurrentProfile()?.nickname || null);
  const hasMore = rankRows.length > lbDisplayLimit;

  document.getElementById('lb').innerHTML = `
    ${statModeSegHTML(lbMode, 'setMode')}
    ${renderStatTableHTML(rankRows, {
      mode:        lbMode,
      headLabel:   isChar ? 'Villain' : 'Player',
      limit:       lbDisplayLimit,
      selfKey,
      getKey:      r   => isChar ? r.character : r.nickname,
      getHref:     key => isChar
        ? `villains.html?vil=${encodeURIComponent(key)}`
        : `players.html?nick=${encodeURIComponent(key)}`,
      getIdentity: key => isChar ? charImgHTML(key) : playerAvatarHTML(lbNickAvatarMap[key]),
      getSub:      key => isChar ? lbCharBoxMap[key] : '',
      getSubHref:  key => (isChar && lbCharBoxMap[key]) ? `villains.html?box=${boxAnchorId(lbCharBoxMap[key])}` : '',
    })}
    ${hasMore ? `<button class="btn-load-more" onclick="lbLoadMore()">Load more</button>` : ''}`;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();
