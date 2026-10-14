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
const tnRule   = { table_split: 'even', pairing: 'random', play_order: 'random', scoring: 'borda', bye: 'half', final: 'off' };
// The final table, an on / off option drawn like the rules.
const TN_FINAL = {
  off: { name: 'Off', hint: 'The standings after the last stage are the final ranking.' },
  on:  { name: 'On',  hint: 'After the last stage, the top of the standings play one final table, which decides the top places.' },
};
let   tnCustom = {};   // the custom scoring's points, { n: row } for every table size, 1st first

const TN_POLL_MS  = 8000;
let   tnPollTimer = null;
let   tnSnapshot  = '';       // the data last drawn: a reload redraws only on a change

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


// A player's name as shown everywhere: the nickname of whoever claimed it,
// else the name the organizer typed.
function tnPlayerName(p) {
  if (!p) return '';
  return (p.user_id && tnProfiles.get(p.user_id)?.nickname) || p.name;
}

async function _tnLoadProfiles(ids) {
  const want = [...new Set(ids.filter(id => id && !tnProfiles.has(id)))];
  if (!want.length) return;
  const { data } = await db.from('profiles').select('id, nickname, avatar_url, default_avatar').in('id', want);
  for (const p of data || []) tnProfiles.set(p.id, p);
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
    .select('*, tournament_players(count)')
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
    <div class="tn-list">${tnList.map(tour => tournamentCardHTML(tour, { organizer: tnProfiles.get(tour.organizer)?.nickname })).join('')}</div>`;
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
  if (!_tnFormOpen()) tnRenderTournament();
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
  return _tnFormOpen() || !!document.querySelector('.overlay.open')
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
  // Each option with its name, as the form calls it.
  // On top the tournament (name, date, organizer, status); under it, after a
  // gap, its options one per row, with ⓘ for How the options work.
  const opt = (label, value) => `<div class="claim-meta">${t(label)}: ${value}</div>`;
  const organizer = t('Organizer: {name}', { name: _esc(tnProfiles.get(tnTour.organizer)?.nickname || '-') });
  const options = [
    opt('Table size', tnTour.table_size),
    opt('Tables', t((TOURNAMENT_SPLITS[tnTour.table_split] || TOURNAMENT_SPLITS.even).name)),
    opt('Stages', tnTour.stages),
    opt('Pairing', pairing ? t(pairing.name) : _esc(tnTour.pairing)),
    opt('Play order', t((TOURNAMENT_PLAY_ORDERS[tnTour.play_order] || TOURNAMENT_PLAY_ORDERS.random).name)),
    opt('Scoring', scoring ? t(scoring.name) : _esc(tnTour.scoring)),
    opt('Bye', t((TOURNAMENT_BYES[tnTour.bye] || TOURNAMENT_BYES.last).name)),
    opt('Final table', t(TN_FINAL[tnTour.final_table ? 'on' : 'off'].name)),
  ].join('');
  const status = [tournamentStatus(tnTour), tn(tnPlayers.length, '{n} player', '{n} players')].join(' | ');

  const actions = [
    `<button class="btn btn-ghost btn-sm" type="button" onclick="tnShare()">${t('Share QR')}</button>`,
    isOrg ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnOpenForm(tnTour)">${t('Edit settings')}</button>` : '',
    isOrg && lobby ? `<button class="btn btn-primary btn-sm" type="button" onclick="tnStart()">${t('Start')}</button>` : '',
  ].join('');

  const ctx  = { user, isOrg, lobby, mine };
  const rows = tnPlayers.map(p => _tnPlayerRowHTML(p, ctx)).join('');

  root.innerHTML = `
    <div class="claim-game-info">
      <div class="claim-date">${_esc(tnTour.name)}</div>
      <div class="claim-meta">${fmtTournamentDate(tnTour)}</div>
      <div class="claim-meta">${organizer}</div>
      <div class="claim-meta">${status}</div>
      <div class="claim-meta tn-options-title"><strong>${t('Options')}</strong> <button class="tn-info" type="button" onclick="tnHelp()" title="${_esc(t('How the options work'))}">ⓘ</button></div>
      ${options}
    </div>
    <div class="claim-share-row">${actions}</div>
    ${lobby ? '' : _tnViewSegHTML()}
    ${lobby || tnView === 'tables' || tnView === 'players' ? `
      ${lobby || tnView === 'players' ? '' : _tnYourGameHTML(mine) + _tnStageHTML(mine)}
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
      <div class="claim-char">${avatar}<div class="claim-who"><div class="claim-name">${_esc(tnPlayerName(p))}</div>${sub}</div></div>
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

// Your game in the current stage, on top: your table, your villain and your
// turn (or your bye), with the table's button. For a claimed name still playing.
function _tnYourGameHTML(mine) {
  if (!mine || mine.withdrawn_after != null || tnTour.finished_at) return '';
  const tb = tnTables.find(x => x.stage === tnTour.current_stage && x.seats.some(s => s.player_id === mine.id));
  if (!tb) return '';
  const seat = tb.seats.find(s => s.player_id === mine.id);
  const head = `${t('Your game')} | ${tb.stage > tnTour.stages ? t('Final') : t('Stage {n}', { n: tb.stage })}`;
  if (tb.seats.length === 1) {
    return `<div class="claim-game-info tn-you"><div class="claim-date">${head}</div><div class="claim-meta">${t('You have a bye in this stage (it counts as last).')}</div></div>`;
  }
  const action = _tnTableActionHTML(tb);
  const line = tb.saved_at
    ? t('Saved: you finished {place}.', { place: fmtPlace(seat.place) })
    : t('{place} to play.', { place: fmtPlace(seat.position + 1) });
  return `
    <div class="claim-game-info tn-you">
      <div class="claim-date">${head} | ${t('Table {n}', { n: tb.table_no })}</div>
      <div class="tn-you-villain">${moverImgHTML(seat.character)}${charImgHTML(seat.character)}
        <div class="claim-who"><div class="claim-name">${villainNameHTML(seat.character)}</div><div class="claim-nick">${line}</div></div>
      </div>
      ${action ? `<div class="tn-you-actions">${action}</div>` : ''}
    </div>`;
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
    <div class="section-label">${tnStageLabel(stage)} | ${t('{n} of {m} tables saved', { n: saved, m: tables.length })}</div>
    <div class="tn-tables">${tables.map(tb => _tnTableHTML(tb, myId)).join('')}</div>
    ${_tnNextStageHTML(tables)}`;
}

// The organizer's Draw stage (once every table of the stage is saved) and
// Undo draw (while none of its games is saved; a bye isn't a game).
function _tnNextStageHTML(tables) {
  const user = getCurrentUser();
  if (!user || user.id !== tnTour.organizer) return '';
  const canUndo = !tables.some(tb => tb.game_id);
  const open  = !tnTour.finished_at;
  const more  = open && tnTour.current_stage < tnTour.stages;
  const final = open && tnTour.final_table && tnTour.current_stage === tnTour.stages;
  const ready = tables.every(tb => tb.saved_at);
  if (!more && !final && !canUndo) return '';
  const draw = more
    ? `<button class="btn btn-primary btn-sm" type="button" onclick="tnNextStage()"${ready ? '' : ' disabled'}>${t('Draw stage {n}', { n: tnTour.current_stage + 1 })}</button>`
    : final ? `<button class="btn btn-primary btn-sm" type="button" onclick="tnDrawFinal()"${ready ? '' : ' disabled'}>${t('Draw the final')}</button>` : '';
  return `
    <div class="claim-share-row">
      ${canUndo ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnUndoStage()">${t('Undo draw')}</button>` : ''}
      ${draw}
    </div>
    ${draw && !ready ? `<p class="tn-hint tn-hint-center">${t('Every table of this stage has to be saved first.')}</p>` : ''}`;
}

// What the next draw makes: "Stage 3 of 5: 2 tables and 1 bye, Swiss pairing."
function _tnDrawSummary(stage) {
  const playing = tnPlayers.filter(p => p.withdrawn_after == null).length;
  const sizes = tournamentSplit(playing, tnTour.table_size, tnTour.table_split);
  const tables = sizes.filter(n => n > 1).length, byes = sizes.length - tables;
  const what = byes ? t('{tables} and {byes}', { tables: tn(tables, '{n} table', '{n} tables'), byes: tn(byes, '{n} bye', '{n} byes') }) : tn(tables, '{n} table', '{n} tables');
  const pairing = (TOURNAMENT_PAIRINGS[tnTour.pairing] || TOURNAMENT_PAIRINGS.random).name;
  return `${t('Stage {n} of {m}: {what}, {pairing} pairing.', { n: stage, m: tnTour.stages, what, pairing: t(pairing) })} ${t('It can be undone until a table is saved.')}`;
}

// A stage's name: "Stage 2 of 3", or "Final" for the final table.
function tnStageLabel(stage) {
  return stage > tnTour.stages ? t('Final') : t('Stage {n} of {m}', { n: stage, m: tnTour.stages });
}

// The final: the top of the standings play one last table (tournament-rules.js).
function tnDrawFinal() {
  const { players, villains } = tournamentDrawFinal(tnTour, tnPlayers, tnTables);
  const names = players.map(id => _esc(tnPlayerName(tnPlayers.find(p => p.id === id))));
  openConfirmSheet({
    id:           'tnFinalSheet',
    title:        t('Draw the final?'),
    bodyHTML:     `<p class="confirm-text">${t('The top {n} of the standings play one last table, and its ranking decides the tournament\'s top places: {names}.', { n: players.length, names: `<strong class="text-emph">${new Intl.ListFormat(LOCALE, { type: 'conjunction' }).format(names)}</strong>` })} ${t('It can be undone until it is saved.')}</p>`,
    confirmLabel: t('Draw the final'),
    busyLabel:    t('Drawing…'),
    onConfirm:    async () => {
      const { error } = await db.rpc('draw_tournament_final', { target: tnTour.id, villains, players });
      tnView = 'tables';
      await _tnAfter(error);
    },
  });
}

// Undo draw: the stage's tables go (games in progress on a phone too) and the
// tournament is back at the stage before, or in the lobby from stage 1.
function tnUndoStage() {
  const st = tnTour.current_stage;
  openConfirmSheet({
    id:           'tnUndoSheet',
    title:        t('Undo the draw of stage {n}?', { n: st }),
    bodyHTML:     `<p class="confirm-text">${st === 1
      ? t('Its tables are cancelled, games in progress included, and the tournament goes back to sign-ups: players can join or leave, the settings change, and Start draws everything again.')
      : t('Its tables are cancelled, games in progress included, and the tournament goes back to stage {n}: you can bring players back, then draw again.', { n: st - 1 })}</p>`,
    confirmLabel: t('Undo draw'),
    busyLabel:    t('Working…'),
    danger:       true,
    onConfirm:    async () => {
      const { error } = await db.rpc('undo_tournament_stage', { target: tnTour.id });
      tnView = 'tables';
      await _tnAfter(error);
    },
  });
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
    const name = tnPlayerName(byName.get(s.player_id));
    return `
      <div class="chip${won ? ' winner' : ''}${self ? ' self' : ''}">
        <span class="chip-seat">${bye ? '' : tb.saved_at ? fmtPlace(s.place) : s.position + 1}</span>
        <a class="char-link chip-img" href="villains.html?vil=${encodeURIComponent(s.character)}">${charImgHTML(s.character)}</a>
        <div class="chip-body">
          <div class="chip-char"><a class="char-link" href="villains.html?vil=${encodeURIComponent(s.character)}">${villainNameHTML(s.character)}</a></div>
          <div class="chip-nick">${[_esc(name), s.dropped ? `🏳️ ${tb.saved_at ? t('Dropped') : t('Withdrawn')}` : null, tb.saved_at ? _tnPointsLabel(_tnSeatPoints(tb, s)) : null].filter(Boolean).join(' | ')}</div>
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
  // A name typed for you already: claim it instead.
  if (tnPlayers.some(p => !p.user_id && p.name.toLowerCase() === profile.nickname.toLowerCase())) {
    return _tnShowError(t("There is already a player named {name}: if it's you, tap That's me.", { name: profile.nickname }));
  }
  // Your nickname shows while you hold the name; the name itself is "Player N",
  // so it stays its own if you release it.
  const name = _tnFreeName(new Set(tnPlayers.map(p => p.name.toLowerCase())), tnPlayers.length + 1);
  const { error } = await db.from('tournament_players').insert({ tournament_id: tnTour.id, name, user_id: user.id });
  await _tnAfter(error);
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
    bodyHTML:     `<p class="confirm-text">${t('{name} and its villains in the tournament\'s games go back to unclaimed, for you or someone else to claim.', { name: `<strong class="text-emph">${_esc(tnPlayerName(p))}</strong>` })}</p>`,
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
  const sizes = tournamentSplit(n, tnTour.table_size, tnTour.table_split);
  openConfirmSheet({
    id:           'tnStartSheet',
    title:        t('Start the tournament?'),
    bodyHTML:     `<p class="confirm-text">${t('Sign-ups close, and stage 1 is drawn: {tables} and a villain for every player.', { tables: tn(sizes.length, '{n} table', '{n} tables') })}</p>`,
    confirmLabel: t('Start'),
    busyLabel:    t('Drawing…'),
    onConfirm:    async () => _tnAfter(await _tnDrawStart()),
  });
}

// Every player's villains for every stage, and stage 1's tables.
async function _tnDrawStart() {
  const villains = tournamentVillainSchedule(tnTour, tnPlayers.map(p => p.id));
  const tables   = tournamentDrawStage(tnTour, tnPlayers, []);
  return (await db.rpc('start_tournament', { target: tnTour.id, villains, tables })).error;
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
// The settings change until one of the tournament's games starts (or is
// entered): once started, saving draws stage 1 again when the draw changes.
const _tnAllOpen = tour => !tour || (tour.current_stage <= 1 && !tnTables.some(tb => tb.started_at || tb.game_id));

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
  document.getElementById('tnDate').value   = tour?.event_date || _tnToday();
  document.getElementById('tnSize').value   = String(tour?.table_size || 4);
  document.getElementById('tnStages').value = String(tour?.stages || 3);
  tnRule.table_split = tour?.table_split || 'even';
  tnRule.pairing     = tour?.pairing || 'random';
  tnRule.play_order  = tour?.play_order || 'random';
  tnRule.scoring     = tour?.scoring || 'borda';
  tnRule.bye         = tour?.bye || (tour ? 'last' : 'half');
  tnRule.final       = tour?.final_table ? 'on' : 'off';
  tnCustom = tour?.custom_points?.length ? tournamentCustomRows(tour) : _tnCustomRows(tour?.table_size || 4);
  // Once a game has started: only the name and the date (fixing a typo).
  const open = _tnAllOpen(tour);
  document.querySelectorAll('#tnForm .tn-fixed').forEach(el => setVisible(el, open));
  setVisible('tnRedrawNote', !!tour && open && tour.current_stage > 0);
  _tnRenderRules();
  _tnHelpButtons();

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
  }
  const draft = tour ? null : _tnLoadDraft();
  if (draft?.pool) tnPool.restoreState(draft.pool);
  else if (!tour) tnPool.defaultToMine();   // your boxes, when you've marked some
  tnPool.updatePaceUI();
  // New: the players. Edit settings: the players to add.
  document.getElementById('tnFormPlayersLabel').textContent = tour ? t('Add players') : t('Players');
  document.getElementById('tnFormPlayersHint').textContent = tour
    ? t('Up to the villains in the draw pool. An empty name keeps the one shown.')
    : t('From 2 players up to the villains in the draw pool. An empty name keeps the one shown; more players can join later from the tournament page.');
  tnFormPlayers = tour ? [] : [{ name: '', isMe: false }, { name: '', isMe: false }];
  if (draft) _tnApplyDraft(draft);
  setVisible('tnFormPlayers', open);
  if (open) _tnRenderFormPlayers();
  _tnPoolChanged();
  setVisible('tnFormDiscard', !tour);
  _tnDraftReady = !tour;
  _tnUpdateDiscard();
}

// ── New tournament's draft ──
// As in New Game: the form (name, date, options, custom points, players and
// the draw pool) is kept in localStorage as you edit, so leaving the page or
// Cancel doesn't lose it. It expires an hour after the last change; Discard
// and Create tournament clear it. An untouched date isn't kept (it comes back
// as today). Edit settings has no draft: Cancel leaves the tournament as it was.
const TN_DRAFT_KEY    = 'divilytics_tournament_draft' + STORAGE_SCOPE;   // the beta's apart (config.js)
const TN_DRAFT_MAX_MS = 60 * 60 * 1000;
let _tnDraftReady = false;   // only while New tournament's form is open

function _tnDraftState() {
  const val = id => document.getElementById(id).value;
  return {
    name:    val('tnName'),
    date:    val('tnDate') !== _tnToday() ? val('tnDate') : '',
    size:    val('tnSize'),
    stages:  val('tnStages'),
    rule:    { ...tnRule },
    custom:  tnCustom,
    players: tnFormPlayers.map(p => ({ name: p.name, isMe: !!p.isMe })),
    pool:    { excluded: [...tnPool.excluded], selectedPace: tnPool.selectedPace, pacePlus: !!tnPool.selectedPace && tnPool.pacePlus, mineOn: tnPool.mineOn },
  };
}

// Anything changed from a fresh New tournament form?
function _tnFormChanged() {
  const d = _tnDraftState();
  return !!d.name.trim() || !!d.date || d.size !== '4' || d.stages !== '3'
    || Object.entries({ table_split: 'even', pairing: 'random', play_order: 'random', scoring: 'borda', bye: 'half', final: 'off' }).some(([k, v]) => d.rule[k] !== v)
    || d.players.length !== 2 || d.players.some(p => p.name.trim() || p.isMe)
    || !tnPool.isDefault();
}

function _tnSaveDraft() {
  if (!_tnDraftReady || tnFormFor) return;
  _tnUpdateDiscard();
  try {
    if (!_tnFormChanged()) return localStorage.removeItem(TN_DRAFT_KEY);
    localStorage.setItem(TN_DRAFT_KEY, JSON.stringify({ saved: Date.now(), ..._tnDraftState() }));
  } catch (_) {}
}

function _tnDropDraft() {
  try { localStorage.removeItem(TN_DRAFT_KEY); } catch (_) {}
}

function _tnLoadDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(TN_DRAFT_KEY)); } catch (_) {}
  if (d && !(Date.now() - d.saved <= TN_DRAFT_MAX_MS)) { _tnDropDraft(); return null; }
  return d;
}

function _tnApplyDraft(d) {
  document.getElementById('tnName').value = d.name || '';
  if (d.date) document.getElementById('tnDate').value = d.date;
  if (d.size)   document.getElementById('tnSize').value = d.size;
  if (d.stages) document.getElementById('tnStages').value = d.stages;
  for (const k of Object.keys(tnRule)) if (d.rule?.[k]) tnRule[k] = d.rule[k];
  if (d.custom) tnCustom = d.custom;
  if (d.players?.length >= 2) tnFormPlayers = d.players.map(p => ({ name: p.name || '', isMe: !!p.isMe && !!getCurrentProfile() }));
  _tnRenderRules();
}

function _tnUpdateDiscard() {
  const btn = document.getElementById('tnFormDiscard');
  if (btn) btn.disabled = !(_tnDraftReady && _tnFormChanged());
}

function tnDiscardForm() {
  openConfirmSheet({
    id:           'tnDiscardFormSheet',
    title:        t('Discard this tournament?'),
    bodyHTML:     `<p class="confirm-text">${t('This resets the form (name, options, draw pool and players) and clears the saved draft.')}</p>`,
    confirmLabel: t('Discard'),
    danger:       true,
    onConfirm:    async () => {
      _tnDraftReady = false;
      _tnDropDraft();
      await tnOpenForm();
      window.scrollTo(0, 0);
    },
  });
}

// Every change in the form saves the draft (a tap's handler runs first).
for (const ev of ['input', 'change']) document.getElementById('tnForm')?.addEventListener(ev, _tnSaveDraft);
document.getElementById('tnForm')?.addEventListener('click', () => setTimeout(_tnSaveDraft));

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
    ['table_split', TOURNAMENT_SPLITS, 'tnSplit', 'tnSplitHint'],
    ['pairing', TOURNAMENT_PAIRINGS, 'tnPairing', 'tnPairingHint'],
    ['play_order', TOURNAMENT_PLAY_ORDERS, 'tnPlayOrder', 'tnPlayOrderHint'],
    ['scoring', TOURNAMENT_SCORINGS, 'tnScoring', 'tnScoringHint'],
    ['bye', TOURNAMENT_BYES, 'tnBye', 'tnByeHint'],
    ['final', TN_FINAL, 'tnFinal', 'tnFinalHint'],
  ]) {
    const seg = document.getElementById(segId);
    const off = seg.classList.contains('disabled');
    seg.innerHTML = Object.entries(rules).map(([id, r]) =>
      `<button class="seg-btn${id === tnRule[kind] ? ' on' : ''}" type="button" onclick="tnPickRule('${kind}', '${id}')"${off ? ' disabled' : ''}>${t(r.name)}</button>`).join('');
    document.getElementById(hintId).textContent = t(rules[tnRule[kind]]?.hint || '');
  }
  _tnRenderCustom();
}

const _tnToday     = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const _tnBordaRow  = size => Array.from({ length: size }, (_, i) => size - 1 - i);
const _tnFormSize  = () => Number(document.getElementById('tnSize').value);

// Custom scoring: a row of boxes per table size, the largest on top. The
// organizer types the largest table's points; Same win or Keep the
// average fills the smaller tables from them (TOURNAMENT_CUSTOM_FILLS), and
// each box can still be changed by hand.
const _tnCustomRows = (size, top = _tnBordaRow(size), fill = 'ends') => {
  const rows = { [size]: top };
  for (let n = size - 1; n >= 2; n--) rows[n] = tournamentCustomFill(top, n, fill);
  return rows;
};

function _tnRenderCustom() {
  const on = tnRule.scoring === 'custom';
  setVisible('tnCustom', on);
  if (!on) return;
  const size = _tnFormSize();
  if (tnCustom[size]?.length !== size) tnCustom = _tnCustomRows(size);
  // A triangle: the places once on top, a row per table size under them.
  const cells = [`<span></span>`, ...Array.from({ length: size }, (_, i) => `<span class="tn-custom-place">${fmtPlace(i + 1)}</span>`)];
  for (let n = size; n >= 2; n--) {
    cells.push(`<span class="tn-custom-n">${tn(n, '{n} player', '{n} players')}</span>`);
    tnCustom[n].forEach((v, i) => cells.push(`<input type="number" inputmode="decimal" min="0" step="any" value="${v}" aria-label="${_esc(`${tn(n, '{n} player', '{n} players')}, ${fmtPlace(i + 1)}`)}" oninput="tnCustom[${n}][${i}] = Math.max(0, Number(this.value) || 0)">`));
    for (let i = n; i < size; i++) cells.push('<span></span>');
  }
  const lines = [`<div class="tn-custom-grid" style="--places: ${size}">${cells.join('')}</div>`];
  document.getElementById('tnCustomRows').innerHTML = lines.join('');
  setVisible('tnCustomFill', size > 2);
  document.getElementById('tnCustomFill').innerHTML = `<span>${t('Fill the smaller tables:')}</span>` +
    Object.entries(TOURNAMENT_CUSTOM_FILLS).map(([id, f]) =>
      `<button class="btn btn-ghost btn-sm" type="button" onclick="tnCustomFill('${id}')">${t(f.name)}</button>`).join('');
}

function tnCustomFill(fill) {
  const size = _tnFormSize();
  tnCustom = _tnCustomRows(size, tnCustom[size], fill);
  _tnRenderCustom();
}

// ── How the options work ──
// Every option in full, with examples, in a sheet: the button on top of the
// form opens it at the start, each option's ⓘ at its own section.
const TN_HELP = [
  ['date', 'Date', [
    'The day of the tournament, shown on its page and in the lists. The organizer can change it at any time, like the name, to fix a mistake. The games keep the day and time they were actually played.',
  ]],
  ['size', 'Table size', [
    'No table has more players than this. With Balanced tables, some tables can have one player fewer; with Full tables, every table has exactly this many.',
    'It also sets the scale of the points: a win scores the same at every table, whatever its size.',
    'Fixed once the first game starts.',
  ]],
  ['stages', 'Stages', [
    'How many rounds of tables the tournament plays. In every stage, each player still in the tournament plays one game, or has a bye. The final table, when on, comes after the last stage.',
    'Fixed once the first game starts.',
  ]],
  ['tables', 'Tables', [
    'Balanced: as many tables as needed, all as balanced as possible. 9 players at tables of 4 play at three tables of 3; 10 players at 4, 3 and 3. Only tables of 2 with an odd number of players leave someone without a table: a bye (see Bye).',
    'Full: every table full, and whoever is left over has a bye (sits out the stage, see Bye). 9 players at tables of 4 play at two tables of 4, and one has a bye; 7 players play at one table of 4, and three have a bye. With fewer players than a table, they all play together.',
    'Byes go to whoever has had the fewest so far (with Swiss pairing, the lowest ranked of them), so over the stages everyone gets their share.',
    'Fixed once the first game starts.',
  ]],
  ['pairing', 'Pairing', [
    'Random: new random tables every stage.',
    'Swiss: stage 1 at random. From stage 2, the players are sorted by the standings (points, then the tiebreaks, see Ranking) and seated in that order, the leaders at the same table; then players swap between neighboring tables whenever that lowers how many players at a table already met. A rematch still happens when there is no way around it.',
    'Fixed once the first game starts.',
  ]],
  ['order', 'Play order', [
    'Random: each table\'s play order is drawn at random.',
    'Rotation: each table plays in the order that puts as few players as possible back in a seat they already had (every repeat counts: sitting 2nd twice counts twice); among equally good orders, whoever sat later so far, on average, plays earlier. Seats compare across table sizes by where they fall between first and last. With 4 players at one table for 4 stages, everyone sits in every seat once.',
    'Fixed once the first game starts.',
  ]],
  ['scoring', 'Scoring', [
    'Borda count: at a table of the largest size, 1st scores one point less than the players at the table, 2nd one less, down to 0 for last (at tables of 4: 3, 2, 1, 0). A smaller table keeps 1st\'s and last\'s points and spreads the places in between evenly: at 3 players, 3, 1.5 and 0.',
    'Custom: you type the points for each place at every table size, each place no more than the one above. Type the largest table\'s row, then fill the smaller tables from it with one of two buttons, and change any box by hand if you like.',
    'Same win: a smaller table keeps 1st\'s and last\'s points and spreads the others along your row. 5, 3, 1, 0 at 4 gives 5, 2, 0 at 3 and 5, 0 at 2. A win is worth the same at every table, but the average place scores more at a smaller table (2.33 at 3 and 2.5 at 2, against 2.25 at 4).',
    'Same average: each place at a smaller table scores the average of the largest table\'s places it stands for. 5, 3, 1, 0 at 4 gives 4.5, 2, 0.25 at 3 and 4, 0.5 at 2. The average place scores the same at every table (2.25), so no table is easier to score at, but a win at a smaller table is worth less.',
    'With both, a player who drops out of a game scores the place they got: drops take the last places, in the order they drop (the first to drop is last).',
    'Fixed once the first game starts.',
  ]],
  ['bye', 'Bye', [
    'A bye is a stage a player sits out: when the players can\'t all be seated at the tables, whoever is left over doesn\'t play in that stage and gets the bye\'s points instead.',
    'What a bye scores, a win being what 1st scores at a full table (3 at tables of 4 with Borda count).',
    'Last: 0.',
    'Half a win: half of that (1.5).',
    'A win: as much as a win, as in Swiss chess.',
    'A bye never counts as a 1st place for the tiebreaks, and a player with a bye has no opponents in that stage.',
    'Fixed once the first game starts.',
  ]],
  ['ranking', 'Ranking and tiebreaks', [
    'The standings rank by points. Equal points are separated by the most 1st places, then by the opponents\' points: the sum of the current points of every opponent faced, once for each time they met. Players still equal share their place.',
  ]],
  ['final', 'Final table', [
    'Off: the standings after the last stage are the final ranking.',
    'On: after the last stage, the top of the standings (as many as a table holds, among the players still in the tournament; equal places in the standings\' order) play one final table. Its ranking decides the top places: its winner wins the tournament, its 2nd is 2nd, and so on; everyone else keeps their order from the standings, after the finalists. The final scores no points. Each finalist gets a villain they haven\'t played in the tournament, when the pool allows.',
    'Fixed once the first game starts.',
  ]],
  ['villains', 'Villains', [
    'At the start, every player\'s villain for every stage is drawn at once, from the draw pool: in each stage all villains are different, and nobody gets the same villain twice while the pool has enough of them (with more stages than villains, everyone plays every villain once before any repeats). A stage\'s villains show only once it is drawn.',
    'The draw pool needs at least as many villains as players. Fixed once the first game starts.',
  ]],
  ['players', 'Players', [
    'The organizer types the names; a signed-in player claims theirs with That\'s me (or joins by themselves), and from then on shows by their nickname. Sign-ups close at the start.',
    'The organizer can withdraw a player at any time: they leave the tournament, keep their points and are no longer drawn. If their game of the current stage hasn\'t started yet, they drop out of it (the last places); bringing them back before it starts takes the drop back. Bring back makes them play again from the next stage.',
    'Dropping out of a game is not withdrawing: the player leaves that game only (the last places) and is drawn in the next stage as usual.',
    'Edit settings adds players after the start too, until the first game starts: stage 1 is drawn again with them. Once a game has started, no player can be added. A player with no name typed is Player N until claimed.',
  ]],
  ['changes', 'After the start', [
    'Until the first game starts every setting can change, in Edit settings; changing the tables, the stages, the pool or the players draws stage 1 again. Once a game has started, only the name and the date change, nothing about the rules. Undo draw cancels the current stage\'s draw while none of its games is saved (undoing stage 1 goes back to sign-ups, and the start draws everything again).',
    'The organizer can fix any saved table with Edit result (places, drops, duration, rounds, play order) and enter the result of a table nobody recorded.',
  ]],
];

// A paragraph that opens with an option's name ("Random: ...") shows the name in bold.
function tnHelp(section) {
  document.getElementById('tnHelpBody').innerHTML = TN_HELP.map(([id, title, paras]) => `
    <section class="tn-help-section" id="tnHelp-${id}">
      <h4>${t(title)}</h4>
      ${paras.map(p => `<p>${t(p).replace(/^[^:.;,]{1,24}:/, '<strong>$&</strong>')}</p>`).join('')}
    </section>`).join('');
  openOverlay('tnHelpSheet');
  if (section) document.getElementById(`tnHelp-${section}`)?.scrollIntoView({ block: 'start' });
  else document.getElementById('tnHelpBody').scrollTop = 0;
}

// Each option's ⓘ, next to its label (added once: the labels are translated first).
function _tnHelpButtons() {
  document.querySelectorAll('#tnForm [data-help] > label').forEach(label => {
    if (label.querySelector('.tn-info')) return;
    const key = label.parentElement.dataset.help;
    label.insertAdjacentHTML('beforeend', ` <button class="tn-info" type="button" onclick="event.preventDefault(); tnHelp('${key}')" title="${_esc(t('How the options work'))}">ⓘ</button>`);
  });
}

function tnSizeChanged() {
  tnCustom = _tnCustomRows(_tnFormSize());
  _tnRenderCustom();
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
  if (!document.getElementById('tnFormPlayers').classList.contains('hidden')) _tnRenderFormPlayers();
}

// ── The form's players (New tournament) ──
// New Game's rows: a name each (empty: the "Player 3" shown), 👤 for you (your
// nickname, your name claimed), ❌ to remove; the count menu from 2 up to the
// villains in the draw pool (every player needs a different one per stage).
let tnFormPlayers = [];

function _tnPoolSize() { return tnChars.length - (tnPool?.excluded.size || 0); }

// Edit settings adds players: none to start with, up to the pool's villains
// for everyone still playing (the lobby: everyone).
const _tnFormMin    = () => tnFormFor ? 0 : 2;
const _tnFormMax    = () => Math.max(_tnFormMin(), _tnPoolSize() - (tnFormFor ? tnPlayers.filter(p => p.withdrawn_after == null).length : 0));
const _tnFormNumber = i => (tnFormFor ? tnPlayers.length : 0) + i + 1;

// The names to store: typed, or "Player N" (yours too: your nickname shows
// while you hold it, and the name stays its own if you release it), never one
// already taken.
function _tnFormNames() {
  const taken = new Set(tnFormFor ? tnPlayers.map(p => p.name.toLowerCase()) : []);
  tnFormPlayers.forEach(p => { if (!p.isMe && p.name.trim()) taken.add(p.name.trim().toLowerCase()); });
  return tnFormPlayers.map((p, i) => {
    if (!p.isMe && p.name.trim()) return p.name.trim();
    return _tnFreeName(taken, _tnFormNumber(i));
  });
}

// "Player N" from n up, the first one not taken (and now taken).
function _tnFreeName(taken, n) {
  let name;
  for (; taken.has((name = t('Player {n}', { n })).toLowerCase()); n++);
  taken.add(name.toLowerCase());
  return name;
}

function _tnRenderFormPlayers() {
  const min = _tnFormMin(), max = _tnFormMax();
  const n = tnFormPlayers.length;
  const sel = document.getElementById('tnPlayerCount');
  sel.innerHTML = Array.from({ length: Math.max(max, n) - min + 1 }, (_, i) => i + min)
    .map(k => `<option value="${k}"${k === n ? ' selected' : ''}${k > max ? ' disabled' : ''}>${k}p</option>`).join('');
  // 👤 when you're not in the tournament yet (a new one: always).
  const me = !!getCurrentUser() && !(tnFormFor && tnPlayers.some(p => p.user_id === getCurrentUser().id));
  document.getElementById('tnFormRows').innerHTML = tnFormPlayers.map((p, i) => `
    <div class="order-slot">
      <span class="row-num">${_tnFormNumber(i)}.</span>
      ${p.isMe && getCurrentProfile() ? avatarHTML(resolveAvatar(getCurrentProfile()), { cls: 'order-slot-portrait' }) : '<img class="order-slot-portrait" src="asset/players/default.svg" alt="">'}
      <input class="order-slot-name order-slot-input" type="text" maxlength="30" value="${_esc(p.name)}" placeholder="${_esc(t('Player {n}', { n: _tnFormNumber(i) }))}"
             oninput="tnFormPlayers[${i}].name = this.value" autocomplete="off">
      <div class="order-slot-actions">
        <button class="pf-btn del" type="button" onclick="tnRemoveFormPlayer(${i})" ${n > min ? `title="${t('Remove')}"` : `title="${t('A tournament needs at least 2 players.')}" disabled`}>❌</button>
        <button class="pf-btn me${p.isMe ? ' on' : ''}${me ? '' : ' locked'}" type="button" onclick="tnToggleFormMe(${i})" title="${t('Me')}">👤</button>
      </div>
    </div>`).join('');
  document.getElementById('tnAddRowBtn').disabled = n >= max;
}

function tnSetPlayerCount(n) {
  n = Math.max(_tnFormMin(), Math.min(n, _tnFormMax()));
  while (tnFormPlayers.length < n) tnFormPlayers.push({ name: '', isMe: false });
  tnFormPlayers.length = n;
  _tnRenderFormPlayers();
}

function tnRemoveFormPlayer(i) {
  if (tnFormPlayers.length <= _tnFormMin()) return;
  tnFormPlayers.splice(i, 1);
  _tnRenderFormPlayers();
}

// 👤: you play too (one row): your nickname, your name already claimed.
function tnToggleFormMe(i) {
  const nick = getCurrentProfile()?.nickname;
  if (!nick || (tnFormFor && tnPlayers.some(p => p.user_id === getCurrentUser()?.id))) return;
  const on = !tnFormPlayers[i].isMe;
  tnFormPlayers.forEach((p, k) => {
    if (p.isMe && k !== i) { p.isMe = false; if (p.name === nick) p.name = ''; }
  });
  tnFormPlayers[i].isMe = on;
  if (on) tnFormPlayers[i].name = nick;
  else if (tnFormPlayers[i].name === nick) tnFormPlayers[i].name = '';
  _tnRenderFormPlayers();
}

async function tnSaveForm() {
  const user = getCurrentUser();
  if (!user) return goToSignIn();
  const date  = document.getElementById('tnDate').value || _tnToday();
  const names = _tnFormNames();
  const me    = tnFormPlayers.findIndex(p => p.isMe);
  const pool  = tnChars.map(c => c.name).filter(n => !tnPool.excluded.has(n));
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length
      || (tnFormFor && names.some(n => tnPlayers.some(p => p.name.toLowerCase() === n.toLowerCase())))) {
    return showError('tnFormErr', t('Every player needs a different name.'));
  }
  // A game has started: the name and the date only.
  if (tnFormFor && !_tnAllOpen(tnFormFor)) {
    const name = document.getElementById('tnName').value.trim();
    if (!name) return showError('tnFormErr', t('Give the tournament a name.'));
    const btn = document.getElementById('tnFormSave');
    btn.disabled = true;
    let error = null;
    if (name !== tnFormFor.name) error = (await db.rpc('set_tournament_name', { target: tnFormFor.id, new_name: name })).error;
    if (!error && date !== tnFormFor.event_date) error = (await db.rpc('set_tournament_date', { target: tnFormFor.id, new_date: date })).error;
    btn.disabled = false;
    if (error) return showError('tnFormErr', _tnErrorMsg(error));
    setVisible('tnForm', false);
    setVisible('tnRoot', true);
    return tnLoad(tnFormFor.id);
  }
  const name   = document.getElementById('tnName').value.trim();
  const stages = Number(document.getElementById('tnStages').value);
  if (!name) return showError('tnFormErr', t('Give the tournament a name.'));
  if (!Number.isInteger(stages) || stages < 1 || stages > 20) return showError('tnFormErr', t('Stages: from 1 to 20.'));
  if (pool.length < 2) return showError('tnFormErr', t('The draw pool needs at least 2 villains.'));
  const total = names.length + (tnFormFor ? tnPlayers.length : 0);
  if (total > pool.length) return showError('tnFormErr', t('The draw pool has {v} villains for {n} players: every player needs a different one.', { v: pool.length, n: total }));
  const row = {
    name, stages,
    table_size:   Number(document.getElementById('tnSize').value),
    pairing:      tnRule.pairing,
    scoring:      tnRule.scoring,
    villain_pool: pool,
  };
  if (tnRule.scoring === 'custom') {
    const rows = Object.keys(tnCustom).map(Number).filter(n => n <= row.table_size).sort((a, b) => b - a).map(n => tnCustom[n]);
    if (rows.some(r => r.some((v, i) => i && v > r[i - 1]))) return showError('tnFormErr', t('Custom points: each place scores no more than the one above it.'));
    row.custom_points = rows.flat();
  }
  // The options the database adds a default for are written only when they
  // differ from it (or from what the tournament had).
  for (const [key, value, dflt] of [
    ['table_split', tnRule.table_split, 'even'], ['play_order', tnRule.play_order, 'random'],
    ['bye', tnRule.bye, 'half'], ['event_date', date, _tnToday()], ['final_table', tnRule.final === 'on', false],
  ]) {
    if (value !== dflt || (tnFormFor && (tnFormFor[key] ?? dflt) !== value)) row[key] = value;
  }
  const newPlayers = id => names.map((name, i) => ({ tournament_id: id, name, user_id: i === me ? user.id : null }));

  // Started, no game saved: a change to the draw draws stage 1 again.
  if (tnFormFor?.current_stage > 0) {
    const was = tnFormFor;
    const redraw = names.length || row.table_size !== was.table_size || row.stages !== was.stages
      || row.table_split !== undefined && row.table_split !== (was.table_split || 'even')
      || row.play_order  !== undefined && row.play_order  !== (was.play_order || 'random')
      || pool.length !== was.villain_pool.length || pool.some(v => !was.villain_pool.includes(v));
    if (!redraw) return _tnSaveSettings(row, []);
    return openConfirmSheet({
      id:           'tnRedrawSheet',
      title:        t('Draw stage 1 again?'),
      bodyHTML:     `<p class="confirm-text">${t('The tables, the stages, the pool or the players changed: stage 1\'s tables and every player\'s villains are drawn again.')}</p>`,
      confirmLabel: t('Draw again'),
      busyLabel:    t('Drawing…'),
      onConfirm:    async () => {
        // Back to sign-ups, the settings and the players, then Start again.
        let { error } = await db.rpc('undo_tournament_stage', { target: was.id });
        if (!error) ({ error } = await db.from('tournaments').update(row).eq('id', was.id));
        if (!error && names.length) ({ error } = await db.from('tournament_players').insert(newPlayers(was.id)));
        setVisible('tnForm', false);
        setVisible('tnRoot', true);
        await tnLoad(was.id);
        if (!error) error = await _tnDrawStart();
        await _tnAfter(error);
      },
    });
  }
  if (tnFormFor) return _tnSaveSettings(row, names.length ? newPlayers(tnFormFor.id) : []);

  const btn = document.getElementById('tnFormSave');
  btn.disabled = true;
  const res = await db.from('tournaments').insert({ ...row, organizer: user.id }).select('id');
  btn.disabled = false;
  if (res.error || !res.data?.length) return showError('tnFormErr', _tnErrorMsg(res.error));
  const id = res.data[0].id;
  const { error } = await db.from('tournament_players').insert(newPlayers(id));
  if (error) console.warn('tournament players', error);   // the lobby still adds them
  _tnDraftReady = false;
  _tnDropDraft();
  location.replace(`tournaments.html?t=${id}`);
}

// The settings (and the players added), while every setting can change.
async function _tnSaveSettings(row, players) {
  const btn = document.getElementById('tnFormSave');
  btn.disabled = true;
  const res = await db.from('tournaments').update(row).eq('id', tnFormFor.id).select('id');
  let error = res.error || (!res.data?.length && { message: 'already_started' });
  if (!error && players.length) error = (await db.from('tournament_players').insert(players)).error;
  btn.disabled = false;
  if (error) return showError('tnFormErr', _tnErrorMsg(error));
  setVisible('tnForm', false);
  setVisible('tnRoot', true);
  await tnLoad(tnFormFor.id);
}

// ── RECORDING A TABLE ─────────────────────────────────────────────────────────
// Who can record a table, its card's buttons, and Start game: the phone takes
// the table (take_tournament_table: the organizer, or a player at it who
// claimed their name; one at a time) and the game runs on its own page,
// tournament-game.html (tournament-game.js), on New Game's engine. One game in
// progress per phone, New Game's or a table's.

const _tnSavedGame = () => liveGame.loadSaved();

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
  if (saved?.tournament?.tableId === tb.id) return `<a class="btn btn-primary btn-sm" href="tournament-game.html?table=${tb.id}">${t('Resume game')}</a>`;
  if (!_tnCanRecord(tb)) return '';
  const user = getCurrentUser();
  const isOrg = user.id === tnTour.organizer;
  // The organizer can also type a table's result without playing it on a phone.
  const enter = isOrg ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnEditTable('${tb.id}')">${t('Enter result')}</button>` : '';
  if (!tb.recorder || tb.recorder === user.id) return `<button class="btn btn-primary btn-sm" type="button" onclick="tnStartTable('${tb.id}')">${t('Start game')}</button>${enter}`;
  if (isOrg) return `<button class="btn btn-ghost btn-sm" type="button" onclick="tnStartTable('${tb.id}')">${t('Take over')}</button>${enter}`;
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
  const game = {
    tourId: tnTour.id, tableId, stage: tb.stage, tableNo: tb.table_no, tourName: tnTour.name, isFinal: tb.stage > tnTour.stages,
    startedAt: Date.now(),
    seats: tb.seats.map(s => ({ position: s.position, player_id: s.player_id, character: s.character, name: tnPlayerName(byId.get(s.player_id)) })),
    // Who withdrew before the game: dropped from the start (the last places).
    actions: tb.seats.filter(s => s.dropped).map((s, i) => ({ position: s.position, place: tb.seats.length - i, minutes: null, round: null, dropped: true, withdrawn: true })),
  };
  liveGame.clear();
  liveGame.markStarted(Date.now());
  liveGame.setTurns(1);
  liveGame.persist({ slots: game.seats, tournament: game });
  location.href = `tournament-game.html?table=${tableId}`;   // the game has a page of its own
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
    ? btn('players', t('Players')) + btn('standings', t('Final ranking')) + btn('log', t('Log'))
    : btn('tables', t('Tables')) + btn('standings', t('Standings')) + btn('log', t('Log'))}</div></div>`;
}

function tnSetView(v) {
  tnView = v;
  tnRenderTournament();
}

function _tnSeatPoints(tb, seat) {
  return tournamentSeatPoints(tnTour, tb.seats.length, seat);
}
const _tnPointsLabel = p => t(p === 1 ? '{n} pt' : '{n} pts', { n: fmtTournamentPoints(p) });

// Under a row tied on points with a neighbor (finalists aside: the final
// orders them): the tiebreak that separates them, with its value, or that the
// place is shared.
function _tnTieNote(rows, r) {
  const i = rows.indexOf(r);
  const tied = [rows[i - 1], rows[i + 1]].filter(x => x && !x.final && x.points === r.points);
  if (!tied.length) return '';
  for (const tb of TOURNAMENT_TIEBREAKS) {
    if (tied.some(x => tb.value(x) !== tb.value(r))) return `${t('Tiebreak')}: ${t(tb.name)} ${fmtTournamentPoints(tb.value(r))}`;
  }
  return t('Shared place');
}

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
    const sub = r.final ? '' : _tnTieNote(rows, r);
    // A claimed name links to its player page, as in the Leaderboard.
    const name = prof
      ? `<a class="row-name row-name-link" href="players.html?nick=${encodeURIComponent(prof.nickname)}">${_esc(tnPlayerName(p))}</a>`
      : `<span class="row-name">${_esc(tnPlayerName(p))}</span>`;
    return `
      <div class="lb-row${mine && r.player_id === mine.id ? ' lb-row-self' : ''}">
        <div class="rank-num ${medal(r.rank)}">${tnTour.finished_at && r.rank <= 3 ? `<span class="tn-medal">${TOURNAMENT_MEDALS[r.rank - 1]}</span>` : r.rank}</div>
        <div class="row-identity">${avatar}<div class="row-id-text">${name}${sub ? `<div class="row-sub">${sub}</div>` : ''}</div></div>
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
    <p class="results-hint">${_esc(t(scoring?.hint || ''))} ${t('Ties: most 1st places, then the points of the opponents faced.')}${tnTour.final_table ? ` ${t('With a final table, the finalists come first, in the final\'s order.')}` : ''}</p>`;
}

// Every stage's saved tables, in order, with places and points (the ones
// still being played are in Tables).
function _tnLogHTML(mine) {
  const myId = mine?.id;
  const out = [];
  for (let st = 1; st <= tnTour.current_stage; st++) {
    const tables = tnTables.filter(tb => tb.stage === st && tb.saved_at);
    if (!tables.length) continue;
    out.push(`<div class="section-label">${tnStageLabel(st)}</div>
      <div class="tn-tables">${tables.map(tb => _tnTableHTML(tb, myId)).join('')}</div>`);
  }
  return out.length ? out.join('') : emptyStateHTML('🏟️', t('No results yet'), t('The tables appear here once they are saved.'));
}

function tnNextStage() {
  const next = tnTour.current_stage + 1;
  openConfirmSheet({
    id:           'tnNextSheet',
    title:        t('Draw stage {n}?', { n: next }),
    bodyHTML:     `<p class="confirm-text">${_tnDrawSummary(next)}</p>`,
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
// order (1st on top), each with 🏳️ for a drop; and, under them, the play
// order (the villains stay the drawn ones). Drops always sit at the bottom:
// marking one moves it just above the earlier drops (the latest drop), taking
// one back moves it just below the others; dragging keeps that order.
let tnEdit = null;   // { tableId, rows: [{ position, dropped }] } in place order

function tnEditTable(tableId) {
  const tb = tnTables.find(x => x.id === tableId);
  if (!tb) return;
  const entering = !tb.saved_at;   // Enter result: a table nobody recorded, in play order to start
  tnEdit = {
    tableId,
    rows:  tb.seats.slice().sort((a, b) => entering ? a.position - b.position : a.place - b.place).map(s => ({ position: s.position, dropped: !!s.dropped })),
    order: tb.seats.map(s => s.position).sort((a, b) => a - b),   // the seats in play order
  };
  const first = entering ? null : tb.seats.find(s => s.place === 1);   // the standard game's duration and rounds are 1st place's
  openConfirmSheet({
    id:           'tnEditSheet',
    title:        t('Table {n}', { n: tb.table_no }),
    bodyHTML:     `<div class="form-row">
                     <div class="field"><label>${t('Duration <span class="optional">(min)</span>')}</label><input type="number" id="tnEditDur" min="1" max="999" value="${first?.minutes || ''}"></div>
                     <div class="field"><label>${t('Rounds <span class="optional"></span>')}</label><input type="number" id="tnEditTurns" min="1" max="999" value="${first?.round || ''}"></div>
                   </div>
                   <div class="section-label lineup-label"><span>${t('Ranking')}</span>
                     <span class="players-legend"><span class="sep-item">${t('⠿ = drag')}</span> | <span class="sep-item">${t('🏳️ = dropped')}</span></span></div>
                   <div class="err" id="tnEditErr"></div>
                   <div class="tn-edit-rows" id="tnEditRows"></div>
                   <p class="modal-hint">${t('Drag the villains into their places. Drops stay at the bottom; the standard game follows (1st place won it, with this duration and these rounds).')}</p>
                   <div class="${entering ? 'hidden' : ''}">
                     <div class="section-label">${t('Play order')}</div>
                     <div class="tn-edit-rows" id="tnEditOrder"></div>
                     <p class="modal-hint">${t('If the table played in another order than the drawn one, drag the villains into it. Their villains stay the drawn ones.')}</p>
                   </div>`,
    confirmLabel: entering ? t('Save result') : t('Save Changes'),
    busyLabel:    t('Saving…'),
    onConfirm:    async () => {
      const results = tnEdit.rows.map((r, i) => ({ position: r.position, place: i + 1, dropped: r.dropped }));
      // A new play order: each seat's new position (sent only when it changed).
      if (!entering && tnEdit.order.some((pos, i) => pos !== i)) for (const r of results) r.order = tnEdit.order.indexOf(r.position);
      // The game's duration and rounds go to whoever is 1st now (empty: as they were).
      const dur = parseInt(document.getElementById('tnEditDur').value), turns = parseInt(document.getElementById('tnEditTurns').value);
      if (dur > 0)   results[0].minutes = dur;
      if (turns > 0) results[0].round   = turns;
      // A new result: the organizer takes the table (another phone's game can't
      // save any more) and saves it; this phone's game of it, if any, is over.
      const error = entering
        ? (await db.rpc('take_tournament_table', { target_table: tableId })).error
          || (await db.rpc('save_tournament_table', { target_table: tableId, played_at: new Date().toISOString(), results })).error
        : (await db.rpc('edit_tournament_table', { target_table: tableId, results })).error;
      if (error) { showError('tnEditErr', _tnErrorMsg(error)); throw error; }
      if (entering && _tnSavedGame()?.tournament?.tableId === tableId) { liveGame.clear(); liveGame.emit('close'); updateLiveGameNavBadge(); }
      await tnLoad(tnTour.id);
    },
  });
  for (const [id, list] of [['tnEditRows', 'rows'], ['tnEditOrder', 'order']]) {
    const box = document.getElementById(id);
    if (box.dataset.drag) continue;
    box.dataset.drag = '1';
    attachRowDrag(box, {
      rowSelector: '.order-slot',
      onDrop: (from, to) => {
        if (to !== from) tnEdit[list].splice(to, 0, tnEdit[list].splice(from, 1)[0]);
        _tnRenderEditRows();
      },
    });
  }
  _tnRenderEditRows();
}

// A villain's row in the sheet: ⠿, the place or seat number, portrait, names.
function _tnEditRowHTML(s, num, cls = '', actions = '') {
  const name = tnPlayerName(tnPlayers.find(p => p.id === s.player_id));
  return `
    <div class="order-slot tn-edit-row${cls}">
      <div class="drag-handle">
        <span class="drag-dots">⠿</span><span class="row-num tn-edit-place">${num}</span>
        <img class="order-slot-portrait" src="${charImgSrc(s.character)}" onerror="this.src='asset/players/default.svg'" alt="">
      </div>
      <div class="claim-who"><div class="claim-name">${villainNameHTML(s.character)}</div><div class="claim-nick">${_esc(name)}</div></div>
      ${actions}
    </div>`;
}

function _tnRenderEditRows() {
  // Drops at the bottom, each group keeping its order.
  tnEdit.rows = [...tnEdit.rows.filter(r => !r.dropped), ...tnEdit.rows.filter(r => r.dropped)];
  const tb = tnTables.find(x => x.id === tnEdit.tableId);
  const playing = tnEdit.rows.filter(r => !r.dropped).length;
  document.getElementById('tnEditRows').innerHTML = tnEdit.rows.map((r, i) => {
    const s = tb.seats.find(x => x.position === r.position);
    const last = !r.dropped && playing === 1;   // someone finishes 1st
    return _tnEditRowHTML(s, fmtPlace(i + 1), `${i === 0 ? ' winner' : ''}${r.dropped ? ' dropped' : ''}`, `
      <div class="order-slot-actions">
        <button class="pf-btn drop${r.dropped ? ' on' : ''}" type="button" onclick="tnToggleDrop(${r.position})"
                ${last ? `disabled title="${t('Someone has to finish 1st')}"` : `title="${t('Dropped')}"`}>🏳️</button>
      </div>`);
  }).join('');
  document.getElementById('tnEditOrder').innerHTML = tnEdit.order
    .map((pos, i) => _tnEditRowHTML(tb.seats.find(x => x.position === pos), `${i + 1}.`)).join('');
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
