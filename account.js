let _acctChars      = [];
let _acctAvatar     = null;   // the saved avatar (in the DB)
let _pendingAvatar  = null;   // the currently-previewed selection, saved on "Apply"
let _acctNick       = null;
let _acctFallback   = 'asset/players/default.svg';
let _acctBoxInfo    = {};
let _acctOwnedBoxes = new Set();
let _acctAch        = new Map();
let _acctGlobal     = null;   // profile-wide achievements (table sizes / volume / locations)
let _acctIdentities = [];   // list of { provider, identity_id, email, last_sign_in_at, ... }

// Providers we support, in display order. Keep in sync with sign-in.html.
const ACCT_PROVIDERS = [
  { key: 'discord', label: 'Discord', logo: 'asset/signin/discord.png' },
  { key: 'google',  label: 'Google',  logo: 'asset/signin/google.png'  },
];

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  await initAuth(() => _onAuthChange());
  const user = getCurrentUser();
  if (!user) { location.href = 'index.html'; return; }
  const [chars, boxInfo, ownedRes, gpRes] = await Promise.all([
    loadCharacters(),
    loadBoxInfo(),
    db.from('profile_boxes').select('box').eq('user_id', user.id),
    _fetchAllRows(() => db.from('game_players').select('game_id, character, is_winner').eq('user_id', user.id)),
  ]);
  _acctChars      = chars;
  _acctBoxInfo    = boxInfo;
  _acctOwnedBoxes = new Set((ownedRes.data || []).map(r => r.box));
  const { games, players } = await fetchGamesWithPlayers([...new Set(gpRes.rows.map(r => r.game_id))]);
  const official  = new Set(games.map(g => g.id));   // solo games give no achievements
  _acctAch        = computeCharacterAchievements(gpRes.rows.filter(r => official.has(r.game_id)));
  _acctGlobal     = computeGlobalAchievements(games, players, p => p.user_id === user.id, _acctChars);
  await _loadIdentities();
  _renderPage();

  // A language switch brings back the avatar tab and an image picked but not
  // applied yet (the Build tab keeps its work itself, avatar-builder.js).
  const saved = takeViewState();
  if (saved?.avatarTab === 'builder') _showAvatarTab('builder');
  else if (saved?.pending && saved.pending !== _acctAvatar) _previewAvatar(saved.pending);
  keepViewState(() => ({
    avatarTab: document.getElementById('avatarTabBuilder')?.classList.contains('on') ? 'builder' : 'photos',
    pending:   _pendingAvatar,
  }));
}

async function _loadIdentities() {
  try {
    const { data, error } = await db.auth.getUserIdentities();
    if (error) { console.warn('getUserIdentities error:', error); _acctIdentities = []; return; }
    _acctIdentities = data?.identities || [];
  } catch (e) {
    console.warn('getUserIdentities threw:', e);
    _acctIdentities = [];
  }
}

function _onAuthChange() {
  if (!getCurrentUser()) location.href = 'index.html';
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function _renderPage() {
  const profile = getCurrentProfile();
  const user    = getCurrentUser();
  _acctNick      = profile?.nickname   || null;
  _acctAvatar    = profile?.avatar_url || null;
  _pendingAvatar = _acctAvatar;
  _acctFallback  = profile?.default_avatar || 'asset/players/default.svg';

  setAchievementsContext({
    ach: _acctAch, chars: _acctChars, boxInfo: _acctBoxInfo, global: _acctGlobal,
    title: _acctNick ? `${t('Achievements')} | ${_acctNick}` : t('Achievements'),
  });

  const metaLn = profile?.created_at ? t('Since {date}', { date: fmtDateShort(profile.created_at) }) : null;

  const root = document.getElementById('acctRoot');
  root.className = '';
  root.innerHTML = `
    <div class="acct-section">
      <div class="section-label">${t('My Profile')}</div>
      <div class="err" id="avatarErr"></div>
      <div class="acct-identity">
        <span id="acctAvatarPreviewWrap"></span>
        <div class="acct-identity-info">
          <div class="acct-nick">${_acctNick
            ? `<a class="acct-nick-link" href="players.html?nick=${encodeURIComponent(_acctNick)}" title="${t('View my player page')}">${_esc(_acctNick)}</a>`
            : '-'}</div>
          ${metaLn ? `<div class="pf-since">${_esc(metaLn)}</div>` : ''}
          <button class="btn btn-ghost btn-sm acct-change-nick" onclick="changeNickname()">${t('Change nickname')}</button>
        </div>
      </div>
      <div class="avatar-tab-row">
        <div class="seg seg-sm" role="tablist">
          <button class="seg-btn on" id="avatarTabPhotos"  type="button" onclick="_showAvatarTab('photos')">${t('Images')}</button>
          <button class="seg-btn"    id="avatarTabBuilder" type="button" onclick="_showAvatarTab('builder')">${t('Build')}</button>
        </div>
        <div class="avatar-actions">
          <button class="btn btn-ghost btn-sm" id="removeAvatarBtn" onclick="removeAvatar()" ${(_pendingAvatar || _acctAvatar) ? '' : 'disabled'}>${t('Default')}</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick="randomizeAvatar()">${t('Random')}</button>
          <button class="btn btn-primary btn-sm" id="commitAvatarBtn" onclick="commitAvatar()" disabled>${t('Apply')}</button>
        </div>
      </div>
      <div class="avatar-pane" id="avatarPanePhotos">
        <div class="avatar-picker" id="avatarPicker"></div>
      </div>
      <div class="avatar-pane" id="avatarPaneBuilder" hidden></div>
    </div>

    <div class="acct-section">
      <div class="section-label">${t('My boxes')}</div>
      <div class="err" id="boxesErr"></div>
      <div class="box-picker" id="boxPicker"></div>
    </div>

    <div class="acct-section">
      ${achievementsSectionHTML({
        ach: _acctAch, chars: _acctChars, boxInfo: _acctBoxInfo, global: _acctGlobal,
        // The account page shows every achievement, earned or not.
        onlyEarned: false,
        header: (earned, total) => `<div class="section-label">${t('My Achievements')} | ${earned} / ${total}</div>`,
      })}
    </div>

    <div class="acct-section" id="betaSection">${_betaSectionHTML()}</div>

    <div class="acct-section">
      <div class="section-label">${t('Account')}</div>
      <div class="err" id="identitiesErr"></div>
      <div id="identitiesList" class="acct-identities">${_renderIdentitiesHTML()}</div>
      <div class="acct-actions">
        <button class="btn btn-ghost" id="exportDataBtn" onclick="exportMyData()">${t('Download my data')}</button>
        <button class="btn btn-ghost" onclick="signOut()">${t('Sign out')}</button>
      </div>
    </div>

    <div class="acct-section acct-danger">
      <div class="section-label">${t('Danger zone')}</div>
      <button class="btn btn-danger" onclick="openDeleteAccount()">${t('Delete profile')}</button>
    </div>
  `;

  _buildAvatarPicker();
  avatarBuilder.configure({ getSavedAvatar: () => _acctAvatar, onPreview: _previewBuild });
  avatarBuilder.build('avatarPaneBuilder');
  _buildBoxPicker();
}

function _showAvatarTab(name) {
  const isBuilder = name === 'builder';
  document.getElementById('avatarTabPhotos') ?.classList.toggle('on', !isBuilder);
  document.getElementById('avatarTabBuilder')?.classList.toggle('on',  isBuilder);
  const photos  = document.getElementById('avatarPanePhotos');
  const builder = document.getElementById('avatarPaneBuilder');
  if (photos)  photos.hidden  = isBuilder;
  if (builder) builder.hidden = !isBuilder;
  // The identity avatar previews the active tab: the saved icon (or a clicked
  // preset) on Presets, the in-progress composition on Build.
  if (isBuilder) {
    _previewBuild();
  } else {
    _pendingAvatar = _acctAvatar;
    document.querySelectorAll('#avatarPicker .avatar-option').forEach(el =>
      el.classList.toggle('selected', el.dataset.value === _acctAvatar));
    _renderPreview();
    _syncCommitBtn();
  }
}

function _buildBoxPicker() {
  const picker = document.getElementById('boxPicker');
  if (!picker) return;
  // A box that only reprints characters (no character has it as their primary
  // `box`, e.g. Darkness Brewing) still needs to be markable as owned, so
  // extraBoxes count too.
  const boxNames = [...new Set(_acctChars.flatMap(c => [c.box, ...(c.extraBoxes || [])]).filter(Boolean))];
  boxNames.sort((a, b) => {
    const oa = _acctBoxInfo[a]?.order ?? 999;
    const ob = _acctBoxInfo[b]?.order ?? 999;
    return oa - ob || a.localeCompare(b);
  });
  picker.innerHTML = boxNames.map(box => {
    const info  = _acctBoxInfo[box] || {};
    const owned = _acctOwnedBoxes.has(box);
    const src   = info.slug ? `asset/boxes/${info.slug}.webp` : 'asset/players/default.svg';
    const year  = info.year ? `<span class="box-option-year">${info.year}</span>` : '';
    return `
      <button class="box-option${owned ? ' selected' : ''}" data-box="${_esc(box)}" type="button" onclick="_toggleBox(this.dataset.box)" title="${_esc(box)}">
        <img src="${src}" alt="${_esc(box)}" onerror="this.src='asset/players/default.svg'">
        <span class="box-option-name">${_esc(box)}</span>
        ${year}
      </button>`;
  }).join('');
}

async function _toggleBox(box) {
  const user = getCurrentUser();
  if (!user) return;
  const wasOwned = _acctOwnedBoxes.has(box);
  if (wasOwned) _acctOwnedBoxes.delete(box);
  else          _acctOwnedBoxes.add(box);
  const btn = document.querySelector(`.box-option[data-box="${CSS.escape(box)}"]`);
  if (btn) btn.classList.toggle('selected', !wasOwned);
  clearError('boxesErr');

  const { error } = wasOwned
    ? await db.from('profile_boxes').delete().eq('user_id', user.id).eq('box', box)
    : await db.from('profile_boxes').insert({ user_id: user.id, box });

  if (error) {
    if (wasOwned) _acctOwnedBoxes.add(box);
    else          _acctOwnedBoxes.delete(box);
    if (btn) btn.classList.toggle('selected', wasOwned);
    showError('boxesErr', error.message);
  }
}

// ── DATA EXPORT ──────────────────────────────────────────────────────────────

// CSV field escaping (RFC 4180): quote and double up internal quotes only
// when the value contains a comma, quote or newline.
function _csvField(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Sortable "YYYY-MM-DD HH:MM" in local time, deliberately not the locale-
// formatted `fmtDateTime` (ui.js): a spreadsheet sorts/parses this correctly
// regardless of the viewer's locale, month names don't.
function _csvDateTime(iso) {
  if (!iso) return '';   // game with no recorded date
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function exportMyData() {
  const user = getCurrentUser();
  if (!user) return;
  const btn = document.getElementById('exportDataBtn');
  btn.disabled    = true;
  btn.textContent = t('Preparing…');

  try {
    const gpAll = await _fetchAllRows(() => db.from('game_players').select('*').eq('user_id', user.id));

    // One row per player per game (not one row per game with player1/2/3…
    // columns), so every game's variable player count (2-6) fits without
    // padding, and the file filters/pivots cleanly in a spreadsheet.
    const gameIds = [...new Set(gpAll.rows.map(r => r.game_id))];
    const { games, players } = await fetchGamesWithPlayers(gameIds, { orderByPlayedAtDesc: true });
    const playersByGame = {};
    for (const p of players) (playersByGame[p.game_id] ||= []).push(p);

    const header = ['Game ID', 'Date', 'Location', 'Duration (min)', 'Rounds', 'Player', 'Villain', 'Seat', 'Winner'];
    const rows = [header];
    for (const g of games) {
      const dateStr = isDateOnly(g) ? g.played_at.slice(0, 10) : _csvDateTime(g.played_at);   // date-only sources: the day, no time
      for (const p of sortGamePlayers(playersByGame[g.id] || [])) {
        rows.push([
          g.id,
          dateStr,
          g.location || '',
          g.duration_minutes ?? '',
          g.num_turns ?? '',
          p.nickname || '',
          p.character,
          p.position == null ? '' : p.position + 1,   // empty: play order not recorded
          p.is_winner ? 'yes' : 'no',
        ]);
      }
    }
    const csv = rows.map(r => r.map(_csvField).join(',')).join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href     = url;
    a.download = `DiVilytics-${_acctNick || user.id}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    btn.textContent = t('Downloaded ✓');
    setTimeout(() => { btn.disabled = false; btn.textContent = t('Download my data'); }, 1500);
  } catch (e) {
    console.error('exportMyData failed:', e);
    btn.disabled    = false;
    btn.textContent = t('Download failed. Retry');
  }
}

function _buildAvatarPicker() {
  const picker = document.getElementById('avatarPicker');
  if (!picker) return;
  picker.innerHTML = '';
  for (let i = 1; i <= AVATAR_PRESET_COUNT; i++) {
    const value = presetAvatarSrc(i);
    const img   = document.createElement('img');
    img.className = 'avatar-option' + (value === _acctAvatar ? ' selected' : '');
    img.src   = value;
    img.alt   = t('Player {n}', { n: i });
    img.dataset.value = value;
    img.onerror = () => { img.src = 'asset/players/default.svg'; };
    img.onclick = () => _previewAvatar(value);
    picker.appendChild(img);
  }
  _renderPreview();
}

// The large identity avatar (left of the nickname) is the live preview of the
// pending selection, a clicked preset or the in-progress build. It's only
// written to the profile when the user presses "Use this icon".
function _renderPreview() {
  const host = document.getElementById('acctAvatarPreviewWrap');
  if (host) host.innerHTML = avatarHTML(_pendingAvatar || _acctFallback, { cls: 'acct-identity-avatar', extraClass: 'zoomable', fallback: _acctFallback, lightbox: true });
}

// Clicking a preset previews it (highlights it + shows it large) but does not
// save, saving happens on "Use this icon".
function _previewAvatar(value) {
  _pendingAvatar = value;
  document.querySelectorAll('#avatarPicker .avatar-option').forEach(el =>
    el.classList.toggle('selected', el.dataset.value === value));
  _renderPreview();
  _syncCommitBtn();
  clearError('avatarErr');
}

// Preview the in-progress build (clears any preset highlight, since it's a build).
function _previewBuild() {
  _pendingAvatar = avatarBuilder.recipe();
  document.querySelectorAll('#avatarPicker .avatar-option').forEach(el => el.classList.remove('selected'));
  _renderPreview();
  _syncCommitBtn();
}

// "Use this icon" lights up only when the preview differs from what's saved.
function _syncCommitBtn() {
  const btn = document.getElementById('commitAvatarBtn');
  if (btn) btn.disabled = (_pendingAvatar === _acctAvatar);
  _syncRemoveBtn();   // the Default button also depends on the pending preview
}

// 🎲, random preset on the Presets tab, random composition on the Build tab.
function randomizeAvatar() {
  const builderPane = document.getElementById('avatarPaneBuilder');
  if (builderPane && !builderPane.hidden) {
    avatarBuilder.randomize();
  } else {
    _previewAvatar(presetAvatarSrc(1 + Math.floor(Math.random() * AVATAR_PRESET_COUNT)));
  }
}

// The avatar builder UI (compose an icon from body parts over a background) lives
// in avatar-builder.js as the `avatarBuilder` module. It's wired to this page via
// avatarBuilder.configure({ getSavedAvatar, onPreview }) in _renderPage().

// ── AVATAR ACTIONS ───────────────────────────────────────────────────────────

// "Use this icon": persist the previewed selection (preset or build). Optimistic,
// reverts on error.
async function commitAvatar() {
  const user = getCurrentUser();
  if (!user || _pendingAvatar === _acctAvatar) return;

  const value = _pendingAvatar;
  const btn   = document.getElementById('commitAvatarBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('Saving…'); }
  clearError('avatarErr');

  const previous = _acctAvatar;
  _acctAvatar = value;
  const profile = getCurrentProfile();
  if (profile) profile.avatar_url = value;
  _updateAuthUI();
  _syncRemoveBtn();

  const { error } = await db.from('profiles').update({ avatar_url: value }).eq('id', user.id);
  if (error) {
    _acctAvatar = previous;
    if (profile) profile.avatar_url = previous;
    _updateAuthUI();
    _syncRemoveBtn();
    showError('avatarErr', error.message);
    if (btn) { btn.textContent = t('Apply'); btn.disabled = false; }
    return;
  }
  if (btn) {
    btn.textContent = t('Saved ✓');
    setTimeout(() => { btn.textContent = t('Apply'); _syncCommitBtn(); }, 1500);
  }
}

// "Default" stages the default icon as a pending selection (like clicking a
// preset); Apply commits it. Disabled once the preview is already the default,
// i.e. there's nothing left to clear.
function _syncRemoveBtn() {
  const btn = document.getElementById('removeAvatarBtn');
  if (btn) btn.disabled = !_pendingAvatar;
}

// Preview the default icon. No DB write, Apply persists it, matching every
// other control in the editor (presets, build, random).
function removeAvatar() {
  _pendingAvatar = null;
  document.querySelectorAll('#avatarPicker .avatar-option').forEach(el => el.classList.remove('selected'));
  _renderPreview();
  _syncCommitBtn();   // re-enables Apply (now differs from saved) + re-syncs Default
  clearError('avatarErr');
}

// ── CHANGE NICKNAME ───────────────────────────────────────────────────────────

function changeNickname() {
  openChangeNicknameModal(newNick => {
    _acctNick = newNick;
    const el = document.querySelector('.acct-nick');
    if (el) el.textContent = newNick;
  });
}

// ── DELETE ACCOUNT ────────────────────────────────────────────────────────────

function openDeleteAccount() {
  document.getElementById('delAccountInput').value = '';
  clearError('delAccountErr');
  _syncDelBtn();
  openOverlay('delAccountOverlay');
  setTimeout(() => document.getElementById('delAccountInput')?.focus(), 120);
}

function closeDeleteAccount() {
  closeOverlay('delAccountOverlay');
}

function _syncDelBtn() {
  const input = document.getElementById('delAccountInput');
  const btn   = document.getElementById('delAccountBtn');
  if (!input || !btn) return;
  btn.disabled = (input.value !== _acctNick);
}

async function confirmDeleteAccount() {
  const errEl = document.getElementById('delAccountErr');
  clearError(errEl);

  const user = getCurrentUser();
  if (!user) return;

  const btn = document.getElementById('delAccountBtn');
  btn.disabled    = true;
  btn.textContent = t('Deleting…');

  const fail = msg => {
    showError(errEl, msg);
    btn.disabled    = false;
    btn.textContent = t('Delete my profile');
  };

  // Deleting the profile also clears your name from your seats (a database trigger).
  const { error } = await db.from('profiles').delete().eq('id', user.id);
  if (error) return fail(error.message);

  await db.auth.signOut();
  location.href = 'index.html';
}

// The achievement detail overlay handlers (_showAchDetail / _showBoxDetail /
// _showGlobalDetail / _closeAchOverlay) are shared from achievements.js and read
// the context set via setAchievementsContext() in _renderPage().

// ── BETA ──────────────────────────────────────────────────────────────────────
// Join the beta (lang.js): this browser then opens the beta instead of the
// release. Joining from the release goes to the beta's account page, leaving
// from the beta back to the release's.

function _betaSectionHTML() {
  const joined = betaJoined();
  return `
    <div class="section-label">${t('Beta')}</div>
    <p class="acct-note">${joined && IS_BETA
      ? t("You're on the beta: on this browser, DiVilytics always opens here.")
      : t('Try new features before everyone else, on a version still being finished. Your account and your games are the same on both.')}</p>
    <button class="btn btn-ghost" onclick="setBeta(${!joined})">${joined ? t('Leave the beta') : t('Join the beta')}</button>`;
}

function setBeta(join) {
  try { if (join) localStorage.setItem(BETA_KEY, '1'); else localStorage.removeItem(BETA_KEY); } catch (_) {}
  if (join === IS_BETA) { document.getElementById('betaSection').innerHTML = _betaSectionHTML(); return; }
  location.href = join ? `/beta${location.pathname}` : (location.pathname.replace(/^\/beta/, '') || '/');
}

// ── LINKED IDENTITIES ─────────────────────────────────────────────────────────

function _renderIdentitiesHTML() {
  const linkedSet = new Set(_acctIdentities.map(i => i.provider));
  const canUnlink = linkedSet.size > 1;  // refuse to remove the last identity

  return ACCT_PROVIDERS.map(p => {
    const identity = _acctIdentities.find(i => i.provider === p.key);
    const isLinked = !!identity;
    const meta     = identity?.identity_data?.email || identity?.email || '';

    let actionHTML;
    if (isLinked) {
      actionHTML = `
        <span class="identity-linked-badge">${t('Linked')}</span>
        <button class="btn btn-ghost btn-sm" ${canUnlink ? '' : 'disabled'} title="${t(canUnlink ? 'Unlink this provider' : 'You need at least one sign-in method')}"
                onclick="unlinkIdentity('${_esc(p.key)}')">${t('Unlink')}</button>
      `;
    } else {
      actionHTML = `<button class="btn btn-primary btn-sm" onclick="linkIdentity('${_esc(p.key)}')">${t('Link')}</button>`;
    }

    return `
      <div class="identity-row">
        <img class="identity-logo" src="${_esc(p.logo)}" alt="">
        <div class="identity-text">
          <div class="identity-name">${_esc(p.label)}</div>
          ${meta ? `<div class="identity-meta">${_esc(meta)}</div>` : ''}
        </div>
        <div class="identity-actions">${actionHTML}</div>
      </div>
    `;
  }).join('');
}

async function linkIdentity(provider) {
  clearError('identitiesErr');
  const { error } = await db.auth.linkIdentity({
    provider,
    options: { redirectTo: window.location.href },
  });
  if (error) {
    // Common case: "Manual linking is not enabled" or provider not configured.
    showError('identitiesErr', error.message);
  }
}

async function unlinkIdentity(provider) {
  clearError('identitiesErr');
  const identity = _acctIdentities.find(i => i.provider === provider);
  if (!identity) return;

  // Safety: never unlink the last identity (would leave the user stranded).
  if (_acctIdentities.length <= 1) {
    showError('identitiesErr', t('You need at least one sign-in method.'));
    return;
  }

  const { error } = await db.auth.unlinkIdentity(identity);
  if (error) {
    showError('identitiesErr', error.message);
    return;
  }

  await _loadIdentities();
  const host = document.getElementById('identitiesList');
  if (host) host.innerHTML = _renderIdentitiesHTML();
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();
