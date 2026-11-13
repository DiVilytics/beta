// ── TOURNAMENTS (beta) ────────────────────────────────────────────────────────
// tournaments.html. Without a parameter: the tournaments and + New tournament.
// ?new: the New tournament form. ?t=<id>: one tournament, with its settings,
// its players by name and, once started, the current stage's tables.
//
// The organizers (whoever created it, and whoever joined with the organizers'
// QR code, all alike) type the players' names (New tournament, Edit tournament
// until the first game starts). A signed-in player claims their name with
// That's me (and with it every seat of theirs in the tournament's games), at
// any time. Start draws stage 1's tables and villains, each next stage's are
// drawn with it. The form (New and Edit tournament) is tournament-form.js; the
// rules (pairing, scoring, villain draw, the knockout's bracket) live in
// tournament-rules.js; the database (DiVilytics-Sync, the tournaments
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
const TN_POLL_MS  = 8000;
let   tnPollTimer = null;
let   tnSnapshot  = '';       // the data last drawn: a reload redraws only on a change

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('tournaments.html');
  const params = new URLSearchParams(location.search);
  await initAuth(() => _tnAuthChanged());
  [tnChars, tnBoxInfo] = await Promise.all([loadCharacters(), loadBoxInfo()]);
  if (params.has('tour')) { history.replaceState(null, '', location.pathname); return startTournamentTour(); }   // the Tutorial's Show me around
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
  if (tnTouring) return;
  if (e.persisted && tnTour && !_tnFormOpen()) tnLoad(tnTour.id, { quiet: true });
  else if (e.persisted && tnList) tnLoadList();
});

function _tnAuthChanged() {
  if (tnTouring) return;   // the tour's demo stays as it is
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
    db.from('tournaments').select('*, tournament_players!tournament_players_tournament_id_fkey(count), tournament_organizers(user_id, added_at)').order('created_at', { ascending: false }),
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
  if (!tnTour || tnTour.finished_at || tnTouring) return;
  tnPollTimer = setTimeout(() => {
    if (document.visibilityState === 'visible' && !_tnBusy()) tnLoad(tnTour.id, { quiet: true });
    else _tnSchedulePoll();
  }, TN_POLL_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tnTour && !tnTour.finished_at && !_tnBusy() && !tnTouring) tnLoad(tnTour.id, { quiet: true });
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

  // On top the tournament (name, date, organizer, status); under it, after a
  // gap, Options (folded until tapped: one per row), with ⓘ for Tournament options.
  const organizer = tn(tnOrganizers.length, 'Organizer: {names}', 'Organizers: {names}', { names: _esc(_tnOrganizerNames(tnOrganizers) || '-') });
  const ko = tournamentIsKnockout(tnTour);
  const options = _tnOptionsHTML();
  const status = [tournamentStatusHTML(tnTour), tn(tnPlayers.length, '{n} player', '{n} players')].join(' | ');

  // The organizers' buttons on one row; under them Share QR, for the players,
  // the one to find: larger and purple.
  const actions = `
    ${isOrg ? `<div class="claim-share-row tn-org-actions">
      <button class="btn btn-ghost btn-sm" type="button" onclick="tnOpenForm(tnTour)">${t('Edit tournament')}</button>
      <button class="btn btn-ghost btn-sm" type="button" onclick="tnShareOrganizers()">${t('Organizer QR')}</button>
    </div>` : ''}
    <div class="claim-share-row"><button class="btn btn-primary tn-share-btn" type="button" onclick="tnShare()">${t('Share QR')}</button></div>`;

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
    ${actions}
    ${_tnInviteHTML(user, isOrg)}
    ${_tnOverHTML(mine)}
    ${lobby ? '' : _tnViewSegHTML()}
    ${lobby || tnView === 'players' ? `
      ${lobby ? `<div class="section-label">${t('Players')}</div>` : ''}
      ${tnPlayers.length ? `<div class="tn-player-rows">${rows}</div>` : `<p class="tn-hint">${t('No players yet.')}</p>`}
      ${isOrg && !lobby && !ko && tournamentMoreStages(tnTour)
        ? `<button class="add-row-btn tn-late-btn" type="button" onclick="tnAddLatePlayer()">${t('+ Add player')}</button>
           <p class="tn-hint">${t('A player added now plays from stage {n}, starting from 0 points.', { n: tnTour.current_stage + 1 })}</p>` : ''}
      ${!user ? `<p class="tn-hint">${t('Sign in to claim your name.')} <button class="btn btn-ghost btn-sm" type="button" onclick="goToSignIn()">${t('Sign in')}</button></p>`
        : !mine && !isOrg && !_tnCode() && tnPlayers.some(p => !p.user_id) ? `<p class="tn-hint">${t('To claim your name, scan the tournament\'s QR code from an organizer, or open its link.')}</p>` : ''}
      ${_tnOrganizersHTML(user, isOrg)}`
      : tnView === 'standings' ? (ko ? _tnBracketHTML(mine) : _tnStandingsHTML(mine)) : _tnTablesHTML(mine)}
    ${isOrg ? `<div class="claim-delete-row" id="tnLobbyActions">
      <button class="btn btn-danger btn-sm" type="button" onclick="tnDelete()">${t('Delete tournament')}</button>
      ${lobby ? `<button class="btn btn-primary btn-sm" type="button" onclick="tnStart()">${t('Start tournament')}</button>` : ''}
    </div>` : ''}`;
  _tnDrawBracket();
  requestAnimationFrame(() => _tnDrawBracket());   // once the fonts and portraits are laid out
}

// The tournament's options, one per row, each with its name as the form calls
// it: a knockout's own, or the points format's.
function _tnOptionsHTML() {
  const opt = (label, value) => `<div class="claim-meta">${t(label)}: ${value}</div>`;
  const name = (rules, id, dflt) => t((rules[id] || rules[dflt]).name);
  const playOrder = opt('Play order', name(TOURNAMENT_PLAY_ORDERS, tnTour.play_order, 'random'));
  if (tournamentIsKnockout(tnTour)) return [
    opt('Format', t(TOURNAMENT_FORMATS.knockout.name)),
    opt('Table size', tnTour.table_size),
    opt('Advance from each table', tnTour.advance),
    opt('Stages', tnTour.stages),
    playOrder,
  ].join('');
  return [
    opt('Format', t(TOURNAMENT_FORMATS.points.name)),
    opt('Table size', tnTour.table_size),
    opt('Tables', name(TOURNAMENT_SPLITS, tnTour.table_split, 'even')),
    opt('Stages', [tnTour.stages ?? t('Open-ended'), tnTour.ended_stage ? t('ended after stage {n}', { n: tnTour.ended_stage }) : null].filter(Boolean).join(' | ')),
    opt('Pairing', TOURNAMENT_PAIRINGS[tnTour.pairing] ? name(TOURNAMENT_PAIRINGS, tnTour.pairing) : _esc(tnTour.pairing)),
    playOrder,
    opt('Scoring', TOURNAMENT_SCORINGS[tnTour.scoring] ? name(TOURNAMENT_SCORINGS, tnTour.scoring) : _esc(tnTour.scoring)),
    opt('Bye', name(TOURNAMENT_BYES, tnTour.bye, 'last')),
    opt('Final table', t(TN_FINAL[tnTour.final_table ? 'on' : 'off'].name)),
  ].join('');
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
    // A late player's stage first: the row cuts what doesn't fit.
    p.joined_stage ? (tnTour.current_stage < p.joined_stage ? t('Plays from stage {n}', { n: p.joined_stage }) : t('Joined at stage {n}', { n: p.joined_stage })) : '',
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

// ── Tournament options ──
// The sheet behind every ⓘ: each option, what its choices do
// (asset/data/tournament-help.json, .it.json; db.js loadTournamentHelp). A
// paragraph that opens with an option's name ("Random: ...") shows the name
// in bold; section opens it at that option's.
async function tnHelp(section) {
  const help = await loadTournamentHelp();
  const betaOnly = ['format', 'advance'];   // knockout is the beta's
  document.getElementById('tnHelpBody').innerHTML = Object.entries(help).filter(([id]) => IS_BETA || !betaOnly.includes(id)).map(([id, { title, paras }]) => `
    <section class="tn-help-section" id="tnHelp-${id}">
      <h4>${_esc(title)}</h4>
      ${paras.map(p => `<p>${_esc(p).replace(/^[^:.;,]{1,24}:/, '<strong>$&</strong>')}</p>`).join('')}
    </section>`).join('');
  openOverlay('tnHelpSheet');
  if (section) document.getElementById(`tnHelp-${section}`)?.scrollIntoView({ block: 'start' });
  else document.getElementById('tnHelpBody').scrollTop = 0;
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
  // A knockout: your place at the final, or the stage you went out in (no points).
  const ko = tournamentIsKnockout(tnTour);
  const meLine = !me ? '' : !ko ? `${medal}${t('You finished {place}', { place: fmtPlace(me.rank) })} | ${_tnPointsLabel(me.points)}`
    : me.reached === tnTour.stages ? `${medal}${t('You finished {place}', { place: fmtPlace(me.rank) })}`
    : me.reached ? t('Out in stage {n}', { n: me.reached }) : '';
  // Ended by an organizer, without a final: theirs to reopen.
  const reopen = _tnIsOrg(getCurrentUser()) && !ko && !tnTour.final_table && tnTour.ended_stage === tnTour.current_stage;
  return `
    <div class="claim-game-info tn-you">
      <div class="claim-date">🏁 ${t('Tournament over')}</div>
      ${winners.length ? `<div class="claim-meta">${tn(winners.length, 'Winner: {names}', 'Winners: {names}', { names: new Intl.ListFormat(LOCALE, { type: 'conjunction' }).format(winners) })}</div>` : ''}
      ${meLine ? `<div class="claim-meta tn-over-you">${meLine}</div>` : ''}
    </div>
    ${reopen ? `<div class="claim-share-row"><button class="btn btn-ghost btn-sm" type="button" onclick="tnReopen()">${t('Reopen')}</button></div>
      <p class="tn-hint tn-hint-center">${t('Ended by an organizer after stage {n}: Reopen and the stages go on.', { n: tnTour.ended_stage })}</p>` : ''}`;
}

// Your game in the current stage, on top: your table, your villain and your
// turn (or your bye), with the table's button. For a claimed name still playing.
function _tnYourGameHTML(mine) {
  if (!mine || mine.withdrawn_after != null || tnTour.finished_at) return '';
  const tb = tnTables.find(x => x.stage === tnTour.current_stage && x.seats.some(s => s.player_id === mine.id));
  if (!tb) return '';
  const seat = tb.seats.find(s => s.player_id === mine.id);
  const head = `${t('Your game')} | ${tournamentIsLastTable(tnTour, tb.stage) ? t('Final') : t('Stage {n}', { n: tb.stage })}`;
  if (tb.seats.length === 1) {
    const bye = tournamentIsKnockout(tnTour) ? t('Nobody else is left at your table: you go on without playing.') : t('You have a bye in this stage (it counts as last).');
    return `<div class="claim-game-info tn-you"><div class="claim-date">${head}</div><div class="claim-meta">${bye}</div></div>`;
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
      ${tb.saved_at ? '' : `<p class="tn-you-how">${t('One phone at the table records the game: tap a villain\'s mover when it wins or drops out, and the ranking fills up.')}
        <a class="tn-info" href="tournament-game.html?tour" title="${_esc(t('Show me around'))}">ⓘ</a></p>`}
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
// Undo draw (while none of its games is saved, a bye isn't a game: after,
// it stays, off, the reason on hover). The stages can end after any stage:
// Draw the final (with one; at the last stage it's the only way on), End
// tournament (without; the last stage ends it by itself).
function _tnNextStageHTML(tables) {
  const user = getCurrentUser();
  if (!_tnIsOrg(user)) return '';
  const canUndo = !tables.some(tb => tb.game_id);
  const more  = tournamentMoreStages(tnTour);
  const ko    = tournamentIsKnockout(tnTour);   // its last stage is the final: no early end
  const atEnd = !tnTour.finished_at && tnTour.ended_stage == null && !tournamentIsFinal(tnTour, tnTour.current_stage);
  const final = !ko && atEnd && tnTour.final_table;
  const end   = !ko && more && !tnTour.final_table;
  const next  = tnTour.current_stage + 1;
  const ready = tables.every(tb => tb.saved_at);
  if (!more && !final && !canUndo) return '';
  const off = ready ? '' : ' disabled';
  const btn = (cls, fn, label) => `<button class="btn ${cls} btn-sm" type="button" onclick="${fn}()"${off}>${label}</button>`;
  const draws = [
    final ? btn(more ? 'btn-ghost' : 'btn-primary', 'tnDrawFinal', t('Draw the final')) : '',
    end   ? btn('btn-ghost', 'tnEndStages', t('End tournament')) : '',
    more  ? btn('btn-primary', 'tnNextStage', ko && next === tnTour.stages ? t('Draw the final') : t('Draw stage {n}', { n: next })) : '',
  ].join('');
  return `
    <div class="claim-share-row" id="tnNextRow">
      <button class="btn btn-ghost btn-sm" type="button" onclick="tnUndoStage()"${canUndo ? '' : ` disabled title="${_esc(t('A game of this stage is saved: its draw stays.'))}"`}>${t('Undo draw')}</button>
      ${draws}
    </div>
    ${draws && !ready ? `<p class="tn-hint tn-hint-center">${t('Every table of this stage has to be saved first.')}</p>` : ''}`;
}

// What the next draw makes: "Stage 3 of 5: 2 tables and 1 bye, Swiss pairing."
function _tnDrawSummary(stage) {
  const playing = tournamentPlaying(tnPlayers, stage, tnTour, tnTables).length;
  if (!playing) return t('Nobody is still playing: the tournament ends here, on the standings as they are.');
  if (tournamentIsKnockout(tnTour)) {
    const tables = tournamentKoTables(tnTour, stage);
    const head = stage === tnTour.stages ? t('The final: the {n} who advanced play one table.', { n: playing })
      : t('Stage {n} of {m}: {what}, by the bracket.', { n: stage, m: tnTour.stages, what: tn(tables, '{n} table', '{n} tables') });
    return `${head} ${t('It can be undone until a game is saved.')}`;
  }
  const sizes = tournamentSplit(playing, tnTour.table_size, tnTour.table_split);
  const tables = sizes.filter(n => n > 1).length, byes = sizes.length - tables;
  const what = byes ? t('{tables} and {byes}', { tables: tn(tables, '{n} table', '{n} tables'), byes: tn(byes, '{n} bye', '{n} byes') }) : tn(tables, '{n} table', '{n} tables');
  const pairing = (TOURNAMENT_PAIRINGS[tnTour.pairing] || TOURNAMENT_PAIRINGS.random).name;
  const head = tnTour.stages ? t('Stage {n} of {m}: {what}, {pairing} pairing.', { n: stage, m: tnTour.stages, what, pairing: t(pairing) })
    : t('Stage {n}: {what}, {pairing} pairing.', { n: stage, what, pairing: t(pairing) });
  return `${head} ${t('It can be undone until a game is saved (a bye isn\'t a game).')}`;
}

// A stage's name: "Stage 2 of 3" ("Stage 2" while open; of the stage they
// ended at, once ended early), or "Final" for the final table.
function tnStageLabel(stage) {
  return tournamentStageName(tnTour, stage);
}

// The final: the top of the standings play one last table (tournament-rules.js).
function tnDrawFinal() {
  const { players, villains } = tournamentDrawFinal(tnTour, tnPlayers, tnTables);
  const names = players.map(id => _esc(tnPlayerName(tnPlayers.find(p => p.id === id))));
  // Fewer than two still playing: no final to play. One left wins it, like a
  // bye; nobody left, the standings as they are.
  const body = players.length > 1
    ? `${t('The top {n} of the standings play one last table, and its ranking decides the tournament\'s top places: {names}.', { n: players.length, names: `<strong class="text-emph">${new Intl.ListFormat(LOCALE, { type: 'conjunction' }).format(names)}</strong>` })} ${t('It can be undone until it is saved.')}`
    : players.length ? t('Only {name} is still playing: they win the final and the tournament ends.', { name: `<strong class="text-emph">${names[0]}</strong>` })
    : t('Nobody is still playing: there is no final and the tournament ends on the standings as they are.');
  // Before the planned last stage (or open): the stages end here.
  const early = tnTour.current_stage !== tnTour.stages
    ? `<p class="confirm-text">${t('The stages end with stage {n}: no stage is drawn after it.', { n: tnTour.current_stage })}</p>` : '';
  openConfirmSheet({
    id:           'tnFinalSheet',
    title:        players.length > 1 ? t('Draw the final?') : t('End the tournament?'),
    bodyHTML:     `${early}<p class="confirm-text">${body}</p>`,
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
  const isFinal = tournamentIsFinal(tnTour, st);
  openConfirmSheet({
    id:           'tnUndoSheet',
    title:        isFinal ? t('Undo the draw of the final?') : t('Undo the draw of stage {n}?', { n: st }),
    bodyHTML:     `<p class="confirm-text">${isFinal
      ? t('Its table is cancelled, a game in progress included, and the tournament goes back to the end of stage {n}: the stages go on, or the final is drawn again.', { n: st - 1 })
      : st === 1
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

// End tournament, without a final table: the stages end after this one, the
// standings as they are. Reopen takes it back while nothing else is drawn.
function tnEndStages() {
  openConfirmSheet({
    id:           'tnEndSheet',
    title:        t('End the tournament?'),
    bodyHTML:     `<p class="confirm-text">${t('The stages end with stage {n}, and the tournament ends on the standings as they are. Reopen takes it back.', { n: tnTour.current_stage })}</p>`,
    confirmLabel: t('End tournament'),
    onConfirm:    async () => {
      const { error } = await db.rpc('end_tournament_stages', { target: tnTour.id, ended: true });
      await _tnAfter(error);
    },
  });
}

async function tnReopen() {
  const { error } = await db.rpc('end_tournament_stages', { target: tnTour.id, ended: false });
  await _tnAfter(error);
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
          <div class="chip-nick">${[_esc(name), s.dropped ? `🏳️ ${tb.game_id ? t('Dropped') : t('Withdrawn')}` : null, tb.saved_at && !tournamentIsKnockout(tnTour) ? _tnPointsLabel(_tnSeatPoints(tb, s)) : null].filter(Boolean).join(' | ')}</div>
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

// Whether the pool's copies give n players at the tournament's tables
// different villains at each table; if not, the error says so (Start, Draw).
function _tnVillainsFit(n, tour = tnTour, sizes = null) {
  sizes ??= tournamentIsKnockout(tour) && tour.current_stage === 0 ? tournamentKoStartSizes(tour, n) : tournamentSplit(n, tour.table_size, tour.table_split);
  if (!n || tournamentVillainsFit(tour.villain_pool, sizes.filter(x => x > 0))) {
    document.querySelector('#tnRoot > .err')?.remove();   // an earlier no, now fixed
    return true;
  }
  _tnShowError(t("With the draw pool's copies, {n} players can't all have different villains at their tables: add villains or copies in Edit tournament.", { n }));
  return false;
}

// Start: stage 1's tables and villains are drawn here (tournament-rules.js)
// and checked by the database; each next stage's with it.
function tnStart() {
  const n = tnPlayers.length;
  if (n < 2) return _tnShowError(t('A tournament needs at least 2 players.'));
  if (tournamentIsKnockout(tnTour) && (n < tournamentKoMin(tnTour) || n > tournamentKoMax(tnTour))) {
    return _tnShowError(t('This knockout takes from {min} to {max} players.', { min: tournamentKoMin(tnTour), max: tournamentKoMax(tnTour) }));
  }
  if (!_tnVillainsFit(n)) return;
  const sizes = tournamentIsKnockout(tnTour) ? tournamentKoStartSizes(tnTour, n) : tournamentSplit(n, tnTour.table_size, tnTour.table_split);
  openConfirmSheet({
    id:           'tnStartSheet',
    title:        t('Start the tournament?'),
    bodyHTML:     `<p class="confirm-text">${t('Stage 1 is drawn: {tables} and a villain for every player.', { tables: tn(sizes.length, '{n} table', '{n} tables') })}</p>`,
    confirmLabel: t('Start tournament'),
    onConfirm:    async () => _tnAfter(await _tnDrawStart()),
  });
}

// Stage 1's tables, and its villains for them.
async function _tnDrawStart() {
  const tables   = tournamentDrawStage(tnTour, tnPlayers, []);
  const villains = tournamentStageVillains(tnTour, tables, []);
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
  if (!tb.recorder || tb.recorder === user.id) return `${enter}<button class="btn btn-primary btn-sm" type="button" onclick="tnStartTable('${tb.id}')">${t('Start game')}</button>`;
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
    tourId: tnTour.id, tableId, stage: tb.stage, tableNo: tb.table_no, tourName: tnTour.name, isFinal: tournamentIsLastTable(tnTour, tb.stage),
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
  const last = tournamentIsKnockout(tnTour) ? t('Bracket') : t('Standings');
  return `<div class="controls mb-1"><div class="seg tn-view-seg">${btn('players', t('Players')) + btn('tables', t('Tables')) + btn('standings', last)}</div></div>`;
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

// ── BRACKET (knockout) ──
// One column per stage, a box per table of the bracket, each centered on the
// tables that feed it, joined by lines (_tnDrawBracket). A saved table shows
// who advanced (the final: its winner and places), one being played its
// players, one still to come "To be drawn". Tapping a drawn table opens it
// whole (tnBracketTable). Wider than a phone, it scrolls sideways.
function _tnBracketHTML(mine) {
  const F = tnTour.stages, k = tnTour.table_size / tnTour.advance;
  const leaves = tournamentKoTables(tnTour, 1);
  const byId = new Map(tnPlayers.map(p => [p.id, p]));
  const name = id => _esc(tnPlayerName(byId.get(id)));
  const heads = [], boxes = [];
  for (let st = 1; st <= F; st++) {
    const span = k ** (st - 1), last = st === F;
    heads.push(`<div class="tn-bk-head" style="grid-column:${st}">${last ? t('Final') : t('Stage {n}', { n: st })}</div>`);
    for (let j = 1; j <= tournamentKoTables(tnTour, st); j++) {
      const tb = tnTables.find(x => x.stage === st && x.table_no === j);
      const self = !!mine && !!tb?.seats.some(s => s.player_id === mine.id);
      let body;
      if (!tb) {
        body = `<div class="tn-bk-empty">${st <= tnTour.current_stage ? t('Not played') : t('To be drawn')}</div>`;
      } else if (tb.saved_at) {
        const top = tb.seats.filter(s => s.place != null && (last || s.place <= tnTour.advance)).sort((a, b) => a.place - b.place);
        body = top.map(s => `<div class="tn-bk-name${s.place === 1 ? ' won' : ''}${mine && s.player_id === mine.id ? ' self' : ''}">
          ${tnTour.advance > 1 || last ? `<span class="tn-bk-place">${fmtPlace(s.place)}</span>` : ''}${charImgHTML(s.character)}<span class="tn-bk-text">${name(s.player_id)}</span>${last && s.place === 1 ? ' 👑' : ''}</div>`).join('');
      } else {
        body = tb.seats.map(s => `<div class="tn-bk-name waiting${mine && s.player_id === mine.id ? ' self' : ''}">${charImgHTML(s.character)}<span class="tn-bk-text">${name(s.player_id)}</span></div>`).join('');
      }
      boxes.push(`<button class="tn-bk-box${self ? ' self' : ''}${tb && !tb.saved_at ? ' live' : ''}" type="button" data-bk="${st}-${j}"
        style="grid-column:${st}; grid-row:${(j - 1) * span + 2} / span ${span}"${tb ? ` onclick="tnBracketTable('${tb.id}')"` : ' disabled'}>
        <div class="tn-bk-title">${last ? t('Final') : t('Table {n}', { n: j })}</div>${body}</button>`);
    }
  }
  const hint = tnTour.advance > 1
    ? t('The top {n} of each table play the next stage, at the table its lines lead to. Tap a table to see it whole.', { n: tnTour.advance })
    : t('The winner of each table plays the next stage, at the table its lines lead to. Tap a table to see it whole.');
  return `
    <div class="tn-bracket-wrap"><div class="tn-bracket" id="tnBracket" data-k="${k}" data-stages="${F}"
      style="grid-template-columns: repeat(${F}, minmax(var(--tn-bk-w), 1fr)); grid-template-rows: auto repeat(${leaves}, auto)">
      <svg class="tn-bk-lines" aria-hidden="true"></svg>${heads.join('')}${boxes.join('')}</div></div>
    <p class="results-hint">${hint}</p>`;
}

// The lines: from each table's right edge to the middle of the gap, down or
// up to the table it feeds, and into its left edge.
function _tnDrawBracket() {
  const el = document.getElementById('tnBracket');
  if (!el) return;
  const k = +el.dataset.k, F = +el.dataset.stages, svg = el.querySelector('.tn-bk-lines');
  const at = el.getBoundingClientRect();
  const box = (st, j) => el.querySelector(`[data-bk="${st}-${j}"]`)?.getBoundingClientRect();
  const paths = [];
  for (let st = 2; st <= F; st++) {
    for (let j = 1; ; j++) {
      const to = box(st, j);
      if (!to) break;
      const y2 = to.top + to.height / 2 - at.top, x2 = to.left - at.left;
      for (let c = (j - 1) * k + 1; c <= j * k; c++) {
        const from = box(st - 1, c);
        if (!from) continue;
        const x1 = from.right - at.left, y1 = from.top + from.height / 2 - at.top, mx = (x1 + x2) / 2;
        paths.push(`M${x1},${y1}H${mx}V${y2}H${x2}`);
      }
    }
  }
  svg.setAttribute('width', el.scrollWidth);
  svg.setAttribute('height', el.scrollHeight);
  svg.innerHTML = `<path d="${paths.join('')}"/>`;
}
window.addEventListener('resize', () => _tnDrawBracket());

function tnBracketTable(tableId) {
  const tb = tnTables.find(x => x.id === tableId);
  if (!tb) return;
  const mine = tnPlayers.find(p => p.user_id && p.user_id === getCurrentUser()?.id);
  document.getElementById('tnTableSheetTitle').textContent = tournamentIsLastTable(tnTour, tb.stage)
    ? t('Final') : `${tournamentStageName(tnTour, tb.stage)} | ${t('Table {n}', { n: tb.table_no })}`;
  document.getElementById('tnTableSheetBody').innerHTML = _tnTableHTML(tb, mine?.id);
  openOverlay('tnTableSheet');
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
  const playing = tournamentPlaying(tnPlayers, next, tnTour, tnTables).length;
  const nobody = !playing;   // the tournament ends here
  const ko = tournamentIsKnockout(tnTour);
  if (!_tnVillainsFit(playing, tnTour, ko ? tournamentDrawStage(tnTour, tnPlayers, tnTables).map(tb => tb.length) : null)) return;
  const last = ko && next === tnTour.stages;
  openConfirmSheet({
    id:           'tnNextSheet',
    title:        nobody ? t('End the tournament?') : last ? t('Draw the final?') : t('Draw stage {n}?', { n: next }),
    bodyHTML:     `<p class="confirm-text">${_tnDrawSummary(next)}</p>`,
    confirmLabel: nobody ? t('End tournament') : last ? t('Draw the final') : t('Draw stage {n}', { n: next }),
    onConfirm:    async () => {
      // The tables, then their villains (each player's so far: the tables before).
      const tables   = tournamentDrawStage(tnTour, tnPlayers, tnTables);
      const villains = tables.some(tb => tb.length) ? tournamentStageVillains(tnTour, tables, tnTables) : [];
      const { error } = await db.rpc('next_tournament_stage', { target: tnTour.id, tables, villains });
      tnView = 'tables';
      await _tnAfter(error);
    },
  });
}

// A late player: an organizer adds them to the running tournament; they play
// from the next stage, from 0 points (add_tournament_player). Only if the
// pool's copies still give the next stage's tables different villains.
function tnAddLatePlayer() {
  const next = tnTour.current_stage + 1;
  if (!_tnVillainsFit(tournamentPlaying(tnPlayers, next).length + 1)) return;
  openConfirmSheet({
    id:           'tnLateSheet',
    title:        t('Add a player'),
    bodyHTML:     `<div class="field"><label for="tnLateName">${t('Name')}</label><input type="text" id="tnLateName" maxlength="30" autocomplete="off"></div>
                   <div class="err" id="tnLateErr"></div>
                   <p class="modal-hint">${t('They play from stage {n}, starting from 0 points. To claim the name, they scan the tournament\'s QR code.', { n: next })}</p>`,
    confirmLabel: t('Add player'),
    onConfirm:    async () => {
      const name = document.getElementById('tnLateName').value.trim();
      if (!name) { showError('tnLateErr', t('Give the player a name.')); throw new Error('name'); }
      const { error } = await db.rpc('add_tournament_player', { target: tnTour.id, player_name: name });
      if (error) { showError('tnLateErr', _tnErrorMsg(error)); throw error; }
      tnView = 'players';
      await tnLoad(tnTour.id);
    },
  });
  setTimeout(() => document.getElementById('tnLateName')?.focus(), 50);
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
    bodyHTML:     _tnEditBodyHTML(tb, entering, first),
    confirmLabel: entering ? t('Save result') : t('Save Changes'),
    onConfirm:    () => _tnSaveTableResult(tableId, entering),
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

// The sheet: duration and rounds (optional: a game recorded on a phone has the
// timer's, a result typed in afterwards those the organizer knows, or none),
// the ranking rows and, for a saved table, its play order.
function _tnEditBodyHTML(tb, entering, first) {
  return `${entering && tb.recorder && tb.recorder !== getCurrentUser()?.id
    ? `<p class="modal-hint">${t("{name}'s phone has this game open: once you save the result here, it can no longer save it.", { name: _esc(tnProfiles.get(tb.recorder)?.nickname || '-') })}</p>` : ''}
  <div class="form-row">
    <div class="field"><label>${t('Duration <span class="optional">(min)</span>')}</label><input type="number" id="tnEditDur" min="1" max="999" placeholder="${t('optional')}" value="${first?.minutes || ''}"></div>
    <div class="field"><label>${t('Rounds <span class="optional"></span>')}</label><input type="number" id="tnEditTurns" min="1" max="999" placeholder="${t('optional')}" value="${first?.round || ''}"></div>
  </div>
  <div class="section-label lineup-label"><span>${t('Ranking')}</span>
    <span class="players-legend"><span class="sep-item">${t('⠿ = drag')}</span> | <span class="sep-item">${t('🏳️ = dropped')}</span></span></div>
  <div class="err" id="tnEditErr"></div>
  <div class="tn-edit-rows" id="tnEditRows"></div>
  <p class="modal-hint">${t('Drag the villains into their places. Drops stay at the bottom; the standard game follows (1st place won it, with the duration and rounds above, if given).')}</p>
  <div class="${entering ? 'hidden' : ''}">
    <div class="section-label">${t('Play order')}</div>
    <div class="tn-edit-rows" id="tnEditOrder"></div>
    <p class="modal-hint">${t('If the table played in another order than the drawn one, drag the villains into it. Their villains stay the drawn ones.')}</p>
  </div>`;
}

async function _tnSaveTableResult(tableId, entering) {
  const results = tnEdit.rows.map((r, i) => ({ position: r.position, place: i + 1, dropped: r.dropped }));
  // A new play order: each seat's new position (sent only when it changed).
  if (!entering && tnEdit.order.some((pos, i) => pos !== i)) for (const r of results) r.order = tnEdit.order.indexOf(r.position);
  // The game's duration and rounds go to whoever is 1st now (empty: as they were).
  const dur = parseInt(document.getElementById('tnEditDur').value), turns = parseInt(document.getElementById('tnEditTurns').value);
  if (dur > 0)   results[0].minutes = dur;
  if (turns > 0) results[0].round   = turns;
  // A new result: an organizer saves it without taking the table (a phone
  // with the game open can't save it after); this phone's game of it, if
  // any, is over.
  const error = entering
    ? (await db.rpc('save_tournament_table', { target_table: tableId, played_at: new Date().toISOString(), results, time_zone: browserTimeZone() })).error
    : (await db.rpc('edit_tournament_table', { target_table: tableId, results })).error;
  // The recording phone saved it first: its result stands.
  if (error?.message === 'saved_from_phone') { await _tnAfter(error); return; }
  if (error) { showError('tnEditErr', _tnErrorMsg(error)); throw error; }
  if (entering && _tnSavedGame()?.tournament?.tableId === tableId) { liveGame.clear(); liveGame.emit('close'); updateLiveGameNavBadge(); }
  await tnLoad(tnTour.id);
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

// ── TOUR (organizers) ─────────────────────────────────────────────────────────
// Show me around (ⓘ by the intro, or the Tutorial's link): New tournament's
// form, then a tournament's page, over a demo (tour.js). Nothing is saved or
// loaded while it runs (tnTouring: no draft, no refresh, no database call),
// and the page reloads at the end, as it was. Signed out, a stand-in organizer.
let tnTouring = false;
const TN_TOUR_NAMES = ['Ada', 'Bea', 'Cleo', 'Dario', 'Elio', 'Fede', 'Gaia', 'Leo'];
let _tnTourDrawn = null;   // stage 1's demo tables, drawn once: the same at every step

async function startTournamentTour() {
  if (tnTouring) return;
  const back = location.pathname + location.search.replace(/[?&]tour\b/, '').replace(/^&/, '?');
  tnTouring = true;
  clearTimeout(tnPollTimer);
  tnTour = null; tnPlayers = []; tnTables = [];
  if (!tnChars.length) [tnChars, tnBoxInfo] = await Promise.all([loadCharacters(), loadBoxInfo()]);
  await tnOpenForm(null);
  _tnTourForm();
  // Signed out: a stand-in organizer for the demo page, set only now (the
  // form's pool asks the database for your boxes); the page reloads at the end.
  if (!getCurrentUser()) window.getCurrentUser = () => ({ id: 'tn-tour-organizer' });
  const orgId = getCurrentUser().id;
  tnOrganizers = [orgId];
  tnProfiles = new Map([[orgId, { id: orgId, nickname: getCurrentProfile()?.nickname || t('You') }]]);
  const form = () => { setVisible('tnRoot', false); setVisible('tnForm', true); setVisible('tnIntroHelp', true); };
  const page = (stage, view = 'tables') => () => { _tnTourPage(stage); tnView = view; tnRenderTournament(); };
  const field = id => () => document.querySelector(`#tnForm [data-help="${id}"]`);
  startTour([
    { el: () => document.getElementById('tnName').closest('.form-row'), prep: form, text: t('<b>New tournament</b>: its name and day. The day can be one to come: create it ahead and share it.') },
    { el: field('format'), prep: form, betaOnly: true, text: t('<b>Points</b>: every stage everyone plays and scores by their place. <b>Knockout</b>: a bracket, the top of each table go on to the final. Each shows its own options.') },
    { el: () => document.getElementById('tnSize').closest('.form-row'), prep: form, text: t('<b>Table size</b> is the largest table; <b>Stages</b> how many rounds of tables, or <b>Open-ended</b>: you end them when you like.') },
    { el: ['#tnForm [data-help="tables"]', '#tnForm [data-help="order"]'], prep: form, text: t('How the tables are made (<b>Tables</b>, <b>Pairing</b>) and who plays first at each (<b>Play order</b>). Every ⓘ explains the choices, with examples.') },
    { el: ['#tnForm [data-help="scoring"]', '#tnForm [data-help="final"]'], prep: form, text: t('The points for each place (<b>Scoring</b>), for a stage sat out (<b>Bye</b>), and whether the top players play a <b>Final table</b>.') },
    { el: field('villains'), prep: form, text: t('The <b>draw pool</b>: the villains drawn every stage, never twice at a table. <b>Copies</b> lets more players than villains play.') },
    { el: '#tnFormPlayers', prep: form, text: t('The players\' names (👤 marks you, if you play too). They claim their names later, with the tournament\'s QR code.') },
    { el: '.tn-form-actions', prep: form, text: t('<b>Create tournament</b>: its page opens. Everything can still change until the first game starts.') },
    { el: ['.tn-org-actions', '.tn-share-btn'], prep: page(0, 'players'), text: t('<b>Edit tournament</b> changes it until the first game starts; <b>Organizer QR</b> adds other organizers. <b>Share QR</b> is for the players: they scan it and claim their name.') },
    { el: '#tnLobbyActions', prep: page(0, 'players'), text: t('<b>Start tournament</b> draws stage 1: the tables and a villain for everyone.') },
    { el: '.tn-view-seg', prep: page(1), text: t('Once started: <b>Players</b> (claims, and Withdraw for a player who leaves), <b>Tables</b> and <b>Standings</b>.') },
    { el: () => document.querySelector('#tnRoot .tn-table'), prep: page(1), text: t('Each table is played on one phone: <b>Start game</b> runs it with New Game\'s timer (an organizer\'s phone, or a seated player\'s). <b>Enter result</b> types it in afterwards; a saved table has <b>Edit result</b>.') },
    { el: '#tnNextRow', prep: page(1), text: t('Once every table is saved, <b>Draw stage 2</b>, or <b>End tournament</b> to stop after this stage. <b>Undo draw</b> takes a draw back until one of its games is saved.') },
    { el: '.tn-standings', prep: page(1, 'standings'), text: IS_BETA
      ? t('<b>Standings</b>: the points, ties by most 1st places, then the opponents\' points. In a knockout, this tab is the <b>Bracket</b>.')
      : t('<b>Standings</b>: the points, ties by most 1st places, then the opponents\' points.') },
  ].filter(s => IS_BETA || !s.betaOnly), { onEnd: () => location.replace(back) });
}

// The form's demo: a name, 8 players, Swiss pairing and Rotation (not saved).
function _tnTourForm() {
  document.getElementById('tnName').value = t('Forbidden Mountain Cup');
  document.getElementById('tnStages').value = '3';
  tnRule.pairing = 'swiss';
  tnRule.play_order = 'rotation';
  tnFormPlayers = TN_TOUR_NAMES.map(name => ({ name, isMe: false }));
  _tnRenderRules();
  _tnSyncFormat();
  _tnPoolChanged();
}

// The page's demo: the same tournament not started (stage 0), or with stage 1
// drawn, table 2 saved and table 1 to play.
function _tnTourPage(stage) {
  setVisible('tnForm', false);
  setVisible('tnRoot', true);
  setVisible('tnIntroHelp', false);   // New tournament's own link
  const pool = tnChars.map(c => c.name);
  tnTour = { id: 'tn-tour', name: t('Forbidden Mountain Cup'), event_date: _tnToday(), created_at: new Date().toISOString(),
    format: 'points', table_size: 4, stages: 3, pairing: 'swiss', scoring: 'borda', table_split: 'even', play_order: 'rotation',
    bye: 'half', final_table: false, villain_pool: pool, current_stage: 0, finished_at: null, ended_stage: null };
  tnPlayers = TN_TOUR_NAMES.map((name, i) => ({ id: `tn-tour-p${i}`, name, user_id: null, withdrawn_after: null, joined_stage: null }));
  tnTables = [];
  if (!stage) return;
  if (!_tnTourDrawn) {
    const drawn = tournamentDrawStage(tnTour, tnPlayers, []);
    _tnTourDrawn = { drawn, villains: tournamentStageVillains(tnTour, drawn, []) || [] };
  }
  const { drawn } = _tnTourDrawn;
  const vOf = new Map(_tnTourDrawn.villains.map(v => [v.player_id, v.character]));
  tnTables = drawn.map((ids, j) => ({ id: `tn-tour-t${j + 1}`, stage: 1, table_no: j + 1, recorder: null, started_at: null,
    saved_at: j ? new Date().toISOString() : null, game_id: j ? 'tn-tour-game' : null,
    seats: ids.map((player_id, position) => ({ player_id, position, character: vOf.get(player_id), place: j ? position + 1 : null, minutes: null, round: null, dropped: false })) }));
  tnTour.current_stage = 1;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();
