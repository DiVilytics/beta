// ── CHARTS PAGE ──────────────────────────────────────────────────────────────
// A hub of visualizations: a row of chips picks a chart, rendered lazily into the
// card below via the hand-rolled SVG helpers in chart-lib.js. Data is fetched on
// first view of a chart and cached for the session. Charts that need a not-yet-
// installed RPC degrade to a short "add this function" note.

// ── SHARED DATASETS (lazy + cached) ────────────────────────────────────────────

const _data = {};

// Per-character games/wins (character_stats view) joined with pace + box.
async function _characterStats() {
  if (_data.charStats) return _data.charStats;
  const [{ rows }, chars] = await Promise.all([
    _fetchAllRows(() => db.from('character_stats').select('*')),
    loadCharacters(),
  ]);
  const byName = Object.fromEntries(chars.map(c => [c.name, c]));
  _data.charStats = rows.map(r => ({
    name:  r.character,
    games: Number(r.games),
    wins:  Number(r.wins),
    pace:  byName[r.character]?.pace || null,
    box:   byName[r.character]?.box  || null,
  }));
  return _data.charStats;
}

// All games' played_at / duration / rounds (small rows, paged past the cap).
async function _gamesLite() {
  if (_data.games) return _data.games;
  const { rows } = await _fetchAllRows(() => db.from('games').select('played_at, duration_minutes, num_turns'));
  _data.games = rows;
  return _data.games;
}

// Games + avg duration per table size, via the existing game_stats RPC (one call
// per size, 2..6).
async function _sizeStats() {
  if (_data.sizeStats) return _data.sizeStats;
  const sizes = [2, 3, 4, 5, 6];
  const res = await Promise.all(sizes.map(n => db.rpc('game_stats', { player_count_filter: n })));
  _data.sizeStats = sizes.map((n, i) => {
    const row = (res[i].data || [])[0] || { games: 0, avg_duration: null };
    return { size: n, games: Number(row.games) || 0, avgDur: row.avg_duration };
  });
  return _data.sizeStats;
}

// Games-per-player counts (player_stats view); players with at least one game.
async function _playerStats() {
  if (_data.playerStats) return _data.playerStats;
  const { rows } = await _fetchAllRows(() => db.from('player_stats').select('games'));
  _data.playerStats = rows.map(r => Number(r.games)).filter(g => g > 0);
  return _data.playerStats;
}

// First month (YYYY-MM, inclusive) the "Games over time" chart shows. Earlier
// months are only the imported BoardGameGeek games, whose dates are placeholders
// spread over Apr 2020 - Nov 2024; real recorded games start in December 2024.
const TIME_CHART_FROM = '2024-12';

// ── CHART REGISTRY ─────────────────────────────────────────────────────────────
// Each: { id, icon, label, desc, render() -> SVG/HTML string }.

const CHARTS = [
  {
    id: 'scatter', icon: '🎯', label: 'Win rate vs popularity',
    desc: 'Each villain by games played (x) and win rate (y); the axes zoom to the data. Up-left is strong but rarely picked, down-right is popular but weak. Tap a dot to open it.',
    async render() {
      const cs = (await _characterStats()).filter(c => c.games > 0);
      const points = cs.map(c => {
        const pct = Math.round(c.wins / c.games * 100);
        return {
          x: c.games,
          y: pct,
          label: c.name,
          color: c.pace ? `var(--pace-${c.pace})` : 'var(--pace-gray)',
          href: `characters.html?char=${encodeURIComponent(c.name)}`,
          box: c.box || null,
          boxHref: c.box ? `characters.html?box=${boxAnchorId(c.box)}` : null,
          meta: `${c.games} games | ${pct}% win rate`,
        };
      });
      return Charts.scatter(points, { xLabel: 'Games played', ySuffix: '%', yMax: 100 });
    },
  },
  {
    id: 'pace', icon: '🎨', label: 'Win rate by pace',
    desc: "Each pace band's overall win rate, pooling every villain of that colour (total wins over total games). Tap a band for its games and villains.",
    async render() {
      const cs = await _characterStats();
      const bands = ['green', 'yellow', 'orange', 'red', 'gray'];
      const data = bands.map(b => {
        const rows  = b === 'gray' ? cs.filter(c => !c.pace) : cs.filter(c => c.pace === b);
        const games = rows.reduce((a, c) => a + c.games, 0);
        const wins  = rows.reduce((a, c) => a + c.wins,  0);
        const pct   = games ? Math.round(wins / games * 100) : 0;
        return { label: b[0].toUpperCase() + b.slice(1), value: pct, games, color: `var(--pace-${b})`, href: `characters.html?pace=${b}`, meta: `${pct}% win rate | ${games} games | ${rows.length} villains` };
      }).filter(d => d.games > 0);
      return Charts.barsH(data, { axisFmt: v => `${v}%`, labelW: 60 });
    },
  },
  {
    id: 'box', icon: '📦', label: 'Win rate by box',
    desc: "Each expansion box's overall win rate, pooling every villain in the box (total wins over total games); bars are sorted strongest first. Tap a box for its total games.",
    async render() {
      const [cs, boxInfo] = await Promise.all([_characterStats(), loadBoxInfo()]);
      const byBox = {};
      for (const c of cs) {
        if (!c.box) continue;
        (byBox[c.box] ||= { games: 0, wins: 0, villains: 0 });
        byBox[c.box].games += c.games;
        byBox[c.box].wins  += c.wins;
        byBox[c.box].villains++;
      }
      const data = Object.entries(byBox)
        .filter(([, v]) => v.games > 0)
        .map(([box, v]) => {
          const pct  = Math.round(v.wins / v.games * 100);
          const year = boxInfo[box]?.year;
          return {
            label: box,
            value: pct,
            games: v.games,
            href: `characters.html?box=${boxAnchorId(box)}`,
            meta: `${year ? year + ' | ' : ''}${pct}% win rate | ${v.games} games | ${v.villains} villains`,
          };
        })
        .sort((a, b) => b.value - a.value);
      return Charts.barsH(data, { axisFmt: v => `${v}%`, labelW: 152 });
    },
  },
  {
    id: 'boxpop', icon: '🔥', label: 'Box popularity',
    desc: "How often each box's villains are picked across all recorded games. Bars are sorted most-played first; tap one to open the box.",
    async render() {
      const [cs, boxInfo] = await Promise.all([_characterStats(), loadBoxInfo()]);
      const byBox = {};
      let total = 0;
      for (const c of cs) {
        if (!c.box) continue;
        (byBox[c.box] ||= { games: 0, villains: 0 });
        byBox[c.box].games += c.games;
        byBox[c.box].villains++;
        total += c.games;
      }
      const data = Object.entries(byBox)
        .filter(([, v]) => v.games > 0)
        .map(([box, v]) => {
          const year = boxInfo[box]?.year;
          return {
            label: box,
            value: v.games,
            href: `characters.html?box=${boxAnchorId(box)}`,
            meta: `${year ? year + ' | ' : ''}${v.games} picks | ${Math.round(v.games / (total || 1) * 100)}% of all picks | ${v.villains} villains`,
          };
        })
        .sort((a, b) => b.value - a.value);
      return Charts.barsH(data, { labelW: 152 });
    },
  },
  {
    id: 'duration', icon: '⏱️', label: 'Game duration',
    desc: 'How many games fall into each 15-minute band (0-15, 15-30, and so on); the band start in minutes is under each bar. Counts only games with a recorded duration.',
    async render() {
      const vals = (await _gamesLite()).map(g => g.duration_minutes).filter(v => v != null);
      if (!vals.length) return Charts.barsV([]);
      const SIZE = 15;   // 15-minute buckets
      const max = Math.max(...vals);
      const n = Math.floor(max / SIZE) + 1;
      const buckets = Array.from({ length: n }, (_, b) => ({ lo: b * SIZE, hi: (b + 1) * SIZE, value: 0 }));
      for (const v of vals) buckets[Math.min(n - 1, Math.floor(v / SIZE))].value++;
      for (const b of buckets) { b.name = `${b.lo}-${b.hi} min`; b.meta = `${b.value} game${b.value === 1 ? '' : 's'}`; }
      return Charts.barsV(buckets, {
        fmt: (v, d) => `${d.lo}-${d.hi} min: ${v}`,
        xTick: i => buckets[i].lo,
        xEvery: 1,
      });
    },
  },
  {
    id: 'avglen', icon: '⏳', label: 'Avg duration by players',
    desc: 'Average recorded game duration in minutes for each table size, from 2 to 6 players. Averaged only over games that recorded a duration.',
    async render() {
      const bySize = Object.fromEntries((await _sizeStats()).map(s => [s.size, s]));
      const data = [2, 3, 4, 5, 6].map(size => {              // always show every table size, even empty
        const s = bySize[size];
        const has = s && s.games > 0 && s.avgDur != null;
        const m = has ? Math.round(s.avgDur) : 0;
        return {
          label: `${size}p`,
          value: m,
          has,
          meta: has ? `${m} min average | ${s.games} games` : (s && s.games > 0 ? 'no duration recorded' : 'no games recorded'),
        };
      });
      return Charts.barsH(data, { labelW: 48 });
    },
  },
  {
    id: 'rounds', icon: '🔁', label: 'Rounds per game',
    desc: 'How many games fall into each 3-round band, grouped to smooth out noise. Counts only games with a recorded round count.',
    async render() {
      const vals = (await _gamesLite()).map(g => g.num_turns).filter(v => v != null);
      if (!vals.length) return Charts.barsV([]);
      const SIZE = 3;   // group rounds into 3-round bands to smooth out noise
      const lo0 = Math.floor(Math.min(...vals) / SIZE) * SIZE;
      const hi0 = Math.floor(Math.max(...vals) / SIZE) * SIZE;
      const buckets = [];
      for (let b = lo0; b <= hi0; b += SIZE) buckets.push({ lo: b, hi: b + SIZE - 1, value: 0 });
      for (const v of vals) buckets[Math.floor((v - lo0) / SIZE)].value++;
      for (const b of buckets) { b.name = `${b.lo}-${b.hi} rounds`; b.meta = `${b.value} game${b.value === 1 ? '' : 's'}`; }
      return Charts.barsV(buckets, {
        fmt: (v, d) => `${d.lo}-${d.hi} rounds: ${v}`,
        xTick: i => buckets[i].lo,
        xEvery: 1,
      });
    },
  },
  {
    id: 'tablesize', icon: '👥', label: 'Players per game',
    desc: 'Share of recorded games by table size, from 2 to 6 players. Tap a slice for its exact game count and percentage.',
    async render() {
      const ss = (await _sizeStats()).filter(s => s.games > 0);
      const total = ss.reduce((a, s) => a + s.games, 0) || 1;
      const segs = ss.map(s => ({ label: `${s.size}p`, value: s.games, meta: `${s.games} games | ${Math.round(s.games / total * 100)}%` }));
      return Charts.donut(segs);
    },
  },
  {
    id: 'perplayer', icon: '🎮', label: 'Games per player',
    desc: 'How many games each player has recorded, as a distribution. Most players appear in a few games; a few are very active.',
    async render() {
      const vals = await _playerStats();
      if (!vals.length) return Charts.barsV([]);
      const max = Math.max(...vals);
      const SIZE = 5;   // fixed 5-game bands (1-5, 6-10, ...)
      const n = Math.floor((max - 1) / SIZE) + 1;
      const buckets = Array.from({ length: n }, (_, b) => ({ lo: b * SIZE + 1, hi: (b + 1) * SIZE, value: 0 }));
      for (const p of vals) buckets[Math.min(n - 1, Math.floor((p - 1) / SIZE))].value++;
      for (const b of buckets) {
        b.name = `${b.lo}-${b.hi} games`;
        b.meta = `${b.value} player${b.value === 1 ? '' : 's'}`;
      }
      return Charts.barsV(buckets, { xTick: i => buckets[i].lo, xEvery: Math.max(1, Math.ceil(n / 12)) });
    },
  },
  {
    id: 'time', icon: '📈', label: 'Games over time',
    desc: 'Games recorded per calendar month, by play date (labelled YYYY/MM), from December 2024. Shows the latest 12 months; drag sideways to see earlier ones.',
    async render() {
      const byMonth = {};
      for (const g of await _gamesLite()) {
        if (!g.played_at) continue;
        const k = String(g.played_at).slice(0, 7);   // YYYY-MM
        if (k < TIME_CHART_FROM) continue;
        byMonth[k] = (byMonth[k] || 0) + 1;
      }
      // Every calendar month from the first to the last, empty ones as 0, so the
      // 12 visible points are really 12 consecutive months.
      const months = Object.keys(byMonth).sort();
      const pts = [];
      if (months.length) {
        let [y, m] = months[0].split('-').map(Number);
        const last = months[months.length - 1];
        for (let k = months[0]; k <= last; ) {
          const c = byMonth[k] || 0;
          pts.push({ label: k.replace('-', '/'), value: c, meta: `${c} game${c === 1 ? '' : 's'}` });   // YYYY/MM
          m++; if (m > 12) { m = 1; y++; }
          k = `${y}-${String(m).padStart(2, '0')}`;
        }
      }
      return Charts.line(pts, { visible: 12 });
    },
  },
  {
    id: 'weekday', icon: '📅', label: 'Games by weekday',
    desc: 'Number of games recorded on each weekday, by play date. Weekday is derived from your local time zone.',
    async render() {
      const counts = new Array(7).fill(0);   // 0 = Sunday
      for (const g of await _gamesLite()) {
        if (!g.played_at) continue;
        counts[new Date(g.played_at).getDay()]++;
      }
      const order  = [1, 2, 3, 4, 5, 6, 0];   // Monday first
      const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const full   = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      const data = order.map((d, i) => ({ value: counts[d], name: full[i], meta: `${counts[d]} game${counts[d] === 1 ? '' : 's'}` }));
      return Charts.barsV(data, { xTick: i => labels[i], xEvery: 1 });
    },
  },
  {
    id: 'seatorder', icon: '🪑', label: 'Turn-order advantage',
    desc: "Win rate of each seat in play order (seat 1 plays first) per table size. Warmer cells are above the fair share (1 / players); the cell shows the win rate. Recorded-seating games only.",
    async render() {
      const { data, error } = await db.rpc('position_stats');
      if (error || !data || !data.length) return _needRpc('position_stats');
      const bySize = {};
      for (const r of data) {
        const size = Number(r.player_count), seat = Number(r.seat);
        (bySize[size] ||= {})[seat] = { games: Number(r.games), wins: Number(r.wins) };
      }
      const sizes = [2, 3, 4, 5, 6];              // always render the full grid; cells with no data show greyed
      const maxSeat = 6;
      const rowLabels = sizes.map(s => `${s}p`);
      const colLabels = Array.from({ length: maxSeat }, (_, i) => `Seat ${i + 1}`);
      return Charts.heatmap(rowLabels, colLabels, (ri, ci) => {
        const s = sizes[ri], seat = ci + 1;       // seats are 1-based (ranked play order)
        if (seat > s) return null;                // that seat does not exist for this size
        const cell = bySize[s] && bySize[s][seat];
        if (!cell || !cell.games) return null;
        const pct = cell.wins / cell.games, fair = 1 / s;
        const t = (pct / fair - 0.5) / 1.5;       // 0.5x..2x of fair -> 0..1 on the ramp
        return {
          value: t,
          label: `${Math.round(pct * 100)}%`,
          name:  `${s}p, seat ${seat}`,
          meta:  `${Math.round(pct * 100)}% win | fair ${Math.round(fair * 100)}% | ${cell.games} games`,
        };
      });
    },
  },
];

function _needRpc(name) {
  return `<div class="chart-note">This chart needs the <code>${_esc(name)}</code> function in Supabase. Add it, then refresh.</div>`;
}

// ── PICKER + RENDER ────────────────────────────────────────────────────────────

let _selected = null;
let _lastPanEnd = 0;   // timestamp of the last scatter pan/pinch; suppresses the click that ends it
function _renderPicker() {
  document.getElementById('chartPicker').innerHTML =
    `<div class="chart-select-wrap"><select class="chart-select" aria-label="Choose a chart" onchange="selectChart(this.value)">` +
    CHARTS.map(c => `<option value="${c.id}"${c.id === _selected ? ' selected' : ''}>${c.icon} ${_esc(c.label)}</option>`).join('') +
    `</select><span class="chart-chevron">▾</span></div>`;
}

async function selectChart(id) {
  const c = CHARTS.find(x => x.id === id);
  if (!c) return;
  _selected = id;
  _renderPicker();
  document.getElementById('chartDesc').textContent = c.desc;
  const cap = document.getElementById('chartCaption');
  if (cap) cap.textContent = '';
  const stage = document.getElementById('chartStage');
  stage.innerHTML = `<div class="chart-note">Loading…</div>`;
  try {
    stage.innerHTML = await c.render();
    const z = stage.querySelector('.ch-zoomable');
    if (z) _attachZoom(z);
    const lp = stage.querySelector('.ch-pannable');
    if (lp) _attachLinePan(lp);
  } catch (e) {
    console.error('chart render failed:', e);
    stage.innerHTML = `<div class="chart-note">Could not load this chart.</div>`;
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
// to MAX (20x). Records _lastPanEnd so the click that ends a gesture does not select a
// dot, and touch-action flips to 'none' only while zoomed so the page still
// scrolls at the default view.
function _attachZoom(svg) {
  const pan = svg.querySelector('.ch-pan');
  if (!pan) return;
  const FW = 440, FH = 280, MAX = 20;
  const L = +pan.dataset.l, R = +pan.dataset.r, T = +pan.dataset.t, B = +pan.dataset.b;
  const PW = FW - L - R, PH = FH - T - B;
  const xlo = +pan.dataset.xlo, xhi = +pan.dataset.xhi, ylo = +pan.dataset.ylo, yhi = +pan.dataset.yhi;
  const xsuf = pan.dataset.xsuf || '', ysuf = pan.dataset.ysuf || '';
  const xticks = svg.querySelectorAll('.ch-xtick'), yticks = svg.querySelectorAll('.ch-ytick');
  const dots = pan.querySelectorAll('.ch-dot');
  const badgeTxt = svg.querySelector('.ch-zoom-badge-txt');

  let vbx = 0, vby = 0, vbw = PW, vbh = PH;   // visible window in plot-local space
  const apply = () => {
    const s = PW / vbw;
    pan.setAttribute('transform', `translate(${(L - s * (L + vbx)).toFixed(2)} ${(T - s * (T + vby)).toFixed(2)}) scale(${s.toFixed(4)})`);
    // Dots grow with zoom: 8px on screen at the default view up to 2x (16px) at
    // max zoom. r is in pre-transform units, so divide the target screen size by
    // the group scale s. (The selection ring stays constant via non-scaling-stroke.)
    const grow = 1 + (s - 1) / (MAX - 1);   // 1 at default, 2 at MAX
    const r = (8 * grow / s).toFixed(2);
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
    nodes.forEach((n, i) => { if (i) cap.append(' | '); cap.append(n); });
  });
  selectChart(CHARTS[0].id);
}

init();
