// ── TOURNAMENTS (beta) ────────────────────────────────────────────────────────
// tournaments.html. Without a parameter: the tournaments and + New tournament.
// ?new: the New tournament form. ?t=<id>: one tournament, with its settings,
// its players by name and, once started, the current stage's tables.
//
// The organizer adds the players by name. A signed-in player claims their name
// with That's me (and with it every seat of theirs in the tournament's games),
// or joins by themselves. Start closes sign-ups and draws every stage's
// villains and stage 1's tables. The rules (pairing, scoring, villain draw)
// live in tournament-rules.js; the database (DiVilytics-Sync, the tournaments
// migration) keeps the facts, checks every write and answers with the codes in
// TN_ERRORS. While a tournament is open and not finished, the page reloads it
// every few seconds, so names, claims and tables show up as they change.

let tnChars    = [];
let tnBoxInfo  = {};
let tnList     = null;        // the list view's tournaments
let tnTour     = null;        // the open tournament (a tournaments row)
let tnPlayers  = [];          // its players (tournament_players rows)
let tnTables   = [];          // its tables, each with .seats in play order
let tnProfiles = new Map();   // user id → profile (organizers, claimed names, recorders)
let tnPool     = null;        // the form's draw pool (pace-filter.js)
let tnFormFor  = null;        // the form edits this tournament's settings (null: a new one)
const tnRule   = { pairing: 'random', scoring: 'borda' };

const TN_POLL_MS  = 8000;
let   tnPollTimer = null;
let   tnSnapshot  = '';       // the data last drawn: a reload redraws only on a change

// The database's answers (tournaments migration).
const TN_ERRORS = {
  not_organizer:         'Only the organizer can do this.',
  already_started:       'The tournament has already started.',
  too_few_players:       'A tournament needs at least 2 players.',
  invalid_pool:          'The draw pool needs at least as many villains as there are players.',
  invalid_villains:      "The villains couldn't be drawn. Try again.",
  invalid_tables:        "The tables couldn't be drawn. Try again.",
  name_claimed:          'Someone else just claimed this name.',
  already_in_tournament: 'You already have a name in this tournament.',
  no_profile:            'You need a nickname first.',
  not_your_name:         "This name isn't yours to release.",
  not_running:           "The tournament isn't running.",
  stage_not_done:        'Every table of this stage has to be saved first.',
};
function _tnErrorMsg(error) {
  if (error?.code === '23505') return t('There is already a player with this name.');
  return TN_ERRORS[error?.message] ? t(TN_ERRORS[error.message]) : (error?.message || '');
}

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('tournaments.html');
  const params = new URLSearchParams(location.search);
  await initAuth(() => _tnAuthChanged());
  [tnChars, tnBoxInfo] = await Promise.all([loadCharacters(), loadBoxInfo()]);
  if (params.has('new')) return tnOpenForm(null);
  const id = params.get('t');
  if (id) {
    setVisible('tnBack', true);
    return tnLoad(id);
  }
  tnLoadList();
}

function _tnAuthChanged() {
  if (!_tnFormOpen() && tnTour) tnRenderTournament();
  else if (!_tnFormOpen() && tnList) tnRenderList();
  if (_tnFormOpen() && tnPool) tnPool.loadOwnedBoxes().then(() => tnPool.updatePaceUI());
}

// ── SHARED BITS ───────────────────────────────────────────────────────────────

async function _tnLoadProfiles(ids) {
  const want = [...new Set(ids.filter(id => id && !tnProfiles.has(id)))];
  if (!want.length) return;
  const { data } = await db.from('profiles').select('id, nickname, avatar_url, default_avatar').in('id', want);
  for (const p of data || []) tnProfiles.set(p.id, p);
}

function _tnStatus(tour) {
  if (tour.finished_at)   return t('Finished');
  if (!tour.current_stage) return t('Sign-ups open');
  return t('Stage {n} of {m}', { n: tour.current_stage, m: tour.stages });
}

// 1st, 2nd, 3rd… (1º, 2º… in Italian).
function fmtPlace(n) {
  if (LANG === 'it') return `${n}º`;
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${tail}`;
}

// A failed action: a banner on top of the page, as on the game page.
function _tnShowError(msg) {
  const root = document.getElementById('tnRoot');
  root.querySelector(':scope > .err')?.remove();
  const el = document.createElement('div');
  el.className = 'err show';
  el.textContent = msg;
  root.prepend(el);
  el.scrollIntoView({ block: 'nearest' });
}

// ── THE LIST ──────────────────────────────────────────────────────────────────

async function tnLoadList() {
  const root = document.getElementById('tnRoot');
  const { data, error } = await db.from('tournaments')
    .select('id, name, organizer, created_at, stages, current_stage, finished_at, tournament_players(count)')
    .order('created_at', { ascending: false });
  root.className = '';
  if (error) { root.innerHTML = loadErrorHTML(t("Couldn't load the tournaments"), error); return; }
  tnList = data || [];
  await _tnLoadProfiles(tnList.map(x => x.organizer));
  tnRenderList();
}

function tnRenderList() {
  const root = document.getElementById('tnRoot');
  const newBtn = `<button class="btn btn-primary btn-sm" type="button" onclick="tnNew()">${t('+ New tournament')}</button>`;
  if (!tnList.length) {
    root.innerHTML = emptyStateHTML('🏟️', t('No tournaments yet'), t('Add the players, and DiVilytics draws the tables and the villains of every stage.'), newBtn);
    return;
  }
  root.innerHTML = `
    <div class="list-header">
      <div class="results-hint">${tn(tnList.length, '{n} tournament', '{n} tournaments')}</div>
      ${newBtn}
    </div>
    <div class="tn-list">${tnList.map(_tnCardHTML).join('')}</div>`;
}

function _tnCardHTML(tour) {
  const n   = tour.tournament_players?.[0]?.count ?? 0;
  const org = tnProfiles.get(tour.organizer)?.nickname;
  const meta = [org ? _esc(org) : null, tn(n, '{n} player', '{n} players'), fmtDateShort(tour.created_at)].filter(Boolean).join(' | ');
  return `
    <a class="game-card tn-card" href="tournaments.html?t=${tour.id}">
      <div class="card-body">
        <div class="card-top">
          <div class="card-date">${_esc(tour.name)}</div>
          <div class="card-meta">${_tnStatus(tour)}</div>
        </div>
        <div class="tn-card-meta">${meta}</div>
      </div>
    </a>`;
}

function tnNew() {
  if (!getCurrentUser()) return goToSignIn();
  location.href = 'tournaments.html?new';
}

// ── ONE TOURNAMENT ────────────────────────────────────────────────────────────

// Loads the tournament and draws it; quiet (the reloads): no spinner, and a
// redraw only when something changed.
async function tnLoad(id, { quiet = false } = {}) {
  const root = document.getElementById('tnRoot');
  const [tourRes, playersRes, tablesRes] = await Promise.all([
    db.from('tournaments').select('*').eq('id', id).maybeSingle(),
    db.from('tournament_players').select('*').eq('tournament_id', id).order('joined_at'),
    db.from('tournament_tables').select('*, tournament_seats(*)').eq('tournament_id', id).order('stage').order('table_no'),
  ]);
  const error = tourRes.error || playersRes.error || tablesRes.error;
  if (quiet && (error || !tourRes.data)) { _tnSchedulePoll(); return; }
  root.className = '';
  // A malformed id (22P02: not a uuid) is a wrong link, like a missing tournament.
  if (error && error.code !== '22P02') { root.innerHTML = loadErrorHTML(t("Couldn't load the tournament"), error); return; }
  if (!tourRes.data) {
    root.innerHTML = emptyStateHTML('⚠️', t('Tournament not found'), t('This tournament may have been deleted, or the link is wrong.'),
      `<a class="btn btn-ghost btn-sm" href="tournaments.html">${t('All tournaments')}</a>`);
    return;
  }
  tnTour    = tourRes.data;
  tnPlayers = playersRes.data || [];
  tnTables  = (tablesRes.data || []).map(tb => ({ ...tb, seats: (tb.tournament_seats || []).sort((a, b) => a.position - b.position) }));
  await _tnLoadProfiles([tnTour.organizer, ...tnPlayers.map(p => p.user_id), ...tnTables.map(tb => tb.recorder)]);
  _tnSchedulePoll();
  const snap = JSON.stringify([tnTour, tnPlayers, tnTables]);
  if (quiet && snap === tnSnapshot) return;
  tnSnapshot = snap;
  if (!_tnFormOpen() && !_tnLiveOpen()) tnRenderTournament();
  // A reload on the table's game: back into it.
  const table = new URLSearchParams(location.search).get('table');
  if (!quiet && table && _tnSavedGame()?.tournament?.tableId === table) tnResumeTable();
}

// The reloads: every few seconds while the page is visible and the tournament
// isn't finished, skipped while you type a name, a sheet is open or the
// settings are being edited; and at once when the page comes back into view.
function _tnSchedulePoll() {
  clearTimeout(tnPollTimer);
  if (!tnTour || tnTour.finished_at) return;
  tnPollTimer = setTimeout(() => {
    if (document.visibilityState === 'visible' && !_tnBusy()) tnLoad(tnTour.id, { quiet: true });
    else _tnSchedulePoll();
  }, TN_POLL_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tnTour && !tnTour.finished_at && !_tnBusy()) tnLoad(tnTour.id, { quiet: true });
});

function _tnBusy() {
  const input = document.getElementById('tnAddName');
  return _tnFormOpen() || _tnLiveOpen() || !!document.querySelector('.overlay.open')
    || (!!input && (input.value.trim() !== '' || document.activeElement === input));
}

function tnRenderTournament() {
  const root = document.getElementById('tnRoot');
  root.className = '';
  const user  = getCurrentUser();
  const isOrg = !!user && user.id === tnTour.organizer;
  const lobby = tnTour.current_stage === 0;
  const mine  = user ? tnPlayers.find(p => p.user_id === user.id) : null;

  const pairing = TOURNAMENT_PAIRINGS[tnTour.pairing];
  const scoring = TOURNAMENT_SCORINGS[tnTour.scoring];
  const settings = [
    t('Organizer: {name}', { name: _esc(tnProfiles.get(tnTour.organizer)?.nickname || '-') }),
    t('Up to {n} per table', { n: tnTour.table_size }),
    tn(tnTour.stages, '{n} stage', '{n} stages'),
    pairing ? t(pairing.name) : _esc(tnTour.pairing),
    scoring ? t(scoring.name) : _esc(tnTour.scoring),
  ].join(' | ');
  const status = [_tnStatus(tnTour), tn(tnPlayers.length, '{n} player', '{n} players')].join(' | ');

  const actions = [
    `<button class="btn btn-ghost btn-sm" type="button" onclick="tnShare()">${t('Share QR')}</button>`,
    isOrg && lobby ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnOpenForm(tnTour)">${t('Edit settings')}</button>` : '',
    isOrg && lobby ? `<button class="btn btn-primary btn-sm" type="button" onclick="tnStart()">${t('Start')}</button>` : '',
  ].join('');

  const ctx  = { user, isOrg, lobby, mine };
  const rows = tnPlayers.map(p => _tnPlayerRowHTML(p, ctx)).join('');

  root.innerHTML = `
    <div class="claim-game-info">
      <div class="claim-date">${_esc(tnTour.name)}</div>
      <div class="claim-meta">${settings}</div>
      <div class="claim-meta">${status}</div>
    </div>
    <div class="claim-share-row">${actions}</div>
    ${lobby ? '' : _tnViewSegHTML()}
    ${lobby || tnView === 'tables' || tnView === 'players' ? `
      ${lobby || tnView === 'players' ? '' : _tnStageHTML(mine)}
      <div class="section-label">${t('Players')}</div>
      ${tnPlayers.length ? `<div class="claim-rows">${rows}</div>` : `<p class="tn-hint">${t('No players yet.')}</p>`}
      ${_tnJoinHTML(ctx)}` : tnView === 'standings' ? _tnStandingsHTML(mine) : _tnLogHTML(mine)}
    ${isOrg ? `<div class="claim-delete-row"><button class="btn btn-danger btn-sm" type="button" onclick="tnDelete()">${t('Delete tournament')}</button></div>` : ''}`;
}

// A player: their name, the avatar and nickname of whoever claimed it (the
// nickname only when it differs from the name), and what you can do with it.
function _tnPlayerRowHTML(p, { user, isOrg, lobby, mine }) {
  const prof   = p.user_id ? tnProfiles.get(p.user_id) : null;
  const isMine = !!user && p.user_id === user.id;
  const avatar = prof
    ? avatarHTML(resolveAvatar(prof), { cls: 'tn-avatar' })
    : '<img class="tn-avatar nav-avatar-guest" src="asset/players/default.svg" alt="">';
  const canClaim = !p.user_id && !!user && !mine;
  let sub = '';
  if (p.withdrawn_after != null)        sub = `<div class="claim-nick">${t('Withdrawn after stage {n}', { n: p.withdrawn_after })}</div>`;
  else if (prof && prof.nickname !== p.name) sub = `<div class="claim-nick">${_esc(prof.nickname)}</div>`;
  else if (!p.user_id && !canClaim)      sub = `<div class="claim-nick unclaimed">${t('Unclaimed')}</div>`;
  const actions = [
    canClaim ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnClaim('${p.id}')">${t("That's me")}</button>` : '',
    isMine   ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnRelease('${p.id}')">${t('Release')}</button>` : '',
    isOrg && lobby ? `<button class="pf-btn del" type="button" onclick="tnRemove('${p.id}')" title="${t('Remove')}">❌</button>` : '',
    isOrg && !lobby && !tnTour.finished_at
      ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnWithdraw('${p.id}', ${p.withdrawn_after == null})">${p.withdrawn_after == null ? t('Withdraw') : t('Bring back')}</button>` : '',
  ].join('');
  return `
    <div class="claim-row${isMine ? ' mine' : ''}">
      <div class="claim-char">${avatar}<div class="claim-who"><div class="claim-name">${_esc(p.name)}</div>${sub}</div></div>
      ${actions ? `<div class="tn-row-actions">${actions}</div>` : ''}
    </div>`;
}

// Under the players: the organizer's Add a player (lobby), Join as a player
// for whoever signed in has no name yet (lobby), and Sign in for guests.
function _tnJoinHTML({ user, isOrg, lobby, mine }) {
  if (!user) {
    return `<p class="tn-hint">${lobby ? t('Sign in to join, or to claim your name.') : t('Sign in to claim your name.')}
      <button class="btn btn-ghost btn-sm" type="button" onclick="goToSignIn()">${t('Sign in')}</button></p>`;
  }
  if (!lobby) return '';
  return `
    ${isOrg ? `
      <div class="tn-add-row">
        <input type="text" id="tnAddName" maxlength="30" placeholder="${t('Player name')}" autocomplete="off"
               onkeydown="if (event.key === 'Enter') tnAddPlayer()">
        <button class="btn btn-ghost" type="button" onclick="tnAddPlayer()">${t('Add')}</button>
      </div>` : ''}
    ${mine ? '' : `<div class="claim-share-row"><button class="btn btn-ghost btn-sm" type="button" onclick="tnJoin()">${t('Join as a player')}</button></div>`}`;
}

// The current stage: its tables, yours first.
function _tnStageHTML(mine) {
  const stage  = tnTour.current_stage;
  const myId   = mine?.id;
  const atMine = tb => tb.seats.some(s => s.player_id === myId);
  const tables = tnTables.filter(tb => tb.stage === stage)
    .sort((a, b) => (atMine(b) - atMine(a)) || a.table_no - b.table_no);
  const saved  = tables.filter(tb => tb.saved_at).length;
  return `
    <div class="section-label">${t('Stage {n} of {m}', { n: stage, m: tnTour.stages })} | ${t('{n} of {m} tables saved', { n: saved, m: tables.length })}</div>
    <div class="tn-tables">${tables.map(tb => _tnTableHTML(tb, myId)).join('')}</div>
    ${_tnNextStageHTML(tables)}`;
}

// The organizer's Next stage: once every table of the stage is saved.
function _tnNextStageHTML(tables) {
  const user = getCurrentUser();
  if (!user || user.id !== tnTour.organizer || tnTour.finished_at || tnTour.current_stage >= tnTour.stages) return '';
  const ready = tables.every(tb => tb.saved_at);
  return `
    <div class="claim-share-row">
      <button class="btn btn-primary btn-sm" type="button" onclick="tnNextStage()"${ready ? '' : ' disabled'}>${t('Draw stage {n}', { n: tnTour.current_stage + 1 })}</button>
    </div>
    ${ready ? '' : `<p class="tn-hint tn-hint-center">${t('Every table of this stage has to be saved first.')}</p>`}`;
}

// A table, drawn like a game card: its players in play order with their
// villains (a saved table: in place order, with their places).
function _tnTableHTML(tb, myId) {
  const bye = tb.seats.length === 1;
  const recorder = tb.recorder ? tnProfiles.get(tb.recorder)?.nickname : null;
  const status = bye ? t('Bye')
    : tb.saved_at ? t('Saved')
    : recorder    ? t("In progress on {name}'s phone", { name: _esc(recorder) })
    : t('Waiting');
  const byName = new Map(tnPlayers.map(p => [p.id, p]));
  const seats  = tb.saved_at && !bye ? tb.seats.slice().sort((a, b) => a.place - b.place) : tb.seats;
  const chips = seats.map(s => {
    const won  = tb.saved_at && !bye && s.place === 1;
    const self = s.player_id === myId;
    const name = byName.get(s.player_id)?.name || '';
    return `
      <div class="chip${won ? ' winner' : ''}${self ? ' self' : ''}">
        <span class="chip-seat">${bye ? '' : tb.saved_at ? fmtPlace(s.place) : s.position + 1}</span>
        <a class="char-link chip-img" href="villains.html?vil=${encodeURIComponent(s.character)}">${charImgHTML(s.character)}</a>
        <div class="chip-body">
          <div class="chip-char"><a class="char-link" href="villains.html?vil=${encodeURIComponent(s.character)}">${villainNameHTML(s.character)}</a></div>
          <div class="chip-nick">${[_esc(name), s.dropped ? `🏳️ ${t('Dropped')}` : null, tb.saved_at ? _tnPointsLabel(_tnSeatPoints(tb, s)) : null].filter(Boolean).join(' | ')}</div>
        </div>
        ${won ? '<span class="win-star">👑</span>' : ''}
      </div>`;
  }).join('');
  return `
    <div class="game-card tn-table">
      <div class="card-body">
        <div class="card-top card-top-wrap">
          <div class="card-date">${t('Table {n}', { n: tb.table_no })}</div>
          <div class="card-meta">${status}</div>
        </div>
        <div class="card-players rows tn-seats">${chips}</div>
      </div>
      ${(action => action ? `<div class="card-actions">${action}</div>` : '')(_tnTableActionHTML(tb))}
    </div>`;
}

// ── ACTIONS ───────────────────────────────────────────────────────────────────

function tnShare() {
  showQRModal(new URL(`tournaments.html?t=${tnTour.id}`, location.href).href, 'qrCode', 'qrOverlay');
}

// After an action: the tournament as it is now, and the error if it failed.
async function _tnAfter(error) {
  await tnLoad(tnTour.id);
  if (error) _tnShowError(_tnErrorMsg(error));
}

async function tnAddPlayer() {
  const input = document.getElementById('tnAddName');
  const name  = input?.value.trim();
  if (!name) return;
  const { error } = await db.from('tournament_players').insert({ tournament_id: tnTour.id, name });
  if (!error) input.value = '';
  await _tnAfter(error);
  document.getElementById('tnAddName')?.focus();   // the next name
}

async function tnJoin() {
  const user = getCurrentUser();
  if (!user) return goToSignIn();
  const profile = getCurrentProfile();
  if (!profile) return _openNicknameModal();
  const { error } = await db.from('tournament_players').insert({ tournament_id: tnTour.id, name: profile.nickname, user_id: user.id });
  await tnLoad(tnTour.id);
  if (error?.code === '23505') _tnShowError(t("There is already a player named {name}: if it's you, tap That's me.", { name: profile.nickname }));
  else if (error) _tnShowError(_tnErrorMsg(error));
}

async function tnClaim(playerId) {
  if (!getCurrentProfile()) return _openNicknameModal();
  const { error } = await db.rpc('claim_tournament_player', { target_player: playerId });
  await _tnAfter(error);
}

function tnRelease(playerId) {
  const p = tnPlayers.find(x => x.id === playerId);
  if (!p) return;
  openConfirmSheet({
    id:           'tnReleaseSheet',
    title:        t('Release this name?'),
    bodyHTML:     `<p class="confirm-text">${t('{name} and its villains in the tournament\'s games go back to unclaimed, for you or someone else to claim.', { name: `<strong class="text-emph">${_esc(p.name)}</strong>` })}</p>`,
    confirmLabel: t('Release'),
    busyLabel:    t('Releasing…'),
    danger:       true,
    onConfirm:    async () => {
      const { error } = await db.rpc('release_tournament_player', { target_player: playerId });
      await _tnAfter(error);
    },
  });
}

async function tnRemove(playerId) {
  const { error } = await db.from('tournament_players').delete().eq('id', playerId);
  await _tnAfter(error);
}

// Start: sign-ups close; every player's villains for every stage and stage 1's
// tables are drawn here (tournament-rules.js) and checked by the database.
function tnStart() {
  const n = tnPlayers.length;
  if (n < 2) return _tnShowError(t('A tournament needs at least 2 players.'));
  if (tnTour.villain_pool.length < n) {
    return _tnShowError(t('The draw pool has {v} villains for {n} players: every player needs a different one. Add villains in Edit settings.', { v: tnTour.villain_pool.length, n }));
  }
  const sizes = tournamentSplit(n, tnTour.table_size);
  openConfirmSheet({
    id:           'tnStartSheet',
    title:        t('Start the tournament?'),
    bodyHTML:     `<p class="confirm-text">${t('Sign-ups close, and stage 1 is drawn: {tables} and a villain for every player.', { tables: tn(sizes.length, '{n} table', '{n} tables') })}</p>`,
    confirmLabel: t('Start'),
    busyLabel:    t('Drawing…'),
    onConfirm:    async () => {
      const villains = tournamentVillainSchedule(tnTour, tnPlayers.map(p => p.id));
      const tables   = tournamentDrawStage(tnTour, tnPlayers, []);
      const { error } = await db.rpc('start_tournament', { target: tnTour.id, villains, tables });
      await _tnAfter(error);
    },
  });
}

function tnDelete() {
  const games = tnTables.filter(tb => tb.game_id).length;
  openConfirmSheet({
    id:           'tnDeleteSheet',
    title:        t('Delete tournament?'),
    bodyHTML:     `<p class="confirm-text">${t('This will permanently delete the tournament, its players and tables. This action cannot be undone.')}</p>`
                + (games ? `<p class="confirm-text">${tn(games, 'Its {n} game is deleted too, from the Game Log and from every profile.', 'Its {n} games are deleted too, from the Game Log and from every profile.')}</p>` : ''),
    confirmLabel: t('Delete tournament'),
    busyLabel:    t('Deleting…'),
    danger:       true,
    onConfirm:    async () => {
      const { error } = await db.rpc('delete_tournament', { target: tnTour.id });
      if (error) { await _tnAfter(error); return; }
      location.replace('tournaments.html');
    },
  });
}

// ── THE FORM ──────────────────────────────────────────────────────────────────
// New tournament, or the lobby's settings: the name, the players per table
// (the largest table), the stages, the pairing and scoring rules (one button
// per rule in tournament-rules.js) and the draw pool (New Game's draw pool).

const _tnFormOpen = () => !document.getElementById('tnForm').classList.contains('hidden');

async function tnOpenForm(tour) {
  tnFormFor = tour;
  if (!getCurrentUser() && !tour) return goToSignIn();
  clearTimeout(tnPollTimer);
  setVisible('tnRoot', false);
  setVisible('tnBack', true);
  setVisible('tnForm', true);
  document.getElementById('tnFormSave').textContent = tour ? t('Save Changes') : t('Create tournament');
  clearError('tnFormErr');

  document.getElementById('tnName').value   = tour?.name || '';
  document.getElementById('tnSize').value   = String(tour?.table_size || 4);
  document.getElementById('tnStages').value = String(tour?.stages || 3);
  tnRule.pairing = tour?.pairing || 'random';
  tnRule.scoring = tour?.scoring || 'borda';
  _tnRenderRules();

  if (!tnPool) {
    tnPool = createPaceFilter({
      getChars:     () => tnChars,
      gridId:       'tnPoolGrid',
      paceColorsId: 'tnPaceColors',
      paceModeId:   'tnPaceMode',
      mineBtnId:    'tnMineBtn',
      mineTitles: {
        signIn:  t('Sign in to filter by owned boxes'),
        noBoxes: t('Mark which boxes you own on the account page first'),
        on:      t('Pool limited to your boxes'),
        off:     t('Limit the pool to your boxes'),
      },
      onChange:      _tnPoolChanged,
      onError:       msg => showError('tnFormErr', msg),
      mineByDefault: true,
    });
    buildExcludeGrid(document.getElementById('tnPoolGrid'), tnChars, tnPool.excluded, _tnPoolChanged, tnBoxInfo);
    await tnPool.loadOwnedBoxes();
  }
  if (tour) {
    const inPool = new Set(tour.villain_pool);
    tnPool.restoreState({ excluded: tnChars.map(c => c.name).filter(n => !inPool.has(n)) });
  } else {
    tnPool.reset();
    tnPool.defaultToMine();   // your boxes, when you've marked some
  }
  tnPool.updatePaceUI();
  _tnPoolChanged();
  if (!tour) document.getElementById('tnName').focus();
}

function tnCloseForm() {
  if (!tnFormFor) return goBack('tournaments.html');
  setVisible('tnForm', false);
  setVisible('tnRoot', true);
  tnRenderTournament();
  _tnSchedulePoll();
}

// One button per rule, the picked one on, its explanation under it.
function _tnRenderRules() {
  for (const [kind, rules, segId, hintId] of [
    ['pairing', TOURNAMENT_PAIRINGS, 'tnPairing', 'tnPairingHint'],
    ['scoring', TOURNAMENT_SCORINGS, 'tnScoring', 'tnScoringHint'],
  ]) {
    document.getElementById(segId).innerHTML = Object.entries(rules).map(([id, r]) =>
      `<button class="seg-btn${id === tnRule[kind] ? ' on' : ''}" type="button" onclick="tnPickRule('${kind}', '${id}')">${t(r.name)}</button>`).join('');
    document.getElementById(hintId).textContent = t(rules[tnRule[kind]]?.hint || '');
  }
}

function tnPickRule(kind, id) {
  tnRule[kind] = id;
  _tnRenderRules();
}

function tnTogglePool(open) {
  const body = document.getElementById('tnPoolBody');
  const isOpen = body.classList.toggle('open', open);
  document.getElementById('tnPoolChevron').classList.toggle('open', isOpen);
}

function _tnPoolChanged() {
  const badge = document.getElementById('tnPoolBadge');
  badge.textContent = tnChars.length - tnPool.excluded.size;
  badge.classList.add('visible');
  badge.classList.toggle('full', !tnPool.excluded.size);
  document.getElementById('tnPoolReset').disabled = tnPool.isDefault();
}

async function tnSaveForm() {
  const user = getCurrentUser();
  if (!user) return goToSignIn();
  const name   = document.getElementById('tnName').value.trim();
  const stages = Number(document.getElementById('tnStages').value);
  const pool   = tnChars.map(c => c.name).filter(n => !tnPool.excluded.has(n));
  if (!name) return showError('tnFormErr', t('Give the tournament a name.'));
  if (!Number.isInteger(stages) || stages < 1 || stages > 20) return showError('tnFormErr', t('Stages: from 1 to 20.'));
  if (pool.length < 2) return showError('tnFormErr', t('The draw pool needs at least 2 villains.'));
  const row = {
    name, stages,
    table_size:   Number(document.getElementById('tnSize').value),
    pairing:      tnRule.pairing,
    scoring:      tnRule.scoring,
    villain_pool: pool,
  };
  const btn = document.getElementById('tnFormSave');
  btn.disabled = true;
  const res = tnFormFor
    ? await db.from('tournaments').update(row).eq('id', tnFormFor.id).select('id')
    : await db.from('tournaments').insert({ ...row, organizer: user.id }).select('id');
  btn.disabled = false;
  if (res.error || !res.data?.length) return showError('tnFormErr', _tnErrorMsg(res.error) || t('The tournament has already started.'));
  if (!tnFormFor) { location.replace(`tournaments.html?t=${res.data[0].id}`); return; }
  setVisible('tnForm', false);
  setVisible('tnRoot', true);
  await tnLoad(tnFormFor.id);
}

// ── A TABLE'S GAME IN PROGRESS ────────────────────────────────────────────────
// The phone that records a table (take_tournament_table: the organizer, or a
// player at it who claimed their name; one at a time) runs its game here, on
// New Game's engine: the timer and rounds of liveGame (shared.js), the same
// live panel and the lock-screen controls (new-game-audio.js, which calls the
// startLive / stopLive / bumpTurn / liveMediaLines below). One game in
// progress per phone, New Game's or a table's.
//
// Tapping a villain still playing places it: won (the next place from the
// top) or dropped (the next place from the bottom), with the time and round
// it happened at (the round only once the counter was used, as in New Game:
// otherwise the rounds are saved empty). The last one placed can be undone. With one villain left it
// takes the free place, the game stops and Save sends it all at once
// (save_tournament_table: the standard game is 1st place's).

let tnGame      = null;   // { tourId, tableId, stage, tableNo, tourName, startedAt, seats, actions }
let liveTimerId = null;
let tnSaveTimer = null;

Object.assign(TN_ERRORS, {
  table_not_saved: 'Only a saved table can be edited.',
  not_at_table:    'Only the players at this table who claimed their name, or the organizer, can record it.',
  table_taken:     'Another phone is already recording this table.',
  not_recorder:    'Another phone records this table now (the organizer took it over).',
  table_saved:     'This table has already been saved.',
  invalid_results: 'Every villain needs a place before saving.',
});

const _tnSavedGame = () => liveGame.loadSaved();
const _tnLiveOpen  = () => !document.getElementById('tnLive').classList.contains('hidden');

// Who can record a table: the organizer, or a player at it who claimed their name.
function _tnCanRecord(tb) {
  const user = getCurrentUser();
  if (!user || tb.saved_at || tb.seats.length < 2) return false;
  if (user.id === tnTour.organizer) return true;
  const mine = tnPlayers.find(p => p.user_id === user.id);
  return !!mine && tb.seats.some(s => s.player_id === mine.id);
}

// The table card's button: Resume on the phone that runs it; Start game when
// nobody records it (or you do, from another session); Take over for the organizer.
function _tnTableActionHTML(tb) {
  if (tb.saved_at) {
    if (!tb.game_id) return '';
    const isOrg = getCurrentUser()?.id === tnTour.organizer;
    return `<a class="btn btn-ghost btn-sm" href="claim.html?game=${tb.game_id}">${t('Open game')}</a>`
      + (isOrg ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnEditTable('${tb.id}')">${t('Edit result')}</button>` : '');
  }
  const saved = _tnSavedGame();
  if (saved?.tournament?.tableId === tb.id) return `<button class="btn btn-primary btn-sm" type="button" onclick="tnResumeTable()">${t('Resume game')}</button>`;
  if (!_tnCanRecord(tb)) return '';
  const user = getCurrentUser();
  if (!tb.recorder || tb.recorder === user.id) return `<button class="btn btn-primary btn-sm" type="button" onclick="tnStartTable('${tb.id}')">${t('Start game')}</button>`;
  if (user.id === tnTour.organizer) return `<button class="btn btn-ghost btn-sm" type="button" onclick="tnStartTable('${tb.id}')">${t('Take over')}</button>`;
  return '';
}

async function tnStartTable(tableId) {
  const tb = tnTables.find(x => x.id === tableId);
  if (!tb) return;
  const saved = _tnSavedGame();
  if (saved && saved.tournament?.tableId !== tableId) {
    return _tnShowError(t('Another game is in progress on this phone: save it or discard it first.'));
  }
  const { error } = await db.rpc('take_tournament_table', { target_table: tableId });
  if (error) return _tnAfter(error);
  const byId = new Map(tnPlayers.map(p => [p.id, p]));
  tnGame = {
    tourId: tnTour.id, tableId, stage: tb.stage, tableNo: tb.table_no, tourName: tnTour.name,
    startedAt: Date.now(),
    seats: tb.seats.map(s => ({ position: s.position, player_id: s.player_id, character: s.character, name: byId.get(s.player_id)?.name || '' })),
    actions: [],
  };
  liveGame.clear();
  liveGame.markStarted(Date.now());
  liveGame.setTurns(1);
  _tnPersist();
  _tnOpenLive();
  liveGame.emit('start');
}

function tnResumeTable() {
  const saved = _tnSavedGame();
  if (!saved?.tournament) return;
  tnGame = saved.tournament;
  liveGame.restoreFrom(saved);
  if (liveGame.turns < 1) liveGame.setTurns(1);
  _tnOpenLive();
  if (liveGame.isRunning) liveGame.emit('start');
}

function _tnPersist() {
  if (!tnGame) return;
  liveGame.persist({ slots: tnGame.seats, tournament: tnGame });
  updateLiveGameNavBadge();
}

function _tnOpenLive() {
  clearTimeout(tnPollTimer);
  const url = new URL(location.href);
  url.searchParams.set('table', tnGame.tableId);
  history.replaceState(null, '', url);
  setVisible('tnRoot', false);
  setVisible('tnBack', false);
  setVisible('tnLive', true);
  clearError('tnLiveErr');
  document.getElementById('fLocation').value = tnGame.tourName;
  clearInterval(liveTimerId);
  if (liveGame.isRunning) liveTimerId = setInterval(tickLive, 1000);
  clearInterval(tnSaveTimer);
  tnSaveTimer = setInterval(_tnPersist, 30000);
  _tnRenderLive();
  window.scrollTo(0, 0);
}

function _tnCloseLive() {
  clearInterval(liveTimerId); liveTimerId = null;
  clearInterval(tnSaveTimer); tnSaveTimer = null;
  tnGame = null;
  const url = new URL(location.href);
  url.searchParams.delete('table');
  history.replaceState(null, '', url);
  setVisible('tnLive', false);
  setVisible('tnRoot', true);
  setVisible('tnBack', true);
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
  const { left, top, bottom, results, done } = _tnPlaces();
  document.getElementById('liveInfo').innerHTML = [
    _esc(tnGame.tourName), t('Stage {n}', { n: tnGame.stage }), t('Table {n}', { n: tnGame.tableNo }),
  ].join(' | ');
  document.getElementById('tnLiveStatus').textContent = done ? t('Game over') : liveGame.isRunning ? t('Game in progress') : t('Game paused');
  document.getElementById('tnLiveStatus').classList.toggle('paused', !liveGame.isRunning);
  document.getElementById('liveTurnCount').textContent = liveGame.turns;
  document.getElementById('liveMinusBtn').disabled = liveGame.turns <= 1;
  tickLive();

  const seat = pos => tnGame.seats.find(s => s.position === pos);
  const who  = s => `<span class="tn-mover-villain">${villainNameHTML(s.character)}</span><span class="tn-mover-name">${_esc(s.name)}</span>`;
  document.getElementById('tnPlaying').innerHTML = left.length > 1
    ? left.map(s => `<button class="tn-mover" type="button" onclick="tnTapPlaying(${s.position})">${moverImgHTML(s.character)}${who(s)}</button>`).join('')
    : `<p class="tn-hint">${t('Everyone is placed.')}</p>`;

  const byPlace = new Map(results.map(r => [r.place, r]));
  const lastAction = tnGame.actions[tnGame.actions.length - 1];
  document.getElementById('tnRanking').innerHTML = tnGame.seats.map((_, i) => {
    const place = i + 1, r = byPlace.get(place);
    if (!r) return `<div class="tn-slot empty"><span class="tn-slot-place">${fmtPlace(place)}</span></div>`;
    const s = seat(r.position);
    const undo = !r.auto && r === lastAction;
    const when = [r.minutes != null ? (fmtDuration(r.minutes) || '0m') : null, r.round != null && tnGame.roundsCounted ? t('Round {n}', { n: r.round }) : null].filter(Boolean).join(' | ');
    return `
      <${undo ? 'button type="button" onclick="tnUndoLast()" title="' + t('Undo') + '"' : 'div'} class="tn-slot${place === 1 ? ' winner' : ''}${r.dropped ? ' dropped' : ''}${undo ? ' undo' : ''}">
        <span class="tn-slot-place">${fmtPlace(place)}${place === 1 ? ' 👑' : ''}</span>
        ${moverImgHTML(s.character)}${who(s)}
        <span class="tn-slot-when">${r.dropped ? `🏳️ ${t('Dropped')}` : ''}${r.dropped && when ? ' | ' : ''}${when}</span>
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
}

// Undoing the placement that ended the game: the timer goes on from where it
// stopped by itself (a game paused by hand stays paused).
function tnUndoLast() {
  tnGame.actions.pop();
  if (tnGame.autoStopped) { tnGame.autoStopped = false; startLive(); }
  _tnPersist();
  _tnRenderLive();
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

function liveMediaLines() {
  return { title: t('Round {n}', { n: liveGame.turns }), artist: t('Update Timer and Rounds') };
}

function tnTogglePause() { tnGame.autoStopped = false; liveGame.isRunning ? stopLive() : startLive(); }

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
  const tourId = tnGame.tourId;
  liveGame.clear();
  liveGame.emit('close');
  updateLiveGameNavBadge();
  _tnCloseLive();
  await tnLoad(tourId);
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
      const tourId = tnGame.tourId;
      liveGame.clear();
      liveGame.emit('close');
      updateLiveGameNavBadge();
      _tnCloseLive();
      await tnLoad(tourId);
    },
  });
}

// ── STANDINGS, LOG, NEXT STAGE ────────────────────────────────────────────────
// Once started: Tables (the current stage and the players), Standings (the
// ranking by the tournament's scoring and tiebreaks, tournament-rules.js) and
// Log (every stage's tables, places and points). A finished tournament opens on
// its final standings, the top three with their medals (🥇 🥈 🥉; tied places share one).

let tnView = null;   // 'tables' | 'standings' | 'log' (null: the default for the tournament)

// A finished tournament has no current tables: it opens on its Final ranking,
// then the Log and the Players (whose names can still be claimed).
function _tnViewSegHTML() {
  const done = !!tnTour.finished_at;
  if (!tnView || (done && tnView === 'tables')) tnView = done ? 'standings' : 'tables';
  const btn = (v, label) => `<button class="seg-btn${tnView === v ? ' on' : ''}" type="button" onclick="tnSetView('${v}')">${label}</button>`;
  return `<div class="controls mb-1"><div class="seg tn-view-seg">${done
    ? btn('standings', t('Final ranking')) + btn('log', t('Log')) + btn('players', t('Players'))
    : btn('tables', t('Tables')) + btn('standings', t('Standings')) + btn('log', t('Log'))}</div></div>`;
}

function tnSetView(v) {
  tnView = v;
  tnRenderTournament();
}

function _tnSeatPoints(tb, seat) {
  const scoring = TOURNAMENT_SCORINGS[tnTour.scoring] || TOURNAMENT_SCORINGS.borda;
  return scoring.points(seat.place, tb.seats.length, tnTour.table_size, seat);
}
const _tnPointsLabel = p => t(p === 1 ? '{n} pt' : '{n} pts', { n: fmtTournamentPoints(p) });

// The standings, drawn like the Leaderboard's table: rank (medals for the
// top three), player, points with their 1st places in parentheses, a bar.
function _tnStandingsHTML(mine) {
  const rows = tournamentStandings(tnTour, tnTables, { players: tnPlayers });
  if (!rows.some(r => r.played || r.byes)) return emptyStateHTML('🏟️', t('No results yet'), t('The standings fill in as the tables are saved.'));
  const byId = new Map(tnPlayers.map(p => [p.id, p]));
  const max = Math.max(...rows.map(r => r.points)) || 1;
  const medal = rank => rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
  const digits = String(Math.max(0, ...rows.map(r => r.firsts))).length;
  const body = rows.map(r => {
    const p = byId.get(r.player_id);
    const prof = p?.user_id ? tnProfiles.get(p.user_id) : null;
    const avatar = prof ? avatarHTML(resolveAvatar(prof)) : '<img class="player-avatar nav-avatar-guest" src="asset/players/default.svg" alt="">';
    const sub = [
      p?.withdrawn_after != null ? t('Withdrawn after stage {n}', { n: p.withdrawn_after }) : null,
      t("Opponents' points: {n}", { n: fmtTournamentPoints(r.opponents) }),
    ].filter(Boolean).join(' | ');
    return `
      <div class="lb-row${mine && r.player_id === mine.id ? ' lb-row-self' : ''}">
        <div class="rank-num ${medal(r.rank)}">${tnTour.finished_at && r.rank <= 3 ? `<span class="tn-medal">${['🥇', '🥈', '🥉'][r.rank - 1]}</span>` : r.rank}</div>
        <div class="row-identity">${avatar}<div class="row-id-text"><span class="row-name">${_esc(p?.name || '')}</span><div class="row-sub">${sub}</div></div></div>
        <div class="row-val row-val-stack">
          <span class="sv"><span class="sv-main">${fmtTournamentPoints(r.points)}</span><span class="sv-games">(${r.firsts})</span></span>
          <div class="bar-bg"><div class="bar-fill${r.rank === 1 ? ' gold' : ''}" style="width:${Math.max(0, r.points / max * 100)}%"></div></div>
        </div>
      </div>`;
  }).join('');
  const scoring = TOURNAMENT_SCORINGS[tnTour.scoring];
  return `
    <div class="lb-table tn-standings" style="--sv-games: calc(${digits} * 0.6em + 0.65em)">
      <div class="lb-head"><span>#</span><span>${t('Player')}</span><span class="text-right">${t('Points')} <span class="lb-head-sub">(${t('1st places')})</span></span></div>
      ${body}
    </div>
    <p class="results-hint">${_esc(t(scoring?.hint || ''))} ${t('Ties: most 1st places, then the points of the opponents faced.')}</p>`;
}

// Every stage's tables, in order, with places and points.
function _tnLogHTML(mine) {
  const myId = mine?.id;
  const out = [];
  for (let st = 1; st <= tnTour.current_stage; st++) {
    const tables = tnTables.filter(tb => tb.stage === st);
    out.push(`<div class="section-label">${t('Stage {n} of {m}', { n: st, m: tnTour.stages })}</div>
      <div class="tn-tables">${tables.map(tb => _tnTableHTML(tb, myId)).join('')}</div>`);
  }
  return out.join('');
}

function tnNextStage() {
  const next = tnTour.current_stage + 1;
  openConfirmSheet({
    id:           'tnNextSheet',
    title:        t('Draw stage {n}?', { n: next }),
    confirmLabel: t('Draw stage {n}', { n: next }),
    busyLabel:    t('Drawing…'),
    onConfirm:    async () => {
      const tables = tournamentDrawStage(tnTour, tnPlayers, tnTables);
      const { error } = await db.rpc('next_tournament_stage', { target: tnTour.id, tables });
      tnView = 'tables';
      await _tnAfter(error);
    },
  });
}

async function tnWithdraw(playerId, withdrawn) {
  const { error } = await db.rpc('withdraw_tournament_player', { target_player: playerId, withdrawn });
  await _tnAfter(error);
}

// The organizer fixes a saved table: New Game's rows, dragged by ⠿ into place
// order (1st on top), each with 🏳️ for a drop. Drops always sit at the bottom:
// marking one moves it just above the earlier drops (the latest drop), taking
// one back moves it just below the others; dragging keeps that order.
let tnEdit = null;   // { tableId, rows: [{ position, dropped }] } in place order

function tnEditTable(tableId) {
  const tb = tnTables.find(x => x.id === tableId);
  if (!tb) return;
  tnEdit = { tableId, rows: tb.seats.slice().sort((a, b) => a.place - b.place).map(s => ({ position: s.position, dropped: !!s.dropped })) };
  openConfirmSheet({
    id:           'tnEditSheet',
    title:        t('Table {n}', { n: tb.table_no }),
    bodyHTML:     `<div class="section-label lineup-label"><span>${t('Ranking')}</span>
                     <span class="players-legend"><span class="sep-item">${t('⠿ = drag')}</span> | <span class="sep-item">${t('🏳️ = dropped')}</span></span></div>
                   <div class="err" id="tnEditErr"></div>
                   <div class="tn-edit-rows" id="tnEditRows"></div>
                   <p class="modal-hint">${t('Drag the villains into their places. Drops stay at the bottom; the standard game follows (1st place won it).')}</p>`,
    confirmLabel: t('Save Changes'),
    busyLabel:    t('Saving…'),
    onConfirm:    async () => {
      const results = tnEdit.rows.map((r, i) => ({ position: r.position, place: i + 1, dropped: r.dropped }));
      const { error } = await db.rpc('edit_tournament_table', { target_table: tableId, results });
      if (error) { showError('tnEditErr', _tnErrorMsg(error)); throw error; }
      await tnLoad(tnTour.id);
    },
  });
  const box = document.getElementById('tnEditRows');
  if (!box.dataset.drag) {
    box.dataset.drag = '1';
    attachRowDrag(box, {
      rowSelector: '.order-slot',
      onDrop: (from, to) => {
        if (to !== from) tnEdit.rows.splice(to, 0, tnEdit.rows.splice(from, 1)[0]);
        _tnRenderEditRows();
      },
    });
  }
  _tnRenderEditRows();
}

function _tnRenderEditRows() {
  // Drops at the bottom, each group keeping its order.
  tnEdit.rows = [...tnEdit.rows.filter(r => !r.dropped), ...tnEdit.rows.filter(r => r.dropped)];
  const tb = tnTables.find(x => x.id === tnEdit.tableId);
  const byId = new Map(tnPlayers.map(p => [p.id, p]));
  const playing = tnEdit.rows.filter(r => !r.dropped).length;
  document.getElementById('tnEditRows').innerHTML = tnEdit.rows.map((r, i) => {
    const s = tb.seats.find(x => x.position === r.position);
    const last = !r.dropped && playing === 1;   // someone finishes 1st
    return `
      <div class="order-slot tn-edit-row${i === 0 ? ' winner' : ''}${r.dropped ? ' dropped' : ''}">
        <div class="drag-handle">
          <span class="drag-dots">⠿</span><span class="row-num tn-edit-place">${fmtPlace(i + 1)}</span>
          <img class="order-slot-portrait" src="${charImgSrc(s.character)}" onerror="this.src='asset/players/default.svg'" alt="">
        </div>
        <div class="claim-who"><div class="claim-name">${villainNameHTML(s.character)}</div><div class="claim-nick">${_esc(byId.get(s.player_id)?.name || '')}</div></div>
        <div class="order-slot-actions">
          <button class="pf-btn drop${r.dropped ? ' on' : ''}" type="button" onclick="tnToggleDrop(${r.position})"
                  ${last ? `disabled title="${t('Someone has to finish 1st')}"` : `title="${t('Dropped')}"`}>🏳️</button>
        </div>
      </div>`;
  }).join('');
}

function tnToggleDrop(position) {
  const i = tnEdit.rows.findIndex(r => r.position === position);
  const [row] = tnEdit.rows.splice(i, 1);
  row.dropped = !row.dropped;
  // A new drop: the latest, just above the earlier ones; taken back: last of the others.
  const firstDrop = tnEdit.rows.findIndex(r => r.dropped);
  tnEdit.rows.splice(firstDrop < 0 ? tnEdit.rows.length : firstDrop, 0, row);
  _tnRenderEditRows();
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();
