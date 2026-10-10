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

  // The avatar opens the settings panel, the account on top (SETTINGS PANEL).
  const menuBtn = (cls, title, inner) =>
    `<button class="${cls}" id="settingsBtn" type="button" onclick="toggleSettings(event)" title="${title}" aria-haspopup="true" aria-expanded="false">${inner}</button>`;
  const avatarLink = src =>
    menuBtn('nav-avatar-btn nav-avatar-link active', t('Account and settings'), avatarHTML(src, { cls: 'nav-avatar' }));

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
    el.innerHTML = menuBtn('nav-avatar-btn', t('Sign in and settings'), '<img class="nav-avatar nav-avatar-guest" src="asset/players/default.svg" alt="">');
  }
  _renderSettingsAccount();
  _updateThemeBtn();
  _updateThemeIcons();
}

// ── SETTINGS PANEL ───────────────────────────────────────────────────────────
// The avatar in the nav opens a small panel: the account on top (your avatar
// and nickname, to the account page; Sign in for a guest), then the theme
// (Auto / Light / Dark, theme.js), the text size and the language (EN / IT,
// lang.js; switching reloads the page). It lives in the nav itself (not in
// #navAuth, which is repainted on sign-in), and closes after a choice, on a tap
// outside it, or on Escape (KEYBOARD).
function _settingsAccountHTML() {
  const cached = (!_currentUser && !_authResolved) ? _cachedNavAvatar() : null;
  if (!_currentUser && !cached) {
    return `<button class="settings-account" type="button" onclick="goToSignIn()"><img class="settings-avatar nav-avatar-guest" src="asset/players/default.svg" alt=""><span class="settings-nick">${t('Sign in')}</span><span class="settings-go">›</span></button>`;
  }
  const src  = _currentUser ? resolveAvatar(_currentProfile) : cached;
  const nick = _currentProfile?.nickname;
  return `<a class="settings-account" href="account.html">${avatarHTML(src, { cls: 'settings-avatar' })}<span class="settings-nick">${nick ? _esc(nick) : t('Account')}</span><span class="settings-go">›</span></a>`;
}

function _renderSettingsAccount() {
  const row = document.getElementById('settingsAccount');
  if (row) row.innerHTML = _settingsAccountHTML();
}

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
      <span class="settings-lbl">${t('Account')}</span>
      <div id="settingsAccount">${_settingsAccountHTML()}</div>
    </div>
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

// Returns whether the panel was open.
function _closeSettings() {
  const panel = document.getElementById('settingsPanel');
  if (!panel || !panel.classList.contains('open')) return false;
  panel.classList.remove('open');
  document.getElementById('settingsBtn')?.setAttribute('aria-expanded', 'false');
  return true;
}
document.addEventListener('click', e => {
  if (!e.target.closest('#settingsPanel, #settingsBtn')) _closeSettings();
});

// Paint the nav immediately, the cached avatar for a returning user, else the
// sign-in button, before the async session check, so nothing flickers in.
_updateAuthUI();

// ── KEYBOARD ─────────────────────────────────────────────────────────────────
// Single-key shortcuts, the same in both languages: a letter per page, 1 2 for
// the language, [ ] \ for the theme, ; ' for the text size, / for the page's
// search box, ? for the list of them all, and Escape to close what's on top.
// Keys typed in a field are left alone, so phones (whose only keyboard is the
// on-screen one, in a field) never trigger them; Cmd / Ctrl combinations stay
// the browser's; media keys (headphones, clickers: the live game's controls,
// new-game-audio.js) aren't characters, so they never match. The match is on
// the character typed, so it follows the keyboard layout.

// In the help list: Home, Tutorial and F.A.Q. on top, then (after a gap) the
// pages in the nav's order; Account is listed with the settings, as in the
// avatar menu.
const _KBD_PAGES = [
  ['h', 'index.html',       'Home'],
  ['!', 'tutorial.html',    'Tutorial'],
  ['f', 'faq.html',         'F.A.Q.', { gapAfter: true }],
  ['n', 'new-game.html',    'New Game'],
  ['g', 'game-log.html',    'Game Log'],
  ['t', 'tournaments.html', 'Tournaments'],
  ['l', 'leaderboard.html', 'Leaderboard'],
  ['v', 'villains.html',    'Villains'],
  ['p', 'players.html',     'Players'],
  ['c', 'charts.html',      'Charts'],
  ['a', 'account.html',     'Account', { inSettings: true }],
];
// In the order of the settings panel: theme, text size, language.
const _KBD_SETTINGS = [
  ['[',  'Light theme', () => setTheme('light')],
  [']',  'Dark theme',  () => setTheme('dark')],
  ['\\', 'Auto theme',  () => setTheme('auto')],
  [';',  'Small text',  () => setTextSize('small')],
  ["'",  'Large text',  () => setTextSize('large')],
  ['1',  'English',     () => setLang('en')],
  ['2',  'Italiano',    () => setLang('it')],
];

function _withShortcut(title, key) { return `${title} (${key.toUpperCase()})`; }

function _isTextField(el) {
  return el instanceof Element && (el.isContentEditable || el.matches('input, textarea, select'));
}

// The bare page you're on does nothing; a page with a query (a villain, a
// player, an F.A.Q. topic) goes back to its main view.
function _goToPage(file) {
  const here = location.pathname.split('/').pop() || 'index.html';
  if (here === file && !location.search) return;
  if (file === 'account.html' && _authResolved && !_currentUser) {
    if (here !== 'sign-in.html') goToSignIn();
    return;
  }
  // Closed first, so going Back to this page doesn't show them still open.
  _toggleKbdHelp(false);
  _closeSettings();
  location.href = file;
}

// The search box in the page header (Game Log, Villains, Players, F.A.Q.),
// when it's there and ready.
function _pageSearchBox() {
  const input = document.querySelector('.page-header .cs-search input');
  return input && !input.disabled && input.offsetParent ? input : null;
}

function _kbdHelpOpen() {
  return !!document.getElementById('kbdHelp')?.classList.contains('open');
}

// The list of shortcuts: the "Tap to continue" look (New Game), on top of the
// page; a click anywhere closes it. Settings keys work under it, to try them.
function _toggleKbdHelp(open = !_kbdHelpOpen()) {
  let el = document.getElementById('kbdHelp');
  if (!open) { el?.classList.remove('open'); return; }
  if (!el) {
    const row = (key, label, gap) => `<div class="kbd-help-row${gap ? ' gap-after' : ''}"><kbd>${_esc(key)}</kbd><span>${_esc(label)}</span></div>`;
    const group = (title, rows, note = '') =>
      `<section class="kbd-help-group"><div class="kbd-help-lbl">${_esc(title)}</div>${rows.map(r => row(...r)).join('')}${note ? `<p class="kbd-help-note">${_esc(note)}</p>` : ''}</section>`;
    el = document.createElement('div');
    el.id = 'kbdHelp';
    el.className = 'kbd-help';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', t('Keyboard shortcuts'));
    el.innerHTML = `
      <div class="kbd-help-card">
        <div class="kbd-help-ico">⌨️</div>
        <div class="kbd-help-title">${_esc(t('Keyboard shortcuts'))}</div>
        <div class="kbd-help-groups">
          ${group(t('Pages'), _KBD_PAGES.filter(p => !p[3]?.inSettings).map(([k, , label, o]) => [k.toUpperCase(), t(label), o?.gapAfter]))}
          ${group(t('Settings'), [..._KBD_PAGES.filter(p => p[3]?.inSettings).map(([k, , label]) => [k.toUpperCase(), t(label)]), ..._KBD_SETTINGS.map(([k, label]) => [k, t(label)])])}
          ${group(t('Other'), [['/', t('Search box')], ['?', t('This list')], ['Esc', t('Close pop-up, or leave text field')]])}
          ${group(t('During a game'), [['⏯︎', t('Pause or resume the timer')], ['⏮︎', t('Previous round')], ['⏭︎', t('Next round')]],
                  t('Media keys, headphones and Bluetooth clickers, on New Game.'))}
        </div>
        <p class="kbd-help-text">${_esc(t('Click anywhere or press Esc to close.'))}</p>
      </div>`;
    el.addEventListener('click', () => _toggleKbdHelp(false));
    document.body.appendChild(el);
  }
  el.classList.add('open');
}

// Escape closes one thing, the topmost: this list, the avatar zoom, a sheet
// (as dragging it down does, ui.js), the settings panel. With nothing open it
// leaves the text field, so the shortcuts work again.
function _escape() {
  if (_kbdHelpOpen()) { _toggleKbdHelp(false); return true; }
  if (document.querySelector('.avatar-lightbox.open')) { closeAvatarLightbox(); return true; }
  const sheets = document.querySelectorAll('.overlay.open');
  const sheet = sheets[sheets.length - 1];
  if (sheet) return !sheet.classList.contains('no-drag') && _closeSheetByDrag(sheet);
  if (_closeSettings()) return true;
  const el = document.activeElement;
  if (_isTextField(el)) { el.blur(); return true; }
  return false;
}

function _kbdAction(key) {
  const page = _KBD_PAGES.find(([k]) => k === key);
  if (page) return () => _goToPage(page[1]);
  const setting = _KBD_SETTINGS.find(([k]) => k === key);
  if (setting) return setting[2];
  if (key === '?') return () => _toggleKbdHelp();
  if (key === '/') {
    // Only where there's a search box, so elsewhere / stays the browser's
    // (Firefox's quick find).
    const input = _pageSearchBox();
    return input && (() => { _toggleKbdHelp(false); input.focus(); input.select(); });
  }
  return null;
}

document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing) return;
  if (e.key === 'Escape') { if (_escape()) e.preventDefault(); return; }
  if (e.repeat || e.metaKey || (e.ctrlKey && !e.getModifierState('AltGraph'))) return;
  if (e.key.length !== 1 || _isTextField(e.target)) return;
  // An open pop-up keeps the keyboard: Escape closes it first.
  if (document.querySelector('.overlay.open, .avatar-lightbox.open')) return;
  // Alt + a letter or digit is the browser's menus (Windows) or a special
  // character (Mac); Alt / AltGr with a symbol is how some layouts type [ ] \.
  const alnum = /^[a-z0-9]$/i.test(e.key);
  if (alnum && e.altKey) return;
  const action = _kbdAction(alnum ? e.key.toLowerCase() : e.key);
  if (!action) return;
  e.preventDefault();
  action();
});

// The nav icons' tooltips name their key ("New Game (N)"), once applyI18n
// (lang.js, on DOMContentLoaded too but registered earlier) has translated them.
document.addEventListener('DOMContentLoaded', () => {
  for (const [key, file] of _KBD_PAGES) {
    document.querySelectorAll(`.nav-links a[href="${file}"]`).forEach(a => {
      a.title = _withShortcut(a.title, key);
      a.setAttribute('aria-keyshortcuts', key.toUpperCase());
    });
  }
});

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

    // Your seats follow the new nickname by themselves (a database trigger).
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
