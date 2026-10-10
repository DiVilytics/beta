// ── SOLO ──────────────────────────────────────────────────────────────────────
// The solo variant, unofficial: "Unofficial Instructions for Solo Play" by
// Robert Nava (v2.5.3), summarized in the FAQ (faq.html?topic=solo), its
// villain fixes included. One villain against a Phantom player (the game):
// reach the Objective within 20 turns to win. A solo game (games.variant
// 'solo') has one seat, its creator's, won (is_winner) or lost.
//
// Solo games never count with the official ones: the database's statistics
// skip them, and so does fetchGamesWithPlayers (db.js). The pages show them
// only behind their own dashed Solo pill (size-filter.js, the villain page),
// with statistics computed here from all of them. Depends on db, _fetchAllRows
// (db.js), t (lang.js).

const SOLO_MAX_TURNS = 20;
const SOLO_FAQ_HREF  = 'faq.html?topic=solo';

let _soloGames = null;

// Every solo game with its seat, as { games, players } (fetchGamesWithPlayers'
// shape), newest first and undated last; null if it couldn't load (the next
// call tries again).
function loadSoloGames() {
  return _soloGames ||= (async () => {
    const { rows, error } = await _fetchAllRows(() => db.from('games')
      .select('*, game_players(*)')
      .eq('variant', 'solo')
      .order('played_at', { ascending: false, nullsFirst: false })
      .order('id'));
    if (error) return null;
    return {
      games:   rows.map(({ game_players, ...g }) => g),
      players: rows.flatMap(g => g.game_players || []),
    };
  })().then(s => { if (!s) _soloGames = null; return s; });
}

// The ones played in a period ({ from_ts, to_ts }, period-filter.js; both null
// for All time).
function soloInPeriod({ games, players }, { from_ts, to_ts }) {
  if (!from_ts) return { games, players };
  const from = new Date(from_ts), to = new Date(to_ts);
  const kept = games.filter(g => g.played_at && new Date(g.played_at) >= from && new Date(g.played_at) < to);
  const ids  = new Set(kept.map(g => g.id));
  return { games: kept, players: players.filter(p => ids.has(p.game_id)) };
}

// A ranking's rows, [{ [key]: name, games, wins }], by villain (key
// 'character') or by player ('nickname'); seats without a name are left out.
function soloRankRows(players, key) {
  const by = {};
  for (const p of players) {
    if (!p[key]) continue;
    const r = by[p[key]] ||= { [key]: p[key], games: 0, wins: 0 };
    r.games++;
    if (p.is_winner) r.wins++;
  }
  return Object.values(by);
}

// The summary boxes' numbers: { games, avg_duration, avg_turns }.
function soloSummary(games) {
  return {
    games:        games.length,
    avg_duration: avg(games.map(g => g.duration_minutes)),
    avg_turns:    avg(games.map(g => g.num_turns)),
  };
}

// What Solo is, wherever it's picked (the filters, New Game).
function soloHintHTML() {
  return `<p class="results-hint solo-hint">${t('Solo variant, unofficial: one villain against the game, {n} turns to reach the Objective. Counted only under Solo, never with the other games.', { n: SOLO_MAX_TURNS })} <a href="${SOLO_FAQ_HREF}">${t('Solo rules')} ›</a></p>`;
}
