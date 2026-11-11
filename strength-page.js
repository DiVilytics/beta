// ── STRENGTH AND SKILL (test page) ───────────────────────────────────────────
// strength.html: the model of strength.js on every official game: the
// villains' Strength and the players' Skill as a corrected Δ Wins (their wins
// against those an average villain, or player, would have had in their exact
// seats: the opponents, the seat, the players as the model has them), next to
// the plain Δ Wins. How it's computed (a sheet): the model in words, then its
// math, with the seat's edge by table size and, on request, the prediction
// test. Not in the menu; the Leaderboard gets it once it's settled.


async function init() {
  setActiveNav('');
  await initAuth();
  const root = document.getElementById('stRoot');
  let all, chars, profiles;
  try {
    [all, chars, profiles] = await Promise.all([loadOfficialGames(), loadCharacters(), fetchAllProfiles('id, nickname, avatar_url, default_avatar')]);
  } catch (e) {
    root.className = '';
    root.innerHTML = loadErrorHTML(t("Couldn't load the games"), e);
    return;
  }
  const t0 = performance.now();
  const fit = strengthFit(strengthPrepare(all));
  const ms = Math.round(performance.now() - t0);
  const nick = new Map(profiles.map(p => [p.id, p]));
  root.className = '';
  root.innerHTML = `
    <p class="results-hint"><button class="char-guide-link" type="button" onclick="openStrengthInfo()">${t('How it\'s computed')} ›</button></p>
    ${_villainsHTML(fit, all)}
    ${_playersHTML(fit, nick, all)}`;
  window._st = { fit, ms, games: all };
}

// The plain Δ Wins: wins against an equal share at every table.
function _plainDelta(games, key) {
  const out = {};
  for (const g of games) {
    const k = g.seats.length;
    if (k < 2) continue;
    for (const s of g.seats) {
      const id = key(s);
      if (!id) continue;
      const r = out[id] ||= { wins: 0, exp: 0, vari: 0 };
      if (s.is_winner) r.wins++;
      r.exp += 1 / k; r.vari += 1 / k * (1 - 1 / k);
    }
  }
  return out;
}

// Villains: Strength, the corrected Δ Wins (strengthFit's exp and vari), then the plain one.
function _villainsHTML(fit, all) {
  const plain = _plainDelta(all, s => s.character);
  const rows = fit.villains.slice().sort((a, b) => chanceDelta(b) - chanceDelta(a));
  return `
    <div class="section-label">${t('Villains: Strength')}</div>
    <p class="results-hint">${t('Strength: the villain\'s wins against those an average villain would have had at the same tables. Δ Wins: against an equal share at every table.')}</p>
    <div class="st-table-wrap"><table class="st-table">
      <thead><tr><th>#</th><th>${t('Villain')}</th><th>${t('Strength')}</th><th>${t('Δ Wins')}</th><th>${t('Games')}</th></tr></thead>
      <tbody>${rows.map((v, i) => `
        <tr><td>${i + 1}</td>
          <td class="st-name"><a href="villains.html?vil=${encodeURIComponent(v.name)}">${charImgHTML(v.name)}<span>${villainNameInline(v.name)}</span></a></td>
          <td class="st-main">${fmtChance(chanceDelta(v))}</td>
          <td class="st-sub">${fmtChance(chanceDelta(plain[v.name] || {}))}</td>
          <td class="st-sub">${v.games}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

// Players: Skill, the corrected Δ Wins, then the plain one (their claimed seats), wins, games, last game.
function _playersHTML(fit, nick, all) {
  const plain = _plainDelta(all, s => s.user_id);
  const rows = fit.players.map(p => ({ ...p, prof: nick.get(p.uid) }))
    .filter(p => p.prof?.nickname)
    .sort((a, b) => chanceDelta(b) - chanceDelta(a));
  return `
    <div class="section-label">${t('Players: Skill')}</div>
    <p class="results-hint">${t('Skill: the player\'s wins against those an average player would have had with the same villains at the same tables. Only the games where they claimed their villain.')}</p>
    <div class="st-table-wrap"><table class="st-table">
      <thead><tr><th>#</th><th>${t('Player')}</th><th>${t('Skill')}</th><th>${t('Δ Wins')}</th><th>${t('Wins')}</th><th>${t('Games')}</th><th>${t('Last game')}</th></tr></thead>
      <tbody>${rows.map((p, i) => `
        <tr><td>${i + 1}</td>
          <td class="st-name"><a href="players.html?nick=${encodeURIComponent(p.prof.nickname)}">${playerAvatarHTML(resolveAvatar(p.prof))}<span>${_esc(p.prof.nickname)}</span></a></td>
          <td class="st-main">${fmtChance(chanceDelta(p))}</td>
          <td class="st-sub">${fmtChance(chanceDelta(plain[p.uid] || {}))}</td>
          <td class="st-sub">${p.wins}</td>
          <td class="st-sub">${p.games}</td>
          <td class="st-sub">${fmtDateShort(new Date(p.curve[p.curve.length - 1].at).toISOString())}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

// The seat's edge: each seat's chance at k players, the villains and players alike.
function _seatsTable(fit) {
  const rows = [2, 3, 4, 5, 6].map(k => {
    const es = fit.seat[k].map(Math.exp), sum = es.reduce((a, b) => a + b, 0);
    return `<tr><td>${k}p</td>${es.map(e => `<td class="st-sub">${(100 * e / sum).toFixed(0)}%</td>`).join('')}${'<td></td>'.repeat(6 - k)}</tr>`;
  }).join('');
  return `<div class="st-table-wrap"><table class="st-table st-seats">
      <thead><tr><th></th>${[1, 2, 3, 4, 5, 6].map(s => `<th>${s}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// How it's computed (the link under the title): the model in words, then its math.
function openStrengthInfo() {
  const { fit, ms } = window._st, o = fit.opts;
  const body = infoSheet('stInfoOverlay', t('How it\'s computed'));
  const p = html => `<p class="modal-hint">${html}</p>`;
  const math = (...parts) => `<p class="st-math">${parts.map(x => `<span>${x}</span>`).join(' ')}</p>`;
  body.innerHTML = [
    p(t('<b>In short</b>: every game is a small contest. The model gives every seat a score, and picks the scores that make the winners of all the recorded games as likely as possible. A villain that keeps winning against strong villains ends up strong; a player who keeps winning with weak villains ends up skilled.')),
    p(t('<b>A seat\'s score</b> adds up: the villain\'s strength; the seat\'s edge (playing first helps); and, when the seat was claimed, the player\'s skill at that moment, how much better than usual they do with that villain, and their experience with it (how many times they played it before). An unclaimed seat counts as an average player.')),
    p(t('<b>The chance of winning</b> comes from the scores: each seat wins in proportion to e raised to its score, out of the table\'s total. With every score at 0, everyone has the same chance, 1 in the number of players: Δ Wins\' starting point.')),
    p(t('<b>Villains</b> have one strength each, from every game, estimated again from scratch each time: a new game can change what an old one says (a win against a villain we now know is strong counts for more).')),
    p(t('<b>Players</b> have a skill that changes game by game, estimated with hindsight: their skill at a game also takes their later games into account, so beating a beginner who later became strong still counts as beating a beginner. It can change within one evening; while they don\'t play, it slowly goes back toward average (rust: after a year away, about two thirds of the way).')),
    p(t('<b>Play order</b>: how often each seat would win if villains and players were all equal (seat 1 plays first), from the games with their play order recorded:')),
    _seatsTable(fit),
    p(t('<b>Few games</b>: every villain and player starts from average, and only their games move them away; with few games they stay close to it.')),
    p(t('<b>The numbers</b>: Strength and Skill are Δ Wins corrected by the model. For each game, the model says how many wins an average villain (or player) would have expected in that exact seat: same opponents, same seat, same players (each with their skill in that game). Strength is the villain\'s wins minus those, divided by how much luck alone moves them (as in Δ Wins); Skill the same for a player. 0 is average, past ±2 luck alone rarely goes. Plain Δ Wins assumes everyone at the table had the same chance instead.')),
    p(t('<b>Not counted yet</b>: knowing the opponents\' villains (how many times a player has already faced them). With the claimed games so far it made the predictions worse, so it\'s off; it can come back once there are more.')),
    p(t('<b>Does it work?</b> Fitted only on the older games, the model guesses the winners of the newer ones better than the villains alone or equal chances. The test shows by how much:')),
    `<button class="btn btn-ghost btn-sm" type="button" onclick="stRunTest(this)">${t('Run the prediction test')}</button>
    <div id="stTest"></div>`,
    `<div class="section-label">${t('The math')}</div>`,
    p(t('<b>A seat\'s score</b>, for villain v in seat s of a table of k players, claimed by player p at game t:')),
    math('u = b<sub>v</sub> + c<sub>k,s</sub>', '+ a<sub>p</sub>(t) + d<sub>p,v</sub>', '+ β · ln(1 + n)'),
    p(t('b: the villain\'s strength; c: the seat\'s edge (0 when the order is unknown); a: the player\'s skill at that game; d: the player with that villain; n: how many times they played it before; β: what experience is worth, the same for everyone. Unclaimed seats: a = d = n = 0.')),
    p(t('<b>The chance of winning</b>, out of the seats j at the table:')),
    math('P<sub>i</sub> = e<sup>u<sub>i</sub></sup> / Σ<sub>j</sub> e<sup>u<sub>j</sub></sup>'),
    p(t('<b>The fit</b>: the scores are the most likely ones given the games (maximum a posteriori): the sum of ln P of every game\'s winner, minus a penalty for every score away from 0 (a normal prior):')),
    math(`b ~ N(0, ${o.sb}²)`, `c ~ N(0, ${o.sc}²)`, `d ~ N(0, ${o.sd}²)`, `β ~ N(0, ${o.sbg}²)`),
    p(t('<b>The skill</b> starts from N(0, {s0}²) at a player\'s first game and, from a game to their next, Δ days later:', { s0: o.s0 })),
    math('a<sub>next</sub> = ρ · a + ε,', `ρ = e<sup>−Δ/${o.lambda}</sup>,`, `ε ~ N(0, ${o.tp}²)`),
    p(t('ρ is the rust: after {d} days away, e<sup>−1</sup> ≈ 37% of the skill is left.', { d: o.lambda })),
    p(t('<b>Strength</b>, over a villain\'s games, with W its wins and P⁰ its chance with b = 0 (all the rest as fitted):')),
    math(`${t('Strength')} =`, '(W − Σ P⁰) /', '√(Σ P⁰ (1 − P⁰))'),
    p(t('Skill is the same for a player, with P⁰ their chance with a, d and β · ln(1 + n) at 0. Plain Δ Wins is the same with P⁰ = 1 / k.')),
    p(t('<b>The computation</b>: the problem is concave (one maximum), found with Newton steps, one block of scores at a time; a player\'s skill curve is a tridiagonal system, solved in linear time (as a Kalman smoother). Here: {it} rounds, {ms} ms.', { it: fit.iterations, ms })),
  ].join('');
  openOverlay('stInfoOverlay');
}

// Fit on the games up to a date, predict the winners after it: each term's worth.
async function stRunTest(btn) {
  btn.disabled = true;
  const box = document.getElementById('stTest');
  box.innerHTML = `<p class="results-hint">${t('Loading…')}</p>`;
  await new Promise(r => setTimeout(r, 30));
  const games = window._st.games;
  const at = games.filter(g => g.at && g.seats.some(s => s.user_id)).map(g => g.at).sort((a, b) => a - b);
  const cut = at[Math.floor(at.length * 0.7)];
  const off = { seat: false, pair: false, exp: false, know: false };
  const variants = [
    [t('Villains only'), { terms: off, s0: 1e-4, tp: 1e-4 }],
    [t('+ play order'), { terms: { ...off, seat: true }, s0: 1e-4, tp: 1e-4 }],
    [t('+ players\' skill'), { terms: { ...off, seat: true } }],
    [t('The model (+ with that villain, + experience)'), {}],
    [t('+ knowing the opponents\' villains'), { terms: { know: true } }],
  ];
  const rows = [];
  for (const [name, opts] of variants) {
    const r = strengthTest(games, cut, opts);
    rows.push(`<tr><td class="st-name">${name}</td><td class="st-main">${(100 * r.hitRate).toFixed(1)}%</td><td class="st-sub">${r.gain.toFixed(3)}</td></tr>`);
    box.innerHTML = `<p class="results-hint">${t('Fitted on the games up to {d}, it guessed the winners of the {n} games after. Winner picked: how often the seat it rated highest won. Gain: how much more likely than equal chances it found the actual winners, on average (higher is better).', { d: fmtDateShort(new Date(cut).toISOString()), n: r.games })}</p>
      <div class="st-table-wrap"><table class="st-table"><thead><tr><th>${t('Model')}</th><th>${t('Winner picked')}</th><th>${t('Gain')}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
    await new Promise(r => setTimeout(r, 10));
  }
  btn.disabled = false;
}

init();
