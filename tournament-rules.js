// ── TOURNAMENT RULES ──────────────────────────────────────────────────────────
// The rules of a tournament (tournaments.js), each kind a registry keyed by the
// id the database stores (tournaments.table_split, .pairing, .scoring, .bye,
// .play_order): a new
// option is one entry here plus its translations, no database change. The
// database keeps the facts (who sat where, with which villain, in which place)
// and checks every draw; points and standings are computed here from the facts.
// Draws use the browser's cryptographic random source (as the solo die does).
// Depends on t (lang.js) and LOCALE (lang.js).
//
//   TOURNAMENT_SPLITS[id]         { name, hint, sizes(n, size) }: the table
//                                 sizes of a stage (1 = a bye)
//   TOURNAMENT_PAIRINGS[id]       { name, hint, tables(players, ctx) }: the
//                                 stage's tables, [[playerId, ...], ...]
//   TOURNAMENT_SCORINGS[id]       { name, hint, points(place, n, size, seat, tour) }
//   TOURNAMENT_BYES[id]           { name, hint, points(win) }: a bye's points
//   TOURNAMENT_PLAY_ORDERS[id]    { name, hint, order(table, ctx) }
//   TOURNAMENT_VILLAIN_DRAWS[id]  { schedule(playerIds, pool, stages) }: every
//                                 player's villain in every stage
//   TOURNAMENT_TIEBREAKS          [{ id, name, value(row) }], in order
//
//   tournamentSplit(n, size, split)          the table sizes of a stage
//   tournamentStandings(tour, tables, opts)  the ranking, from saved tables
//   tournamentDrawStage(tour, players, tables)  the next stage's tables, play
//                                            order included (start: no tables)
//   tournamentVillainSchedule(tour, ids)     the villains of every stage
//   tournamentDrawFinal(tour, players, tables) the final table, when there is one
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
// sizes(n, size): the tables of a stage for n players, largest first, a bye
// (a table of 1) last.

const TOURNAMENT_SPLITS = {
  // As few tables as the size allows, as balanced as possible: 14 at 4 → 4, 4, 3,
  // 3; 5 at 4 → 3, 2. Only tables of 2 can leave one player alone (a bye).
  even: {
    name: 'Balanced',
    hint: 'As many tables as needed, as balanced as possible (9 players at tables of 4: 3, 3, 3).',
    sizes(n, size) {
      const k = Math.ceil(n / size);
      const base = Math.floor(n / k), extra = n % k;
      return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
    },
  },
  // Every table full; whoever is left has a bye (9 at 4 → 4, 4 and a bye; up
  // to size - 1 byes). Fewer players than a table: they all play together.
  full: {
    name: 'Full',
    hint: 'Every table full, the players left over have a bye (9 players at tables of 4: 4, 4 and a bye).',
    sizes(n, size) {
      const k = Math.floor(n / size);
      if (!k) return [n];
      return [...Array(k).fill(size), ...Array(n % size).fill(1)];
    },
  },
};

function tournamentSplit(n, size, split = 'even') {
  if (n < 1) return [];
  return (TOURNAMENT_SPLITS[split] || TOURNAMENT_SPLITS.even).sizes(n, size);
}

// Seats the players, given in pairing order (best first), at the stage's
// tables: the byes first go to whoever had the fewest so far (the last in the
// order among them), then the others fill the tables in order.
function _tnSeat(order, { size, split, byes }) {
  const sizes = tournamentSplit(order.length, size, split);
  const byeCount = sizes.filter(x => x === 1).length;
  const sitOut = order.map((id, i) => ({ id, i, b: byes.get(id) || 0 }))
    .sort((a, b) => a.b - b.b || b.i - a.i).slice(0, byeCount).map(x => x.id);
  const rest = order.filter(id => !sitOut.includes(id));
  const tables = [];
  let i = 0;
  for (const n of sizes.filter(x => x > 1)) { tables.push(rest.slice(i, i + n)); i += n; }
  return [...tables, ...sitOut.map(id => [id])];
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


// ── Pairing ──────────────────────────────────────────────────────────────────
// tables(players, ctx): players are the ids of those still playing; ctx is
// { size, split, stage (the one being drawn), standings (tournamentStandings
// rows), met, byes }. Returns the tables, play order not yet drawn.

const TOURNAMENT_PAIRINGS = {
  random: {
    name: 'Random',
    hint: 'New random tables every stage.',
    tables(players, ctx) {
      return _tnSeat(_tnShuffle(players), ctx);
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
      const tables = _tnSeat(order, ctx);
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
// points(place, n, size, seat, tour): what place (1 = first) at a table of n
// players scores (n ≥ 2), size being the tournament's largest table.
// seat.dropped: the place was a drop (the last free one when they left). A
// bye (n = 1) is TOURNAMENT_BYES' (tournamentSeatPoints).

const TOURNAMENT_SCORINGS = {
  borda: {
    name: 'Borda count',
    hint: '1st scores the most, then one point less per place, down to 0 for last; a smaller table scales to the largest.',
    points(place, n, size) {
      return (n - place) / (n - 1) * (size - 1);
    },
  },
  // The organizer's points for each place at every table size (custom_points,
  // tournamentCustomRows).
  custom: {
    name: 'Custom',
    hint: 'Your points for each place, at every table size.',
    points(place, n, size, seat, tour) {
      const row = tournamentCustomRows(tour)[n];
      return row ? row[place - 1] : 0;
    },
  },
};

// Custom scoring, the smaller tables' rows filled from the largest table's:
// 'ends' keeps 1st's and last's points and spreads the places in between
// along the row (5 3 1 0 at 4 → 5 2 0 at 3, 5 0 at 2); 'average' keeps the
// average, each place scoring the average of the largest table's places it
// stands for (5 3 1 0 → 4.5 2 0.25 at 3, 4 0.5 at 2).
const TOURNAMENT_CUSTOM_FILLS = {
  ends: {
    name: 'Same win',
    row(top, n) {
      return Array.from({ length: n }, (_, i) => {
        const at = i / (n - 1) * (top.length - 1), lo = Math.floor(at), hi = Math.ceil(at);
        return top[lo] + (at - lo) * (top[hi] - top[lo]);
      });
    },
  },
  average: {
    name: 'Same average',
    row(top, n) {
      const span = top.length / n;
      return Array.from({ length: n }, (_, i) => {
        let sum = 0;
        top.forEach((v, j) => { sum += v * Math.max(0, Math.min(j + 1, (i + 1) * span) - Math.max(j, i * span)); });
        return sum / span;
      });
    },
  },
};

// A filled row, rounded to hundredths (what the form shows and saves).
function tournamentCustomFill(top, n, fill) {
  return (TOURNAMENT_CUSTOM_FILLS[fill] || TOURNAMENT_CUSTOM_FILLS.ends).row(top, n).map(v => Math.round(v * 100) / 100);
}

// custom_points: the rows one after the other, the largest table's first,
// then one player fewer each, down to 2 (at 4: 4 + 3 + 2 numbers), 1st first
// in each. Only the largest table's row (the tournaments before 2026-10-15):
// the others keep 1st and last. → { n: row }
function tournamentCustomRows(tour) {
  const flat = (tour?.custom_points || []).map(Number), size = tour?.table_size || flat.length;
  const rows = {};
  if (flat.length < 2) return rows;
  if (flat.length === size) {
    for (let n = size; n >= 2; n--) rows[n] = n === size ? flat : TOURNAMENT_CUSTOM_FILLS.ends.row(flat, n);
    return rows;
  }
  let at = 0;
  for (let n = size; n >= 2; n--) { rows[n] = flat.slice(at, at + n); at += n; }
  return rows;
}

// A table's points, 1st to last (the form's preview of a custom scoring).
function tournamentPointsRow(tour, n) {
  const scoring = TOURNAMENT_SCORINGS[tour.scoring] || TOURNAMENT_SCORINGS.borda;
  return Array.from({ length: n }, (_, i) => scoring.points(i + 1, n, tour.table_size, {}, tour));
}

// What a bye scores, a win being what 1st scores at a full table. Never a 1st
// place for the tiebreaks.
const TOURNAMENT_BYES = {
  last: { name: 'Last',     hint: 'A bye counts as last place.',  points: win => 0 },
  half: { name: 'Half a win', hint: 'A bye scores half of what a win does.', points: win => win / 2 },
  win:  { name: 'A win',    hint: 'A bye scores what a win does (as in Swiss chess).', points: win => win },
};

// What a seat scored: its place at its table (n players), or the bye's.
function tournamentSeatPoints(tour, n, seat) {
  const scoring = TOURNAMENT_SCORINGS[tour.scoring] || TOURNAMENT_SCORINGS.borda;
  if (n === 1) {
    const win = scoring.points(1, tour.table_size, tour.table_size, {}, tour);
    return (TOURNAMENT_BYES[tour.bye] || TOURNAMENT_BYES.last).points(win);
  }
  return scoring.points(seat.place, n, tour.table_size, seat, tour);
}

// ── Play order ───────────────────────────────────────────────────────────────
// order(table, ctx): a table's players in their play order; ctx.seats maps a
// player to where they sat so far (0 = first, 1 = last, at any table size),
// ctx.size is the largest table.

const TOURNAMENT_PLAY_ORDERS = {
  random: {
    name: 'Random',
    hint: 'A new random play order at every table.',
    order: table => _tnShuffle(table),
  },
  // Every seat in turn: of all a table's orders (up to 720), the one where the
  // players sit least where they already sat (each repeat counts); among those,
  // the one where whoever sat later so far, on average, plays earlier. Seats
  // compare across table sizes by where they fall between first and last.
  rotation: {
    name: 'Rotation',
    hint: 'Everyone takes turns at every seat: the order with the fewest players back in a seat they already had.',
    order(table, { seats, size }) {
      const n = table.length;
      if (n < 2) return table;
      const bucket = x => Math.round(x * (size - 1));   // 0 (first) … size - 1 (last)
      const sat = id => (seats.get(id) || []).map(bucket);
      const avg = id => { const l = seats.get(id) || []; return l.length ? l.reduce((a, b) => a + b) / l.length : 0.5; };
      const repeats = order => order.reduce((sum, id, i) => sum + sat(id).filter(b => b === bucket(i / (n - 1))).length, 0);
      // How far each sits from the opposite of their average so far.
      const spread  = order => order.reduce((sum, id, i) => sum + (i / (n - 1) - (1 - avg(id))) ** 2, 0);
      let best = null, bestCost = Infinity, bestSpread = Infinity;
      const permute = (done, rest) => {
        if (!rest.length) {
          const c = repeats(done), d = spread(done);
          if (c < bestCost || (c === bestCost && d < bestSpread - 1e-9)) { best = done; bestCost = c; bestSpread = d; }
          return;
        }
        rest.forEach((id, i) => permute([...done, id], [...rest.slice(0, i), ...rest.slice(i + 1)]));
      };
      permute([], _tnShuffle(table));   // ties: the first found, at random
      return best;
    },
  },
};

// ── Database answers ─────────────────────────────────────────────────────────
// The tournament functions' error codes, shown by both tournament pages.
const TN_ERRORS = {
  not_organizer:          'Only the organizer can do this.',
  already_started:        'The tournament has already started.',
  too_few_players:        'A tournament needs at least 2 players.',
  invalid_pool:           'The draw pool needs at least as many villains as there are players.',
  invalid_villains:       "The villains couldn't be drawn. Try again.",
  invalid_tables:         "The tables couldn't be drawn. Try again.",
  name_claimed:           'Someone else just claimed this name.',
  already_in_tournament:  'You already have a name in this tournament.',
  no_profile:             'You need a nickname first.',
  not_your_name:          "This name isn't yours to release.",
  not_running:            "The tournament isn't running.",
  stage_not_done:         'Every table of this stage has to be saved first.',
  table_not_saved:        'Only a saved table can be edited.',
  not_at_table:           'Only the players at this table who claimed their name, or the organizer, can record it.',
  table_taken:            'Another phone is already recording this table.',
  not_recorder:           'Another phone records this table now (the organizer took it over).',
  table_saved:            'This table has already been saved.',
  invalid_results:        'Every villain needs a place before saving.',
  stage_has_games:        'A game of this stage is already saved: its draw can no longer be undone.',
  wrong_code:             'This link can\'t claim names: scan the tournament\'s QR code from the organizer.',
};
function _tnErrorMsg(error) {
  if (error?.code === '23505') return t('There is already a player with this name.');
  return TN_ERRORS[error?.message] ? t(TN_ERRORS[error.message]) : (error?.message || '');
}

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
  const rows = new Map();
  const row = id => {
    if (!rows.has(id)) rows.set(id, { player_id: id, points: 0, firsts: 0, played: 0, byes: 0, opponents: 0, faced: [] });
    return rows.get(id);
  };
  for (const p of players) row(p.id);
  // The stages' tables (a final table scores no points: it ranks the finalists).
  const counted = tables.filter(tb => tb.saved_at && tb.stage <= stage && tb.stage <= tour.stages);
  for (const tb of counted) {
    const n = tb.seats.length;
    for (const s of tb.seats) {
      if (s.place == null) continue;
      const r = row(s.player_id);
      r.points += tournamentSeatPoints(tour, n, s);
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
  let sorted = [...rows.values()].sort(cmp);
  sorted.forEach((r, i) => { r.rank = i && cmp(sorted[i - 1], r) === 0 ? sorted[i - 1].rank : i + 1; delete r.faced; });

  // A saved final table decides the top places: its finalists by its ranking
  // (r.final: their place in it), then everyone else as they stood, after them.
  const final = tour.final_table && stage > tour.stages && tables.find(tb => tb.stage > tour.stages && tb.saved_at);
  if (final) {
    const place = new Map(final.seats.map(s => [s.player_id, s.place]));
    const top  = sorted.filter(r => place.has(r.player_id)).sort((a, b) => place.get(a.player_id) - place.get(b.player_id));
    const rest = sorted.filter(r => !place.has(r.player_id));
    top.forEach((r, i) => { r.final = place.get(r.player_id); r.rank = i + 1; });
    rest.forEach((r, i) => { r.rank = i && cmp(rest[i - 1], r) === 0 ? rest[i - 1].rank : top.length + i + 1; });
    sorted = [...top, ...rest];
  }
  return sorted;
}

// The final table: the top of the standings after the last stage (as many as
// a table holds, among those still playing; ties in the standings' order),
// each with a villain from the pool they haven't played yet in the tournament
// when possible, all different, seated by the play order rule. Returns
// { players: [ids in play order], villains: [{ player_id, character }] }.
function tournamentDrawFinal(tour, players, tables) {
  const playing = new Set(players.filter(p => p.withdrawn_after == null).map(p => p.id));
  const finalists = tournamentStandings(tour, tables, { players, stage: tour.stages })
    .filter(r => playing.has(r.player_id)).slice(0, tour.table_size).map(r => r.player_id);
  const played = new Map(finalists.map(id => [id, new Set()]));
  for (const tb of tables) for (const s of tb.seats) played.get(s.player_id)?.add(s.character);
  const taken = new Set();
  const villains = _tnShuffle(finalists).map(id => {
    const pool = _tnShuffle(tour.villain_pool).filter(v => !taken.has(v));
    const pick = pool.find(v => !played.get(id).has(v)) || pool[0];
    taken.add(pick);
    return { player_id: id, character: pick };
  });
  const seats = new Map();
  for (const tb of tables.filter(x => x.saved_at && x.seats.length > 1)) {
    for (const s of tb.seats) (seats.get(s.player_id) || seats.set(s.player_id, []).get(s.player_id)).push(s.position / (tb.seats.length - 1));
  }
  const order = (TOURNAMENT_PLAY_ORDERS[tour.play_order] || TOURNAMENT_PLAY_ORDERS.random).order(finalists, { seats, size: tour.table_size });
  return { players: order, villains };
}

// ── Draws ────────────────────────────────────────────────────────────────────

// The next stage's tables, each in its play order (the tournament's play
// order rule): the players still playing, paired by its pairing rule.
function tournamentDrawStage(tour, players, tables = []) {
  const pairing = TOURNAMENT_PAIRINGS[tour.pairing] || TOURNAMENT_PAIRINGS.random;
  const playing = players.filter(p => p.withdrawn_after == null).map(p => p.id);
  const { met, byes } = _tnHistory(tables.filter(tb => tb.saved_at));
  const stage = Math.max(0, ...tables.map(tb => tb.stage)) + 1;
  const standings = tournamentStandings(tour, tables, { players });
  const playOrder = TOURNAMENT_PLAY_ORDERS[tour.play_order] || TOURNAMENT_PLAY_ORDERS.random;
  const seats = new Map();   // where each player sat so far, 0 (first) to 1 (last)
  for (const tb of tables.filter(x => x.saved_at && x.seats.length > 1)) {
    for (const s of tb.seats) (seats.get(s.player_id) || seats.set(s.player_id, []).get(s.player_id)).push(s.position / (tb.seats.length - 1));
  }
  return pairing.tables(playing, { size: tour.table_size, split: tour.table_split || 'even', stage, standings, met, byes })
    .map(tb => playOrder.order(tb, { seats, size: tour.table_size }));
}

// Every player's villain in every stage, for Start.
function tournamentVillainSchedule(tour, ids) {
  return TOURNAMENT_VILLAIN_DRAWS[TOURNAMENT_VILLAIN_DRAW].schedule(ids, tour.villain_pool, tour.stages);
}

// Points as shown: up to two decimals, in the page's language (1.5, 1,5).
function fmtTournamentPoints(p) {
  return (Math.round(p * 100) / 100).toLocaleString(LOCALE, { maximumFractionDigits: 2 });
}
