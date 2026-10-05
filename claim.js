// ── STATE ─────────────────────────────────────────────────────────────────────

let claimGame    = null;
let claimPlayers = [];

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('');
  await initAuth(() => render());
  attachLocationAutocomplete('editLocation', 'editLocationDropdown');

  const params = new URLSearchParams(location.search);
  const gameId = params.get('game');

  if (!gameId) {
    return showClaimError(t('No game specified.'));
  }

  const { data: game, error: gameErr } = await db
    .from('games')
    .select('*')
    .eq('id', gameId)
    .maybeSingle();

  if (gameErr || !game) {
    return showClaimError(t('Game not found.'));
  }

  const { data: players, error: playersErr } = await db
    .from('game_players')
    .select('*')
    .eq('game_id', gameId);

  if (playersErr) {
    return showClaimError(playersErr.message);
  }

  claimGame    = game;
  claimPlayers = (players || []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));   // play order

  render();
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function render() {
  const root    = document.getElementById('claimRoot');
  const user    = getCurrentUser();
  const profile = getCurrentProfile();

  root.className = '';

  if (!claimGame) return;

  if (!user) {
    root.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🔒</div>
        <h3>${t('Sign in to claim')}</h3>
        <p>${t('You need to be signed in to claim your villain.')}</p>
        <button class="btn btn-primary" onclick="goToSignIn()">${t('Sign in')}</button>
      </div>`;
    return;
  }

  if (!profile) {
    root.innerHTML = `
      <div class="empty">
        <div class="empty-icon">👤</div>
        <h3>${t('Set a nickname first')}</h3>
        <p>${t('You need a nickname before you can claim a villain.')}</p>
        <button class="btn btn-primary" onclick="_openNicknameModal()">${t('Set nickname')}</button>
      </div>`;
    return;
  }

  const myClaim = claimPlayers.find(p => p.user_id === user.id);
  const role    = gameUserRole(claimGame, claimPlayers, user);

  const meta = [
    fmtDuration(claimGame.duration_minutes),
    claimGame.num_turns ? tn(claimGame.num_turns, '{n} round', '{n} rounds') : null,
    claimGame.location  ? claimGame.location             : null,
  ].filter(Boolean).join(' | ');

  // Like the game cards: the player's nickname sits under the villain's name;
  // the right side only holds the action (Release your claim, or Claim).
  const rowsHTML = claimPlayers.map((p, i) => {
    const isMine = p.user_id === user.id;
    let nickHTML = '', actionHTML = '';
    if (p.nickname)    nickHTML = `<div class="claim-nick">${_esc(p.nickname)}</div>`;
    else if (myClaim)  nickHTML = `<div class="claim-nick unclaimed">${t('Unclaimed')}</div>`;
    if (isMine) {
      // Your own claim: let you release it (e.g. if you picked the wrong one).
      actionHTML = `<button class="btn btn-ghost btn-sm" onclick="releaseCharacter('${p.id}')">${t('Release')}</button>`;
    } else if (!p.nickname && !myClaim) {
      actionHTML = `<button class="btn btn-ghost btn-sm" onclick="claimCharacter('${p.id}')">${t('Claim')}</button>`;
    }
    return `
      <div class="claim-row${p.is_winner ? ' winner' : ''}${isMine ? ' mine' : ''}">
        <div class="claim-char">
          <span class="chip-seat">${i + 1}</span>
          ${charImgHTML(p.character)}
          <div class="claim-who"><div class="claim-name">${villainNameHTML(p.character)}</div>${nickHTML}</div>
          ${p.is_winner ? '<span class="win-star">👑</span>' : ''}
        </div>
        ${actionHTML}
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="claim-game-info">
      <div class="claim-date">${fmtDateTime(claimGame.played_at)}</div>
      ${meta ? `<div class="claim-meta">${meta}</div>` : ''}
    </div>
    <div class="claim-share-row">
      ${role.isParticipant ? `<button class="btn btn-ghost btn-sm" onclick="editGameDetails()">${t('Edit details')}</button>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="shareGame()">${t('Share QR')}</button>
    </div>
    <div class="section-label">${t('Players')}</div>
    <div class="claim-rows">${rowsHTML}</div>
    ${myClaim ? `<p class="claim-success">${t('You are playing as {villain} in this game.', { villain: `<strong>${charImgHTML(myClaim.character)} ${villainNameInline(myClaim.character)}</strong>` })}</p>` : ''}`;
}

// ── NAV / SHARE ───────────────────────────────────────────────────────────────

function claimGoBack() {
  // Back to wherever we came from (e.g. the player profile); the profile page
  // when the claim page was opened cold (e.g. via a shared QR).
  goBack('players.html');
}

function shareGame() {
  if (!claimGame) return;
  const url = new URL(`claim.html?game=${claimGame.id}`, location.href).href;
  showQRModal(url, 'qrCode', 'qrOverlay');
}

// ── EDIT GAME DETAILS ─────────────────────────────────────────────────────────

function editGameDetails() {
  if (!claimGame) return;
  document.getElementById('editLocation').value = claimGame.location || '';
  document.getElementById('editDur').value      = claimGame.duration_minutes || '';
  document.getElementById('editTurns').value    = claimGame.num_turns || '';
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

  const { error } = await db
    .from('game_players')
    .update({ user_id: user.id, nickname: profile.nickname })
    .eq('id', playerId)
    .is('user_id', null);

  if (error) { _showClaimRowError(error.message); return; }
  await init();
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

  const { error } = await db
    .from('game_players')
    .update({ user_id: null, nickname: null })
    .eq('id', playerId)
    .eq('user_id', user.id);

  if (error) { _showClaimRowError(error.message); return; }
  await init();
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

function showClaimError(msg) {
  const root = document.getElementById('claimRoot');
  root.className = '';
  root.innerHTML = `
    <div class="empty">
      <div class="empty-icon">⚠️</div>
      <h3>${t('Oops')}</h3>
      <p>${msg}</p>
      <a class="btn btn-ghost btn-sm" href="index.html">${t('Back to home')}</a>
    </div>`;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();
