// ── A TOURNAMENT TABLE'S GAME IN PROGRESS (beta) ──────────────────────────────
// tournament-game.html?table=<id>: the game of the table this phone records
// (tournaments.js takes the table, take_tournament_table, and starts it here).
// New Game's engine: the timer and rounds of liveGame (shared.js), its live
// panel with the movers in play order, and the lock-screen controls
// (new-game-audio.js, which calls the startLive / stopLive / bumpTurn /
// liveMediaLines below). One game in progress per phone, New Game's or a
// table's; a reload comes back to it.
//
// Tapping a mover still in the game places it: won (the next place from the
// top) or dropped (the next place from the bottom), with the time and round it
// happened at (the round only once the counter was used, as in New Game:
// otherwise the rounds are saved empty). The last one placed is undone with a
// tap. With one villain left it takes the free place, the game stops by itself
// (an undo starts it again) and Save sends it all at once (save_tournament_table:
// the standard game is 1st place's). Then back to the tournament.

let tnGame      = null;   // { tourId, tableId, stage, tableNo, tourName, startedAt, seats, actions, roundsCounted, autoStopped }
let liveTimerId = null;
let tnSaveTimer = null;

async function init() {
  setActiveNav('tournaments.html');
  await initAuth(() => {});
  const table = new URLSearchParams(location.search).get('table');
  const saved = liveGame.loadSaved();
  const root  = document.getElementById('tgRoot');
  root.className = '';
  if (!saved?.tournament || saved.tournament.tableId !== table) {
    // Not this phone's game: back to the tournament (or the tournaments).
    root.innerHTML = emptyStateHTML('🏟️', t("This game isn't running on this phone"),
      t('Start it from its table on the tournament page.'),
      `<a class="btn btn-primary btn-sm" href="tournaments.html">${t('All tournaments')}</a>`);
    return;
  }
  root.innerHTML = '';
  tnGame = saved.tournament;
  liveGame.restoreFrom(saved);
  if (liveGame.turns < 1) liveGame.setTurns(1);
  document.getElementById('tgBack').href = `tournaments.html?t=${tnGame.tourId}`;
  document.getElementById('fLocation').value = tnGame.tourName;
  setVisible('tnLive', true);
  if (liveGame.isRunning) liveTimerId = setInterval(tickLive, 1000);
  tnSaveTimer = setInterval(_tnPersist, 30000);
  _tnRenderLive();
  // Once every script is in: new-game-audio.js (lock-screen controls) loads after this one.
  const start = () => { if (liveGame.isRunning) liveGame.emit('start'); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

function _tnPersist() {
  if (!tnGame) return;
  liveGame.persist({ slots: tnGame.seats, tournament: tnGame });
  updateLiveGameNavBadge();
}

// The places: winners from the top, drops from the bottom; with one villain
// left, it takes the free place (not stored until Save).
function _tnPlaces() {
  const n = tnGame.seats.length;
  const placed = new Set(tnGame.actions.map(a => a.position));
  const left = tnGame.seats.filter(s => !placed.has(s.position));
  const top = tnGame.actions.filter(a => !a.dropped).length + 1;
  const bottom = n - tnGame.actions.filter(a => a.dropped).length;
  const last = tnGame.actions[tnGame.actions.length - 1];
  const results = tnGame.actions.slice();
  if (left.length === 1) results.push({ position: left[0].position, place: top, minutes: last?.minutes ?? null, round: last?.round ?? null, dropped: false, auto: true });
  return { n, left, top, bottom, results, done: left.length <= 1 };
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = x => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function tickLive() {
  document.getElementById('liveTime').textContent = fmtElapsed(liveGame.isRunning ? liveGame.elapsedMs : (liveGame.exactDurMs || 0));
}

function _tnRenderLive() {
  const { left, results, done } = _tnPlaces();
  document.getElementById('liveInfo').innerHTML = [
    _esc(tnGame.tourName), tnGame.isFinal ? t('Final') : t('Stage {n}', { n: tnGame.stage }), tnGame.isFinal ? null : t('Table {n}', { n: tnGame.tableNo }),
  ].filter(Boolean).join(' | ');
  const status = document.getElementById('tnLiveStatus');
  status.textContent = done ? t('Game over') : liveGame.isRunning ? t('Game in progress') : t('Game paused');
  status.classList.toggle('paused', !liveGame.isRunning);
  document.getElementById('liveTurnCount').textContent = liveGame.turns;
  document.getElementById('liveMinusBtn').disabled = liveGame.turns <= 1;
  tickLive();

  // New Game's movers row, in play order: the ones still in the game are
  // tapped to place them; the placed ones fade, with their place.
  const placeOf = new Map(results.map(r => [r.position, r]));
  document.getElementById('liveMovers').innerHTML = tnGame.seats.map(s => {
    const r = placeOf.get(s.position);
    if (r) return `<span class="tg-mover placed${r.dropped ? ' dropped' : ''}" title="${_esc(s.name)}">${moverImgHTML(s.character)}<span class="tg-mover-place">${r.dropped ? '🏳️ ' : ''}${fmtPlace(r.place)}</span><span class="tg-mover-name">${_esc(s.name)}</span></span>`;
    return `<button class="tg-mover" type="button" onclick="tnTapPlaying(${s.position})" title="${_esc(s.name)}"${left.length > 1 ? '' : ' disabled'}>${moverImgHTML(s.character)}<span class="tg-mover-name">${_esc(s.name)}</span></button>`;
  }).join('');

  const seat = pos => tnGame.seats.find(s => s.position === pos);
  const byPlace = new Map(results.map(r => [r.place, r]));
  const lastAction = tnGame.actions[tnGame.actions.length - 1];
  document.getElementById('tnRanking').innerHTML = tnGame.seats.map((_, i) => {
    const place = i + 1, r = byPlace.get(place);
    if (!r) return `<div class="tn-slot empty"><span class="tn-slot-place">${fmtPlace(place)}</span></div>`;
    const s = seat(r.position);
    const undo = !r.auto && !r.withdrawn && r === lastAction;
    const when = [r.minutes != null ? (fmtDuration(r.minutes) || '0m') : null, r.round != null && tnGame.roundsCounted ? t('Round {n}', { n: r.round }) : null].filter(Boolean).join(' | ');
    return `
      <${undo ? 'button type="button" onclick="tnUndoLast()" title="' + t('Undo') + '"' : 'div'} class="tn-slot${place === 1 ? ' winner' : ''}${r.dropped ? ' dropped' : ''}${undo ? ' undo' : ''}">
        <span class="tn-slot-place">${fmtPlace(place)}${place === 1 ? ' 👑' : ''}</span>
        ${charImgHTML(s.character)}
        <span class="tn-mover-villain">${villainNameHTML(s.character)}</span><span class="tn-mover-name">${_esc(s.name)}</span>
        <span class="tn-slot-when">${r.dropped ? `🏳️ ${r.withdrawn ? t('Withdrawn') : t('Dropped')}` : ''}${r.dropped && when ? ' | ' : ''}${when}</span>
      </${undo ? 'button' : 'div'}>`;
  }).join('');

  document.getElementById('tnPauseBtn').textContent = liveGame.isRunning ? t('Pause game') : t('Resume game');
  document.getElementById('tnPauseBtn').disabled = done;
  document.getElementById('tnSaveBtn').disabled = !done;
  setVisible('tnLiveHint', !done);
}

function tnTapPlaying(position) {
  const { top, bottom } = _tnPlaces();
  const s = tnGame.seats.find(x => x.position === position);
  document.getElementById('tnPlaceTitle').innerHTML = `${villainNameInline(s.character)} | ${_esc(s.name)}`;
  const won = document.getElementById('tnPlaceWon');
  const dropped = document.getElementById('tnPlaceDropped');
  won.textContent = `👑 ${t('Won: {place}', { place: fmtPlace(top) })}`;
  dropped.textContent = `🏳️ ${t('Dropped: {place}', { place: fmtPlace(bottom) })}`;
  won.onclick = () => _tnPlace(position, false);
  dropped.onclick = () => _tnPlace(position, true);
  openOverlay('tnPlaceSheet');
}

function _tnPlace(position, dropped) {
  closeOverlay('tnPlaceSheet');
  const { top, bottom } = _tnPlaces();
  const ms = liveGame.isRunning ? liveGame.elapsedMs : (liveGame.exactDurMs || 0);
  tnGame.actions.push({ position, place: dropped ? bottom : top, minutes: Math.round(ms / 60000), round: liveGame.turns, dropped });
  // One left: the game is over and stops by itself (an undo starts it again).
  if (_tnPlaces().done && liveGame.isRunning) { stopLive(); tnGame.autoStopped = true; }
  _tnPersist();
  _tnRenderLive();
  _updateMediaMetadata();   // the lock screen's count (new-game-audio.js)
}

// Undoing the placement that ended the game: the timer goes on from where it
// stopped by itself (a game paused by hand stays paused).
function tnUndoLast() {
  if (tnGame.actions[tnGame.actions.length - 1]?.withdrawn) return;   // withdrawn: not this game's to undo
  tnGame.actions.pop();
  if (tnGame.autoStopped) { tnGame.autoStopped = false; startLive(); }
  _tnPersist();
  _tnRenderLive();
  _updateMediaMetadata();
}

// New Game's names, for the lock-screen controls (new-game-audio.js).
function startLive() {
  if (!tnGame || liveGame.isRunning || _tnPlaces().done) return;
  liveGame.markStarted(Date.now() - (liveGame.exactDurMs || 0));
  clearInterval(liveTimerId);
  liveTimerId = setInterval(tickLive, 1000);
  liveGame.emit('start');
  _tnPersist();
  _tnRenderLive();
}

function stopLive() {
  if (!tnGame || !liveGame.isRunning) return;
  liveGame.markStopped(liveGame.elapsedMs);
  clearInterval(liveTimerId); liveTimerId = null;
  liveGame.emit('stop');
  _tnPersist();
  _tnRenderLive();
}

function bumpTurn(delta) {
  if (!tnGame || (delta < 0 && liveGame.turns <= 1)) return;
  tnGame.roundsCounted = true;   // as in New Game: rounds only when the counter was used
  liveGame.bumpTurns(delta);
  _tnPersist();
  _tnRenderLive();
}

// The lock screen: the round, and how many villains are still in the game.
function liveMediaLines() {
  const left = tnGame ? _tnPlaces().left.length : 0;
  return { title: t('Round {n}', { n: liveGame.turns }), artist: tn(left, '{n} player still in the game', '{n} players still in the game') };
}

function tnTogglePause() { tnGame.autoStopped = false; liveGame.isRunning ? stopLive() : startLive(); }

// Done with the game on this phone: back to its tournament.
function _tnLeave() {
  const tourId = tnGame.tourId;
  clearInterval(liveTimerId);
  clearInterval(tnSaveTimer);
  liveGame.clear();
  liveGame.emit('close');
  updateLiveGameNavBadge();
  location.replace(`tournaments.html?t=${tourId}`);
}

async function tnSaveGame() {
  const { results, done } = _tnPlaces();
  if (!done) return;
  const btn = document.getElementById('tnSaveBtn');
  btn.disabled = true;
  btn.textContent = t('Saving…');
  const { error } = await db.rpc('save_tournament_table', {
    target_table: tnGame.tableId,
    played_at:    new Date(tnGame.startedAt).toISOString(),
    results:      results.map(({ position, place, minutes, round, dropped }) => ({ position, place, minutes, round: tnGame.roundsCounted ? round : null, dropped })),
  });
  btn.textContent = t('Save game');
  if (error) { btn.disabled = false; return showError('tnLiveErr', _tnErrorMsg(error), { scroll: true }); }
  _tnLeave();
}

function tnDiscardGame() {
  openConfirmSheet({
    id:           'tnDiscardSheet',
    title:        t('Discard this game?'),
    bodyHTML:     `<p class="confirm-text">${t('The timer, the rounds and the places so far are lost, and the table is free again for another phone.')}</p>`,
    confirmLabel: t('Discard game'),
    busyLabel:    t('Discarding…'),
    danger:       true,
    onConfirm:    async () => {
      // Taken over meanwhile: the table isn't ours to give back, just let go of it.
      await db.rpc('release_tournament_table', { target_table: tnGame.tableId });
      _tnLeave();
    },
  });
}

init();
