// ── TOURNAMENT RULES ──────────────────────────────────────────────────────────
// The rules of a tournament (tournaments.js), each kind a registry keyed by the
// id the database stores (tournaments.pairing, tournaments.scoring): a new
// option is one entry here plus its translations, no database change. The
// database keeps the facts (who sat where, with which villain, in which place)
// and checks every draw; points and standings are computed here from the facts.
// Draws use the browser's cryptographic random source (as the solo die does).
// Depends on t (lang.js) and LOCALE (lang.js).
//
//   TOURNAMENT_PAIRINGS[id]       { name, hint, tables(players, ctx) }: the
//                                 stage's tables, [[playerId, ...], ...]
//   TOURNAMENT_SCORINGS[id]       { name, hint, points(place, n, size, seat) }
//   TOURNAMENT_VILLAIN_DRAWS[id]  { schedule(playerIds, pool, stages) }: every
//                                 player's villain in every stage
//   TOURNAMENT_TIEBREAKS          [{ id, name, value(row) }], in order
//
//   tournamentSplit(n, size)                 the table sizes of a stage
//   tournamentStandings(tour, tables, opts)  the ranking, from saved tables
//   tournamentDrawStage(tour, players, tables)  the next stage's tables, play
//                                            order included (start: no tables)
//   tournamentVillainSchedule(tour, ids)     the villains of every stage
//   fmtTournamentPoints(p)                   "1.5" / "1,5"
//
// A tour is a tournaments row ({ table_size, stages, pairing, scoring,
// villain_pool }); a table is { stage, saved_at, seats: [{ player_id,
// position, character, place, minutes, round, dropped }] }; a player is a
// tournament_players row ({ id, name, user_id, withdrawn_after }): players are
// their ids here, claimed or not.

// ── Random ───────────────────────────────────────────────────────────────────

function _tnRandInt(n) {
  // Uniform in 0…n-1, without the modulo bias.
  const max = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= max);
  return buf[0] % n;
}

function _tnShuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = _tnRandInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Table sizes ──────────────────────────────────────────────────────────────

// As few tables as the size allows, as even as possible, largest first: 14 at
// 4 → 4, 4, 3, 3; 5 at 4 → 3, 2. Only tables of 2 can leave one player alone
// (an odd number of players): a bye, last.
function tournamentSplit(n, size) {
  if (n < 1) return [];
  const k = Math.ceil(n / size);
  const base = Math.floor(n / k), extra = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

// Cuts an ordered list of players into tables of the split's sizes.
function _tnCut(players, size) {
  const out = [];
  let i = 0;
  for (const s of tournamentSplit(players.length, size)) { out.push(players.slice(i, i + s)); i += s; }
  return out;
}

// ── History ──────────────────────────────────────────────────────────────────

// Who met whom (how many times) and who had a bye, over the given tables.
function _tnHistory(tables) {
  const met = new Map(), byes = new Map();
  for (const tb of tables) {
    const ids = tb.seats.map(s => s.player_id);
    if (ids.length === 1) byes.set(ids[0], (byes.get(ids[0]) || 0) + 1);
    for (const a of ids) {
      if (!met.has(a)) met.set(a, new Map());
      for (const b of ids) if (a !== b) met.get(a).set(b, (met.get(a).get(b) || 0) + 1);
    }
  }
  return { met, byes };
}

// How many pairs at the same table already met (each meeting counted).
function _tnRematches(table, met) {
  let n = 0;
  for (let i = 0; i < table.length; i++)
    for (let j = i + 1; j < table.length; j++) n += met.get(table[i])?.get(table[j]) || 0;
  return n;
}

// A bye goes to a player with the fewest byes so far: if the one at the bye
// table already had more, they swap with the last such player before them.
function _tnFairBye(tables, byes) {
  const last = tables[tables.length - 1];
  if (!last || last.length !== 1) return tables;
  const fewest = Math.min(...tables.flat().map(u => byes.get(u) || 0));
  if ((byes.get(last[0]) || 0) === fewest) return tables;
  for (let ti = tables.length - 2; ti >= 0; ti--) {
    for (let si = tables[ti].length - 1; si >= 0; si--) {
      const u = tables[ti][si];
      if ((byes.get(u) || 0) === fewest) {
        tables[ti][si] = last[0];
        last[0] = u;
        return tables;
      }
    }
  }
  return tables;
}

// ── Pairing ──────────────────────────────────────────────────────────────────
// tables(players, ctx): players are the ids of those still playing; ctx is
// { size, stage (the one being drawn), standings (tournamentStandings rows),
// met, byes }. Returns the tables, play order not yet drawn.

const TOURNAMENT_PAIRINGS = {
  random: {
    name: 'Random',
    hint: 'New random tables every stage.',
    tables(players, { size, byes }) {
      return _tnFairBye(_tnCut(_tnShuffle(players), size), byes);
    },
  },
  swiss: {
    name: 'Swiss',
    hint: 'Stage 1 at random, then players with similar points at the same table, avoiding rematches where possible.',
    tables(players, ctx) {
      if (ctx.stage === 1) return TOURNAMENT_PAIRINGS.random.tables(players, ctx);
      // By standing, ties in random order: the leaders together.
      const rank = new Map(ctx.standings.map(r => [r.player_id, r.rank]));
      const order = _tnShuffle(players).sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
      const tables = _tnFairBye(_tnCut(order, ctx.size), ctx.byes);
      // Then swaps between neighboring tables while they cut the rematches.
      for (let pass = 0, better = true; better && pass < 20; pass++) {
        better = false;
        for (let ti = 0; ti + 1 < tables.length; ti++) {
          const A = tables[ti], B = tables[ti + 1];
          if (A.length === 1 || B.length === 1) continue;   // the bye stays put
          for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
            const before = _tnRematches(A, ctx.met) + _tnRematches(B, ctx.met);
            [A[i], B[j]] = [B[j], A[i]];
            if (_tnRematches(A, ctx.met) + _tnRematches(B, ctx.met) < before) better = true;
            else [A[i], B[j]] = [B[j], A[i]];
          }
        }
      }
      return tables;
    },
  },
};

// ── Scoring ──────────────────────────────────────────────────────────────────
// points(place, n, size, seat): what place (1 = first) at a table of n
// players scores, size being the tournament's largest table; n = 1 is a bye.
// seat.dropped: the place was a drop (the last free one when they left).

const TOURNAMENT_SCORINGS = {
  borda: {
    name: 'Borda count',
    hint: 'At a table of n players, 1st scores n - 1, 2nd n - 2, down to 0 for last; a smaller table scales to the largest, so its 1st scores the same. A drop scores its place; a bye counts as last: 0.',
    points(place, n, size) {
      if (n === 1) return 0;   // a bye: last
      return (n - place) / (n - 1) * (size - 1);
    },
  },
};

// ── Villains ─────────────────────────────────────────────────────────────────

const TOURNAMENT_VILLAIN_DRAWS = {
  // Every stage all different, and a player never gets a villain twice while
  // the pool allows it (more stages than villains: everyone plays every
  // villain once before any repeats). A random Latin rectangle: villain(player,
  // stage) = pool[(r_player + c_stage) mod V], the pool shuffled, r different
  // for every player, c a random permutation of 0…V-1 for every V stages.
  'no-repeat': {
    schedule(ids, pool, stages) {
      const V = pool.length;
      const sym = _tnShuffle(pool);
      const r = _tnShuffle([...Array(V).keys()]).slice(0, ids.length);
      const c = [];
      while (c.length < stages) c.push(..._tnShuffle([...Array(V).keys()]));
      return ids.flatMap((id, i) => Array.from({ length: stages }, (_, s) =>
        ({ stage: s + 1, player_id: id, character: sym[(r[i] + c[s]) % V] })));
    },
  },
};
const TOURNAMENT_VILLAIN_DRAW = 'no-repeat';

// ── Standings ────────────────────────────────────────────────────────────────

// In order, after the points: most 1st places, then the opponents' points
// (the sum of the points of every opponent faced, once per time faced).
const TOURNAMENT_TIEBREAKS = [
  { id: 'firsts',    name: '1st places',        value: r => r.firsts },
  { id: 'opponents', name: "Opponents' points", value: r => r.opponents },
];

// The ranking from the saved tables (up to opts.stage, if given), one row per
// player: { player_id, points, firsts, played, byes, opponents, rank } with
// rank shared by rows equal on points and every tiebreak (1, 1, 3).
function tournamentStandings(tour, tables, { players = [], stage = Infinity } = {}) {
  const scoring = TOURNAMENT_SCORINGS[tour.scoring] || TOURNAMENT_SCORINGS.borda;
  const rows = new Map();
  const row = id => {
    if (!rows.has(id)) rows.set(id, { player_id: id, points: 0, firsts: 0, played: 0, byes: 0, opponents: 0, faced: [] });
    return rows.get(id);
  };
  for (const p of players) row(p.id);
  const counted = tables.filter(tb => tb.saved_at && tb.stage <= stage);
  for (const tb of counted) {
    const n = tb.seats.length;
    for (const s of tb.seats) {
      if (s.place == null) continue;
      const r = row(s.player_id);
      r.points += scoring.points(s.place, n, tour.table_size, s);
      if (n === 1) { r.byes++; continue; }
      r.played++;
      if (s.place === 1) r.firsts++;
      for (const o of tb.seats) if (o.player_id !== s.player_id) r.faced.push(o.player_id);
    }
  }
  for (const r of rows.values()) r.opponents = r.faced.reduce((sum, id) => sum + (rows.get(id)?.points || 0), 0);

  const keys = [r => r.points, ...TOURNAMENT_TIEBREAKS.map(tb => tb.value)];
  const cmp = (a, b) => {
    for (const k of keys) { const d = k(b) - k(a); if (Math.abs(d) > 1e-9) return d; }
    return 0;
  };
  const sorted = [...rows.values()].sort(cmp);
  sorted.forEach((r, i) => { r.rank = i && cmp(sorted[i - 1], r) === 0 ? sorted[i - 1].rank : i + 1; delete r.faced; });
  return sorted;
}

// ── Draws ────────────────────────────────────────────────────────────────────

// The next stage's tables, each in its play order (drawn at random): the
// players still playing, paired by the tournament's rule.
function tournamentDrawStage(tour, players, tables = []) {
  const pairing = TOURNAMENT_PAIRINGS[tour.pairing] || TOURNAMENT_PAIRINGS.random;
  const playing = players.filter(p => p.withdrawn_after == null).map(p => p.id);
  const { met, byes } = _tnHistory(tables.filter(tb => tb.saved_at));
  const stage = Math.max(0, ...tables.map(tb => tb.stage)) + 1;
  const standings = tournamentStandings(tour, tables, { players });
  return pairing.tables(playing, { size: tour.table_size, stage, standings, met, byes })
    .map(tb => _tnShuffle(tb));
}

// Every player's villain in every stage, for Start.
function tournamentVillainSchedule(tour, ids) {
  return TOURNAMENT_VILLAIN_DRAWS[TOURNAMENT_VILLAIN_DRAW].schedule(ids, tour.villain_pool, tour.stages);
}

// Points as shown: up to two decimals, in the page's language (1.5, 1,5).
function fmtTournamentPoints(p) {
  return (Math.round(p * 100) / 100).toLocaleString(LOCALE, { maximumFractionDigits: 2 });
}
