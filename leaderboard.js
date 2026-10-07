// ── STATE ─────────────────────────────────────────────────────────────────────

let lbCharBoxMap    = {};
let lbNickAvatarMap = {};

let lbTab    = 'characters';   // 'characters' | 'players'
let lbMode   = 'pct';          // 'pct' | 'count' | 'games'
let lbFilter = 'all';          // 'all' | 2 | 3 | 4 | 5 | 6
let lbPeriod = 'all';          // 'all' (every game) | 'month' (the games of lbMonth)

// The month shown with Month on: its first day, local time. It opens on the
// current month; the menus reach back to the month of the oldest game with a
// date (lbFirstMonth, read at load).
let lbMonth = (() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); })();
let lbFirstMonth = lbMonth;

const LB_PAGE_SIZE = 35;
let lbDisplayLimit = LB_PAGE_SIZE;

// A character/player with only a couple of games can sit at 100% (or 0%) win
// rate purely by small-sample noise; in the percentage ranking they're listed
// after everyone else, unranked (raw # Wins / # Games stay unaffected, a low
// count there isn't misleading the same way). Intentionally not user-configurable.
const MIN_GAMES_FOR_PCT = 5;

// Cache: key `${lbTab}:${lbFilter}:${period}` → { rows, summary }, period being
// 'all' or the month ('2026-10'). Avoids re-fetching when only the sort lbMode
// changes, or when going back to a month already seen.
const _lbCache = {};
const _lbKey = () => `${lbTab}:${lbFilter}:${lbPeriod === 'month' ? _monthId(lbMonth) : 'all'}`;

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('leaderboard.html');
  await initAuth();

  const [chars, profiles, oldest] = await Promise.all([
    loadCharacters(),
    fetchAllProfiles(),
    db.from('games').select('played_at').not('played_at', 'is', null)
      .order('played_at', { ascending: true }).limit(1),
  ]);
  const first = oldest.data?.[0]?.played_at;
  if (first) { const d = new Date(first); lbFirstMonth = new Date(d.getFullYear(), d.getMonth(), 1); }

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
  const cached = _lbCache[_lbKey()];
  if (cached) render(cached);
}

function setFilter(f) {
  lbFilter = f;
  lbDisplayLimit = LB_PAGE_SIZE;
  updateFilterPills('#filterPills .pill', f);
  loadAndRender();
}

function setPeriod(p) {
  if (p === lbPeriod) return;
  lbPeriod = p;
  lbDisplayLimit = LB_PAGE_SIZE;
  document.querySelectorAll('#periodPills .pill').forEach(b => b.classList.toggle('on', b.dataset.period === p));
  _renderMonthSelects();
  loadAndRender();
}

function lbLoadMore() {
  lbDisplayLimit += LB_PAGE_SIZE;
  const cached = _lbCache[_lbKey()];
  if (cached) render(cached);
}

// ── MONTH ─────────────────────────────────────────────────────────────────────
// With Month on, a year and a month menu next to the pills, listing only the
// months that can have games: from the oldest dated game to the current month.

const _addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const _monthId   = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// The months (0-11) of `year` between the first month and now.
function _monthsOf(year) {
  const now  = new Date();
  const from = year === lbFirstMonth.getFullYear() ? lbFirstMonth.getMonth() : 0;
  const to   = year === now.getFullYear() ? now.getMonth() : 11;
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function _renderMonthSelects() {
  const yearSel  = document.getElementById('lbYearSel');
  const monthSel = document.getElementById('lbMonthSel');
  if (!yearSel || !monthSel) return;
  const show = lbPeriod === 'month';
  yearSel.classList.toggle('hidden', !show);
  monthSel.classList.toggle('hidden', !show);
  if (!show) return;
  const year  = lbMonth.getFullYear();
  const years = [];
  for (let y = new Date().getFullYear(); y >= lbFirstMonth.getFullYear(); y--) years.push(y);
  yearSel.innerHTML = years.map(y => `<option value="${y}"${y === year ? ' selected' : ''}>${y}</option>`).join('');
  // Three-letter names (Sep, Set), so the row fits a phone; some locales'
  // short form is longer ("Sept") or has a dot.
  monthSel.innerHTML = _monthsOf(year).map(m => {
    const name = new Date(2000, m, 1).toLocaleDateString(LOCALE, { month: 'short' }).replace('.', '').slice(0, 3);
    return `<option value="${m}"${m === lbMonth.getMonth() ? ' selected' : ''}>${_esc(name.charAt(0).toUpperCase() + name.slice(1))}</option>`;
  }).join('');
}

function _goToMonth(d) {
  lbMonth = d;
  lbDisplayLimit = LB_PAGE_SIZE;
  _renderMonthSelects();
  loadAndRender();
}

// A new year keeps the month when that year has it, else the nearest one it
// has (October 2026 → 2024: December, its only month).
function lbPickYear(year) {
  const months = _monthsOf(year);
  const m = lbMonth.getMonth();
  _goToMonth(new Date(year, Math.min(Math.max(m, months[0]), months[months.length - 1]), 1));
}

function lbPickMonth(month) { _goToMonth(new Date(lbMonth.getFullYear(), month, 1)); }

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
    const data = await (lbPeriod === 'month' ? _fetchMonth() : _fetchAllTime());
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

  return {
    rows:    lbRows,
    summary: (summary || [])[0] || { games: 0, avg_duration: null, avg_turns: null },
  };
}

// One month: the same numbers from the period_* RPCs, for games played between
// the month's first day and the next one's (local midnight). A villain or player
// is listed only if they played that month.
async function _fetchMonth() {
  const range = {
    player_count_filter: lbFilter === 'all' ? null : lbFilter,
    from_ts: lbMonth.toISOString(),
    to_ts:   _addMonths(lbMonth, 1).toISOString(),
  };
  const [stats, summary] = await Promise.all([
    db.rpc('period_leaderboard', { kind: lbTab, ...range }),
    db.rpc('period_game_stats', range),
  ]);
  if (stats.error || summary.error) return null;
  const nameKey = lbTab === 'characters' ? 'character' : 'nickname';
  return {
    rows:    (stats.data || []).map(r => ({ [nameKey]: r.name, wins: r.wins, games: r.games })),
    summary: (summary.data || [])[0] || { games: 0, avg_duration: null, avg_turns: null },
  };
}

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

  if (!rows.length) {
    // Players: there can be games with nobody signed in on them (imported ones).
    const msg = games && lbTab === 'players'
      ? t('No player has claimed a villain in these games.')
      : t('No games match this filter.');
    document.getElementById('lb').innerHTML = `<div class="empty-state">${msg}</div>`;
    return;
  }

  // % Wins only: a 1-2 game sample can sit at 100% (or 0%) purely by noise, so
  // those rows follow the ranking under a divider, unranked. # Wins / # Games
  // rank everyone, a low count there isn't misleading the same way.
  const minGames = lbMode === 'pct' ? MIN_GAMES_FOR_PCT : 0;
  // Registered players who never played have no % at all: only in the counts.
  if (lbMode === 'pct') rows = rows.filter(r => r.games > 0);
  // The note explains the divider, so it shows only when someone is under it.
  const hasUnranked = rows.some(r => r.games < minGames);

  const isChar  = lbTab === 'characters';
  // Only the Players tab has a "you" to highlight.
  const selfKey = isChar ? null : (getCurrentProfile()?.nickname || null);
  const hasMore = rows.length > lbDisplayLimit;

  document.getElementById('lb').innerHTML = `
    ${statModeSegHTML(lbMode, 'setMode')}
    ${hasUnranked ? `<p class="results-hint">${t('Ranked only with at least {n} games.', { n: minGames })}</p>` : ''}
    ${renderStatTableHTML(rows, {
      mode:        lbMode,
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
