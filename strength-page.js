// ── STRENGTH AND SKILL (test page) ───────────────────────────────────────────
// strength.html: the model of strength.js on every official game, shown next
// to Δ Wins to compare: the villains' Strength, the players' Skill (now: their
// last game's, rusted by the days since), the seat's edge by table size, and on
// request the prediction test (each term's worth). Not in the menu; the
// Leaderboard gets it once it's settled. Every value reads as a chance: winning
// a table of 4 against three average seats (25% is average). Rankings use the
// prudent value (the estimate less one σ): few or old games can't top them.

const _num = (x, d = 1) => x.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
const _pct = u => `${_num(100 * strengthP4(u))}%`;
const _pm  = (u, sd) => _num(100 * (strengthP4(u + sd) - strengthP4(u)));

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
    ${_playersHTML(fit, nick)}
    ${_seatsHTML(fit)}
    ${_modelHTML(fit, ms, all)}`;
}

// Villains: Strength (prudent, then the estimate ± σ) and, to compare, Δ Wins.
function _villainsHTML(fit, all) {
  const delta = {};
  for (const g of all) {
    const k = g.seats.length;
    if (k < 2) continue;
    for (const s of g.seats) {
      const r = delta[s.character] ||= { wins: 0, exp: 0, vari: 0 };
      if (s.is_winner) r.wins++;
      r.exp += 1 / k; r.vari += 1 / k * (1 - 1 / k);
    }
  }
  const rows = fit.villains.slice().sort((a, b) => (b.u - b.sd) - (a.u - a.sd));
  return `
    <div class="section-label">${t('Villains: Strength')}</div>
    <p class="results-hint">${t('How often the villain would win at a table of 4 against three average villains, everyone with an average player, whatever the seat. Ranked by the cautious value (the estimate minus its margin), so a villain with few games doesn\'t top it by luck; the estimate and its margin are next to it, then Δ Wins to compare.')}</p>
    <div class="st-table-wrap"><table class="st-table">
      <thead><tr><th>#</th><th>${t('Villain')}</th><th>${t('Strength')}</th><th>${t('Estimate')}</th><th>${t('Δ Wins')}</th><th>${t('Games')}</th></tr></thead>
      <tbody>${rows.map((v, i) => `
        <tr><td>${i + 1}</td>
          <td class="st-name"><a href="villains.html?vil=${encodeURIComponent(v.name)}">${charImgHTML(v.name)}<span>${villainNameInline(v.name)}</span></a></td>
          <td class="st-main">${_pct(v.u - v.sd)}</td>
          <td class="st-sub">${_pct(v.u)} ± ${_pm(v.u, v.sd)}</td>
          <td class="st-sub">${fmtChance(chanceDelta(delta[v.name] || {}))}</td>
          <td class="st-sub">${v.games}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

// Players: Skill now (prudent, then the estimate ± σ), their games, wins and last game.
function _playersHTML(fit, nick) {
  const rows = fit.players.map(p => ({ ...p, now: strengthNow(fit, p), prof: nick.get(p.uid) }))
    .filter(p => p.prof?.nickname)
    .sort((a, b) => (b.now.u - b.now.sd) - (a.now.u - a.now.sd));
  return `
    <div class="section-label">${t('Players: Skill')}</div>
    <p class="results-hint">${t('How often the player would win at a table of 4 against three average players, everyone with an average villain. It\'s their skill after their latest game, slowly going back toward average while they don\'t play. Only the games where they claimed their villain count; ranked by the cautious value, like the villains.')}</p>
    <div class="st-table-wrap"><table class="st-table">
      <thead><tr><th>#</th><th>${t('Player')}</th><th>${t('Skill')}</th><th>${t('Estimate')}</th><th>${t('Wins')}</th><th>${t('Games')}</th><th>${t('Last game')}</th></tr></thead>
      <tbody>${rows.map((p, i) => `
        <tr><td>${i + 1}</td>
          <td class="st-name"><a href="players.html?nick=${encodeURIComponent(p.prof.nickname)}">${playerAvatarHTML(resolveAvatar(p.prof))}<span>${_esc(p.prof.nickname)}</span></a></td>
          <td class="st-main">${_pct(p.now.u - p.now.sd)}</td>
          <td class="st-sub">${_pct(p.now.u)} ± ${_pm(p.now.u, p.now.sd)}</td>
          <td class="st-sub">${p.wins}</td>
          <td class="st-sub">${p.games}</td>
          <td class="st-sub">${fmtDateShort(new Date(p.curve[p.curve.length - 1].at).toISOString())}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

// The seat's edge: each seat's chance at k players, the villains and players alike.
function _seatsHTML(fit) {
  const rows = [2, 3, 4, 5, 6].map(k => {
    const es = fit.seat[k].map(Math.exp), sum = es.reduce((a, b) => a + b, 0);
    return `<tr><td>${k}p</td>${es.map(e => `<td class="st-sub">${(100 * e / sum).toFixed(0)}%</td>`).join('')}${'<td></td>'.repeat(6 - k)}</tr>`;
  }).join('');
  return `
    <div class="section-label">${t('Play order')}</div>
    <p class="results-hint">${t('How often each seat would win if villains and players were all equal (seat 1 plays first). From the games with their play order recorded.')}</p>
    <div class="st-table-wrap"><table class="st-table">
      <thead><tr><th></th>${[1, 2, 3, 4, 5, 6].map(s => `<th>${s}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// How it's computed (the link under the title): the model in words.
function openStrengthInfo() {
  const body = infoSheet('stInfoOverlay', t('How it\'s computed'));
  body.innerHTML = [
    t('<b>In short</b>: every game is a small contest. The model gives every seat a score, and picks the scores that make the winners of all the recorded games as likely as possible. A villain that keeps winning against strong villains ends up strong; a player who keeps winning with weak villains ends up skilled.'),
    t('<b>A seat\'s score</b> adds up: the villain\'s strength; the seat\'s edge (playing first helps); and, when the seat was claimed, the player\'s skill at that moment, how much better than usual they do with that villain, and their experience with it (how many times they played it before). An unclaimed seat counts as an average player.'),
    t('<b>The chance of winning</b> comes from the scores: each seat wins in proportion to e raised to its score, out of the table\'s total. With every score at 0, everyone has the same chance, 1 in the number of players: Δ Wins\' starting point.'),
    t('<b>Villains</b> have one strength each, from every game, estimated again from scratch each time: a new game can change what an old one says (a win against a villain we now know is strong counts for more).'),
    t('<b>Players</b> have a skill that changes game by game, estimated with hindsight: their skill at a game also takes their later games into account, so beating a beginner who later became strong still counts as beating a beginner. It can change within one evening; while they don\'t play, it slowly goes back toward average (rust: after a year away, about two thirds of the way).'),
    t('<b>Few games</b>: every villain and player starts from average, and only their games move them away; with few games they stay close to it and their margin is wide. The rankings use the cautious value, the estimate minus its margin.'),
    t('<b>Not counted yet</b>: knowing the opponents\' villains (how many times a player has already faced them). With the claimed games so far it made the predictions worse, so it\'s off; it can come back once there are more.'),
    t('<b>Does it work?</b> Fitted only on the older games, the model guesses the winners of the newer ones better than the villains alone or equal chances: the prediction test at the bottom of the page shows by how much.'),
  ].map(p => `<p class="modal-hint">${p}</p>`).join('');
  openOverlay('stInfoOverlay');
}

// The prediction test, on request.
function _modelHTML(fit, ms, all) {
  window._stGames = all;
  return `
    <div class="section-label">${t('The model')}</div>
    <p class="results-hint">${t('Computed in {ms} ms. To check it works: fitted only on the older games, it guesses the winners of the newer ones.', { ms })}</p>
    <button class="btn btn-ghost btn-sm" type="button" onclick="stRunTest(this)">${t('Run the prediction test')}</button>
    <div id="stTest"></div>`;
}

// Fit on the games up to a date, predict the winners after it: each term's worth.
async function stRunTest(btn) {
  btn.disabled = true;
  const box = document.getElementById('stTest');
  box.innerHTML = `<p class="results-hint">${t('Loading…')}</p>`;
  await new Promise(r => setTimeout(r, 30));
  const games = window._stGames;
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
