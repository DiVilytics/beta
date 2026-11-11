// ── STRENGTH AND SKILL ───────────────────────────────────────────────────────
// A model of who wins, from every official game (the test page strength.html
// first; the Leaderboard later). At a table, a seat's score is
//
//   u = b[villain]                          the villain's strength (static)
//     + c[k][position]                      the seat's edge at k players (static, sum 0 per k; 0 if no order)
//     + if claimed: a[player](game)         the player's skill at that game (a curve in time)
//                 + d[player][villain]      their skill with that villain (pooled toward 0)
//                 + β · log(1 + n)          n: their earlier games with that villain
//                 + γ · mean log(1 + m)     m: their earlier games seeing each opponent's villain
//
// and P(seat i wins) = exp(u_i) / Σ_j exp(u_j) (Luce). Every parameter starts
// from a normal prior around 0; a player's skill follows a mean-reverting
// random walk from one of their games to the next:
//
//   a(next) = ρ · a(prev) + noise,  ρ = exp(−days / λ)  (rust: back toward 0 when idle),
//   noise variance = τp² (per game) + τt² · days
//
// The maximum a posteriori is found by block coordinate Newton steps (the
// objective is concave: one optimum): the static terms one parameter at a time,
// each player's curve whole (a tridiagonal system, Thomas' algorithm: a Kalman
// smoother). Returns the estimates with their uncertainty (σ, from the
// curvature). Pure functions, no DOM: the page and a test script share them.

// Tuned with strengthTest on the games of 2026 (two cuts, 2026-11-11): the
// seat and the player's skill predict the most; knowing the opponents' villains
// (γ) made the predictions worse with so few claimed games, so it's off for now.
const STRENGTH_DEFAULTS = {
  sb: 1.0,      // σ_b: villains' strength prior
  sc: 0.3,      // σ_c: seat edge prior
  sd: 0.3,      // σ_d: player-with-villain prior
  sbg: 0.5,     // σ for β and γ
  s0: 1.0,      // σ_0: a player's skill at their first game
  tp: 0.05,     // τ_p: change per game
  tt: 0,        // τ_t: change per day (0: the games change it, not the days)
  lambda: 365,  // λ: rust, days for an idle player's skill to fall to 1/e of itself
  tol: 1e-3,    // the fit stops once no parameter moves more than this
  terms: { seat: true, pair: true, exp: true, know: false },
};
const _DAY = 86400000;

// The data, once per set of games: seats, their indices and their features.
// games: [{ at (ms or null), seats: [{ character, user_id, position, is_winner }] }].
function strengthPrepare(games) {
  const vIdx = new Map(), pIdx = new Map(), pairIdx = new Map();
  const villains = [], players = [], pairs = [];
  const idx = (map, list, key, mk) => { if (!map.has(key)) { map.set(key, list.length); list.push(mk()); } return map.get(key); };
  // Games with one winner; the dated ones in time order first (the players'
  // curves and the counts run in that order), then the undated (no player there).
  const ok = games.filter(g => g.seats.length >= 2 && g.seats.filter(s => s.is_winner).length === 1);
  const dated = ok.filter(g => g.at != null).sort((a, b) => a.at - b.at);
  const undated = ok.filter(g => g.at == null);
  const G = [];
  const own = new Map(), seen = new Map();   // player → { villain: earlier games }
  const cnt = (m, p) => m.get(p) || m.set(p, {}).get(p);
  for (const g of [...dated, ...undated]) {
    const k = g.seats.length;
    const ordered = g.seats.every(s => s.position != null) && new Set(g.seats.map(s => s.position)).size === k;
    const pos = ordered ? [...g.seats].map(s => s.position).sort((a, b) => a - b) : null;
    const seats = g.seats.map(s => ({
      v: idx(vIdx, villains, s.character, () => ({ name: s.character })),
      pos: ordered ? pos.indexOf(s.position) : -1,
      win: !!s.is_winner,
      p: -1, node: -1, pair: -1, x: 0, z: 0, ch: s.character, uid: g.at != null ? s.user_id : null,
    }));
    for (const s of seats) {
      if (!s.uid) continue;
      s.p = idx(pIdx, players, s.uid, () => ({ uid: s.uid, nodes: [] }));
      s.pair = idx(pairIdx, pairs, s.uid + '|' + s.ch, () => ({ p: s.p, v: s.v }));
      const o = cnt(own, s.uid), sn = cnt(seen, s.uid);
      s.x = Math.log(1 + (o[s.ch] || 0));
      const opp = seats.filter(t => t !== s);
      s.z = opp.reduce((sum, t) => sum + Math.log(1 + (sn[t.ch] || 0)), 0) / opp.length;
      const pl = players[s.p];
      s.node = pl.nodes.length;
      pl.nodes.push({ at: g.at });
    }
    for (const s of seats) {
      if (!s.uid) continue;
      const o = cnt(own, s.uid), sn = cnt(seen, s.uid);
      o[s.ch] = (o[s.ch] || 0) + 1;
      for (const t of seats) sn[t.ch] = (sn[t.ch] || 0) + 1;
    }
    G.push({ k, seats, at: g.at });
  }
  return { G, villains, players, pairs };
}

// The fit. data: strengthPrepare's; opts: STRENGTH_DEFAULTS' keys (any subset).
function strengthFit(data, opts = {}) {
  const o = { ...STRENGTH_DEFAULTS, ...opts, terms: { ...STRENGTH_DEFAULTS.terms, ...(opts.terms || {}) } };
  const { G, villains, players, pairs } = data;
  const b = new Float64Array(villains.length);
  const c = Array.from({ length: 7 }, (_, k) => new Float64Array(k));   // c[k][s], k 2..6
  const d = new Float64Array(pairs.length);
  let beta = 0, gamma = 0;
  const a = players.map(pl => new Float64Array(pl.nodes.length));
  const seats = G.flatMap(g => g.seats.map(s => (s.g = g, s)));

  const score = s => b[s.v]
    + (o.terms.seat && s.pos >= 0 ? c[s.g.k][s.pos] : 0)
    + (s.p >= 0 ? a[s.p][s.node] + (o.terms.pair ? d[s.pair] : 0) + (o.terms.exp ? beta * s.x : 0) + (o.terms.know ? gamma * s.z : 0) : 0);
  // Every seat's probability, surprise r (won − P) and certainty h (P(1 − P)).
  const refresh = () => {
    for (const g of G) {
      let mx = -Infinity;
      for (const s of g.seats) { s.u = score(s); if (s.u > mx) mx = s.u; }
      let sum = 0;
      for (const s of g.seats) { s.e = Math.exp(s.u - mx); sum += s.e; }
      for (const s of g.seats) { s.P = s.e / sum; s.r = (s.win ? 1 : 0) - s.P; s.h = s.P * (1 - s.P); }
    }
  };
  // One Newton step for a group of scalar parameters (key: which one a seat
  // feeds, weight: its feature), each pulled toward 0 by its prior σ.
  const step = (vals, n, key, sigma, weight = () => 1) => {
    const gr = new Float64Array(n), cu = new Float64Array(n);
    for (const s of seats) {
      const i = key(s);
      if (i < 0) continue;
      const w = weight(s);
      gr[i] += s.r * w;
      cu[i] += s.h * w * w;
    }
    let mx = 0;
    for (let i = 0; i < n; i++) {
      const prec = 1 / (sigma * sigma);
      const dlt = 0.9 * (gr[i] - vals[i] * prec) / (cu[i] + prec);
      vals[i] += dlt;
      if (Math.abs(dlt) > mx) mx = Math.abs(dlt);
    }
    return { mx, cu };
  };

  // A player's curve: the prior's tridiagonal precision (mean-reverting walk)
  // and the games' certainty, one Newton step for the whole curve.
  const chain = pl => {
    const N = pl.nodes.length, rho = new Float64Array(N), q = new Float64Array(N);
    for (let n = 1; n < N; n++) {
      const days = Math.max(0, (pl.nodes[n].at - pl.nodes[n - 1].at) / _DAY);
      rho[n] = Math.exp(-days / o.lambda);
      q[n] = o.tp * o.tp + o.tt * o.tt * days;
    }
    return { N, rho, q };
  };
  const chains = players.map(chain);
  const playerSeats = players.map(() => []);
  for (const s of seats) if (s.p >= 0) playerSeats[s.p].push(s);
  // Tridiagonal: diag D, off-diagonal E (between n−1 and n); solve and the inverse's diagonal.
  const curveStep = (pi, wantVar) => {
    const { N, rho, q } = chains[pi], x = a[pi];
    const D = new Float64Array(N), E = new Float64Array(N), g = new Float64Array(N);
    for (const s of playerSeats[pi]) { D[s.node] += s.h; g[s.node] += s.r; }
    D[0] += 1 / (o.s0 * o.s0);
    g[0] -= x[0] / (o.s0 * o.s0);
    for (let n = 1; n < N; n++) {
      const e = x[n] - rho[n] * x[n - 1], w = 1 / q[n];
      D[n] += w; D[n - 1] += rho[n] * rho[n] * w; E[n] = -rho[n] * w;
      g[n] -= e * w; g[n - 1] += rho[n] * e * w;
    }
    // Thomas: forward elimination, back substitution.
    const cp = new Float64Array(N), dp = new Float64Array(N);
    cp[0] = (N > 1 ? E[1] : 0) / D[0]; dp[0] = g[0] / D[0];
    for (let n = 1; n < N; n++) {
      const m = D[n] - E[n] * cp[n - 1];
      cp[n] = (n + 1 < N ? E[n + 1] : 0) / m;
      dp[n] = (g[n] - E[n] * dp[n - 1]) / m;
    }
    const dx = new Float64Array(N);
    dx[N - 1] = dp[N - 1];
    for (let n = N - 2; n >= 0; n--) dx[n] = dp[n] - cp[n] * dx[n + 1];
    let mx = 0;
    for (let n = 0; n < N; n++) { x[n] += 0.9 * dx[n]; mx = Math.max(mx, Math.abs(dx[n])); }
    if (!wantVar) return mx;
    // The inverse's diagonal (each game's variance): the Schur complements from
    // both ends (ratios, so long curves don't overflow), 1 / (α + β − D).
    const al = new Float64Array(N), be = new Float64Array(N);
    al[0] = D[0];
    for (let n = 1; n < N; n++) al[n] = D[n] - E[n] * E[n] / al[n - 1];
    be[N - 1] = D[N - 1];
    for (let n = N - 2; n >= 0; n--) be[n] = D[n] - E[n + 1] * E[n + 1] / be[n + 1];
    return Array.from({ length: N }, (_, n) => 1 / (al[n] + be[n] - D[n]));
  };

  let iter = 0, change = Infinity;
  for (; iter < 200 && change > (o.tol ?? 1e-4); iter++) {
    change = 0;
    refresh(); change = Math.max(change, step(b, villains.length, s => s.v, o.sb).mx);
    if (o.terms.seat) {
      for (let k = 2; k <= 6; k++) {
        refresh();
        change = Math.max(change, step(c[k], k, s => s.g.k === k ? s.pos : -1, o.sc).mx);
        const mean = c[k].reduce((x, y) => x + y, 0) / k;
        for (let s = 0; s < k; s++) c[k][s] -= mean;   // sum 0: only the differences count
      }
    }
    if (o.terms.pair) { refresh(); change = Math.max(change, step(d, pairs.length, s => s.pair, o.sd).mx); }
    if (o.terms.exp)  { refresh(); const bv = [beta];  change = Math.max(change, step(bv, 1, s => s.p >= 0 ? 0 : -1, o.sbg, s => s.x).mx); beta = bv[0]; }
    if (o.terms.know) { refresh(); const gv = [gamma]; change = Math.max(change, step(gv, 1, s => s.p >= 0 ? 0 : -1, o.sbg, s => s.z).mx); gamma = gv[0]; }
    refresh();
    for (let pi = 0; pi < players.length; pi++) change = Math.max(change, curveStep(pi, false));
  }

  // Uncertainties: the static ones from their curvature, the curves' from the inverse.
  refresh();
  const curv = new Float64Array(villains.length);
  for (const s of seats) curv[s.v] += s.h;
  const vOut = villains.map((v, i) => ({ name: v.name, u: b[i], sd: 1 / Math.sqrt(curv[i] + 1 / (o.sb * o.sb)), games: 0, wins: 0, exp: 0, vari: 0 }));
  for (const s of seats) { vOut[s.v].games++; if (s.win) vOut[s.v].wins++; }
  const pOut = players.map((pl, pi) => {
    const v = curveStep(pi, true);   // one more (tiny) step, and the variances
    const games = playerSeats[pi].length, wins = playerSeats[pi].filter(s => s.win).length;
    return { uid: pl.uid, curve: pl.nodes.map((nd, n) => ({ at: nd.at, u: a[pi][n], sd: Math.sqrt(v[n]) })), games, wins, exp: 0, vari: 0 };
  });
  // The corrected Δ Wins (chanceDelta, stats-table.js: (W − E) / √V): E the
  // wins an average villain (b = 0) would have had in each of the villain's
  // seats, everything else at the table as it was (the opponents, the seat,
  // the players); for a player, an average player (their own terms at 0) with
  // the same villains, seats and opponents. V their variance, E's P(1 − P).
  refresh();
  for (const g of G) {
    const tot = g.seats.reduce((x, t) => x + t.e, 0);
    for (const s of g.seats) {
      const rest = tot - s.e;
      const ev = s.e * Math.exp(-b[s.v]);
      const pv = ev / (ev + rest);
      vOut[s.v].exp += pv; vOut[s.v].vari += pv * (1 - pv);
      if (s.p >= 0) {
        const own = a[s.p][s.node] + (o.terms.pair ? d[s.pair] : 0) + (o.terms.exp ? beta * s.x : 0) + (o.terms.know ? gamma * s.z : 0);
        const ep = s.e * Math.exp(-own);
        const pp = ep / (ep + rest);
        pOut[s.p].exp += pp; pOut[s.p].vari += pp * (1 - pp);
      }
    }
  }
  return {
    villains: vOut, players: pOut, iterations: iter,
    seat: c.map(arr => Array.from(arr)), beta, gamma,
    pairs: pairs.map((pr, i) => ({ uid: players[pr.p].uid, villain: villains[pr.v].name, d: d[i] })),
    opts: o,
  };
}

// A player's skill now (or at `at`): their last game's, rusted toward 0 by the
// days since, with the uncertainty grown by them.
function strengthNow(fit, player, at = Date.now()) {
  const last = player.curve[player.curve.length - 1];
  const days = Math.max(0, (at - last.at) / _DAY);
  const rho = Math.exp(-days / fit.opts.lambda);
  const v = rho * rho * last.sd * last.sd + fit.opts.tt * fit.opts.tt * days;
  return { u: rho * last.u, sd: Math.sqrt(v) };
}

// A score as a chance: winning a table of 4 against three average seats.
const strengthP4 = u => Math.exp(u) / (Math.exp(u) + 3);

// The prediction test: fit on the games before `cut` (ms), then the mean log
// probability given to the actual winner of each game from `cut` on, each
// seat scored with what the fit knew (a player's skill rusted to that day;
// a player new then at 0). Compared with the equal-chances baseline (1/k).
function strengthTest(games, cut, opts = {}) {
  const train = games.filter(g => g.at != null && g.at < cut || g.at == null);
  const test = games.filter(g => g.at != null && g.at >= cut && g.seats.length >= 2 && g.seats.filter(s => s.is_winner).length === 1);
  const data = strengthPrepare(train);
  const fit = strengthFit(data, opts);
  const o = fit.opts;
  const vU = new Map(fit.villains.map(v => [v.name, v.u]));
  const pFit = new Map(fit.players.map(p => [p.uid, p]));
  const dMap = new Map(fit.pairs.map(x => [x.uid + '|' + x.villain, x.d]));
  // The counts at the cut, then carried on through the test games.
  const own = new Map(), seen = new Map();
  const cnt = (m, p) => m.get(p) || m.set(p, {}).get(p);
  for (const g of data.G) for (const s of g.seats) if (s.uid) {
    cnt(own, s.uid)[s.ch] = (cnt(own, s.uid)[s.ch] || 0) + 1;
    for (const t of g.seats) cnt(seen, s.uid)[t.ch] = (cnt(seen, s.uid)[t.ch] || 0) + 1;
  }
  let ll = 0, base = 0, n = 0, hits = 0;
  for (const g of test.sort((x, y) => x.at - y.at)) {
    const k = g.seats.length;
    const ordered = g.seats.every(s => s.position != null) && new Set(g.seats.map(s => s.position)).size === k;
    const pos = ordered ? g.seats.map(s => s.position).sort((x, y) => x - y) : null;
    const us = g.seats.map(s => {
      let u = vU.get(s.character) || 0;
      if (o.terms.seat && ordered) u += fit.seat[k][pos.indexOf(s.position)] || 0;
      if (s.user_id) {
        const pl = pFit.get(s.user_id);
        if (pl) u += strengthNow(fit, pl, g.at).u;
        if (o.terms.pair) u += dMap.get(s.user_id + '|' + s.character) || 0;
        const ow = cnt(own, s.user_id), sn = cnt(seen, s.user_id);
        if (o.terms.exp) u += fit.beta * Math.log(1 + (ow[s.character] || 0));
        if (o.terms.know) {
          const opp = g.seats.filter(t => t !== s);
          u += fit.gamma * opp.reduce((x, t) => x + Math.log(1 + (sn[t.character] || 0)), 0) / opp.length;
        }
      }
      return u;
    });
    const mx = Math.max(...us), es = us.map(u => Math.exp(u - mx)), sum = es.reduce((x, y) => x + y, 0);
    const wi = g.seats.findIndex(s => s.is_winner);
    ll += Math.log(es[wi] / sum);
    base += Math.log(1 / k);
    if (es[wi] === Math.max(...es)) hits++;
    n++;
    for (const s of g.seats) if (s.user_id) {
      cnt(own, s.user_id)[s.character] = (cnt(own, s.user_id)[s.character] || 0) + 1;
      for (const t of g.seats) cnt(seen, s.user_id)[t.character] = (cnt(seen, s.user_id)[t.character] || 0) + 1;
    }
  }
  return { games: n, logScore: ll / n, baseline: base / n, gain: (ll - base) / n, hitRate: hits / n };
}

if (typeof module !== 'undefined') module.exports = { STRENGTH_DEFAULTS, strengthPrepare, strengthFit, strengthNow, strengthP4, strengthTest };
