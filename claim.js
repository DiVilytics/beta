// ── STATE ─────────────────────────────────────────────────────────────────────

let claimGame    = null;
let claimPlayers = [];

// Opened by New Game right after saving (claim.html?game=…&saved=1): the QR
// sheet opens on top once, and Back leads to the Game Log.
const claimJustSaved = new URLSearchParams(location.search).get('saved') === '1';
let   claimOpenQR    = claimJustSaved;
if (claimJustSaved) {
  const url = new URL(location.href);
  url.searchParams.delete('saved');
  history.replaceState(null, '', url);   // a reload doesn't reopen the QR
}

// Seats change only through the database functions claim_villain,
// release_villain and edit_lineup, which answer with these codes.
const CLAIM_ERRORS = {
  seat_changed:    'This villain was just changed or claimed. The page is up to date now.',
  already_in_game: 'You already have a villain in this game.',
  no_profile:      'You need a nickname before you can claim a villain.',
  not_your_seat:   "This villain isn't yours to release.",
  not_creator:     'Only the player who recorded the game can change it.',
  lineup_locked:   'Another player has claimed a villain: the villains and the winner can no longer be changed.',
  invalid_lineup:  'Each player needs a different villain, and there must be one winner.',
  solo_seat:       'A solo game is always its creator\'s.',
  solo_locked:     "A solo game's difficulty, villain and result can't be changed.",
};
const _claimErrorMsg = error => CLAIM_ERRORS[error.message] ? t(CLAIM_ERRORS[error.message]) : error.message;

// The creator can change the villains and the winner while no other player has
// claimed a villain (their own seat, marked 👤 in New Game, doesn't count). A
// solo game (solo.js) has one seat, its creator's, never shared or released;
// its difficulty, villain and result stay as recorded (its other details can
// still be fixed).
const claimIsSolo = () => claimGame?.variant === 'solo';

function lineupEditable(user) {
  return !!user && !!claimGame && !claimIsSolo() && claimGame.created_by === user.id
    && claimPlayers.every(p => !p.user_id || p.user_id === user.id);
}

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('');
  await initAuth(() => render());
  attachLocationAutocomplete('editLocation', 'editLocationDropdown');

  const params = new URLSearchParams(location.search);
  const gameId = params.get('game');

  if (!gameId) {
    return showClaimError(t('Game not found'), t("This link doesn't point to a game."));
  }

  const { data: game, error: gameErr } = await db
    .from('games')
    .select('*')
    .eq('id', gameId)
    .maybeSingle();

  // A malformed id (22P02: not a uuid) is a wrong link, like a missing game.
  if (gameErr && gameErr.code !== '22P02') return showClaimError(t("Couldn't load the game"), t('Try reloading the page.'), gameErr);
  if (!game) return showClaimError(t('Game not found'), t('It may have been deleted, or the link is wrong.'));

  const { data: players, error: playersErr } = await db
    .from('game_players')
    .select('*')
    .eq('game_id', gameId);

  if (playersErr) return showClaimError(t("Couldn't load the game"), t('Try reloading the page.'), playersErr);

  claimGame    = game;
  claimPlayers = (players || []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));   // play order
  // Nothing to claim in a solo game: the page is just the game's.
  if (claimIsSolo()) document.getElementById('claimTitle').textContent = t('Solo game');

  render();
  if (claimOpenQR) { claimOpenQR = false; if (!claimIsSolo()) shareGame(); }
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function render() {
  const root    = document.getElementById('claimRoot');
  const user    = getCurrentUser();
  const profile = getCurrentProfile();

  root.className = '';

  if (!claimGame) return;

  if (!user) {
    root.innerHTML = emptyStateHTML('🔑', t('Sign in to claim'), t('You need to be signed in to claim your villain.'),
      `<button class="btn btn-primary" onclick="goToSignIn()">${t('Sign in')}</button>`);
    return;
  }

  if (!profile) {
    root.innerHTML = emptyStateHTML('👤', t('Set a nickname first'), t('You need a nickname before you can claim a villain.'),
      `<button class="btn btn-primary" onclick="_openNicknameModal()">${t('Set nickname')}</button>`);
    return;
  }

  const myClaim = claimPlayers.find(p => p.user_id === user.id);
  const role    = gameUserRole(claimGame, claimPlayers, user);
  const solo    = claimIsSolo();

  const level = solo ? soloLevelOf(claimGame) : null;
  const meta = [
    fmtDuration(claimGame.duration_minutes),
    claimGame.num_turns ? (level ? t('{n}/{max} rounds', { n: claimGame.num_turns, max: SOLO_LEVELS[level].turns }) : tn(claimGame.num_turns, '{n} round', '{n} rounds')) : null,
    claimGame.location  ? _esc(claimGame.location)       : null,
    solo ? t('Solo') : null,
    level ? soloLevelTagHTML(level) : null,
  ].filter(Boolean).join(' | ');

  // Like the game cards: the player's nickname sits under the villain's name;
  // the right side only holds the action (Release your claim, or Claim).
  const rowsHTML = claimPlayers.map((p, i) => {
    const isMine = p.user_id === user.id;
    let nickHTML = '', actionHTML = '';
    if (p.nickname)    nickHTML = `<div class="claim-nick">${_esc(p.nickname)}</div>`;
    else if (myClaim)  nickHTML = `<div class="claim-nick unclaimed">${t('Unclaimed')}</div>`;
    if (solo) {
      // One seat, always its creator's: nothing to claim or release.
    } else if (isMine) {
      // Your own claim: let you release it (e.g. if you picked the wrong one).
      actionHTML = `<button class="btn btn-ghost btn-sm" onclick="releaseCharacter('${p.id}')">${t('Release')}</button>`;
    } else if (!p.nickname && !myClaim) {
      actionHTML = `<button class="btn btn-ghost btn-sm" onclick="claimCharacter('${p.id}')">${t('Claim')}</button>`;
    }
    return `
      <div class="claim-row${p.is_winner ? ' winner' : ''}${isMine ? ' mine' : ''}">
        <div class="claim-char">
          <span class="chip-seat">${solo ? '' : i + 1}</span>
          ${charImgHTML(p.character)}
          <div class="claim-who"><div class="claim-name">${villainNameHTML(p.character)}</div>${nickHTML}</div>
          ${p.is_winner ? '<span class="win-star">👑</span>' : ''}
        </div>
        ${actionHTML}
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="claim-game-info">
      <div class="claim-date">${fmtGameDate(claimGame)}</div>
      ${meta ? `<div class="claim-meta">${meta}</div>` : ''}
    </div>
    <div class="claim-share-row">
      ${role.isParticipant ? `<button class="btn btn-ghost btn-sm" onclick="editGameDetails()">${t('Edit details')}</button>` : ''}
      ${lineupEditable(user) ? `<button class="btn btn-ghost btn-sm" onclick="editLineup()">${t('Edit villains and winner')}</button>` : ''}
      ${solo ? '' : `<button class="btn btn-ghost btn-sm" onclick="shareGame()">${t('Share QR')}</button>`}
    </div>
    <div class="section-label">${solo ? t('Player') : t('Players')}</div>
    <div class="claim-rows${solo ? ' solo' : ''}">${rowsHTML}</div>
    ${myClaim ? `<p class="claim-success">${_playedAsHTML(myClaim, solo)}</p>` : ''}
    ${solo ? soloHintHTML() : ''}
    ${role.isCreator ? `<div class="claim-delete-row"><button class="btn btn-danger btn-sm" onclick="deleteGame()">${t('Delete game')}</button></div>` : ''}`;
}

// "You played as …": in a solo game, whether you won or lost with it.
function _playedAsHTML(seat, solo) {
  const villain = `<strong>${charImgHTML(seat.character)} ${villainNameInline(seat.character)}</strong>`;
  if (!solo) return t('You played as {villain} in this game.', { villain });
  return seat.is_winner
    ? t('You won this solo game with {villain}.', { villain })
    : t('You lost this solo game with {villain}.', { villain });
}

// ── NAV / SHARE ───────────────────────────────────────────────────────────────

// Where Back leads: the Game Log right after saving a game; otherwise wherever
// we came from (e.g. the player profile), the profile page when the claim page
// was opened cold (e.g. via a shared QR).
function claimGoBack() {
  if (claimJustSaved) location.href = 'game-log.html';
  else goBack('players.html');
}

function shareGame() {
  if (!claimGame) return;
  const url = new URL(`claim.html?game=${claimGame.id}`, location.href).href;
  showQRModal(url, 'qrCode', 'qrOverlay');
}

// ── EDIT GAME DETAILS ─────────────────────────────────────────────────────────

// A solo game's rounds go up to its level's (solo.js).
const _maxTurns = () => claimIsSolo() ? SOLO_LEVELS[soloLevelOf(claimGame)].turns : 999;

function editGameDetails() {
  if (!claimGame) return;
  document.getElementById('editLocation').value = claimGame.location || '';
  document.getElementById('editDur').value      = claimGame.duration_minutes || '';
  document.getElementById('editTurns').value    = claimGame.num_turns || '';
  document.getElementById('editTurns').max      = _maxTurns();
  clearError('editDetailsErr');
  const btn = document.getElementById('editDetailsSaveBtn');
  btn.disabled    = false;
  btn.textContent = t('Save Changes');
  openOverlay('editDetailsOverlay');
}

function closeEditDetails() {
  closeOverlay('editDetailsOverlay');
}

async function saveGameDetails() {
  if (!claimGame) return;

  const dur      = parseInt(document.getElementById('editDur').value)   || null;
  const turns    = parseInt(document.getElementById('editTurns').value) || null;
  const location = document.getElementById('editLocation').value.trim() || null;

  // Always write the current values (a cleared field is saved as null).
  const patch = { duration_minutes: dur, num_turns: turns, location: location };

  // No-op if nothing actually changed.
  if (dur === (claimGame.duration_minutes || null) &&
      turns === (claimGame.num_turns || null) &&
      location === (claimGame.location || null)) {
    closeEditDetails();
    return;
  }

  const btn   = document.getElementById('editDetailsSaveBtn');
  const errEl = document.getElementById('editDetailsErr');
  if (claimIsSolo() && turns > _maxTurns()) {
    showError(errEl, t('A solo game on {level} ends by round {n}.', { level: soloLevelName(soloLevelOf(claimGame)), n: _maxTurns() }));
    return;
  }
  btn.disabled    = true;
  btn.textContent = t('Saving…');

  const { error } = await db.from('games').update(patch).eq('id', claimGame.id);

  if (error) {
    showError(errEl, error.message);
    btn.disabled    = false;
    btn.textContent = t('Save Changes');
    return;
  }

  closeEditDetails();
  await init();
}

// ── CLAIM ─────────────────────────────────────────────────────────────────────

function claimCharacter(playerId) {
  const user    = getCurrentUser();
  const profile = getCurrentProfile();
  if (!user || !profile) return;
  if (claimPlayers.find(p => p.user_id === user.id)) return;

  const player = claimPlayers.find(p => p.id === playerId);
  if (!player) return;

  // If it got claimed out from under us, refresh
  if (player.user_id) { init(); return; }

  openConfirmSheet({
    id:           'claimConfirmOverlay',
    title:        t('Confirm your villain'),
    bodyHTML:     `<p class="confirm-text">${t("You're about to claim {villain} in this game. Picked the wrong one? You can release it afterwards.", { villain: `<strong class="text-emph">${charImgHTML(player.character)}${villainNameInline(player.character)}</strong>` })}</p>`,
    confirmLabel: t('Claim villain'),
    busyLabel:    t('Claiming…'),
    onConfirm:    () => _doClaim(playerId),
  });
}

async function _doClaim(playerId) {
  const user    = getCurrentUser();
  const profile = getCurrentProfile();
  if (!user || !profile) return;

  // The villain you saw goes along: if the creator changed it meanwhile, the
  // claim fails and the page reloads with the new one.
  const player = claimPlayers.find(p => p.id === playerId);
  const { error } = await db.rpc('claim_villain', { seat_id: playerId, villain: player?.character ?? '' });
  await init();
  if (error) _showClaimRowError(_claimErrorMsg(error));
}

// ── RELEASE ───────────────────────────────────────────────────────────────────

function releaseCharacter(playerId) {
  const user = getCurrentUser();
  if (!user) return;

  const player = claimPlayers.find(p => p.id === playerId);
  if (!player || player.user_id !== user.id) return;

  openConfirmSheet({
    id:           'releaseConfirmOverlay',
    title:        t('Release this villain?'),
    bodyHTML:     `<p class="confirm-text">${t('This frees up {villain} so it can be claimed again, by you or another player.', { villain: `<strong class="text-emph">${charImgHTML(player.character)}${villainNameInline(player.character)}</strong>` })}</p>`,
    confirmLabel: t('Release'),
    busyLabel:    t('Releasing…'),
    danger:       true,
    onConfirm:    () => _doRelease(playerId),
  });
}

async function _doRelease(playerId) {
  const user = getCurrentUser();
  if (!user) return;

  const { error } = await db.rpc('release_villain', { seat_id: playerId });
  await init();
  if (error) _showClaimRowError(_claimErrorMsg(error));
}

// ── EDIT LINEUP ───────────────────────────────────────────────────────────────
// The creator fixes the villains and the winner (see lineupEditable). Seats,
// their order and claims stay as they are; the menus offer only villains not
// used by another seat, and the crown moves from seat to seat (one winner).

let lineupDraft  = [];   // [{ id, character, is_winner }] while the sheet is open
let lineupChars  = [];
let lineupBoxes  = {};

async function editLineup() {
  if (!lineupEditable(getCurrentUser())) return;
  [lineupChars, lineupBoxes] = await Promise.all([loadCharacters(), loadBoxInfo()]);
  lineupDraft = claimPlayers.map(p => ({ id: p.id, character: p.character, is_winner: !!p.is_winner }));
  document.getElementById('lineupTitle').textContent = t('Edit villains and winner');
  document.getElementById('lineupHint').textContent  = t('You can change the villains and the winner until another player claims a villain.');
  clearError('lineupErr');
  const btn = document.getElementById('lineupSaveBtn');
  btn.disabled    = false;
  btn.textContent = t('Save Changes');
  _renderLineup();
  openOverlay('lineupOverlay');
}

function closeLineup() {
  closeOverlay('lineupOverlay');
}

function _renderLineup() {
  document.getElementById('lineupSlots').innerHTML = lineupDraft.map((s, i) => {
    const taken     = new Set(lineupDraft.filter(o => o.id !== s.id).map(o => o.character));
    const available = lineupChars.filter(c => !taken.has(c.name));
    return `
      <div class="order-slot">
        <span class="row-num">${i + 1}.</span>
        <img class="order-slot-portrait" src="${charImgSrc(s.character)}" onerror="this.src='asset/players/default.svg'" alt="">
        <div class="order-slot-info">
          <select class="order-slot-select" onchange="setLineupVillain(${i}, this.value)" aria-label="${t('Select villain')}">
            ${charSelectHTML(available, s.character, lineupBoxes)}
          </select>
          <div class="order-slot-name">${villainNameHTML(s.character)}</div>
          <span class="chevron order-slot-chevron" aria-hidden="true">▼</span>
        </div>
        <div class="order-slot-actions">
          <button class="pf-btn win${s.is_winner ? ' on' : ''}" type="button" onclick="setLineupWinner(${i})" title="${t('Winner')}">👑</button>
        </div>
      </div>`;
  }).join('');
}

// Every seat keeps a villain: the menu's empty first entry changes nothing.
function setLineupVillain(i, name) {
  if (name) lineupDraft[i].character = name;
  _renderLineup();
}

// The crown moves to this seat (one winner).
function setLineupWinner(i) {
  lineupDraft.forEach((s, j) => { s.is_winner = j === i; });
  _renderLineup();
}

async function saveLineup() {
  const unchanged = lineupDraft.every(s => {
    const p = claimPlayers.find(x => x.id === s.id);
    return p && p.character === s.character && !!p.is_winner === s.is_winner;
  });
  if (unchanged) { closeLineup(); return; }

  const btn   = document.getElementById('lineupSaveBtn');
  const errEl = document.getElementById('lineupErr');
  btn.disabled    = true;
  btn.textContent = t('Saving…');

  const { error } = await db.rpc('edit_lineup', { target_game: claimGame.id, lineup: lineupDraft });

  if (error) {
    // Someone claimed meanwhile: nothing left to edit, show the page as it is.
    if (error.message === 'lineup_locked') {
      closeLineup();
      await init();
      _showClaimRowError(_claimErrorMsg(error));
      return;
    }
    showError(errEl, _claimErrorMsg(error));
    btn.disabled    = false;
    btn.textContent = t('Save Changes');
    return;
  }

  closeLineup();
  await init();
}

// ── DELETE ────────────────────────────────────────────────────────────────────
// The creator only (the database agrees). Players who claimed a villain are
// named: the game leaves their profiles too.

function deleteGame() {
  const user = getCurrentUser();
  if (!claimGame || !user || claimGame.created_by !== user.id) return;
  const others = claimPlayers.filter(p => p.user_id && p.user_id !== user.id && p.nickname).map(p => p.nickname);
  const names  = new Intl.ListFormat(LOCALE, { type: 'conjunction' }).format(others.map(_esc));
  openConfirmSheet({
    id:           'deleteGameOverlay',
    title:        t('Delete game?'),
    bodyHTML:     `<p class="confirm-text">${t('This will permanently delete the game and all player records. This action cannot be undone.')}</p>`
                + (others.length ? `<p class="confirm-text">${tn(others.length, '{names} claimed a villain in it: the game will disappear from their profile too.', '{names} claimed a villain in it: the game will disappear from their profiles too.', { names: `<strong class="text-emph">${names}</strong>` })}</p>` : ''),
    confirmLabel: t('Delete game'),
    busyLabel:    t('Deleting…'),
    danger:       true,
    onConfirm:    _doDeleteGame,
  });
}

async function _doDeleteGame() {
  const { error } = await db.from('games').delete().eq('id', claimGame.id);
  if (error) { _showClaimRowError(error.message); return; }
  // A fresh load of where we came from, so the game isn't shown there anymore.
  let back = claimJustSaved ? 'game-log.html' : 'players.html';
  try {
    if (!claimJustSaved && document.referrer && new URL(document.referrer).origin === location.origin) back = document.referrer;
  } catch (_) {}
  location.replace(back);
}

// Surface a claim/release failure as a banner at the top of the page.
function _showClaimRowError(msg) {
  const root = document.getElementById('claimRoot');
  const errEl = document.createElement('div');
  errEl.className = 'err show';
  errEl.textContent = msg;
  root.prepend(errEl);
}

// ── ERROR ─────────────────────────────────────────────────────────────────────

// The game couldn't be shown: what happened, and the way home. A load error
// itself goes to the console.
function showClaimError(title, text, error) {
  if (error) console.warn(title, error);
  const root = document.getElementById('claimRoot');
  root.className = '';
  root.innerHTML = emptyStateHTML('⚠️', title, text, `<a class="btn btn-ghost btn-sm" href="index.html">${t('Back to home')}</a>`);
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();
