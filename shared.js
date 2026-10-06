// ── LIVE GAME STATE ───────────────────────────────────────────────────────────
//
// In-memory state + localStorage persistence for an in-progress recorded game.
// new-game.js drives all the writes; shared.js's nav badge only reads.
// DOM tickers (the 1s clock and the periodic save) live in new-game.js.
const liveGame = (() => {
  // KEY and MAX_AGE_MS come from config.js (loaded earlier).
  const KEY        = LIVE_GAME_KEY;
  const MAX_AGE_MS = LIVE_GAME_MAX_AGE_MS;

  let _start      = null;        // ms since epoch when current run began (null = paused/never)
  let _turns      = 0;
  let _exactDurMs = null;        // captured at stopLive, used to seed next run
  let _hasSession = false;       // true once a real game has been started

  const _hooks = { start: [], stop: [], turnBump: [], close: [] };

  return {
    KEY,
    MAX_AGE_MS,

    // queries
    get hasSession() { return _hasSession; },
    get startedAt()  { return _start; },
    get isRunning()  { return _start != null; },
    get isPaused()   { return _hasSession && _start == null; },
    get turns()      { return _turns; },
    get elapsedMs()  { return _start != null ? Date.now() - _start : 0; },
    get exactDurMs() { return _exactDurMs; },

    // mutators (caller wires DOM)
    markStarted(startTs) { _start = startTs; _hasSession = true; _exactDurMs = null; },
    markStopped(durMs)   { _exactDurMs = durMs; _start = null; },
    setTurns(n)          { _turns = n; },
    bumpTurns(delta) {
      _turns = Math.max(1, _turns + delta);   // the current round: never below 1
      this.emit('turnBump');
    },

    // event hooks
    on(name, fn) { _hooks[name]?.push(fn); },
    emit(name)   { _hooks[name]?.forEach(fn => fn()); },

    // persistence, `extras` carries the form/slot data that only new-game.js knows
    persist(extras = {}) {
      if (!_hasSession) return;
      try {
        localStorage.setItem(KEY, JSON.stringify({
          saved:       Date.now(),
          liveStart:   _start,
          liveTurns:   _turns,
          isLive:      _start != null,
          fDurExactMs: _exactDurMs,
          ...extras,
        }));
      } catch (_) {}
    },
    clear() {
      _start      = null;
      _turns      = 0;
      _exactDurMs = null;
      _hasSession = false;
      localStorage.removeItem(KEY);
    },
    // Returns the saved snapshot, or null if absent / stale / invalid.
    loadSaved() {
      let s;
      try { s = JSON.parse(localStorage.getItem(KEY)); } catch (_) { return null; }
      if (!s || !s.slots || !s.slots.length) return null;
      if (Date.now() - s.saved > MAX_AGE_MS)  return null;
      // Running for 48h: someone forgot to pause and stopped playing long ago.
      if (s.liveStart && Date.now() - s.liveStart > MAX_AGE_MS) return null;
      if (!s.liveStart && !s.fDurExactMs)     return null;
      return s;
    },
    restoreFrom(state) {
      _hasSession = true;
      _start      = state.liveStart   || null;
      _turns      = state.liveTurns   || 0;
      _exactDurMs = state.fDurExactMs || null;
    },
  };
})();

// ── NAV ───────────────────────────────────────────────────────────────────────

let _activeNavFile = '';

function setActiveNav(filename) {
  _activeNavFile = filename;
  document.querySelectorAll('.nav-links a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === filename);
  });
  updateLiveGameNavBadge();
}

// Reads the saved live game from localStorage and tags the New Game nav link
// with `.has-live-game` (red, pulsing) or `.has-paused-game` (gold) so users
// see at a glance that a game is open. Safe to call repeatedly.
function updateLiveGameNavBadge() {
  const link = document.querySelector('.nav-links a[href="new-game.html"]');
  if (!link) return;
  link.classList.remove('has-live-game', 'has-paused-game');

  const state = liveGame.loadSaved();
  if (!state) return;
  link.classList.add(state.liveStart ? 'has-live-game' : 'has-paused-game');
}

// Cross-tab sync: another tab may have started/stopped a game.
window.addEventListener('storage', e => {
  if (e.key === liveGame.KEY) updateLiveGameNavBadge();
});

// ── AUTH ──────────────────────────────────────────────────────────────────────

let _currentUser    = null;
let _currentProfile = null;
let _profileLoadFailed = false;  // true when the last fetch errored (likely offline), don't prompt for nickname
let _authChangeHook = null;
let _authResolved   = false;     // true once the session check has actually run

// Cache the signed-in nav avatar so the first paint (before the async session
// check) shows it instead of the guest button, avoids a guest→avatar flash on
// every page load for returning users.
const NAV_AUTH_LS = 'divilytics:navAvatar';
function _cachedNavAvatar() {
  try { return localStorage.getItem(NAV_AUTH_LS) || null; } catch (_) { return null; }
}
function _setCachedNavAvatar(src) {
  try {
    if (src) localStorage.setItem(NAV_AUTH_LS, src);
    else     localStorage.removeItem(NAV_AUTH_LS);
  } catch (_) {}
}

async function initAuth(onChange) {
  _authChangeHook = onChange;
  _injectNicknameModal();
  _updateAuthUI();  // render sign-in button immediately, before async session check

  const { data: { session } } = await db.auth.getSession();
  _authResolved = true;
  if (session?.user) {
    _currentUser = session.user;
    await _loadProfile();
  } else {
    _setCachedNavAvatar(null);   // not logged in, drop any stale cached avatar
  }

  db.auth.onAuthStateChange(async (event, session) => {
    _authResolved = true;
    const prevId = _currentUser?.id;
    _currentUser = session?.user || null;

    if (_currentUser && _currentUser.id !== prevId) {
      await _loadProfile();
    }
    if (!_currentUser) { _currentProfile = null; _setCachedNavAvatar(null); }

    _updateAuthUI();

    if (event === 'SIGNED_IN' && _currentUser && !_currentProfile && !_profileLoadFailed) {
      _openNicknameModal();
    }

    if (_authChangeHook) _authChangeHook(_currentUser, _currentProfile);
  });

  _updateAuthUI();

  // Force nickname setup if logged in but no profile yet
  // (e.g. user closed the tab before finishing setup and came back).
  // Skip when the profile fetch errored, likely offline with a cached page,
  // and we can't tell whether a profile actually exists.
  if (_currentUser && !_currentProfile && !_profileLoadFailed) {
    _openNicknameModal();
  }

  return { user: _currentUser, profile: _currentProfile };
}

async function _loadProfile() {
  if (!_currentUser) return null;
  const { data, error } = await db
    .from('profiles')
    .select('*')
    .eq('id', _currentUser.id)
    .maybeSingle();
  if (error) {
    console.warn('_loadProfile error:', error);
    _profileLoadFailed = true;
    _currentProfile = null;
  } else {
    _profileLoadFailed = false;
    _currentProfile = data || null;
  }
  return _currentProfile;
}

function getCurrentUser()    { return _currentUser; }
function getCurrentProfile() { return _currentProfile; }

// Best-guess sign-in status for a synchronous first paint: the real value once
// the session check has resolved, otherwise the cached nav-avatar hint ("was
// signed in last time"). Lets UI render the right state immediately; if the
// cache is wrong it self-corrects on the next render after auth resolves.
function isLikelySignedIn() {
  return _authResolved ? !!_currentUser : !!_cachedNavAvatar();
}

const _preSignInHooks = [];
function onBeforeSignIn(fn) { _preSignInHooks.push(fn); }

async function signInWithDiscord() {
  for (const fn of _preSignInHooks) { try { fn(); } catch (_) {} }
  await db.auth.signInWithOAuth({
    provider: 'discord',
    options: { redirectTo: window.location.href },
  });
}

async function signInWithGoogle() {
  for (const fn of _preSignInHooks) { try { fn(); } catch (_) {} }
  await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href },
  });
}

// Navigate to the dedicated sign-in page, remembering where to return after
// the OAuth round-trip. Used everywhere we used to call signInWithDiscord()
// directly from a UI affordance.
function goToSignIn() {
  for (const fn of _preSignInHooks) { try { fn(); } catch (_) {} }
  const returnTo = encodeURIComponent(window.location.href);
  window.location.href = `sign-in.html?returnTo=${returnTo}`;
}

async function signOut() {
  await db.auth.signOut();
  _currentUser    = null;
  _currentProfile = null;
  _updateAuthUI();
  if (_authChangeHook) _authChangeHook(null, null);
}

function _updateAuthUI() {
  const el = document.getElementById('navAuth');
  if (!el) return;

  const themeBtn = `<button class="nav-icon-btn" id="settingsBtn" type="button" onclick="toggleSettings(event)" title="${t('Settings')}" aria-haspopup="true" aria-expanded="false">⚙️</button>`;
  const avatarLink = src =>
    `${themeBtn}<a class="nav-avatar-link active" href="account.html" title="${t('Account')}">${avatarHTML(src, { cls: 'nav-avatar' })}</a>`;

  // Before the session check resolves, fall back to the cached avatar (if any) so
  // a returning user sees their icon immediately rather than a guest flash.
  const cached = (!_currentUser && !_authResolved) ? _cachedNavAvatar() : null;

  if (_currentUser) {
    const avatarSrc = resolveAvatar(_currentProfile);
    _setCachedNavAvatar(avatarSrc);
    el.innerHTML = avatarLink(avatarSrc);
  } else if (cached) {
    el.innerHTML = avatarLink(cached);
  } else {
    if (_authResolved) _setCachedNavAvatar(null);   // confirmed signed out, drop the cache
    el.innerHTML = `${themeBtn}<button class="nav-avatar-btn" onclick="goToSignIn()" title="${t('Sign in')}"><img class="nav-avatar nav-avatar-guest" src="asset/players/default.svg" alt=""></button>`;
  }
  _updateThemeBtn();
  _updateThemeIcons();
}

// ── SETTINGS PANEL ───────────────────────────────────────────────────────────
// The ⚙️ in the nav opens a small panel with the theme (Auto / Light / Dark,
// theme.js) and the language (EN / IT, lang.js; switching reloads the page).
// It lives in the nav itself (not in #navAuth, which is repainted on sign-in),
// and closes after a choice, on a tap outside it, or on Escape.
function _settingsPanel() {
  let panel = document.getElementById('settingsPanel');
  if (panel) return panel;
  const nav = document.querySelector('nav');
  if (!nav) return null;
  const btn = (attr, val, label, title) =>
    `<button class="seg-btn" type="button" ${attr}="${val}"${title ? ` title="${title}"` : ''}>${label}</button>`;
  panel = document.createElement('div');
  panel.id = 'settingsPanel';
  panel.className = 'settings-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('Settings'));
  panel.innerHTML = `
    <div class="settings-row">
      <span class="settings-lbl">${t('Theme')}</span>
      <div class="seg">${btn('data-theme-opt', 'auto', `<span class="settings-ico">🌗</span>${t('Auto')}`)}${btn('data-theme-opt', 'light', `<span class="settings-ico">☀️</span>${t('Light')}`)}${btn('data-theme-opt', 'dark', `<span class="settings-ico">🌙</span>${t('Dark')}`)}</div>
    </div>
    <div class="settings-row">
      <span class="settings-lbl">${t('Text size')}</span>
      <div class="seg">${btn('data-text-opt', 'small', `<span class="settings-ico ts-a">A</span>${t('Small')}`)}${btn('data-text-opt', 'large', `<span class="settings-ico ts-a">A</span>${t('Large')}`)}</div>
    </div>
    <div class="settings-row">
      <span class="settings-lbl">${t('Language')}</span>
      <div class="seg">${btn('data-lang', 'en', '<span class="settings-ico">🌐</span>EN', 'English')}${btn('data-lang', 'it', '<span class="settings-ico">🌐</span>IT', 'Italiano')}</div>
    </div>`;
  panel.addEventListener('click', e => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    if (b.dataset.themeOpt) setTheme(b.dataset.themeOpt);
    if (b.dataset.textOpt)  setTextSize(b.dataset.textOpt);
    if (b.dataset.lang)     setLang(b.dataset.lang);   // reloads, unless it's already the language
    _closeSettings();
  });
  panel.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('on', b.dataset.lang === LANG));
  _updateTextSizeBtns(panel);
  nav.appendChild(panel);
  _updateThemeBtn();
  return panel;
}

// Text size: Small (default) or Large, kept in localStorage like the theme. The
// scale is CSS (--ts); a 'resize' event re-runs the layouts that measure text
// (the New Game legend, the game cards' details line).
function setTextSize(size) {
  const large = size === 'large';
  if (large) document.documentElement.dataset.text = 'large';
  else       delete document.documentElement.dataset.text;
  try { localStorage.setItem('textSize', large ? 'large' : 'small'); } catch (_) {}
  _updateTextSizeBtns();
  window.dispatchEvent(new Event('resize'));
}

function _updateTextSizeBtns(panel = document.getElementById('settingsPanel')) {
  const cur = document.documentElement.dataset.text === 'large' ? 'large' : 'small';
  panel?.querySelectorAll('[data-text-opt]').forEach(b => b.classList.toggle('on', b.dataset.textOpt === cur));
}

function toggleSettings(e) {
  e?.stopPropagation();
  const panel = _settingsPanel();
  if (!panel) return;
  const open = !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  document.getElementById('settingsBtn')?.setAttribute('aria-expanded', String(open));
}

function _closeSettings() {
  const panel = document.getElementById('settingsPanel');
  if (!panel || !panel.classList.contains('open')) return;
  panel.classList.remove('open');
  document.getElementById('settingsBtn')?.setAttribute('aria-expanded', 'false');
}
document.addEventListener('click', e => {
  if (!e.target.closest('#settingsPanel, #settingsBtn')) _closeSettings();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeSettings(); });

// Paint the nav immediately, the cached avatar for a returning user, else the
// sign-in button, before the async session check, so nothing flickers in.
_updateAuthUI();

// ── NICKNAME MODAL ────────────────────────────────────────────────────────────

let _nickMode      = 'create';  // 'create' | 'update'
let _nickOnSuccess = null;      // optional callback(newNick)

function _injectNicknameModal() {
  if (document.getElementById('nicknameOverlay')) return;
  const tpl = document.createElement('div');
  tpl.innerHTML = `
    <div class="overlay" id="nicknameOverlay">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h3 id="nickModalTitle">${t('Choose your nickname')}</h3>
        </div>
        <div class="sheet-body">
          <p id="nickModalHint" class="modal-hint">
            ${t("This nickname identifies you on game records and the leaderboard. You can change it later from your Account page.")}
          </p>
          <div class="err" id="nickErr"></div>
          <div class="field">
            <label>${t('Nickname')}</label>
            <input type="text" id="nickInput" maxlength="30" placeholder="${t('e.g. emilio')}" autocomplete="off">
          </div>
        </div>
        <div class="sheet-footer">
          <button class="btn btn-primary" onclick="_saveNickname()">${t('Save Nickname')}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(tpl.firstElementChild);
}

function _openNicknameModal(onSuccess) {
  _nickMode = 'create';
  _nickOnSuccess = onSuccess || null;
  if (!document.getElementById('nicknameOverlay')) return;
  document.getElementById('nicknameOverlay').classList.add('no-drag');   // required: no dragging it away
  document.getElementById('nickModalTitle').textContent = t('Choose your nickname');
  document.getElementById('nickModalHint').textContent  = t("This nickname identifies you on game records and the leaderboard. You can change it later from your Account page.");
  document.getElementById('nickInput').value = '';
  clearError('nickErr');
  openOverlay('nicknameOverlay');
  setTimeout(() => document.getElementById('nickInput')?.focus(), 120);
}

function openChangeNicknameModal(onSuccess) {
  _nickMode = 'update';
  _nickOnSuccess = onSuccess || null;
  const overlay = document.getElementById('nicknameOverlay');
  if (!overlay) return;
  overlay.classList.remove('no-drag');   // optional: drag down to cancel
  overlay._dragClose = () => { _closeNicknameModal(); return true; };
  document.getElementById('nickModalTitle').textContent = t('Change your nickname');
  document.getElementById('nickModalHint').textContent  = t('Your nickname will be updated on all past and future game records.');
  document.getElementById('nickInput').value = _currentProfile?.nickname || '';
  clearError('nickErr');
  openOverlay('nicknameOverlay');
  setTimeout(() => document.getElementById('nickInput')?.focus(), 120);
}

function _closeNicknameModal() {
  const overlay = document.getElementById('nicknameOverlay');
  if (!overlay) return;
  closeOverlay('nicknameOverlay');
}

async function _saveNickname() {
  const input = document.getElementById('nickInput');
  const errEl = document.getElementById('nickErr');
  const nick  = input?.value.trim() || '';

  clearError(errEl);

  if (nick.length < 2) {
    showError(errEl, t('Nickname must be at least 2 characters.'));
    return;
  }

  const friendlyDupMsg = err =>
    err.message.includes('unique') || err.message.includes('duplicate')
      ? t('That nickname is already taken. Try another.')
      : err.message;

  if (_nickMode === 'update') {
    if (nick === _currentProfile?.nickname) { _closeNicknameModal(); return; }

    const { error } = await db.from('profiles').update({ nickname: nick }).eq('id', _currentUser.id);
    if (error) { showError(errEl, friendlyDupMsg(error)); return; }

    await db.from('game_players').update({ nickname: nick }).eq('user_id', _currentUser.id);

    _currentProfile = { ..._currentProfile, nickname: nick };
  } else {
    const { error } = await db.from('profiles').insert({ id: _currentUser.id, nickname: nick });
    if (error) { showError(errEl, friendlyDupMsg(error)); return; }

    _currentProfile = { id: _currentUser.id, nickname: nick };
  }

  _closeNicknameModal();
  _updateAuthUI();
  if (_authChangeHook) _authChangeHook(_currentUser, _currentProfile);
  if (_nickOnSuccess) _nickOnSuccess(nick);
}
