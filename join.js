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
    return showClaimError('No game specified.');
  }

  const { data: game, error: gameErr } = await db
    .from('games')
    .select('*')
    .eq('id', gameId)
    .maybeSingle();

  if (gameErr || !game) {
    return showClaimError('Game not found.');
  }

  const { data: players, error: playersErr } = await db
    .from('game_players')
    .select('*')
    .eq('game_id', gameId);

  if (playersErr) {
    return showClaimError(playersErr.message);
  }

  claimGame    = game;
  claimPlayers = players || [];

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
        <h3>Sign in to claim</h3>
        <p>You need to be signed in to claim your villain.</p>
        <button class="btn btn-primary" onclick="goToSignIn()">Sign in</button>
      </div>`;
    return;
  }

  if (!profile) {
    root.innerHTML = `
      <div class="empty">
        <div class="empty-icon">👤</div>
        <h3>Set a nickname first</h3>
        <p>You need a nickname before you can claim a villain.</p>
        <button class="btn btn-primary" onclick="_openNicknameModal()">Set nickname</button>
      </div>`;
    return;
  }

  const myClaim = claimPlayers.find(p => p.user_id === user.id);
  const role    = gameUserRole(claimGame, claimPlayers, user);

  const meta = [
    fmtDuration(claimGame.duration_minutes),
    claimGame.num_turns ? `${claimGame.num_turns} rounds` : null,
    claimGame.location  ? claimGame.location             : null,
  ].filter(Boolean).join(' | ');

  const rowsHTML = claimPlayers.map(p => {
    const isMine = p.user_id === user.id;
    let actionHTML;
    if (isMine) {
      // Your own claim: let you release it (e.g. if you picked the wrong one).
      actionHTML = `
        <div class="claim-mine-actions">
          <span class="claim-nick">${_esc(p.nickname)}</span>
          <button class="btn btn-ghost btn-sm" onclick="releaseCharacter('${p.id}')">Release</button>
        </div>`;
    } else if (p.nickname) {
      actionHTML = `<div class="claim-nick">${_esc(p.nickname)}</div>`;
    } else if (myClaim) {
      actionHTML = `<div class="claim-nick unclaimed">Unclaimed</div>`;
    } else {
      actionHTML = `<button class="btn btn-ghost btn-sm" onclick="claimCharacter('${p.id}')">Claim</button>`;
    }
    return `
      <div class="claim-row${p.is_winner ? ' winner' : ''}${isMine ? ' mine' : ''}">
        <div class="claim-char">
          ${p.is_winner ? '<span class="win-star">👑</span>' : ''}
          ${charImgHTML(p.character)}${_esc(p.character)}
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
      ${role.isParticipant ? `<button class="btn btn-ghost btn-sm" onclick="editGameDetails()">Edit details</button>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="shareGame()">Share QR</button>
    </div>
    <div class="section-label">Players</div>
    <div class="claim-rows">${rowsHTML}</div>
    ${myClaim ? `<p class="claim-success">You are playing as <strong>${charImgHTML(myClaim.character)} ${_esc(myClaim.character)}</strong> in this game.</p>` : ''}`;
}

// ── NAV / SHARE ───────────────────────────────────────────────────────────────

function claimGoBack() {
  // Return to wherever we came from (e.g. the player profile); fall back to the
  // profile page when the claim page was opened cold (e.g. via a shared QR).
  if (history.length > 1) { history.back(); return; }
  location.href = 'players.html';
}

function shareGame() {
  if (!claimGame) return;
  const url = new URL(`join.html?game=${claimGame.id}`, location.href).href;
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
  btn.textContent = 'Save Changes';
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
  btn.textContent = 'Saving…';

  const { error } = await db.from('games').update(patch).eq('id', claimGame.id);

  if (error) {
    showError(errEl, error.message);
    btn.disabled    = false;
    btn.textContent = 'Save Changes';
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
    title:        'Confirm your villain',
    bodyHTML:     `<p class="confirm-text">You're about to claim <strong class="text-emph">${charImgHTML(player.character)}${_esc(player.character)}</strong> in this game. Picked the wrong one? You can release it afterwards.</p>`,
    confirmLabel: 'Claim villain',
    busyLabel:    'Claiming…',
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
    title:        'Release this villain?',
    bodyHTML:     `<p class="confirm-text">This frees up <strong class="text-emph">${charImgHTML(player.character)}${_esc(player.character)}</strong> so it can be claimed again, by you or another player.</p>`,
    confirmLabel: 'Release',
    busyLabel:    'Releasing…',
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
      <h3>Oops</h3>
      <p>${msg}</p>
      <a class="btn btn-ghost btn-sm" href="index.html">Back to Games</a>
    </div>`;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();
