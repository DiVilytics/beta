// ── SOLO ──────────────────────────────────────────────────────────────────────
// The solo variant, unofficial: "Unofficial Instructions for Solo Play" by
// Robert Nava (v2.5.3), summarized in the FAQ (faq.html?topic=solo), its
// villain fixes included. One villain against a Phantom player (the game):
// reach the Objective within the level's turns to win. A solo game
// (games.variant 'solo') has one seat, its creator's, won (is_winner) or lost,
// a difficulty level (games.solo_level) and the rounds it took (num_turns: the
// one it was won on, or the level's last when lost).
//
// Solo games never count with the official ones: the database's statistics
// skip them, and so does fetchGamesWithPlayers (db.js). The pages show them
// only behind their own dashed Solo pill (size-filter.js, the villain page),
// with statistics computed here from all of them. Depends on db, _fetchAllRows
// (db.js), t (lang.js).

const SOLO_FAQ_HREF  = 'faq.html?topic=solo';

// The difficulty levels (games.solo_level), the solo rules' optional
// difficulty: the turns you have, and the results of the Phantom's 10-sided
// die that Fate you (1 to `fate`). Green, yellow and red wherever they show.
// Never redefine one: a recorded game keeps its meaning (a new level gets a
// new id).
const SOLO_LEVELS = {
  easy:   { turns: 25, fate: 2 },
  medium: { turns: 20, fate: 4 },   // the rules as written
  hard:   { turns: 15, fate: 6 },
};
const SOLO_LEVEL_IDS     = Object.keys(SOLO_LEVELS);
const SOLO_DEFAULT_LEVEL = 'medium';
const SOLO_DIE           = 10;

// A game's level (one recorded before the levels was medium).
const soloLevelOf = g => SOLO_LEVELS[g?.solo_level] ? g.solo_level : SOLO_DEFAULT_LEVEL;

function soloLevelName(id) {
  return { easy: t('Easy'), medium: t('Medium'), hard: t('Hard') }[id] || '';
}

// What a level means, on two lines: "20 rounds" and "Fated on 1-4/10".
function soloLevelRuleHTML(id) {
  const l = SOLO_LEVELS[id];
  return `${_esc(tn(l.turns, '{n} round', '{n} rounds'))}<br>${_esc(soloFatedOn(id))}`;
}

// "Fated on 1-4/10": the die results that Fate you, out of the die's.
const soloFatedOn = id => t('Fated on 1-{n}/{die}', { n: SOLO_LEVELS[id].fate, die: SOLO_DIE });

// The level's name, in its color (green, yellow, red).
function soloLevelTagHTML(id) {
  return `<span class="solo-level lvl-${id}">${_esc(soloLevelName(id))}</span>`;
}

// The level row under Solo (size-filter.js, the villain page): All, then the
// three levels in their colors, dashed like Solo. `onPick` is the name of the
// function that takes the picked id ('all' or a level).
function soloLevelPillsHTML(current, onPick) {
  const pill = (id, label) => `<button class="pill pill-solo${id === 'all' ? '' : ` lvl-${id}`}${current === id ? ' on' : ''}" type="button" data-level="${id}"${onPick ? ` onclick="${onPick}('${id}')"` : ''}>${_esc(label)}</button>`;
  return pill('all', t('All')) + SOLO_LEVEL_IDS.map(id => pill(id, soloLevelName(id))).join('');
}

// New Game's level picker: the switch of the draw pool (Pace | Pace+), one
// segment per level, with what the picked one means beside it.
function soloLevelSegHTML(current, onPick) {
  const btn = id => `<button class="seg-btn lvl-${id}${id === current ? ' on' : ''}" type="button" aria-pressed="${id === current}" onclick="${onPick}('${id}')">${_esc(soloLevelName(id))}</button>`;
  return `<div class="seg seg-sm solo-level-seg" role="group" aria-label="${_esc(t('Difficulty'))}">${SOLO_LEVEL_IDS.map(btn).join('')}</div>
    <span class="solo-level-rule">${soloLevelRuleHTML(current)}</span>`;
}

// A fair roll of the Phantom's 10-sided die: 1…SOLO_DIE.
function soloRollDie() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return 1 + (a[0] % SOLO_DIE);
}

// The games of one level ('all': every one).
function soloOfLevel({ games, players }, level) {
  if (!SOLO_LEVELS[level]) return { games, players };
  const kept = games.filter(g => soloLevelOf(g) === level);
  const ids  = new Set(kept.map(g => g.id));
  return { games: kept, players: players.filter(p => ids.has(p.game_id)) };
}

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

// The summary boxes' numbers: { games, avg_duration, avg_turns }. The rounds
// are those of the games won (a lost game always runs to its last round):
// how quickly the Objective is reached. `wonIds` holds their ids.
function soloSummary(games, wonIds) {
  return {
    games:        games.length,
    avg_duration: avg(games.map(g => g.duration_minutes)),
    avg_turns:    avg(games.filter(g => wonIds.has(g.id)).map(g => g.num_turns)),
  };
}

// The ids of the games won, from their seats.
const soloWonIds = players => new Set(players.filter(p => p.is_winner).map(p => p.game_id));

// What Solo is, wherever it's picked (the filters, New Game).
function soloHintHTML() {
  const [e, m, h] = SOLO_LEVEL_IDS.map(id => SOLO_LEVELS[id].turns);
  return `<p class="results-hint solo-hint">${t('Solo variant, unofficial: one villain against the game, {easy}, {medium} or {hard} turns to reach the Objective (Easy, Medium, Hard). Counted only under Solo, never with the other games.', { easy: e, medium: m, hard: h })} <a href="${SOLO_FAQ_HREF}">${t('Solo rules')} ›</a></p>`;
}
