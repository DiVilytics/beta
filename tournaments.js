// ── TOURNAMENTS (beta) ────────────────────────────────────────────────────────
// tournaments.html. Without a parameter: the tournaments and + New tournament.
// ?new: the New tournament form. ?t=<id>: one tournament, with its settings,
// its players by name and, once started, the current stage's tables.
//
// The organizers (whoever created it, and whoever joined with the organizers'
// QR code, all alike) type the players' names (New tournament, Edit tournament
// until the first game starts). A signed-in player claims their name with
// That's me (and with it every seat of theirs in the tournament's games), at
// any time. Start draws every stage's villains and stage 1's tables. The rules (pairing, scoring, villain draw)
// live in tournament-rules.js; the database (DiVilytics-Sync, the tournaments
// migration) keeps the facts, checks every write and answers with the codes in
// TN_ERRORS. While a tournament is open and not finished, the page reloads it
// every few seconds, so names, claims and tables show up as they change.

let tnChars    = [];
let tnBoxInfo  = {};
let tnList     = null;        // the list view's tournaments
let tnMineIds  = new Set();   // the ones you play in (a name claimed, not withdrawn)
let tnTour     = null;        // the open tournament (a tournaments row)
let tnPlayers  = [];          // its players (tournament_players rows)
let tnTables   = [];          // its tables, each with .seats in play order
let tnOrganizers = [];        // its organizers' user ids, the longest-standing first
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
    // A link with the claim code (the QR code), or the organizers' code (their
    // QR code): kept on this phone, out of the address.
    const url = new URL(location.href);
    if (params.get('c')) { _tnSaveCode(id, params.get('c')); url.searchParams.delete('c'); }
    if (params.get('o')) { _tnSaveInvite(id, params.get('o')); url.searchParams.delete('o'); }
    history.replaceState(null, '', url);
    _tnSetBack();
    return tnLoad(id);
  }
  tnLoadList();
}

// The ← link (ui.js): a tournament (or New tournament) goes back to the list
// or the player page it was opened from, else up to the list. Edit
// tournament's goes back to its tournament, as Cancel does.
function _tnSetBack() {
  setBackLink('tnBack', { parent: { href: 'tournaments.html', label: t('Tournaments') }, from: ['tournaments.html', 'players.html'] });
}

// Back to a tournament, from a table's game or another page (the browser's
// back can show it as it was): reloaded quietly.
window.addEventListener('pageshow', e => {
  if (e.persisted && tnTour && !_tnFormOpen()) tnLoad(tnTour.id, { quiet: true });
  else if (e.persisted && tnList) tnLoadList();
});

function _tnAuthChanged() {
  if (!_tnFormOpen() && tnTour) tnRenderTournament();
  else if (!_tnFormOpen() && tnList) tnLoadList();   // yours on top change with who's signed in
  if (_tnFormOpen() && tnPool) tnPool.loadOwnedBoxes().then(() => tnPool.updatePaceUI());
}

// ── SHARED BITS ───────────────────────────────────────────────────────────────

// The claim code: names are claimed only with it, as a game is only from its
// QR code. It comes with the tournament's link or QR code (?c=), kept on this
// phone; the organizers and whoever claimed a name can read it (and so share
// it), the others only have it from a link.
const _tnCodeKey = id => `divilytics_tn_code_${id}${STORAGE_SCOPE}`;
function _tnSaveCode(id, code) { try { localStorage.setItem(_tnCodeKey(id), code); } catch (_) {} }
function _tnCode() {
  if (!tnTour) return null;
  try { return localStorage.getItem(_tnCodeKey(tnTour.id)); } catch (_) { return null; }
}
// Signing in from here: the code rides along in the return address, so it
// comes back even if sign-in ends in another browser.
onBeforeSignIn(() => {
  const code = _tnCode(), invite = _tnInvite();
  if (!code && !invite) return;
  const url = new URL(location.href);
  if (code)   url.searchParams.set('c', code);
  if (invite) url.searchParams.set('o', invite);
  history.replaceState(null, '', url);
});

// The organizers: whoever created the tournament and whoever joined with the
// organizers' code (their QR code, which only organizers can read and share).
// They are all alike: each can do everything, add organizers and remove any
// of them, themselves included, as long as one is left.
const _tnIsOrg = user => !!user && tnOrganizers.includes(user.id);

// The organizers' code from their QR code: an invitation, kept on this phone
// until it's used (Become an organizer) or you already are one.
const _tnInviteKey = id => `divilytics_tn_org_${id}${STORAGE_SCOPE}`;
function _tnSaveInvite(id, code) { try { localStorage.setItem(_tnInviteKey(id), code); } catch (_) {} }
function _tnInvite() {
  if (!tnTour) return null;
  try { return localStorage.getItem(_tnInviteKey(tnTour.id)); } catch (_) { return null; }
}
function _tnDropInvite() { try { localStorage.removeItem(_tnInviteKey(tnTour.id)); } catch (_) {} }

async function _tnFetchCode() {
  const user = getCurrentUser();
  if (_tnCode() || !user || (!_tnIsOrg(user) && !tnPlayers.some(p => p.user_id === user.id))) return;
  const { data } = await db.from('tournament_claim_codes').select('code').eq('tournament_id', tnTour.id).maybeSingle();
  if (data?.code) _tnSaveCode(tnTour.id, data.code);
}


// A player's name as shown everywhere: the nickname of whoever claimed it,
// else the name an organizer typed.
function tnPlayerName(p) {
  if (!p) return '';
  return (p.user_id && tnProfiles.get(p.user_id)?.nickname) || p.name;
}

// By the name shown ("Player 2" before "Player 10").
const _tnByName = (a, b) => tnPlayerName(a).localeCompare(tnPlayerName(b), LOCALE, { numeric: true, sensitivity: 'base' });

// Every list of the players: the claimed names first, then the others, each
// block alphabetical (the standings too, among equal places).
function _tnSortPlayers() {
  tnPlayers.sort((a, b) => (!a.user_id - !b.user_id) || _tnByName(a, b));
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
  el.className = 'err';
  root.prepend(el);
  showError(el, msg);
}

// ── THE LIST ──────────────────────────────────────────────────────────────────

async function tnLoadList() {
  const root = document.getElementById('tnRoot');
  const user = getCurrentUser();
  const [{ data, error }, mine] = await Promise.all([
    db.from('tournaments').select('*, tournament_players(count), tournament_organizers(user_id, added_at)').order('created_at', { ascending: false }),
    user ? db.from('tournament_players').select('tournament_id').eq('user_id', user.id).is('withdrawn_after', null) : { data: [] },
  ]);
  root.className = '';
  if (error) { root.innerHTML = loadErrorHTML(t("Couldn't load the tournaments"), error); return; }
  tnList = data || [];
  tnMineIds = new Set((mine.data || []).map(r => r.tournament_id));
  await _tnLoadProfiles(tnList.flatMap(_tnCardOrganizers));
  tnRenderList();
}

// A listed tournament's organizers (from tournament_organizers), the longest-standing first.
const _tnCardOrganizers = tour => (tour.tournament_organizers || [])
  .slice().sort((a, b) => a.added_at.localeCompare(b.added_at)).map(o => o.user_id);
// Their nicknames as a card shows them: "Ikron and Norrell".
const _tnOrganizerNames = ids => new Intl.ListFormat(LOCALE, { type: 'conjunction' })
  .format(ids.map(id => tnProfiles.get(id)?.nickname).filter(Boolean));

// Your tournaments in progress (you play in them or organize them) on top,
// then the others, newest first.
function tnRenderList() {
  const root = document.getElementById('tnRoot');
  const newBtn = `<button class="btn btn-primary btn-sm" type="button" onclick="tnNew()">${t('+ New tournament')}</button>`;
  if (!tnList.length) {
    root.innerHTML = emptyStateHTML('🏟️', t('No tournaments yet'), t('Add the players, and DiVilytics draws the tables and the villains of every stage.'), newBtn);
    return;
  }
  const me    = getCurrentUser()?.id;
  const isYou = tour => tournamentState(tour) === 'running' && (tnMineIds.has(tour.id) || (!!me && _tnCardOrganizers(tour).includes(me)));
  const yours  = tnList.filter(isYou);
  const others = tnList.filter(tour => !isYou(tour));
  const cards  = list => list.length ? `<div class="tn-list">${list.map(tour => tournamentCardHTML(tour, { organizer: _tnOrganizerNames(_tnCardOrganizers(tour)) })).join('')}</div>` : '';
  root.innerHTML = `
    <div class="list-header">
      <div class="results-hint">${tn(tnList.length, '{n} tournament', '{n} tournaments')}</div>
      ${newBtn}
    </div>
    ${yours.length ? `
      <div class="section-label">${tn(yours.length, 'Your tournament in progress', 'Your tournaments in progress')}</div>
      ${cards(yours)}
      ${others.length ? `<div class="section-label">${t('Other tournaments')}</div>` : ''}` : ''}
    ${cards(others)}`;
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
  const [tourRes, playersRes, tablesRes, orgsRes] = await Promise.all([
    db.from('tournaments').select('*').eq('id', id).maybeSingle(),
    db.from('tournament_players').select('*').eq('tournament_id', id).order('joined_at'),
    db.from('tournament_tables').select('*, tournament_seats(*)').eq('tournament_id', id).order('stage').order('table_no'),
    db.from('tournament_organizers').select('user_id').eq('tournament_id', id).order('added_at'),
  ]);
  const error = tourRes.error || playersRes.error || tablesRes.error || orgsRes.error;
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
  tnOrganizers = (orgsRes.data || []).map(o => o.user_id);
  await _tnLoadProfiles([...tnOrganizers, ...tnPlayers.map(p => p.user_id), ...tnTables.map(tb => tb.recorder)]);
  if (_tnIsOrg(getCurrentUser())) _tnDropInvite();   // already one of them
  _tnSortPlayers();
  await _tnFetchCode();
  _tnSchedulePoll();
  const snap = JSON.stringify([tnTour, tnPlayers, tnTables, tnOrganizers]);
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
  const isOrg = _tnIsOrg(user);
  const lobby = tnTour.current_stage === 0;
  const mine  = user ? tnPlayers.find(p => p.user_id === user.id) : null;

  const pairing = TOURNAMENT_PAIRINGS[tnTour.pairing];
  const scoring = TOURNAMENT_SCORINGS[tnTour.scoring];
  // Each option with its name, as the form calls it.
  // On top the tournament (name, date, organizer, status); under it, after a
  // gap, Options (folded until tapped: one per row), with ⓘ for Tournament options.
  const opt = (label, value) => `<div class="claim-meta">${t(label)}: ${value}</div>`;
  const organizer = tn(tnOrganizers.length, 'Organizer: {names}', 'Organizers: {names}', { names: _esc(_tnOrganizerNames(tnOrganizers) || '-') });
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
  const status = [tournamentStatusHTML(tnTour), tn(tnPlayers.length, '{n} player', '{n} players')].join(' | ');

  const actions = [
    isOrg ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnOpenForm(tnTour)">${t('Edit tournament')}</button>` : '',
    // Share QR, for the players, is the one to find: the others are ghost buttons.
    `<button class="btn btn-primary btn-sm" type="button" onclick="tnShare()">${t('Share QR')}</button>`,
    isOrg ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnShareOrganizers()">${t('Organizer QR')}</button>` : '',
  ].join('');

  const ctx  = { user, isOrg, lobby, mine };
  const rows = tnPlayers.map((p, i) => _tnPlayerRowHTML(p, i, ctx)).join('');

  root.innerHTML = `
    <div class="claim-game-info">
      <div class="claim-date">${_esc(tnTour.name)}</div>
      <div class="claim-meta">${fmtTournamentDate(tnTour)}</div>
      <div class="claim-meta">${organizer}</div>
      <div class="claim-meta">${status}</div>
      <div class="claim-meta tn-options-title">
        <button class="tn-options-toggle" type="button" onclick="tnToggleOptions()" aria-expanded="${tnOptionsOpen}"><strong>${t('Options')}</strong> <span class="chevron${tnOptionsOpen ? ' open' : ''}">▼</span></button>
        <button class="tn-info" type="button" onclick="tnHelp()" title="${_esc(t('Tournament options'))}">ⓘ</button>
      </div>
      <div class="tn-options${tnOptionsOpen ? '' : ' hidden'}">${options}</div>
    </div>
    <div class="claim-share-row">${actions}</div>
    ${_tnInviteHTML(user, isOrg)}
    ${_tnOverHTML(mine)}
    ${lobby ? '' : _tnViewSegHTML()}
    ${lobby || tnView === 'players' ? `
      ${lobby ? `<div class="section-label">${t('Players')}</div>` : ''}
      ${tnPlayers.length ? `<div class="tn-player-rows">${rows}</div>` : `<p class="tn-hint">${t('No players yet.')}</p>`}
      ${!user ? `<p class="tn-hint">${t('Sign in to claim your name.')} <button class="btn btn-ghost btn-sm" type="button" onclick="goToSignIn()">${t('Sign in')}</button></p>`
        : !mine && !isOrg && !_tnCode() && tnPlayers.some(p => !p.user_id) ? `<p class="tn-hint">${t('To claim your name, scan the tournament\'s QR code from an organizer, or open its link.')}</p>` : ''}
      ${_tnOrganizersHTML(user, isOrg)}`
      : tnView === 'standings' ? _tnStandingsHTML(mine) : _tnTablesHTML(mine)}
    ${isOrg ? `<div class="claim-delete-row">
      <button class="btn btn-danger btn-sm" type="button" onclick="tnDelete()">${t('Delete tournament')}</button>
      ${lobby ? `<button class="btn btn-primary btn-sm" type="button" onclick="tnStart()">${t('Start tournament')}</button>` : ''}
    </div>` : ''}`;
}

// A player, in New tournament's row: their number, the avatar of whoever
// claimed the name (or the default), the name (the nickname once claimed),
// whether it's claimed or withdrawn, and That's me / Release (and, once
// started, an organizer's Withdraw / Bring back). Players are added, renamed
// and removed in Edit tournament, not here.
function _tnPlayerRowHTML(p, i, { user, isOrg, lobby, mine }) {
  const prof   = p.user_id ? tnProfiles.get(p.user_id) : null;
  const isMine = !!user && p.user_id === user.id;
  const avatar = prof
    ? avatarHTML(resolveAvatar(prof), { cls: 'order-slot-portrait' })
    : '<img class="order-slot-portrait" src="asset/players/default.svg" alt="">';
  const canClaim = !p.user_id && !!user && !mine && (!!_tnCode() || isOrg);
  // Drops in saved games, and a withdrawal (the standings leave them out).
  const drops = tnTables.filter(tb => tb.game_id && tb.seats.some(x => x.player_id === p.id && x.dropped)).length;
  const status = [
    p.user_id ? '' : t('Unclaimed'),
    drops ? `🏳️ ${tn(drops, '{n} drop', '{n} drops')}` : '',
    p.withdrawn_after != null ? t('Withdrawn after stage {n}', { n: p.withdrawn_after }) : '',
  ].filter(Boolean).join(' | ');
  const actions = [
    canClaim ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnClaim('${p.id}')">${t("That's me")}</button>` : '',
    isMine   ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnRelease('${p.id}')">${t('Release')}</button>` : '',
    isOrg && !lobby && !tnTour.finished_at
      ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnWithdraw('${p.id}', ${p.withdrawn_after == null})">${p.withdrawn_after == null ? t('Withdraw') : t('Bring back')}</button>` : '',
  ].join('');
  return `
    <div class="order-slot tn-player-row${isMine ? ' mine' : ''}">
      <span class="row-num">${i + 1}.</span>
      ${avatar}
      <div class="order-slot-info"><span class="order-slot-name">${_esc(tnPlayerName(p))}</span>${status ? `<span class="tn-row-status">${status}</span>` : ''}</div>
      ${actions ? `<div class="order-slot-actions">${actions}</div>` : ''}
    </div>`;
}

// Opened with the organizers' QR code and not one of them yet: the invitation,
// with Become an organizer (Sign in first, when signed out).
function _tnInviteHTML(user, isOrg) {
  if (!_tnInvite() || isOrg) return '';
  return `
    <div class="claim-game-info tn-you">
      <div class="claim-date">${t('Organize this tournament')}</div>
      <div class="claim-meta">${t('This QR code makes you one of its organizers: you can do everything they do, playing included.')}</div>
      <div class="tn-you-actions">${user
        ? `<button class="btn btn-primary btn-sm" type="button" onclick="tnJoinOrganizers()">${t('Become an organizer')}</button>`
        : `<button class="btn btn-primary btn-sm" type="button" onclick="goToSignIn()">${t('Sign in')}</button>`}</div>
    </div>`;
}

// The organizers, under the players: avatar and nickname; to an organizer,
// Remove for each of the others and Step down for themselves (while another
// is left), and how to add one.
function _tnOrganizersHTML(user, isOrg) {
  const rows = tnOrganizers.map(id => {
    const prof = tnProfiles.get(id);
    const self = user?.id === id;
    const action = isOrg && tnOrganizers.length > 1
      ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnRemoveOrganizer('${id}')">${self ? t('Step down') : t('Remove')}</button>` : '';
    return `
      <div class="order-slot tn-player-row${self ? ' mine' : ''}">
        ${prof ? avatarHTML(resolveAvatar(prof), { cls: 'order-slot-portrait' }) : '<img class="order-slot-portrait" src="asset/players/default.svg" alt="">'}
        <div class="order-slot-info"><span class="order-slot-name">${_esc(prof?.nickname || '-')}</span></div>
        ${action ? `<div class="order-slot-actions">${action}</div>` : ''}
      </div>`;
  }).join('');
  return `
    <div class="section-label">${t('Organizers')}</div>
    <div class="tn-player-rows">${rows}</div>
    ${isOrg ? `<p class="tn-hint">${t('To add an organizer, share the Organizer QR: whoever scans it, signed in, becomes one.')}</p>` : ''}`;
}

// Options, folded at first: tapping the title opens them (kept open through the reloads).
let tnOptionsOpen = false;
function tnToggleOptions() {
  tnOptionsOpen = !tnOptionsOpen;
  tnRenderTournament();
}

// A finished tournament, above the tabs, highlighted like your game: that it's
// over, who won and, for a player in it, their final place and points.
function _tnOverHTML(mine) {
  if (!tnTour.finished_at) return '';
  const rows = tournamentStandings(tnTour, tnTables, { players: tnPlayers });
  const byId = new Map(tnPlayers.map(p => [p.id, p]));
  const winners = rows.filter(r => r.rank === 1).map(r => `<strong class="text-emph">${_esc(tnPlayerName(byId.get(r.player_id)))}</strong>`);
  const me = mine ? rows.find(r => r.player_id === mine.id) : null;
  const medal = me && me.rank <= 3 ? `${TOURNAMENT_MEDALS[me.rank - 1]} ` : '';
  return `
    <div class="claim-game-info tn-you">
      <div class="claim-date">🏁 ${t('Tournament over')}</div>
      ${winners.length ? `<div class="claim-meta">${tn(winners.length, 'Winner: {names}', 'Winners: {names}', { names: new Intl.ListFormat(LOCALE, { type: 'conjunction' }).format(winners) })}</div>` : ''}
      ${me ? `<div class="claim-meta tn-over-you">${medal}${t('You finished {place}', { place: fmtPlace(me.rank) })} | ${_tnPointsLabel(me.points)}</div>` : ''}
    </div>`;
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
      <div class="tn-you-villain">${charImgHTML(seat.character)}
        <div class="claim-who"><div class="claim-name">${villainNameHTML(seat.character)}</div><div class="claim-nick">${line}</div></div>
        ${moverImgHTML(seat.character, 'cs-mover')}
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
  if (!_tnIsOrg(user)) return '';
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
  if (!playing) return t('Nobody is still playing: the tournament ends here, on the standings as they are.');
  const sizes = tournamentSplit(playing, tnTour.table_size, tnTour.table_split);
  const tables = sizes.filter(n => n > 1).length, byes = sizes.length - tables;
  const what = byes ? t('{tables} and {byes}', { tables: tn(tables, '{n} table', '{n} tables'), byes: tn(byes, '{n} bye', '{n} byes') }) : tn(tables, '{n} table', '{n} tables');
  const pairing = (TOURNAMENT_PAIRINGS[tnTour.pairing] || TOURNAMENT_PAIRINGS.random).name;
  return `${t('Stage {n} of {m}: {what}, {pairing} pairing.', { n: stage, m: tnTour.stages, what, pairing: t(pairing) })} ${t('It can be undone until a game is saved (a bye isn\'t a game).')}`;
}

// A stage's name: "Stage 2 of 3", or "Final" for the final table.
function tnStageLabel(stage) {
  return stage > tnTour.stages ? t('Final') : t('Stage {n} of {m}', { n: stage, m: tnTour.stages });
}

// The final: the top of the standings play one last table (tournament-rules.js).
function tnDrawFinal() {
  const { players, villains } = tournamentDrawFinal(tnTour, tnPlayers, tnTables);
  const names = players.map(id => _esc(tnPlayerName(tnPlayers.find(p => p.id === id))));
  // Fewer than two still playing: no final to play. One left wins it, like a
  // bye; nobody left, the standings as they are.
  const body = players.length > 1
    ? `${t('The top {n} of the standings play one last table, and its ranking decides the tournament\'s top places: {names}.', { n: players.length, names: `<strong class="text-emph">${new Intl.ListFormat(LOCALE, { type: 'conjunction' }).format(names)}</strong>` })} ${t('It can be undone until it is saved.')}`
    : players.length ? t('Only {name} is still playing: they win the final, like a bye, and the tournament ends.', { name: `<strong class="text-emph">${names[0]}</strong>` })
    : t('Nobody is still playing: there is no final, and the tournament ends on the standings as they are.');
  openConfirmSheet({
    id:           'tnFinalSheet',
    title:        players.length > 1 ? t('Draw the final?') : t('End the tournament?'),
    bodyHTML:     `<p class="confirm-text">${body}</p>`,
    confirmLabel: players.length > 1 ? t('Draw the final') : t('End tournament'),
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
      ? t('Its tables are cancelled, games in progress included, and the tournament goes back to before the start: the settings and the players change in Edit tournament, and Start draws everything again.')
      : t('Its tables are cancelled, games in progress included, and the tournament goes back to stage {n}: you can bring players back, then draw again.', { n: st - 1 })}</p>`,
    confirmLabel: t('Undo draw'),
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
  const notPlayed = tournamentTableNotPlayed(tb);
  const status = bye ? t('Bye')
    : notPlayed   ? t('Not played: everyone withdrew')
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
          <div class="chip-nick">${[_esc(name), s.dropped ? `🏳️ ${tb.game_id ? t('Dropped') : t('Withdrawn')}` : null, tb.saved_at ? _tnPointsLabel(_tnSeatPoints(tb, s)) : null].filter(Boolean).join(' | ')}</div>
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

// The QR code: with the claim code when you have it (an organizer, a player
// with a name), so whoever scans it can claim theirs.
function tnShare() {
  const code = _tnCode();
  _tnQR(t('Share with players'), t('Players scan this to follow the tournament and claim their name.'), code ? `&c=${encodeURIComponent(code)}` : '');
}

// The organizers' QR code: whoever scans it, signed in, can become one.
async function tnShareOrganizers() {
  const { data, error } = await db.from('tournament_organizer_codes').select('code').eq('tournament_id', tnTour.id).maybeSingle();
  if (error || !data?.code) return _tnShowError(error ? _tnErrorMsg(error) : t('Only an organizer can do this.'));
  _tnQR(t('Share with organizers'), t('Whoever scans this, signed in, can become an organizer, with everything you can do. Share it only with people you trust.'), `&o=${encodeURIComponent(data.code)}`);
}

function _tnQR(title, hint, query) {
  document.getElementById('qrTitle').textContent = title;
  document.getElementById('qrHint').textContent = hint;
  showQRModal(new URL(`tournaments.html?t=${tnTour.id}${query}`, location.href).href, 'qrCode', 'qrOverlay');
}

// After an action: the tournament as it is now, and the error if it failed.
async function _tnAfter(error) {
  await tnLoad(tnTour.id);
  if (error) _tnShowError(_tnErrorMsg(error));
}

async function tnJoinOrganizers() {
  if (!getCurrentProfile()) return _openNicknameModal();
  const { error } = await db.rpc('join_tournament_organizers', { target: tnTour.id, organizer_code: _tnInvite() });
  if (!error || error.message === 'wrong_organizer_code') _tnDropInvite();   // used, or no good
  await _tnAfter(error);
}

// Remove an organizer, or step down (yourself); one has to be left.
function tnRemoveOrganizer(userId) {
  const self = userId === getCurrentUser()?.id;
  const name = `<strong class="text-emph">${_esc(tnProfiles.get(userId)?.nickname || '-')}</strong>`;
  openConfirmSheet({
    id:           'tnRemoveOrgSheet',
    title:        self ? t('Step down as organizer?') : t('Remove this organizer?'),
    bodyHTML:     `<p class="confirm-text">${self
      ? t('You can no longer run the tournament; the other organizers go on. To come back, you need the Organizer QR from one of them.')
      : t('{name} can no longer run the tournament. To come back, they need the Organizer QR again.', { name })}</p>`,
    confirmLabel: self ? t('Step down') : t('Remove'),
    danger:       true,
    onConfirm:    async () => {
      const { error } = await db.rpc('remove_tournament_organizer', { target: tnTour.id, who: userId });
      await _tnAfter(error);
    },
  });
}

async function tnClaim(playerId) {
  if (!getCurrentProfile()) return _openNicknameModal();
  const { error } = await db.rpc('claim_tournament_player', { target_player: playerId, claim_code: _tnCode() });
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
    danger:       true,
    onConfirm:    async () => {
      const { error } = await db.rpc('release_tournament_player', { target_player: playerId });
      await _tnAfter(error);
    },
  });
}

// Start: every player's villains for every stage and stage 1's
// tables are drawn here (tournament-rules.js) and checked by the database.
function tnStart() {
  const n = tnPlayers.length;
  if (n < 2) return _tnShowError(t('A tournament needs at least 2 players.'));
  if (tnTour.villain_pool.length < n) {
    return _tnShowError(t('The draw pool has {v} villains for {n} players: every player needs a different one. Add villains in Edit tournament.', { v: tnTour.villain_pool.length, n }));
  }
  const sizes = tournamentSplit(n, tnTour.table_size, tnTour.table_split);
  openConfirmSheet({
    id:           'tnStartSheet',
    title:        t('Start the tournament?'),
    bodyHTML:     `<p class="confirm-text">${t('Stage 1 is drawn: {tables} and a villain for every player.', { tables: tn(sizes.length, '{n} table', '{n} tables') })}</p>`,
    confirmLabel: t('Start tournament'),
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
  setVisible('tnForm', true);
  if (tour) {
    const back = document.getElementById('tnBack');
    back.href = `tournaments.html?t=${tour.id}`;
    back.textContent = `← ${tour.name}`;
    back.onclick = e => { e.preventDefault(); tnCloseForm(); };
    setVisible(back, true);
  } else {
    _tnSetBack();
  }
  // New tournament only: an open tournament has its ⓘ next to Options.
  setVisible('tnIntroHelp', !tour);
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
  // The players: two empty rows, or the tournament's (a default name shows as
  // the empty row's placeholder; a claimed one as its nickname).
  document.getElementById('tnFormPlayersLabel').textContent = t('Players');
  document.getElementById('tnFormPlayersHint').textContent =
    t('From 2 players up to the villains in the draw pool. An empty name keeps the one shown. Players change here until the first game starts.');
  const meId = getCurrentUser()?.id;
  tnFormPlayers = tour
    ? tnPlayers.map(p => ({ id: p.id, stored: p.name, name: _tnIsDefaultName(p.name) ? '' : p.name, userId: p.user_id, isMe: !!meId && p.user_id === meId }))
    : [{ name: '', isMe: false }, { name: '', isMe: false }];
  if (draft) _tnApplyDraft(draft);
  setVisible('tnFormPlayers', open);
  if (open) _tnRenderFormPlayers();
  _tnPoolChanged();
  // New: Discard (the Back link keeps the draft); Edit tournament: Cancel.
  setVisible('tnFormDiscard', !tour);
  setVisible('tnFormCancel', !!tour);
  _tnDraftReady = !tour;
  _tnUpdateDiscard();
}

// ── New tournament's draft ──
// As in New Game: the form (name, date, options, custom points, players and
// the draw pool) is kept in localStorage as you edit, so leaving the page or
// Cancel doesn't lose it. It expires an hour after the last change; Discard
// and Create tournament clear it. An untouched date isn't kept (it comes back
// as today). Edit tournament has no draft: Cancel leaves the tournament as it was.
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
  if (!tnFormFor) return void (location.href = 'tournaments.html');
  _tnSetBack();
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

// ── Tournament options ──
// Every option in full, with examples, in a sheet: the button on top of the
// form opens it at the start, each option's ⓘ at its own section.
const TN_HELP = [
  ['date', 'Date', [
    'The day of the tournament, shown on its page and in the lists. It can be a day to come: create the tournament in advance and share it. The organizers can change it at any time, like the name. The games keep the day and time they were actually played.',
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
    'The organizers type the names, in New tournament and then in Edit tournament until the first game starts. A signed-in player claims theirs with That\'s me, at any time, but only from the tournament\'s QR code or link: an organizer shares it with Share QR (so can anyone who already claimed a name). From then on they show by their nickname, and their villains in the tournament\'s games are theirs; Release gives it all back. A tournament game\'s villains are claimed only this way, not on the game\'s page.',
    'An organizer can withdraw a player at any time: they leave the tournament, keep their points and are no longer drawn. If their game of the current stage hasn\'t started yet, they drop out of it (the last places); bringing them back before it starts takes the drop back. Bring back makes them play again from the next stage.',
    'Dropping out of a game is not withdrawing: the player leaves that game only (the last places) and is drawn in the next stage as usual.',
    'Edit tournament adds players after the start too, until the first game starts: stage 1 is drawn again with them. Once a game has started, no player can be added. A player with no name typed is Player N until claimed.',
  ]],
  ['organizers', 'Organizers', [
    'Whoever creates the tournament is its first organizer. An organizer adds others with Organizer QR: whoever scans it, signed in, and taps Become an organizer is one too. There can be as many as you like, and they are all alike: each can do everything, from editing, starting and drawing the stages to entering and fixing results, withdrawing players and deleting the tournament, and can add or remove organizers.',
    'An organizer can play too: they claim their name with That\'s me, without the claim code. An organizer can remove any other, or step down; one is always left. If an organizer deletes their account, the others go on with the tournament.',
  ]],
  ['changes', 'After the start', [
    'Until the first game starts (a bye isn\'t a game) every setting can change, in Edit tournament; changing the tables, the stages, the pool or the players draws stage 1 again. Once a game has started, only the name and the date change, nothing about the rules. Undo draw cancels the current stage\'s draw while none of its games is saved (undoing stage 1 goes back to before the start, and Start draws everything again).',
    'An organizer can fix any saved table with Edit result (places, drops, duration, rounds, play order) and enter the result of any table not saved yet with Enter result, also one a phone has open (say its battery died): that phone can no longer save it.',
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
    label.insertAdjacentHTML('beforeend', ` <button class="tn-info" type="button" onclick="event.preventDefault(); tnHelp('${key}')" title="${_esc(t('Tournament options'))}">ⓘ</button>`);
    // Only the ⓘ opens it: a label with no field of its own would otherwise
    // pass a tap anywhere on it to the button.
    if (!label.htmlFor) label.addEventListener('click', e => { if (!e.target.closest('.tn-info')) e.preventDefault(); });
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

// ── The form's players ──
// New Game's rows: a name each (empty: the "Player 3" shown), 👤 for you (your
// nickname, your name claimed), ❌ to remove; the count menu from 2 up to the
// villains in the draw pool (every player needs a different one per stage).
// Edit tournament starts from the tournament's players ({ id, stored, userId }):
// a name someone claimed shows their nickname and can't be typed over.
let tnFormPlayers = [];

function _tnPoolSize() { return tnChars.length - (tnPool?.excluded.size || 0); }
const _tnFormMax = () => Math.max(2, _tnPoolSize());

// "Player 3" (or "Giocatore 3"): a name nobody typed.
const _tnIsDefaultName = name => /^(player|giocatore) \d+$/i.test(name || '');

// A row someone else claimed (locked). Your own claim follows 👤: moved to
// another row, the old one is a plain name again at once.
const _tnOthersClaim = p => !!p.userId && p.userId !== getCurrentUser()?.id;

// The nickname a row shows instead of its name: yours with 👤, or whoever
// else claimed it.
function _tnRowNick(p) {
  if (p.isMe) return getCurrentProfile()?.nickname || null;
  return _tnOthersClaim(p) ? tnProfiles.get(p.userId)?.nickname || null : null;
}

// The names to store: a claimed name stays as it is; a typed one; an existing
// name left empty keeps its own; a new one left empty (or yours) is
// "Player N" (your nickname shows while you hold it, and the name stays its own
// if you release it), never one already taken.
function _tnFormNames() {
  const kept = p => p.id && (_tnOthersClaim(p) || p.isMe || !p.name.trim()) ? p.stored : null;
  const taken = new Set();
  tnFormPlayers.forEach(p => {
    const n = kept(p) ?? (!p.isMe && p.name.trim());
    if (n) taken.add(n.toLowerCase());
  });
  return tnFormPlayers.map((p, i) => kept(p) ?? ((!p.isMe && p.name.trim()) || _tnFreeName(taken, i + 1)));
}

// "Player N" from n up, the first one not taken (and now taken).
function _tnFreeName(taken, n) {
  let name;
  for (; taken.has((name = t('Player {n}', { n })).toLowerCase()); n++);
  taken.add(name.toLowerCase());
  return name;
}

function _tnRenderFormPlayers() {
  const max = _tnFormMax();
  const n = tnFormPlayers.length;
  const sel = document.getElementById('tnPlayerCount');
  sel.innerHTML = Array.from({ length: Math.max(max, n) - 1 }, (_, i) => i + 2)
    .map(k => `<option value="${k}"${k === n ? ' selected' : ''}${k > max ? ' disabled' : ''}>${k}p</option>`).join('');
  const signedIn = !!getCurrentUser();
  document.getElementById('tnFormRows').innerHTML = tnFormPlayers.map((p, i) => {
    const nick = _tnRowNick(p);
    const prof = p.isMe ? getCurrentProfile() : _tnOthersClaim(p) ? tnProfiles.get(p.userId) : null;
    const placeholder = p.stored && _tnIsDefaultName(p.stored) ? p.stored : t('Player {n}', { n: i + 1 });
    return `
    <div class="order-slot">
      <span class="row-num">${i + 1}.</span>
      ${prof ? avatarHTML(resolveAvatar(prof), { cls: 'order-slot-portrait' }) : '<img class="order-slot-portrait" src="asset/players/default.svg" alt="">'}
      ${nick
        ? `<input class="order-slot-name order-slot-input" type="text" value="${_esc(nick)}" readonly tabindex="-1">`
        : `<input class="order-slot-name order-slot-input" type="text" maxlength="30" value="${_esc(p.name)}" placeholder="${_esc(placeholder)}"
             oninput="tnFormPlayers[${i}].name = this.value" autocomplete="off">`}
      <div class="order-slot-actions">
        <button class="pf-btn del" type="button" onclick="tnRemoveFormPlayer(${i})" ${n > 2 ? `title="${t('Remove')}"` : `title="${t('A tournament needs at least 2 players.')}" disabled`}>❌</button>
        <button class="pf-btn me${p.isMe ? ' on' : ''}${signedIn && !_tnOthersClaim(p) ? '' : ' locked'}" type="button" onclick="tnToggleFormMe(${i})" title="${t('Me')}">👤</button>
      </div>
    </div>`;
  }).join('');
  document.getElementById('tnAddRowBtn').disabled = n >= max;
}

function tnSetPlayerCount(n) {
  n = Math.max(2, Math.min(n, _tnFormMax()));
  while (tnFormPlayers.length < n) tnFormPlayers.push({ name: '', isMe: false });
  tnFormPlayers.length = n;
  _tnRenderFormPlayers();
}

function tnRemoveFormPlayer(i) {
  if (tnFormPlayers.length <= 2) return;
  tnFormPlayers.splice(i, 1);
  _tnRenderFormPlayers();
}

// 👤: you play too (one row, not a name someone else claimed): your nickname
// shows, your name is claimed when the form is saved.
function tnToggleFormMe(i) {
  if (!getCurrentProfile()?.nickname) return;
  const p = tnFormPlayers[i];
  if (_tnOthersClaim(p)) return;
  const on = !p.isMe;
  tnFormPlayers.forEach(x => { x.isMe = false; });
  p.isMe = on;
  _tnRenderFormPlayers();
}

// What saving Edit tournament does to the players: removed, renamed, added, and
// your claim moved (released, claimed).
function _tnPlayersPlan(names) {
  const me = getCurrentUser()?.id;
  const before = tnFormFor ? tnPlayers : [];   // a new tournament has none yet
  const kept = new Set(tnFormPlayers.filter(p => p.id).map(p => p.id));
  const mineBefore = before.find(p => p.user_id === me);
  const mineAfter  = tnFormPlayers.find(p => p.isMe);
  return {
    removed: before.filter(p => !kept.has(p.id)).map(p => p.id),
    renamed: tnFormPlayers.map((p, i) => p.id && names[i] !== p.stored ? { id: p.id, name: names[i] } : null).filter(Boolean),
    added:   tnFormPlayers.map((p, i) => p.id ? null : { name: names[i], user_id: p.isMe ? me : null }).filter(Boolean),
    release: mineBefore && mineBefore.id !== mineAfter?.id && kept.has(mineBefore.id) ? mineBefore.id : null,
    claim:   mineAfter?.id && mineAfter.id !== mineBefore?.id ? mineAfter.id : null,
  };
}
const _tnPlanChangesDraw = plan => plan.removed.length + plan.renamed.length + plan.added.length > 0;

// Carries out the plan, in an order no unique name (or one name per player)
// trips over: removals and your old claim's release first.
async function _tnApplyPlayers(id, plan) {
  if (plan.removed.length) {
    const { error } = await db.from('tournament_players').delete().in('id', plan.removed);
    if (error) return error;
  }
  if (plan.release) {
    const { error } = await db.rpc('release_tournament_player', { target_player: plan.release });
    if (error) return error;
  }
  for (const r of plan.renamed) {
    const { error } = await db.from('tournament_players').update({ name: r.name }).eq('id', r.id);
    if (error) return error;
  }
  if (plan.added.length) {
    const { error } = await db.from('tournament_players').insert(plan.added.map(a => ({ tournament_id: id, ...a })));
    if (error) return error;
  }
  if (plan.claim) return (await db.rpc('claim_tournament_player', { target_player: plan.claim, claim_code: _tnCode() })).error;
  return null;
}

async function tnSaveForm() {
  const user = getCurrentUser();
  if (!user) return goToSignIn();
  const date  = document.getElementById('tnDate').value || _tnToday();
  const names = _tnFormNames();
  const pool  = tnChars.map(c => c.name).filter(n => !tnPool.excluded.has(n));
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
    _tnSetBack();
    setVisible('tnForm', false);
    setVisible('tnRoot', true);
    return tnLoad(tnFormFor.id);
  }
  const name   = document.getElementById('tnName').value.trim();
  const stages = Number(document.getElementById('tnStages').value);
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length) return showError('tnFormErr', t('Every player needs a different name.'));
  if (!name) return showError('tnFormErr', t('Give the tournament a name.'));
  if (!Number.isInteger(stages) || stages < 1 || stages > 20) return showError('tnFormErr', t('Stages: from 1 to 20.'));
  if (pool.length < 2) return showError('tnFormErr', t('The draw pool needs at least 2 villains.'));
  const total = names.length;
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
  const plan = _tnPlayersPlan(names);

  // Edit tournament: one call (save_tournament_setup), all or nothing. The
  // players as they'll be, a new one with an id made here so stage 1 can be
  // drawn with it.
  if (tnFormFor) {
    const was = tnFormFor;
    const players = tnFormPlayers.map((p, i) => ({ id: p.id || crypto.randomUUID(), name: names[i], me: !!p.isMe }));
    if (was.current_stage === 0) return _tnSaveSetup({ settings: row, players });
    // Started, no game yet: a change to the draw (the players' names included)
    // draws stage 1 again; otherwise only the settings (and your name) change.
    const redraw = _tnPlanChangesDraw(plan) || row.table_size !== was.table_size || row.stages !== was.stages
      || row.table_split !== undefined && row.table_split !== (was.table_split || 'even')
      || row.play_order  !== undefined && row.play_order  !== (was.play_order || 'random')
      || pool.length !== was.villain_pool.length || pool.some(v => !was.villain_pool.includes(v));
    if (!redraw) return _tnSaveSetup({ settings: row, plan });
    return openConfirmSheet({
      id:           'tnRedrawSheet',
      title:        t('Draw stage 1 again?'),
      bodyHTML:     `<p class="confirm-text">${t('The tables, the stages, the pool or the players changed: stage 1\'s tables and every player\'s villains are drawn again.')}</p>`,
      confirmLabel: t('Draw again'),
      onConfirm:    async () => {
        // The new start, from the new settings and players (withdrawn ones stay so).
        const tour = { ...was, ...row };
        const drawn = players.map(x => ({ id: x.id, withdrawn_after: tnPlayers.find(p => p.id === x.id)?.withdrawn_after ?? null }));
        const villains = tournamentVillainSchedule(tour, drawn.map(x => x.id));
        const tables   = tournamentDrawStage(tour, drawn, []);
        await _tnSaveSetup({ settings: row, players, villains, tables });
      },
    });
  }

  const btn = document.getElementById('tnFormSave');
  btn.disabled = true;
  const res = await db.from('tournaments').insert({ ...row, organizer: user.id }).select('id');
  btn.disabled = false;
  if (res.error || !res.data?.length) return showError('tnFormErr', _tnErrorMsg(res.error));
  const id = res.data[0].id;
  const error = await _tnApplyPlayers(id, plan);
  if (error) console.warn('tournament players', error);   // Edit tournament can still add them
  _tnDraftReady = false;
  _tnDropDraft();
  location.replace(`tournaments.html?t=${id}`);
}

// Edit tournament's save. Without the players (started, no new draw): your
// name moved apart, by claim and release.
async function _tnSaveSetup({ settings, players = null, villains = null, tables = null, plan = null }) {
  const btn = document.getElementById('tnFormSave');
  btn.disabled = true;
  let { error } = await db.rpc('save_tournament_setup', { target: tnFormFor.id, settings, players, villains, tables });
  if (!error && plan && (plan.release || plan.claim)) error = await _tnApplyPlayers(tnFormFor.id, { removed: [], renamed: [], added: [], release: plan.release, claim: plan.claim });
  btn.disabled = false;
  if (error) return showError('tnFormErr', _tnErrorMsg(error));
  _tnSetBack();
  setVisible('tnForm', false);
  setVisible('tnRoot', true);
  await tnLoad(tnFormFor.id);
}

// ── RECORDING A TABLE ─────────────────────────────────────────────────────────
// Who can record a table, its card's buttons, and Start game: the phone takes
// the table (take_tournament_table: an organizer, or a player at it who
// claimed their name; one at a time) and the game runs on its own page,
// tournament-game.html (tournament-game.js), on New Game's engine. One game in
// progress per phone, New Game's or a table's.

const _tnSavedGame = () => liveGame.loadSaved();

// Who can record a table: an organizer, or a player at it who claimed their name.
function _tnCanRecord(tb) {
  const user = getCurrentUser();
  if (!user || tb.saved_at || tb.seats.length < 2) return false;
  if (_tnIsOrg(user)) return true;
  const mine = tnPlayers.find(p => p.user_id === user.id);
  return !!mine && tb.seats.some(s => s.player_id === mine.id);
}

// The table card's button: Resume on the phone that runs it; Start game when
// nobody records it (or you do, from another session). The organizer can
// always Enter result instead, also when another phone has the game open (a
// phone gone flat): that phone can't save it any more.
function _tnTableActionHTML(tb) {
  if (tb.saved_at) {
    if (!tb.game_id) return '';
    const isOrg = _tnIsOrg(getCurrentUser());
    return `<a class="btn btn-ghost btn-sm" href="claim.html?game=${tb.game_id}">${t('Open game')}</a>`
      + (isOrg ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnEditTable('${tb.id}')">${t('Edit result')}</button>` : '');
  }
  const saved = _tnSavedGame();
  if (saved?.tournament?.tableId === tb.id) return `<a class="btn btn-primary btn-sm" href="tournament-game.html?table=${tb.id}">${t('Resume game')}</a>`;
  if (!_tnCanRecord(tb)) return '';
  const user = getCurrentUser();
  const isOrg = _tnIsOrg(user);
  // The organizer can also type a table's result without playing it on a phone.
  const enter = isOrg ? `<button class="btn btn-ghost btn-sm" type="button" onclick="tnEditTable('${tb.id}')">${t('Enter result')}</button>` : '';
  if (!tb.recorder || tb.recorder === user.id) return `<button class="btn btn-primary btn-sm" type="button" onclick="tnStartTable('${tb.id}')">${t('Start game')}</button>${enter}`;
  return enter;
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

let tnView = null;   // 'players' | 'tables' | 'standings' (null: the default for the tournament)

// The same three tabs while it runs and once finished: Players (claims, drops,
// withdrawals), Tables (your game, the current stage, then every earlier one)
// and Standings. It opens on Tables while running, on Standings once finished.
function _tnViewSegHTML() {
  if (!tnView) tnView = tnTour.finished_at ? 'standings' : 'tables';
  const btn = (v, label) => `<button class="seg-btn${tnView === v ? ' on' : ''}" type="button" onclick="tnSetView('${v}')">${label}</button>`;
  return `<div class="controls mb-1"><div class="seg tn-view-seg">${btn('players', t('Players')) + btn('tables', t('Tables')) + btn('standings', t('Standings'))}</div></div>`;
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
  // Shown from the start: everyone at 0 until the first table is saved (no
  // tie notes until then).
  const started = rows.some(r => r.played || r.byes);
  const byId = new Map(tnPlayers.map(p => [p.id, p]));
  const max = Math.max(...rows.map(r => r.points)) || 1;
  const medal = rank => rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
  const digits = String(Math.max(0, ...rows.map(r => r.firsts))).length;
  const body = rows.map(r => {
    const p = byId.get(r.player_id);
    const prof = p?.user_id ? tnProfiles.get(p.user_id) : null;
    const avatar = prof ? avatarHTML(resolveAvatar(prof)) : '<img class="player-avatar nav-avatar-guest" src="asset/players/default.svg" alt="">';
    const sub = r.final || !started ? '' : _tnTieNote(rows, r);
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

// Tables: your game and the current stage (all its tables, with the
// organizer's draw buttons), then the earlier stages' saved tables and byes,
// newest first. A finished tournament has only those.
function _tnTablesHTML(mine) {
  const myId = mine?.id;
  const out = [];
  if (!tnTour.finished_at) out.push(_tnYourGameHTML(mine) + _tnStageHTML(mine));
  for (let st = tnTour.finished_at ? tnTour.current_stage : tnTour.current_stage - 1; st >= 1; st--) {
    const tables = tnTables.filter(tb => tb.stage === st && tb.saved_at);
    if (!tables.length) continue;
    out.push(`<div class="section-label">${tnStageLabel(st)}</div>
      <div class="tn-tables">${tables.map(tb => _tnTableHTML(tb, myId)).join('')}</div>`);
  }
  return out.join('');
}

function tnNextStage() {
  const next = tnTour.current_stage + 1;
  const nobody = !tnPlayers.some(p => p.withdrawn_after == null);   // the tournament ends here
  openConfirmSheet({
    id:           'tnNextSheet',
    title:        nobody ? t('End the tournament?') : t('Draw stage {n}?', { n: next }),
    bodyHTML:     `<p class="confirm-text">${_tnDrawSummary(next)}</p>`,
    confirmLabel: nobody ? t('End tournament') : t('Draw stage {n}', { n: next }),
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
  // Duration and rounds only for a game recorded on a phone: a result typed in
  // afterwards has none, so the stats don't take guesses for times.
  const timed = !entering && tb.seats.some(s => s.minutes != null);
  openConfirmSheet({
    id:           'tnEditSheet',
    title:        t('Table {n}', { n: tb.table_no }),
    bodyHTML:     `${entering && tb.recorder && tb.recorder !== getCurrentUser()?.id
                     ? `<p class="modal-hint">${t("{name}'s phone has this game open: once you save the result here, it can no longer save it.", { name: _esc(tnProfiles.get(tb.recorder)?.nickname || '-') })}</p>` : ''}
                   <div class="form-row${timed ? '' : ' hidden'}">
                     <div class="field"><label>${t('Duration <span class="optional">(min)</span>')}</label><input type="number" id="tnEditDur" min="1" max="999" value="${first?.minutes || ''}"></div>
                     <div class="field"><label>${t('Rounds <span class="optional"></span>')}</label><input type="number" id="tnEditTurns" min="1" max="999" value="${first?.round || ''}"></div>
                   </div>
                   <div class="section-label lineup-label"><span>${t('Ranking')}</span>
                     <span class="players-legend"><span class="sep-item">${t('⠿ = drag')}</span> | <span class="sep-item">${t('🏳️ = dropped')}</span></span></div>
                   <div class="err" id="tnEditErr"></div>
                   <div class="tn-edit-rows" id="tnEditRows"></div>
                   <p class="modal-hint">${timed ? t('Drag the villains into their places. Drops stay at the bottom; the standard game follows (1st place won it, with this duration and these rounds).')
                     : t('Drag the villains into their places. Drops stay at the bottom; the standard game follows (1st place won it), without a duration or rounds.')}</p>
                   <div class="${entering ? 'hidden' : ''}">
                     <div class="section-label">${t('Play order')}</div>
                     <div class="tn-edit-rows" id="tnEditOrder"></div>
                     <p class="modal-hint">${t('If the table played in another order than the drawn one, drag the villains into it. Their villains stay the drawn ones.')}</p>
                   </div>`,
    confirmLabel: entering ? t('Save result') : t('Save Changes'),
    onConfirm:    async () => {
      const results = tnEdit.rows.map((r, i) => ({ position: r.position, place: i + 1, dropped: r.dropped }));
      // A new play order: each seat's new position (sent only when it changed).
      if (!entering && tnEdit.order.some((pos, i) => pos !== i)) for (const r of results) r.order = tnEdit.order.indexOf(r.position);
      // The game's duration and rounds go to whoever is 1st now (empty: as they were).
      if (timed) {
        const dur = parseInt(document.getElementById('tnEditDur').value), turns = parseInt(document.getElementById('tnEditTurns').value);
        if (dur > 0)   results[0].minutes = dur;
        if (turns > 0) results[0].round   = turns;
      }
      // A new result: an organizer saves it without taking the table (a phone
      // with the game open can't save it after); this phone's game of it, if
      // any, is over.
      const error = entering
        ? (await db.rpc('save_tournament_table', { target_table: tableId, played_at: new Date().toISOString(), results })).error
        : (await db.rpc('edit_tournament_table', { target_table: tableId, results })).error;
      // The recording phone saved it first: its result stands.
      if (error?.message === 'saved_from_phone') { await _tnAfter(error); return; }
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
