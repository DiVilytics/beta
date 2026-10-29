// ── CHARTS PAGE ──────────────────────────────────────────────────────────────
// A hub of visualizations: a menu picks a chart, rendered into the card below
// via the hand-rolled SVG helpers in chart-lib.js. Every chart reads the same
// games, fetched once: the official games with their seats. The table size
// (size-filter.js, without Solo) and the period (period-filter.js) filter them
// here, as on the Leaderboard; a chart whose view is by table size already
// (sizes: false) grays the size filter out. A chart with `modes` gets a switch
// above it (Minutes | Rounds, ...), each mode remembered.

const size   = createSizeFilter('chartSize', { onChange: () => _rerender(), solo: false });
const period = createPeriodFilter('chartPeriod', { onChange: () => _rerender() });

// ── THE GAMES (one fetch, filtered per view) ───────────────────────────────────

// Every official game with its seats, { id, played_at, at (ms, null when
// undated), duration_minutes, num_turns, source, seats: [{ character, user_id,
// position, is_winner }] }. Fetched in parallel pages (past PostgREST's
// 1000-row cap), once per visit; a failed load is retried next time.
let _allGames = null;
function _loadGames() {
  return _allGames ||= (async () => {
    const sel = 'id, played_at, duration_minutes, num_turns, source, game_players(character, user_id, position, is_winner)';
    const { count, error } = await db.from('games').select('id', { count: 'exact', head: true }).is('variant', null);
    if (error) throw error;
    const PAGE = 1000;
    const pages = await Promise.all(Array.from({ length: Math.ceil((count || 0) / PAGE) + 1 }, (_, i) =>
      db.from('games').select(sel).is('variant', null).order('id').range(i * PAGE, i * PAGE + PAGE - 1)));
    const failed = pages.find(r => r.error);
    if (failed) throw failed.error;
    return pages.flatMap(r => r.data || []).map(({ game_players, ...g }) => ({
      ...g, seats: game_players || [], at: g.played_at ? Date.parse(g.played_at) : null,
    }));
  })().catch(e => { _allGames = null; throw e; });
}

// The games of the period picked, and of the table size picked unless the
// chart is by table size itself.
function _filterGames(all, { sized = true } = {}) {
  const { from_ts, to_ts } = period.range();
  const from = from_ts && Date.parse(from_ts), to = to_ts && Date.parse(to_ts);
  const n = sized ? size.value() : 'all';
  return all.filter(g =>
    (!from || (g.at != null && g.at >= from && g.at < to)) &&
    (n === 'all' || g.seats.length === n));
}

// A game's [year, month (1-12), day] as it was played: in local time, or the
// recorded day for sources without a time (isDateOnly, ui.js).
function _gameDay(g) {
  const d = new Date(g.at);
  return isDateOnly(g) ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()] : [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

// Each villain's games and wins in `games`, with its pace and box.
function _villainStats(games, chars) {
  const by = {};
  for (const g of games) for (const s of g.seats) {
    const r = by[s.character] ||= { games: 0, wins: 0 };
    r.games++;
    if (s.is_winner) r.wins++;
  }
  return chars.filter(c => by[c.name]).map(c => ({ name: c.name, pace: c.pace || null, box: c.box || null, ...by[c.name] }));
}

// The q-quantile of sorted values (0.5: the median), between the two nearest.
function _quantile(sorted, q) {
  const at = (sorted.length - 1) * q, i = Math.floor(at);
  return sorted[i] + (at - i) * ((sorted[i + 1] ?? sorted[i]) - sorted[i]);
}
const _MINUTES_ROUNDS = [{ id: 'minutes', label: 'Minutes' }, { id: 'rounds', label: 'Rounds' }];
// The win rate of every villain pooled (in the games filtered): the line the
// % Wins bars compare with. With every table size it sits well under 50%.
function _overallRef(stats) {
  const games = stats.reduce((a, c) => a + c.games, 0), wins = stats.reduce((a, c) => a + c.wins, 0);
  const pct = games ? Math.round(wins / games * 100) : 0;
  return { value: pct, text: t('Average {pct}%', { pct }) };
}
const _PCT_PICKS = [{ id: 'pct', label: '% Wins' }, { id: 'picks', label: 'Picks' }];

// ── MATCHUPS ──────────────────────────────────────────────────────────────────
// The grid of who beats whom: villains (by box, as on the Villains page) or
// boxes (in release order), a cell for every pair that met in `games`, read
// from its row: the row's wins over the two's, when one of them won. `cell`
// turns { pct, w, l } into its { heat (0..1), label, meta } (the beta adds Δ
// Wins). Portraits or short box names stay on top and on the left while the
// grid scrolls inside the chart's box.
function _matchupsHTML({ games, chars, boxInfo, group, cell }) {
  const boxes = group === 'boxes';
  const boxOf = Object.fromEntries(chars.map(c => [c.name, c.box]));
  const boxOrder = b => boxInfo[b]?.order ?? 99;
  // Per ordered pair: games together, and the row's wins over the column. Two
  // villains of one box at a table are no box against box.
  const together = {}, wins = {};
  for (const g of games) {
    const keyOf = s => boxes ? boxOf[s.character] : s.character;
    const sides = [...new Set(g.seats.map(keyOf))].filter(Boolean);
    const winner = g.seats.find(s => s.is_winner);
    for (const a of sides) for (const b of sides) {
      if (a === b) continue;
      const k = a + '|' + b;
      together[k] = (together[k] || 0) + 1;
      if (winner && keyOf(winner) === a) wins[k] = (wins[k] || 0) + 1;
    }
  }
  const played = new Set(games.flatMap(g => g.seats.map(s => s.character)));
  const items = boxes
    ? Object.keys(boxInfo).filter(b => chars.some(c => c.box === b && played.has(c.name))).sort((a, b) => boxOrder(a) - boxOrder(b))
        .map(b => ({ key: b, name: b, group: b, href: `villains.html?box=${boxAnchorId(b)}` }))
    : chars.filter(c => played.has(c.name))
        .sort((a, b) => boxOrder(a.box) - boxOrder(b.box) || (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map(c => ({ key: c.name, name: villainName(c.name), group: c.box, href: `villains.html?vil=${encodeURIComponent(c.name)}` }));
  if (items.length < 2) return Charts.barsV([]);
  // A box's short name: the initials of its words, small words aside (WTIA, DB).
  const short = b => b.split(/[\s,!]+/).filter(w => w && !/^(the|to|and|at|with|a|of)$/i.test(w)).map(w => w[0].toUpperCase()).join('');
  // A box: its initials over its year's two digits.
  const label = it => boxes
    ? `<span class="vs-abbr">${_esc(short(it.key))}<br>${_esc(String(boxInfo[it.key]?.year ?? '').slice(-2))}</span>`
    : charImgHTML(it.key);
  const newGroup = i => !boxes && i > 0 && items[i].group !== items[i - 1].group;
  const head = (it, i) => `<th class="vs-head${newGroup(i) ? ' vs-box' : ''}" title="${_esc(it.name)}">${label(it)}</th>`;
  const rows = items.map((r, ri) => {
    const cells = items.map((c, ci) => {
      const cls = newGroup(ci) ? ' vs-box' : '';
      if (r.key === c.key) return `<td class="vs-self${cls}"></td>`;
      const n = together[r.key + '|' + c.key] || 0;
      const w = wins[r.key + '|' + c.key] || 0, l = wins[c.key + '|' + r.key] || 0;
      const name = `${r.name} vs ${c.name}`;
      // The caption links both: the row's page, " vs ", the column's.
      const links = ` data-name="${_esc(r.name)}" data-href="${_esc(r.href)}" data-box="${_esc(c.name)}" data-boxhref="${_esc(c.href)}" data-join=" vs "`;
      const meta = `${t('{a} won {w}, {b} won {l}', { a: r.name, w, b: c.name, l })} | ${tn(n, '{n} game together', '{n} games together')}`;
      if (n < MIN_GAMES_FOR_PCT || !(w + l)) return `<td class="vs-few ch-hit${cls}"${links} data-meta="${_esc(meta)}" title="${_esc(name)}"></td>`;
      const v = cell({ pct: w / (w + l), w, l });
      return `<td class="ch-hit${cls}" style="background:${Charts.heatColor(v.heat)}"${links} data-meta="${_esc(`${v.meta} | ${meta}`)}" title="${_esc(name)}">${v.label}</td>`;
    }).join('');
    return `<tr${newGroup(ri) ? ' class="vs-box"' : ''}><th class="vs-head vs-side" title="${_esc(r.name)}">${label(r)}</th>${cells}</tr>`;
  }).join('');
  return `<div class="vs-wrap"><table class="vs-grid${boxes ? ' vs-boxes' : ''}"><thead><tr><th class="vs-corner"></th>${items.map(head).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ── CHART REGISTRY ─────────────────────────────────────────────────────────────
// Each: { id, icon, label, desc (a string, or per mode { mode: string }),
// modes?: [{ id, label }], sizes?: false, render(ctx) -> SVG/HTML string },
// ctx = { games (filtered), chars, boxInfo, mode }. label, desc and the mode
// labels are English keys, translated where they are shown.

const CHARTS = [
  {
    id: 'scatter', icon: '✨', label: 'Wins vs games',
    desc: 'Each villain by games played (x) and win rate (y); the axes zoom to the data. Up-left is strong but rarely picked, down-right is popular but weak. Tap a dot to open it.',
    render({ games, chars }) {
      const points = _villainStats(games, chars).map(c => {
        const pct = Math.round(c.wins / c.games * 100);
        return {
          x: c.games,
          y: pct,
          label: villainName(c.name),
          color: c.pace ? `var(--pace-${c.pace})` : 'var(--pace-gray)',
          href: `villains.html?vil=${encodeURIComponent(c.name)}`,
          box: c.box || null,
          boxHref: c.box ? `villains.html?box=${boxAnchorId(c.box)}` : null,
          meta: `${tn(c.games, '{n} game', '{n} games')} | ${t('{pct}% win rate', { pct })}`,
        };
      });
      return Charts.scatter(points, { xLabel: t('Games played'), ySuffix: '%', yMax: 100, avg: _overallRef(_villainStats(games, chars)) });
    },
  },
  {
    id: 'versus', icon: '🆚', label: 'Matchups',
    groups: [{ id: 'villains', label: 'Villains' }, { id: 'boxes', label: 'Boxes' }],
    desc: "Each pair of villains, or boxes, that met: how often the row won, when one of the two did. Warmer cells win more; gray under 5 games together. Scroll the grid.",
    render({ games, chars, boxInfo, group }) {
      return _matchupsHTML({ games, chars, boxInfo, group, cell: ({ pct }) => ({ heat: (pct - 0.25) / 0.5, label: Math.round(pct * 100), meta: `${Math.round(pct * 100)}%` }) });
    },
  },
  {
    // The id stays 'box': it was the win rate chart; Box popularity is its Picks.
    id: 'box', icon: '📦', label: 'By box',
    modes: _PCT_PICKS,
    desc: {
      pct:   "Each expansion box's overall win rate, pooling every villain in the box (total wins over total games); bars are sorted strongest first. Tap a box for its total games.",
      picks: "How often each box's villains are picked across all recorded games, most-played first. Tap a bar for its share of all picks, or to open the box.",
    },
    render({ games, chars, boxInfo, mode }) {
      const byBox = {};
      let total = 0;
      for (const c of _villainStats(games, chars)) {
        if (!c.box) continue;
        (byBox[c.box] ||= { games: 0, wins: 0, villains: 0 });
        byBox[c.box].games += c.games;
        byBox[c.box].wins  += c.wins;
        byBox[c.box].villains++;
        total += c.games;
      }
      const picks = mode === 'picks';
      const data = Object.entries(byBox)
        .filter(([, v]) => v.games > 0)
        .map(([box, v]) => {
          const pct  = Math.round(v.wins / v.games * 100);
          const year = boxInfo[box]?.year;
          return {
            label: box,
            value: picks ? v.games : pct,
            games: v.games,
            href: `villains.html?box=${boxAnchorId(box)}`,
            meta: picks
              ? `${year ? year + ' | ' : ''}${tn(v.games, '{n} pick', '{n} picks')} | ${t('{pct}% of all picks', { pct: Math.round(v.games / (total || 1) * 100) })} | ${tn(v.villains, '{n} villain', '{n} villains')}`
              : `${year ? year + ' | ' : ''}${t('{pct}% win rate', { pct })} | ${tn(v.games, '{n} game', '{n} games')} | ${tn(v.villains, '{n} villain', '{n} villains')}`,
          };
        })
        .sort((a, b) => b.value - a.value);
      return picks ? Charts.barsH(data, { labelW: 152 })
        : Charts.barsH(data, { axisFmt: v => `${v}%`, labelW: 152, ref: _overallRef(_villainStats(games, chars)) });
    },
  },
  {
    id: 'pace', icon: '🌈', label: 'By pace',
    modes: _PCT_PICKS,
    desc: {
      pct:   "Each pace band's overall win rate, pooling every villain of that color (total wins over total games). Tap a band for its games and villains.",
      picks: "How often villains of each pace are picked across all recorded games, as a share of all picks. Tap a band for its picks and villains.",
    },
    render({ games, chars, mode }) {
      const cs = _villainStats(games, chars);
      const total = cs.reduce((a, c) => a + c.games, 0) || 1;
      const bands = ['green', 'yellow', 'orange', 'red', 'gray'];
      const data = bands.map(b => {
        const rows  = b === 'gray' ? cs.filter(c => !c.pace) : cs.filter(c => c.pace === b);
        const games = rows.reduce((a, c) => a + c.games, 0);
        const wins  = rows.reduce((a, c) => a + c.wins,  0);
        const pct   = games ? Math.round(wins / games * 100) : 0;
        const share = Math.round(games / total * 100);
        const meta  = mode === 'picks'
          ? `${tn(games, '{n} pick', '{n} picks')} | ${t('{pct}% of all picks', { pct: share })} | ${tn(rows.length, '{n} villain', '{n} villains')}`
          : `${t('{pct}% win rate', { pct })} | ${tn(games, '{n} game', '{n} games')} | ${tn(rows.length, '{n} villain', '{n} villains')}`;
        return { label: t(b[0].toUpperCase() + b.slice(1)), value: mode === 'picks' ? share : pct, games, color: `var(--pace-${b})`, href: `villains.html?pace=${b}`, meta };
      }).filter(d => d.games > 0);
      return mode === 'picks' ? Charts.barsH(data, { axisFmt: v => `${v}%`, labelW: 60 })
        : Charts.barsH(data, { axisFmt: v => `${v}%`, labelW: 60, ref: _overallRef(cs) });
    },
  },
  {
    id: 'seatorder', icon: '🪑', label: 'Play order',
    sizes: false,
    desc: "Win rate of each seat in play order (seat 1 plays first) by number of players. Warmer cells are above the fair share (1 / players); the cell shows the win rate. Recorded-seating games only.",
    render({ games }) {
      // Only games with a recorded play order (every seat its own position) and
      // one winner; a seat is its rank in the play order, 1 first.
      const bySize = {};
      for (const g of games) {
        const seats = g.seats;
        if (seats.some(s => s.position == null) || new Set(seats.map(s => s.position)).size !== seats.length) continue;
        if (seats.filter(s => s.is_winner).length !== 1) continue;
        seats.slice().sort((a, b) => a.position - b.position).forEach((s, i) => {
          const cell = ((bySize[seats.length] ||= {})[i + 1] ||= { games: 0, wins: 0 });
          cell.games++;
          if (s.is_winner) cell.wins++;
        });
      }
      const maxSeat = 6;
      const rowLabels = TABLE_SIZES.map(s => `${s}p`);
      const colLabels = Array.from({ length: maxSeat }, (_, i) => t('Seat {n}', { n: i + 1 }));
      return Charts.heatmap(rowLabels, colLabels, (ri, ci) => {
        const s = TABLE_SIZES[ri], seat = ci + 1;  // seats are 1-based (ranked play order)
        if (seat > s) return null;                // that seat does not exist for this size
        const cell = bySize[s] && bySize[s][seat];
        if (!cell || !cell.games) return null;
        const pct = cell.wins / cell.games, fair = 1 / s;
        const heat = (pct / fair - 0.5) / 1.5;    // 0.5x..2x of fair -> 0..1 on the ramp
        return {
          value: heat,
          label: `${Math.round(pct * 100)}%`,
          name:  t('{size}p, seat {seat}', { size: s, seat }),
          meta:  `${t('{pct}% win', { pct: Math.round(pct * 100) })} | ${t('fair {pct}%', { pct: Math.round(fair * 100) })} | ${tn(cell.games, '{n} game', '{n} games')}`,
        };
      });
    },
  },
  {
    // The id stays 'duration': it was the minutes-only chart.
    id: 'duration', icon: '⏳', label: 'Game length',
    modes: _MINUTES_ROUNDS,
    desc: {
      minutes: 'How many games fall into each 15-minute band. The dashed line is the median game, the shaded part the middle half of the games. Only games with a recorded duration.',
      rounds:  'How many games fall into each 3-round band. The dashed line is the median game, the shaded part the middle half of the games. Only games with a recorded round count.',
    },
    render({ games, mode }) {
      // The median and the middle half (25% to 75%), as positions in the bars:
      // a value v sits (v - start) / band bars in, `shift` centering whole rounds.
      const spreadOf = (vals, start, band, shift, unit) => {
        const sorted = vals.slice().sort((a, b) => a - b);
        const [q1, mid, q3] = [0.25, 0.5, 0.75].map(q => _quantile(sorted, q));
        const pos = v => (v - start + shift) / band;
        return { mid: pos(mid), lo: pos(q1), hi: pos(q3),
          text: t(unit, { m: Math.round(mid), a: Math.round(q1), b: Math.round(q3) }) };
      };
      if (mode === 'rounds') {
        const vals = games.map(g => g.num_turns).filter(v => v != null);
        if (!vals.length) return Charts.barsV([]);
        const SIZE = 3;   // group rounds into 3-round bands to smooth out noise
        const lo0 = Math.floor(Math.min(...vals) / SIZE) * SIZE;
        const hi0 = Math.floor(Math.max(...vals) / SIZE) * SIZE;
        const buckets = [];
        for (let b = lo0; b <= hi0; b += SIZE) buckets.push({ lo: b, hi: b + SIZE - 1, value: 0 });
        for (const v of vals) buckets[Math.floor((v - lo0) / SIZE)].value++;
        for (const b of buckets) { b.name = t('{lo}-{hi} rounds', b); b.meta = tn(b.value, '{n} game', '{n} games'); }
        return Charts.barsV(buckets, {
          fmt: (v, d) => `${t('{lo}-{hi} rounds', d)}: ${v}`,
          xTick: i => buckets[i].lo,
          xEvery: 1,
          spread: spreadOf(vals, lo0, SIZE, 0.5, 'Median {m} | middle half {a}-{b} rounds'),
        });
      }
      const vals = games.map(g => g.duration_minutes).filter(v => v != null);
      if (!vals.length) return Charts.barsV([]);
      const SIZE = 15;   // 15-minute buckets
      const n = Math.floor(Math.max(...vals) / SIZE) + 1;
      const buckets = Array.from({ length: n }, (_, b) => ({ lo: b * SIZE, hi: (b + 1) * SIZE, value: 0 }));
      for (const v of vals) buckets[Math.min(n - 1, Math.floor(v / SIZE))].value++;
      for (const b of buckets) { b.name = `${b.lo}-${b.hi} min`; b.meta = tn(b.value, '{n} game', '{n} games'); }
      return Charts.barsV(buckets, {
        fmt: (v, d) => `${d.lo}-${d.hi} min: ${v}`,
        xTick: i => buckets[i].lo,
        xEvery: 1,
        spread: spreadOf(vals, 0, SIZE, 0, 'Median {m} | middle half {a}-{b} min'),
      });
    },
  },
  {
    id: 'tablesize', icon: '👥', label: 'Number of players',
    sizes: false,
    desc: 'Share of recorded games by number of players, from 2 to 6. Tap a slice for its exact number of games and its percentage of all the games played.',
    render({ games }) {
      const total = games.length || 1;
      const segs = TABLE_SIZES.map(n => {
        const c = games.filter(g => g.seats.length === n).length;
        return { label: `${n}p`, value: c, meta: `${tn(c, '{n} game', '{n} games')} | ${Math.round(c / total * 100)}%` };
      });
      // In the hole: how many games, and how many players a game on average.
      const avg = games.reduce((a, g) => a + g.seats.length, 0) / total;
      return Charts.donut(segs, { center: [String(games.length), tn(games.length, 'game', 'games'), t('{n} players a game', { n: avg.toLocaleString(LOCALE, { maximumFractionDigits: 1 }) })] });
    },
  },
  {
    id: 'time', icon: '📈', label: 'Games over time',
    modes: [{ id: 'games', label: 'Games' }, { id: 'players', label: 'Players' }],
    desc: {
      games:   'Games played each month, by play date. All time shows the latest 12 months (drag sideways for earlier ones); a year shows its months, a month its days.',
      players: 'Players who claimed a villain each month, each counted once. All time shows the latest 12 months (drag sideways for earlier ones); a year its months, a month its days.',
    },
    render({ games, mode }) {
      // The buckets: every month from the first game to the last (All time), the
      // year's months, or the month's days, up to today; empty ones as 0.
      const p = period.get();
      const now = new Date();
      const keyOf = g => { const [y, m, d] = _gameDay(g); return p.month != null ? d : p.year != null ? m : y * 12 + m - 1; };
      const dated = games.filter(g => g.at != null);
      let keys = [];
      if (p.month != null) {
        const days = new Date(p.year, p.month + 1, 0).getDate();
        const last = p.year === now.getFullYear() && p.month === now.getMonth() ? now.getDate() : days;
        keys = Array.from({ length: last }, (_, i) => i + 1);
      } else if (p.year != null) {
        const last = p.year === now.getFullYear() ? now.getMonth() + 1 : 12;
        keys = Array.from({ length: last }, (_, i) => i + 1);
      } else if (dated.length) {
        const ks = dated.map(keyOf);
        for (let k = Math.min(...ks); k <= Math.max(...ks); k++) keys.push(k);
      }
      const sets = new Map(keys.map(k => [k, mode === 'players' ? new Set() : []]));
      for (const g of dated) {
        const bucket = sets.get(keyOf(g));
        if (!bucket) continue;
        if (mode === 'players') g.seats.forEach(s => s.user_id && bucket.add(s.user_id));
        else bucket.push(g);
      }
      const label = k => p.month != null ? String(k)
        : p.year != null ? `${p.year}/${String(k).padStart(2, '0')}`
        : `${Math.floor(k / 12)}/${String(k % 12 + 1).padStart(2, '0')}`;   // YYYY/MM
      const name = k => p.month != null ? fmtDayLong(`${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(k).padStart(2, '0')}`) : label(k);
      const pts = keys.map(k => {
        const c = mode === 'players' ? sets.get(k).size : sets.get(k).length;
        return { label: label(k), name: name(k), value: c, meta: mode === 'players' ? tn(c, '{n} player', '{n} players') : tn(c, '{n} game', '{n} games') };
      });
      // Above it: the period's total (players counted once) and the average a
      // month (or a day), dashed.
      const total = mode === 'players' ? new Set(dated.flatMap(g => g.seats.map(s => s.user_id).filter(Boolean))).size : dated.length;
      const avg = pts.length ? pts.reduce((a, p) => a + p.value, 0) / pts.length : 0;
      const avgTxt = avg.toLocaleString(LOCALE, { maximumFractionDigits: avg < 10 ? 1 : 0 });
      const text = `${mode === 'players' ? tn(total, '{n} player', '{n} players') : tn(total, '{n} game', '{n} games')} | ${t(p.month != null ? '{n} a day on average' : '{n} a month on average', { n: avgTxt })}`;
      return Charts.line(pts, { visible: period.isAll() ? 12 : null, avg: pts.length ? { value: avg, text } : null });
    },
  },
  {
    id: 'weekday', icon: '📅', label: 'Games by weekday',
    desc: 'Games played on each weekday, by play date, Monday first. The weekday follows your time zone (or the recorded day, for games saved without a time).',
    render({ games }) {
      const counts = new Array(7).fill(0);   // 0 = Sunday
      for (const g of games) {
        if (g.at == null) continue;
        const d = new Date(g.at);
        counts[isDateOnly(g) ? d.getUTCDay() : d.getDay()]++;   // date-only: the recorded day
      }
      const order  = [1, 2, 3, 4, 5, 6, 0];   // Monday first
      // Weekday names in the current language (5 Jan 2025 was a Sunday).
      const day    = (d, weekday) => new Date(2025, 0, 5 + d).toLocaleDateString(LOCALE, { weekday });
      const labels = order.map(d => day(d, 'short').replace('.', ''));
      const full   = order.map(d => { const s = day(d, 'long'); return s[0].toUpperCase() + s.slice(1); });
      const total = counts.reduce((a, c) => a + c, 0) || 1;
      const pct = c => Math.round(c / total * 100);
      const data = order.map((d, i) => ({ value: counts[d], name: full[i], meta: `${tn(counts[d], '{n} game', '{n} games')} | ${pct(counts[d])}%` }));
      return Charts.barsV(data, { xTick: i => labels[i], xEvery: 1, note: t('Weekends {pct}%', { pct: pct(counts[6] + counts[0]) }) });
    },
  },
];

// ── PICKER + RENDER ────────────────────────────────────────────────────────────

let _selected = null;
let _lastPanEnd = 0;   // timestamp of the last scatter pan/pinch; suppresses the click that ends it
function _renderPicker() {
  document.getElementById('chartPicker').innerHTML =
    `<div class="chart-select-wrap"><select class="chart-select" aria-label="${t('Choose a chart')}" onchange="selectChart(this.value)">` +
    CHARTS.map(c => `<option value="${c.id}"${c.id === _selected ? ' selected' : ''}>${c.icon} ${_esc(t(c.label))}</option>`).join('') +
    `</select><span class="chevron chart-chevron" aria-hidden="true">▼</span></div>`;
}

// Each chart's mode (its switch) and grouping (a second switch on the same
// row, flush right: Matchups' Villains | Boxes), the first one until picked.
const _modes = {}, _groups = {};
const _pick = (opts, saved) => opts ? (opts.some(m => m.id === saved) ? saved : opts[0].id) : null;
const _modeOf  = c => _pick(c.modes, _modes[c.id]);
const _groupOf = c => _pick(c.groups, _groups[c.id]);

// The switches, on one row. A chart without one keeps its place, empty, so
// every chart starts at the same height.
function _modesHTML(c) {
  if (!c.modes && !c.groups) return `<div class="controls mb-1 chart-modes-none" aria-hidden="true"><div class="seg"><button class="seg-btn" type="button" tabindex="-1">&nbsp;</button></div></div>`;
  const seg = (opts, on, fn) => `<div class="seg">${opts.map(m =>
    `<button class="seg-btn${m.id === on ? ' on' : ''}" type="button" onclick="${fn}('${m.id}')">${_esc(t(m.label))}</button>`).join('')}</div>`;
  return `<div class="controls mb-1 chart-switches">${c.modes ? seg(c.modes, _modeOf(c), 'setChartMode') : ''}${c.groups ? seg(c.groups, _groupOf(c), 'setChartGroup').replace('class="seg"', 'class="seg chart-group-seg"') : ''}</div>`;
}

function setChartMode(mode) {
  _modes[_selected] = mode;
  _rerender();
}

function setChartGroup(group) {
  _groups[_selected] = group;
  _rerender();
}

async function selectChart(id) {
  const c = CHARTS.find(x => x.id === id);
  if (!c) return;
  _selected = id;
  _renderPicker();
  await _rerender();
}

// Draws the chart picked, for the filters and mode picked. A newer call wins
// over one still loading.
let _renderToken = 0;
async function _rerender() {
  const c = CHARTS.find(x => x.id === _selected);
  if (!c) return;
  const token = ++_renderToken;
  const mode = _modeOf(c);
  size.setDisabled(c.sizes === false);
  // Every mode's description in the same spot, only the picked one visible:
  // the card is as tall as the longest, so a switch never moves the chart.
  document.getElementById('chartDesc').innerHTML = typeof c.desc === 'string' ? _esc(t(c.desc))
    : Object.entries(c.desc).map(([m, d]) => `<span${m === mode ? '' : ' class="chart-desc-off" aria-hidden="true"'}>${_esc(t(d))}</span>`).join('');
  document.getElementById('chartModes').innerHTML = _modesHTML(c);
  const cap = document.getElementById('chartCaption');
  if (cap) cap.textContent = '';
  const stage = document.getElementById('chartStage');
  if (!_allGames) stage.innerHTML = `<div class="chart-note">${t('Loading…')}</div>`;
  try {
    const [all, chars, boxInfo] = await Promise.all([_loadGames(), loadCharacters(), loadBoxInfo()]);
    if (token !== _renderToken) return;
    stage.innerHTML = c.render({ games: _filterGames(all, { sized: c.sizes !== false }), chars, boxInfo, mode, group: _groupOf(c) });
    const z = stage.querySelector('.ch-zoomable');
    if (z) _attachZoom(z);
    const lp = stage.querySelector('.ch-pannable');
    if (lp) _attachLinePan(lp);
  } catch (e) {
    if (token !== _renderToken) return;
    console.error('chart render failed:', e);
    stage.innerHTML = `<div class="chart-note">${t('Could not load this chart.')}</div>`;
  }
}

// Horizontal pan for a windowed line chart (Charts.line with `visible`): drag
// (mouse or touch) or trackpad/shift+wheel slides the data under a fixed y axis.
// It opens on the most recent points (the group is pre-translated) and is clamped
// so you can't pan past either end. touch-action stays 'pan-y' so vertical swipes
// still scroll the page. A drag stamps _lastPanEnd, so the click that ends it
// doesn't select a dot (same guard as the scatter's zoom).
function _attachLinePan(svg) {
  const groups = [...svg.querySelectorAll('.ch-lpan')];   // data + the label row, panned together
  const pan = groups[0];
  if (!pan) return;
  const FW = +pan.dataset.w, L = +pan.dataset.l, maxOff = +pan.dataset.maxoff;
  let off = maxOff;   // content offset in viewBox units; maxOff = newest months in view
  const apply = () => groups.forEach(g => g.setAttribute('transform', `translate(${(L - off).toFixed(2)} 0)`));
  const clamp = () => { off = Math.min(maxOff, Math.max(0, off)); };

  svg.style.touchAction = 'pan-y';
  let startX = null, startOff = 0, moved = false;
  svg.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startX = e.clientX; startOff = off; moved = false;
  });
  svg.addEventListener('pointermove', e => {
    if (startX == null) return;
    const dx = e.clientX - startX;
    if (!moved) {
      if (Math.abs(dx) < 5) return;   // still a tap, not a drag
      moved = true;
      svg.classList.add('panning');
      // Keep following the pointer past the chart's edge. Only once dragging
      // starts: capturing on pointerdown would retarget the click away from the dot.
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    }
    off = startOff - dx / svg.getBoundingClientRect().width * FW;   // drag right -> older months
    clamp(); apply();
  });
  const end = () => {
    if (startX != null && moved) _lastPanEnd = Date.now();
    startX = null; moved = false;
    svg.classList.remove('panning');
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  // Trackpad two-finger swipe (deltaX) or shift+wheel pans; plain vertical wheel
  // is left alone so the page still scrolls.
  svg.addEventListener('wheel', e => {
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
    if (!dx) return;
    e.preventDefault();
    off += dx / svg.getBoundingClientRect().width * FW;
    clamp(); apply();
  }, { passive: false });
}

// Pinch / wheel / drag zoom for the scatter. Only the plot interior zooms: the
// dots ride a transformed group clipped to the plot rect, while the axes, grid
// and tick labels stay put. The window is tracked in plot-local space [0,PW] x
// [0,PH] so it can never pan into the margins. On every change we re-place the
// dots (kept a constant screen size so close points actually separate), re-label
// the fixed-position ticks for the visible window, and flag `zoomed` for the
// frame highlight + level badge. Max zoom-out is the default (full) view; zoom in
// to MAX (25x). Records _lastPanEnd so the click that ends a gesture does not select a
// dot, and touch-action flips to 'none' only while zoomed so the page still
// scrolls at the default view.
function _attachZoom(svg) {
  const pan = svg.querySelector('.ch-pan');
  if (!pan) return;
  const FW = 440, FH = 280, MAX = 25;
  const L = +pan.dataset.l, R = +pan.dataset.r, T = +pan.dataset.t, B = +pan.dataset.b;
  const PW = FW - L - R, PH = FH - T - B;
  const xlo = +pan.dataset.xlo, xhi = +pan.dataset.xhi, ylo = +pan.dataset.ylo, yhi = +pan.dataset.yhi;
  const xsuf = pan.dataset.xsuf || '', ysuf = pan.dataset.ysuf || '';
  const xticks = svg.querySelectorAll('.ch-xtick'), yticks = svg.querySelectorAll('.ch-ytick');
  const dots = pan.querySelectorAll('.ch-dot');
  const r0 = +(dots[0]?.getAttribute('r') || 8);   // the default view's radius (larger on a phone, chart-lib.js)
  const badgeTxt = svg.querySelector('.ch-zoom-badge-txt');

  let vbx = 0, vby = 0, vbw = PW, vbh = PH;   // visible window in plot-local space
  const apply = () => {
    const s = PW / vbw;
    pan.setAttribute('transform', `translate(${(L - s * (L + vbx)).toFixed(2)} ${(T - s * (T + vby)).toFixed(2)}) scale(${s.toFixed(4)})`);
    // Dots grow with zoom: their default size up to 2x at max zoom. r is in
    // pre-transform units, so divide the target size by the group scale s.
    // (The selection ring stays constant via non-scaling-stroke.)
    const grow = 1 + (s - 1) / (MAX - 1);   // 1 at default, 2 at MAX
    const r = (r0 * grow / s).toFixed(2);
    dots.forEach(d => d.setAttribute('r', r));
    for (let i = 0; i <= 4; i++) {
      const dx = xlo + (vbx + i / 4 * vbw) / PW * (xhi - xlo);
      if (xticks[i]) xticks[i].textContent = Math.round(dx) + xsuf;
      const py = vby + (1 - i / 4) * vbh;
      const dy = ylo + (PH - py) / PH * (yhi - ylo);
      if (yticks[i]) yticks[i].textContent = Math.round(dy) + ysuf;
    }
    const zoomed = vbw < PW - 0.5;
    svg.classList.toggle('zoomed', zoomed);
    if (badgeTxt) badgeTxt.textContent = s.toFixed(1).replace(/\.0$/, '') + '×';
    svg.style.touchAction = zoomed ? 'none' : 'pan-y';
  };
  const clamp = () => {
    vbw = Math.min(PW, Math.max(PW / MAX, vbw));
    vbh = vbw * PH / PW;
    vbx = Math.min(PW - vbw, Math.max(0, vbx));
    vby = Math.min(PH - vbh, Math.max(0, vby));
  };
  const toLocal = (cx, cy) => {
    const r = svg.getBoundingClientRect();
    return {
      x: vbx + ((cx - r.left) / r.width * FW - L) / PW * vbw,
      y: vby + ((cy - r.top) / r.height * FH - T) / PH * vbh,
    };
  };
  const zoomAt = (fx, fy, f) => {
    const nw = Math.min(PW, Math.max(PW / MAX, vbw / f)), ratio = nw / vbw;
    vbx = fx - (fx - vbx) * ratio;
    vby = fy - (fy - vby) * ratio;
    vbw = nw;
    clamp(); apply();
  };
  const reset = () => { vbx = 0; vby = 0; vbw = PW; vbh = PH; apply(); };

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const p = toLocal(e.clientX, e.clientY);
    zoomAt(p.x, p.y, e.deltaY < 0 ? 1.05 : 1 / 1.05);
  }, { passive: false });
  svg.addEventListener('dblclick', e => { e.preventDefault(); reset(); });
  const badge = svg.querySelector('.ch-zoom-badge');
  if (badge) badge.addEventListener('click', e => { e.stopPropagation(); reset(); });

  const ptrs = new Map();
  let lastDist = 0, moved = false;
  svg.addEventListener('pointerdown', e => {
    if (ptrs.size === 0) moved = false;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      lastDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  svg.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId), cur = { x: e.clientX, y: e.clientY };
    ptrs.set(e.pointerId, cur);
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastDist > 0) {
        const m = toLocal((a.x + b.x) / 2, (a.y + b.y) / 2);
        zoomAt(m.x, m.y, Math.pow(dist / lastDist, 0.5));   // damped so the pinch is less twitchy
      }
      lastDist = dist; moved = true;
    } else if (ptrs.size === 1 && vbw < PW - 0.5) {
      const r = svg.getBoundingClientRect();
      vbx -= (cur.x - prev.x) / r.width * FW / PW * vbw;
      vby -= (cur.y - prev.y) / r.height * FH / PH * vbh;
      clamp(); apply();
      moved = true;
    }
  });
  const end = e => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) lastDist = 0;
    if (ptrs.size === 0 && moved) _lastPanEnd = Date.now();
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  apply();   // initial transform, dot size and tick labels
}

// ── INIT ───────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('charts.html');
  await initAuth();
  _renderPicker();
  // Tap a chart element (bar, dot, slice, cell) to pin its stats in the caption;
  // tap anywhere else to clear it. Document-level so a tap outside the chart
  // deselects too.
  document.addEventListener('click', e => {
    if (e.target.closest('.chart-caption-link')) return;   // let a caption link navigate
    const cap = document.getElementById('chartCaption');
    // The click that ends a pan/pinch should still clear any existing selection
    // (it landed inside the chart, same as any other non-dot tap); it should
    // only be stopped from being read as "tap a dot" and selecting a new one.
    const justPanned = Date.now() - _lastPanEnd < 250;
    const hit = justPanned ? null : e.target.closest('.ch-hit');
    const wasSel = hit && hit.classList.contains('sel');
    document.querySelectorAll('#chartStage .ch-hit.sel').forEach(d => d.classList.remove('sel'));
    if (cap) {
      cap.textContent = '';                                // wipe the whole caption (links + text) every time
      // WebKit/Safari can leave the old text visually painted here even though
      // the DOM is genuinely empty (confirmed: cleared node has no children,
      // yet stale text remains on screen until something else forces a
      // repaint, e.g. opening devtools). Toggling display forces one.
      cap.style.display = 'none';
      void cap.offsetHeight;
      cap.style.display = '';
    }
    if (!hit || wasSel) return;                            // tapped empty space, or tapped to deselect
    if (!hit.getAttribute('data-name')) return;             // no name to show; leave the caption cleared rather than a dangling "| box | meta"
    hit.classList.add('sel');
    // Donut slices overlap at their borders, so raise the selected slice to the
    // front for a clean outline. Only paths (donut arcs) need this; raising a
    // heatmap cell <rect> would cover its own % label drawn just after it.
    if (hit.tagName.toLowerCase() === 'path' && hit.parentNode) hit.parentNode.appendChild(hit);
    if (!cap) return;
    // Build the caption from DOM nodes (no innerHTML string), skipping any empty
    // part so a missing name can never leave a dangling " | meta" behind.
    const part = (text, href) => {
      if (!text) return null;
      if (!href) return document.createTextNode(text);
      const a = document.createElement('a');
      a.className = 'chart-caption-link';
      a.href = href;
      a.textContent = text;
      return a;
    };
    const nodes = [
      part(hit.getAttribute('data-name'), hit.getAttribute('data-href')),
      part(hit.getAttribute('data-box'), hit.getAttribute('data-boxhref')),   // scatter's secondary box link
      part(hit.getAttribute('data-meta'), null),
    ].filter(Boolean);
    // Matchups join their two names with " vs " (data-join); the rest with " | ".
    const join = hit.getAttribute('data-join');
    nodes.forEach((n, i) => { if (i) cap.append(i === 1 && join ? join : ' | '); cap.append(n); });
  });
  // A language switch brings back the chart being shown, its mode and the
  // filters (lang.js).
  const saved = takeViewState();
  if (saved) {
    Object.assign(_modes, saved.modes);
    Object.assign(_groups, saved.groups);
    size.set(saved.size);
    period.set(saved.period);
  }
  keepViewState(() => ({ chart: _selected, modes: _modes, groups: _groups, size: size.value(), period: period.get() }));
  period.load();
  selectChart(CHARTS.some(c => c.id === saved?.chart) ? saved.chart : CHARTS[0].id);
}

init();
