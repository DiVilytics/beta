// ── STATE ─────────────────────────────────────────────────────────────────────

let chars            = [];
let boxInfo          = {};          // loadBoxInfo(), used to order box groups by release date
let orderSlots       = [];          // each: { id, char, isMe, isWinner }
let orderNextId      = 0;
let slotTimers       = {};          // slotId → setInterval id (active spin animation)
let _shuffleTimer    = null;        // setInterval id for the shuffle-order animation
let _lastAuthId;                    // last auth user id the slots were rendered for (undefined = not baselined)

// Live-game timers stay here because they tick the DOM directly. All other
// "live game" state (start time, turns, exact duration, hasSession, hooks,
// persistence) lives in the shared `liveGame` module.
let liveTimerId     = null;        // 1s clock ticker
let _saveIntervalId = null;        // 30s background-persist

// Same order as the row buttons: row actions (draw, remove), then player marks
// (you, winner), so 👑, the last tap of a game, sits at the edge away from ❌.
const LEGEND_ITEMS = [t('🎲 = draw'), t('❌ = remove'), t('👤 = you'), t('👑 = winner')];

// The draw-pool character filter (excluded set + pace + My-boxes) lives in the
// shared pace-filter controller; `pace.excluded` is the single source of truth.
const pace = createPaceFilter({
  getChars:     () => chars,
  gridId:       'excludeGrid',
  paceColorsId: 'paceColors',
  paceModeId:   'paceMode',
  mineBtnId:    'ownedOnlyBtn',
  mineTitles: {
    signIn:  t('Sign in to filter by owned boxes'),
    noBoxes: t('Mark which boxes you own on the account page first'),
    on:      t('Pool limited to your boxes'),
    off:     t('Limit the pool to your boxes'),
  },
  onChange: () => { updateExcludeUI(); _updateActionBtns(); },
  onError:  showErr,
});

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('new-game.html');

  // Build the default layout synchronously, the date and the two starter rows,
  // BEFORE the network awaits, so the form doesn't render empty (0 rows, no date,
  // "Add player" at the top) and then visibly fill in / shift once JS finishes.
  // The character <select> options fill in once chars load (no visible change);
  // a saved draft, if any, replaces these rows further down.
  _setDateToNow();
  _markFresh();
  orderSlots = [
    { id: orderNextId++, char: '', isMe: false, isWinner: false },
    { id: orderNextId++, char: '', isMe: false, isWinner: false },
  ];
  renderOrderSlots();
  _initLegend();   // before the network awaits too: until it runs, the legend wraps 3 + 1
  for (const id of ['fDate', 'fLocation', 'fDur', 'fTurns']) {
    for (const ev of ['input', 'change', 'blur']) document.getElementById(id)?.addEventListener(ev, () => { _updateDiscardBtn(); _saveDraft(); });
  }
  _checkResume();   // a game in progress shows right away, not after an empty form

  // Re-render slots whenever auth state changes so the Me-locked indicator
  // updates in-place after sign-in / sign-out.
  await initAuth(async () => {
    await pace.loadOwnedBoxes();
    pace.updatePaceUI();
    // Re-render slots only on a genuine sign-in/out (auth id change), not on the
    // initial auth event or token refreshes, those are redundant here.
    const uid = getCurrentUser()?.id || null;
    const changed = _lastAuthId !== undefined && _lastAuthId !== uid;
    _lastAuthId = uid;
    if (changed && orderSlots.length) renderOrderSlots();
  });
  // Baseline the auth id (unless the initial auth event already did) so that
  // first event counts as "no change".
  if (_lastAuthId === undefined) _lastAuthId = getCurrentUser()?.id || null;
  [chars, boxInfo] = await Promise.all([loadCharacters(), loadBoxInfo()]);
  await pace.loadOwnedBoxes();
  buildExcludeGrid(
    document.getElementById('excludeGrid'),
    chars,
    pace.excluded,
    updateExcludeUI,
    boxInfo
  );
  onBeforeSignIn(_saveDraft);
  const poolRestored = _restoreDraft();
  // Re-render now that chars are loaded (fills the selects), auth is resolved and
  // any draft is back, then start saving it.
  renderOrderSlots();
  _draftReady = true;   // from now on every change is saved (not this load: the hour counts from the last change)
  if (!poolRestored) pace.defaultToMine();   // boxes marked on the Account page: draw from those
  pace.updatePaceUI();
  updateExcludeUI();   // show the pool size from the start
  _initDrag();
  attachLocationAutocomplete('fLocation', 'fLocationDropdown');
}

// ── DRAFT ─────────────────────────────────────────────────────────────────────
// The form (players, villains, 👤 / 👑, date and details) and the draw pool are
// kept in localStorage as you edit, so leaving the page, switching apps or a
// sign-in round-trip don't lose them. The draft expires an hour after the last
// change; Discard and saving the game clear it, pool included. A fresh pool is
// every villain, or only your boxes when you've marked some on the Account page
// (the one lasting way to shape it). An untouched date isn't kept: it comes back
// as "now". A game in progress has its own snapshot (liveGame) and wins over it.
const DRAFT_KEY    = 'divilytics_new_game_draft';
const DRAFT_MAX_MS = 60 * 60 * 1000;
let _draftReady = false;   // nothing is saved until init has restored (or not) the draft

// Saves the draft, or drops it when the page is back to a fresh one (nothing to keep).
function _saveDraft() {
  if (!_draftReady) return;
  if (!_isFormChanged()) { _dropDraft(); return; }
  const val = id => document.getElementById(id)?.value || '';
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      saved:     Date.now(),
      slots:     orderSlots.map(s => ({ char: s.char, isMe: s.isMe, isWinner: s.isWinner })),
      fDate:     val('fDate') !== _freshDate ? val('fDate') : '',
      fLocation: val('fLocation'),
      fDur:      val('fDur'),
      fTurns:    val('fTurns'),
      pool:      { excluded: [...pace.excluded], selectedPace: pace.selectedPace, pacePlus: pace.pacePlus, mineOn: pace.mineOn },
    }));
  } catch (_) {}
}

function _dropDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
}

function _loadDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (_) {}
  if (d && !(Date.now() - d.saved <= DRAFT_MAX_MS)) {
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
    return null;
  }
  return d;
}

// Puts a saved draft back on the page. Returns true when it restored a pool, so
// the My boxes default isn't applied over the user's own choice.
function _restoreDraft() {
  if (liveGame.loadSaved()) return false;   // the resume banner handles a game in progress
  const d = _loadDraft();
  if (!d) return false;
  if (d.slots && d.slots.length >= 2) {
    orderSlots = d.slots.map(s => ({ id: orderNextId++, char: s.char || '', isMe: !!s.isMe, isWinner: !!s.isWinner }));
    if (d.fDate) document.getElementById('fDate').value = d.fDate;
    document.getElementById('fLocation').value = d.fLocation || '';
    document.getElementById('fDur').value      = d.fDur      || '';
    document.getElementById('fTurns').value    = d.fTurns    || '';
  }
  if (!d.pool) return false;
  pace.restoreState(d.pool);
  return true;
}

function _setDateToNow() {
  const now = new Date();
  now.setSeconds(0, 0);
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  document.getElementById('fDate').value = now.toISOString().slice(0, 16);
}

// ── EXCLUDE CONTROLS ─────────────────────────────────────────────────────────

function toggleExclude() {
  const body   = document.getElementById('excludeBody');
  const chevron = document.getElementById('exChevron');
  const open   = body.classList.toggle('open');
  chevron.classList.toggle('open', open);
}

function updateExcludeUI() {
  const badge = document.getElementById('exBadge');
  if (!badge) return;
  badge.textContent = chars.length - pace.excluded.size;   // pool size: starts full, shrinks as you exclude
  badge.classList.add('visible');
  badge.classList.toggle('full', !pace.excluded.size);
  _updateDiscardBtn();
  _saveDraft();
}

// Bulk pool controls (wired to the filter toolbar) delegate to the shared
// pace-filter controller.
function excludeAll()    { pace.excludeAll(); }
function clearExcluded() { pace.clearExcluded(); }

function applyExclude() {
  const body = document.getElementById('excludeBody');
  const chevron = document.getElementById('exChevron');
  body.classList.remove('open');
  chevron.classList.remove('open');
}

// ── PACE / MINE SELECTION ─────────────────────────────────────────────────────
// Pace is a single-select *inclusion* filter: clicking a color RESETS the pool
// to that color's characters (or the color plus its neighbors when Pace+ is
// on), it is not additive. "Mine" is a sticky toggle that further limits the
// pool to your boxes, and every reset takes it into account. The per-character
// pills below let you fine-tune on top after a reset. All of this lives in the
// shared pace-filter controller; these are just the toolbar's onclick targets.

function selectPace(color) { pace.selectPace(color); }
function setPaceMode(plus) { pace.setPaceMode(plus); }
function toggleMine()      { pace.toggleMine(); }

// ── PLAYERS LEGEND LAYOUT ─────────────────────────────────────────────────────
// Lay the legend out in balanced rows: keep it on one line if it fits, otherwise
// split it in half, and recurse on each half, so rows stay even ("2 + 2", never
// "3 + 1"), and the " | " separators only ever sit between items on a row.
let _legendResizeId = null;

function _layoutLegend() {
  const host = document.getElementById('playersLegend');
  if (host) layoutSeparatedRows(host, LEGEND_ITEMS);   // hidden (live game): keeps the current markup
}

// Lays out the legend now, again once the web font is in (a first pass may
// measure the fallback font), and whenever the legend's width changes (window
// resize, rotation, a browser that settles sizes after load).
function _initLegend() {
  _layoutLegend();
  document.fonts?.ready.then(_layoutLegend);
  const legend = document.getElementById('playersLegend');
  if (legend && window.ResizeObserver) {
    let lastW = 0;
    new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (w && w !== lastW) { lastW = w; _layoutLegend(); }
    }).observe(legend);
  }
  // Window resizes, and the Text size setting (same width, bigger text).
  window.addEventListener('resize', _onLegendResize);
}

function _onLegendResize() {
  clearTimeout(_legendResizeId);
  _legendResizeId = setTimeout(_layoutLegend, 150);
}

// ── SLOT MANAGEMENT ──────────────────────────────────────────────────────────

function addOrderSlot(char = '', isMe = false, isWinner = false) {
  if (orderSlots.length >= 6) return;
  orderSlots.push({ id: orderNextId++, char, isMe, isWinner });
  renderOrderSlots();
  _saveLiveState();
}

function setPlayerCount(n) {
  n = Math.max(2, Math.min(6, parseInt(n) || 2));
  while (orderSlots.length < n) orderSlots.push({ id: orderNextId++, char: '', isMe: false, isWinner: false });
  while (orderSlots.length > n) {
    const last = orderSlots[orderSlots.length - 1];
    if (slotTimers[last.id]) { clearInterval(slotTimers[last.id]); delete slotTimers[last.id]; }
    orderSlots.pop();
  }
  renderOrderSlots();
  _saveLiveState();
}

function removeOrderSlot(id) {
  if (orderSlots.length <= 2) return;
  if (slotTimers[id]) { clearInterval(slotTimers[id]); delete slotTimers[id]; }
  orderSlots = orderSlots.filter(s => s.id !== id);
  renderOrderSlots();
  _saveLiveState();
}

function toggleMe(id) {
  if (!getCurrentUser()) {
    showErr(t('Sign in first to mark your villain.'));
    return;
  }
  for (const s of orderSlots) s.isMe = (s.id === id ? !s.isMe : false);
  renderOrderSlots();
  _saveLiveState();
}

function toggleWin(id) {
  for (const s of orderSlots) s.isWinner = (s.id === id ? !s.isWinner : false);
  renderOrderSlots();
  _saveLiveState();
}

function updateOrderSlot(id, char) {
  const slot = orderSlots.find(s => s.id === id);
  if (!slot) return;
  slot.char = char;
  renderOrderSlots();
  _saveLiveState();
}

// Pool of characters available for slot `excludeId` to draw from.
function _slotPool(excludeId) {
  const taken = new Set(orderSlots.filter(o => o.id !== excludeId && o.char).map(o => o.char));
  return chars.filter(c => !pace.excluded.has(c.name) && !taken.has(c.name));
}

// Stop an in-flight shuffle animation and settle the DOM to the final order.
function _cancelShuffle() {
  if (!_shuffleTimer) return;
  clearInterval(_shuffleTimer);
  _shuffleTimer = null;
  renderOrderSlots();
}

function drawSlot(id) {
  _cancelShuffle();
  const slot = orderSlots.find(s => s.id === id);
  if (!slot) return;

  const pool = _slotPool(id);
  if (!pool.length) return;

  if (slotTimers[id]) { clearInterval(slotTimers[id]); delete slotTimers[id]; }

  const slotEl     = document.querySelector(`.order-slot[data-id="${id}"]`);
  const portraitEl = slotEl?.querySelector('.order-slot-portrait');
  const nameEl     = slotEl?.querySelector('.order-slot-name');
  if (!portraitEl) return;

  slotEl.classList.add('spinning');

  let ticks = 0;
  const total = 20;   // 20 ticks × 50ms = 1s per slot

  slotTimers[id] = setInterval(() => {
    const pick = pool[Math.floor(Math.random() * pool.length)];
    portraitEl.src = charImgSrc(pick.name);
    if (nameEl) nameEl.textContent = villainName(pick.name);
    ticks++;

    if (ticks >= total) {
      clearInterval(slotTimers[id]);
      delete slotTimers[id];

      // Land this slot IN PLACE, set its character and drop only its own
      // highlight. We deliberately don't re-render the whole list here, so the
      // other slots keep spinning and each clears its highlight as it lands
      // (sequentially, in the same order they started).
      const finalPool = _slotPool(id);
      if (finalPool.length) {
        const final = finalPool[Math.floor(Math.random() * finalPool.length)];
        slot.char = final.name;
        portraitEl.src = charImgSrc(final.name);
        if (nameEl) nameEl.textContent = villainName(final.name);
      }
      slotEl.classList.remove('spinning');
      _saveLiveState();

      // Once the whole draw has settled, re-render once to refresh the selects
      // and re-enable the buttons (nothing is spinning by then, so no flash).
      if (Object.keys(slotTimers).length === 0) renderOrderSlots();
      else _updateActionBtns();
    }
  }, 50);

  _updateActionBtns();   // freeze the draw/shuffle/start buttons while spinning
}

// Draw villains: clear every slot, then draw each one in turn.
// The draw button adapts to the lineup: every row empty → "Draw villains";
// some empty → "Draw the rest" (keeps the villains already chosen); every row
// filled → "Redraw all". Disabled when the draw pool can't cover it.
function _drawMode() {
  const empty = orderSlots.filter(s => !s.char).length;
  return empty === orderSlots.length ? 'all' : empty ? 'rest' : 'redraw';
}

// Pool villains not yet in the lineup (manual picks outside the pool don't use it up).
function _freePool() {
  const taken = new Set(orderSlots.map(s => s.char).filter(Boolean));
  return chars.filter(c => !pace.excluded.has(c.name) && !taken.has(c.name));
}

function _canDrawAll() {
  const mode = _drawMode();
  if (mode === 'rest') return _freePool().length >= orderSlots.filter(s => !s.char).length;
  return chars.filter(c => !pace.excluded.has(c.name)).length >= orderSlots.length;
}

function drawAll() {
  if (!_canDrawAll()) return;
  _cancelShuffle();
  for (const id of Object.keys(slotTimers)) { clearInterval(slotTimers[id]); }
  slotTimers = {};
  const mode = _drawMode();
  if (mode !== 'rest') for (const s of orderSlots) s.char = '';
  const targets = mode === 'rest' ? orderSlots.filter(s => !s.char) : orderSlots;
  renderOrderSlots();
  targets.forEach((s, i) => setTimeout(() => drawSlot(s.id), i * 60));
}

function shuffleOrder() {
  // Stop any in-flight animations.
  if (_shuffleTimer) { clearInterval(_shuffleTimer); _shuffleTimer = null; }
  for (const id of Object.keys(slotTimers)) { clearInterval(slotTimers[id]); }
  slotTimers = {};

  // Each player's position before this shuffle, so the spinning numbers ride
  // along with their player as the rows jumble.
  const origPos = new Map(orderSlots.map((s, i) => [s.id, i + 1]));

  // Decide the final shuffled order up front (uniform Fisher–Yates).
  for (let i = orderSlots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [orderSlots[i], orderSlots[j]] = [orderSlots[j], orderSlots[i]];
  }

  const container = document.getElementById('orderSlots');
  const slotEls   = container ? [...container.querySelectorAll('.order-slot')] : [];
  if (slotEls.length !== orderSlots.length) {
    // No DOM to animate, just render the result.
    renderOrderSlots();
    _saveLiveState();
    return;
  }

  // Slot-machine shuffle: every row flashes through random orderings, each frame
  // a fresh permutation, so it reads as a genuine all-over shuffle, with each
  // character carrying its previous number, then settles on the real result
  // (numbers back in ascending order). Blue .spinning highlight throughout. Same
  // total length as the draw, but fewer, longer-held frames so it feels slower.
  slotEls.forEach(el => el.classList.add('spinning'));

  const FRAME_MS = 100;                         // longer hold per frame than the draw's 50ms
  const total    = Math.round(1000 / FRAME_MS); // 1s total, same as the draw, fewer frames
  let ticks = 0;
  _shuffleTimer = setInterval(() => {
    ticks++;
    if (ticks >= total) {
      clearInterval(_shuffleTimer);
      _shuffleTimer = null;
      renderOrderSlots();   // settle: final order, ascending numbers
      _saveLiveState();
      return;
    }
    const perm = [...orderSlots];
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    slotEls.forEach((el, idx) => {
      const s        = perm[idx];
      const portrait = el.querySelector('.order-slot-portrait');
      const nameEl   = el.querySelector('.order-slot-name');
      const numEl    = el.querySelector('.row-num');
      if (portrait) portrait.src = s.char ? charImgSrc(s.char) : 'asset/players/default.svg';
      if (nameEl)   nameEl.textContent = s.char ? villainName(s.char) : t('Select villain');
      if (numEl)    numEl.textContent = origPos.get(s.id) + '.';
    });
  }, FRAME_MS);

  _updateActionBtns();   // freeze the draw/shuffle/start buttons while spinning
}

function renderOrderSlots() {
  const container = document.getElementById('orderSlots');

  // Only a row with a villain can be the winner: a row that lost its villain
  // (cleared, redrawn) loses the crown too.
  for (const s of orderSlots) if (!s.char) s.isWinner = false;

  // Use the cached/likely sign-in status so the "Me" lock paints correctly on
  // the first synchronous render (before the session check resolves). It self-
  // corrects on the post-auth re-render if the cache turns out to be wrong.
  const isAuthed = isLikelySignedIn();
  container.innerHTML = orderSlots.map((s, i) => {
    const taken     = new Set(orderSlots.filter(o => o.id !== s.id && o.char).map(o => o.char));
    const available = chars.filter(c => !taken.has(c.name));
    const src       = s.char ? charImgSrc(s.char) : 'asset/players/default.svg';
    const nameTxt   = s.char ? _esc(villainName(s.char)) : `<span class="order-slot-empty">${t('Select villain')}</span>`;
    const meTitle   = isAuthed ? t('My villain') : t('Sign in to mark your villain');
    return `
      <div class="order-slot" data-id="${s.id}">
        <div class="drag-handle">
          <span class="drag-dots">⠿</span><span class="row-num">${i + 1}.</span>
          <img class="order-slot-portrait" src="${src}" onerror="this.src='asset/players/default.svg'" alt="">
        </div>
        <div class="order-slot-info">
          <select class="order-slot-select" onchange="updateOrderSlot(${s.id}, this.value)" title="${t('Pick manually')}">
            ${charSelectHTML(available, s.char, boxInfo)}
          </select>
          <div class="order-slot-name">${nameTxt}</div>
          <span class="order-slot-chevron" aria-hidden="true">▾</span>
        </div>
        <div class="order-slot-actions">
          <button class="pf-btn rand" onclick="drawSlot(${s.id})" title="${t('Draw')}">🎲</button>
          <button class="pf-btn del" onclick="removeOrderSlot(${s.id})" ${orderSlots.length > 2 ? `title="${t('Remove')}"` : `title="${t('A game needs at least 2 players')}" disabled`}>❌</button>
          <button class="pf-btn me${s.isMe ? ' on' : ''}${isAuthed ? '' : ' locked'}" onclick="toggleMe(${s.id})" ${s.char ? `title="${meTitle}"` : `title="${t('Pick a villain first')}" disabled`}>👤</button>
          <button class="pf-btn win${s.isWinner ? ' on' : ''}" onclick="toggleWin(${s.id})" ${s.char ? `title="${t('Winner')}"` : `title="${t('Pick a villain first')}" disabled`}>👑</button>
        </div>
      </div>`;
  }).join('');

  setVisible('orderAddBtn', orderSlots.length < 6);
  const pcSel = document.getElementById('playerCountSel');
  if (pcSel) pcSel.value = String(orderSlots.length);
  _updateActionBtns();
  _updateDiscardBtn();
}

function _updateActionBtns() {
  // While a draw or shuffle is animating, hold the draw/shuffle/start/save
  // buttons disabled, so they don't flicker as slots fill in one by one, and
  // can't be re-triggered mid-animation. They're recomputed once it settles.
  const animating = !!_shuffleTimer || Object.keys(slotTimers).length > 0;

  const filled     = orderSlots.filter(s => s.char).length;

  const drawAllBtn      = document.getElementById('drawAllBtn');
  const shuffleBtn      = document.getElementById('shuffleOrderBtn');
  const startBtn        = document.getElementById('startBtn');
  const submitBtn       = document.getElementById('submitBtn');

  // Mid-draw the lineup is half filled: keep the label and every 🎲 as they
  // were, all disabled, and recompute once the draw has settled.
  if (animating) {
    if (drawAllBtn) drawAllBtn.disabled = true;
    document.querySelectorAll('.order-slot .pf-btn.rand').forEach(b => { b.disabled = true; });
  } else if (drawAllBtn) {
    const label = { all: t('Draw villains'), rest: t('Draw the rest'), redraw: t('Redraw all villains') }[_drawMode()];
    const can   = !chars.length || _canDrawAll();   // chars still loading: don't flash it disabled
    if (drawAllBtn.textContent !== label) drawAllBtn.textContent = label;
    drawAllBtn.disabled = animating || !can;
    drawAllBtn.title    = can ? label : t('Not enough villains in the draw pool');
  }
  // A row's 🎲: off when the pool has nothing it could draw (other than its own villain).
  if (chars.length && !animating) for (const s of orderSlots) {
    const btn = document.querySelector(`.order-slot[data-id="${s.id}"] .pf-btn.rand`);
    if (!btn) continue;
    const can = _slotPool(s.id).some(c => c.name !== s.char);
    btn.disabled = !can;
    btn.title    = can ? t('Draw') : t('No villains left in the draw pool');
  }
  if (shuffleBtn) {
    shuffleBtn.disabled = animating || filled < 2;
    shuffleBtn.title    = filled < 2 && !animating ? t('Pick at least 2 villains first') : t('Random order');
  }
  // Start lights up once the lineup is complete, every player has a different
  // character and "me" is marked. Save additionally needs the winner marked.
  // Until then they gray out (with the reason as a tooltip). Date/sign-in are
  // still validated in the handlers.
  const lineupErr = _validateLineup();                     // null = ready to start
  const hasWinner = orderSlots.some(s => s.isWinner);
  const saveErr   = lineupErr || (hasWinner ? null : t('Mark the winner with 👑.'));
  if (startBtn)  { startBtn.disabled  = animating || !!lineupErr; startBtn.title  = animating ? '' : (lineupErr || ''); }
  if (submitBtn) { submitBtn.disabled = animating || !!saveErr;   submitBtn.title = animating ? '' : (saveErr   || ''); }
}

// ── DRAG TO REORDER ───────────────────────────────────────────────────────────

let _dragSrc = null;

function _initDrag() {
  const container = document.getElementById('orderSlots');

  function _endDrag() {
    if (!_dragSrc) return;
    _dragSrc.classList.remove('dragging');
    _dragSrc = null;
    document.body.style.touchAction = '';
    // Sync orderSlots state to the new DOM order
    const newOrder = [...container.querySelectorAll('.order-slot')]
      .map(el => Number(el.dataset.id));
    orderSlots.sort((a, b) => newOrder.indexOf(a.id) - newOrder.indexOf(b.id));
    renderOrderSlots();
    _saveLiveState();
  }

  container.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    e.preventDefault();
    _dragSrc = handle.closest('.order-slot');
    _dragSrc.classList.add('dragging');
    document.body.style.touchAction = 'none';
    container.setPointerCapture(e.pointerId);
  });

  container.addEventListener('pointermove', e => {
    if (!_dragSrc) return;
    _dragSrc.style.visibility = 'hidden';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    _dragSrc.style.visibility = '';
    if (!el) return;
    const row = el.closest('.order-slot');
    if (!row || row === _dragSrc) return;
    const rect = row.getBoundingClientRect();
    container.insertBefore(_dragSrc, e.clientY < rect.top + rect.height / 2 ? row : row.nextSibling);
  });

  container.addEventListener('pointerup',     _endDrag);
  container.addEventListener('pointercancel', _endDrag);
}

// ── LIVE GAME ─────────────────────────────────────────────────────────────────

// The line under "Game in progress": player count and, when set, the location.
// Drawn on start and on resume (the form fields are hidden while live).
function _renderLiveInfo() {
  const infoEl   = document.getElementById('liveInfo');
  const location = document.getElementById('fLocation').value.trim();
  if (infoEl) infoEl.textContent = [tn(orderSlots.length, '{n} player', '{n} players'), location ? t('Playing at {location}', { location }) : null].filter(Boolean).join(' | ');
}

function setLiveUI(on) {
  setVisible('formContent',   !on);
  setVisible('liveContent',    on);
  setVisible('footerDefault', !on);
  setVisible('footerLive',     on);
}

function fmtElapsed(ms) {
  const s   = Math.max(0, Math.floor(ms / 1000));
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function tickLive() {
  if (!liveGame.isRunning) return;
  document.getElementById('liveTime').textContent = fmtElapsed(liveGame.elapsedMs);
}

function bumpTurn(delta) {
  liveGame.bumpTurns(delta);
  document.getElementById('liveTurnCount').textContent = liveGame.turns;
  if (!liveTimerId) {
    const fTurns = document.getElementById('fTurns');
    if (fTurns) fTurns.value = liveGame.turns || '';
  }
  _saveLiveState();
}

function showErr(msg) {
  showError('err', msg, { scroll: true });
}

function _validateLineup() {
  if (orderSlots.length < 2) return t('A game must have at least 2 players.');
  if (orderSlots.some(s => !s.char)) return t('Choose a villain for each player.');
  const names = orderSlots.map(s => s.char);
  if (new Set(names).size !== names.length) return t('Each player must use a different villain.');
  if (!orderSlots.some(s => s.isMe)) return t('Mark your villain with 👤.');
  return null;
}

function startLive() {
  clearError('err');
  const err = _validateLineup();
  if (err) return showErr(err);

  const fDurEl    = document.getElementById('fDur');
  const durOffset = liveGame.exactDurMs ?? (parseInt(fDurEl.value) || 0) * 60000;
  const resuming  = liveGame.hasSession;   // a paused game: keep the date it started on
  liveGame.markStarted(Date.now() - durOffset);

  if (!resuming) _setDateToNow();

  liveGame.setTurns(parseInt(document.getElementById('fTurns').value) || 0);
  document.getElementById('liveTurnCount').textContent = liveGame.turns;

  _renderLiveInfo();
  setLiveUI(true);
  tickLive();
  liveTimerId = setInterval(tickLive, 1000);
  _updateDiscardBtn();
  liveGame.emit('start');
  _saveLiveState();
  if (!_saveIntervalId) _saveIntervalId = setInterval(_saveLiveState, 30000);
}

function stopLive() {
  if (!liveGame.isRunning) return;
  clearInterval(liveTimerId);
  liveTimerId = null;

  const ms = liveGame.elapsedMs;
  document.getElementById('fDur').value = Math.max(1, Math.round(ms / 60000));
  if (liveGame.turns > 0) document.getElementById('fTurns').value = liveGame.turns;
  liveGame.markStopped(ms);

  setLiveUI(false);
  const sb = document.getElementById('startBtn');
  sb.textContent = t('Resume game');   // stays purple (btn-primary)
  _updateDiscardBtn();
  liveGame.emit('stop');
  _saveLiveState();
}

// ── LIVE STATE PERSISTENCE ────────────────────────────────────────────────────

function _saveLiveState() {
  liveGame.persist({
    slots:     orderSlots,
    fDate:     document.getElementById('fDate')?.value     || '',
    fLocation: document.getElementById('fLocation')?.value || '',
    fDur:      document.getElementById('fDur')?.value      || '',
    fTurns:    document.getElementById('fTurns')?.value    || '',
  });
  _saveDraft();
  updateLiveGameNavBadge();
}

function _clearLiveState() {
  liveGame.clear();
  if (_saveIntervalId) { clearInterval(_saveIntervalId); _saveIntervalId = null; }
  _updateDiscardBtn();
  updateLiveGameNavBadge();
}

// The date a fresh page shows (set on load and after a discard), so editing it
// counts as a change.
let _freshDate = '';
function _markFresh() { _freshDate = document.getElementById('fDate')?.value || ''; }

// True when the page differs from a fresh load: player count, villains, 👤 / 👑
// marks, date, location, duration, rounds, or a draw pool other than the
// default (every villain, or your boxes).
function _isFormChanged() {
  const val = id => document.getElementById(id)?.value || '';
  return orderSlots.length !== 2
      || orderSlots.some(s => s.char || s.isMe || s.isWinner)
      || val('fDate') !== _freshDate
      || !!(val('fLocation') || val('fDur') || val('fTurns'))
      || !pace.isDefault();
}

// Discard is always there; it's enabled as soon as anything changed, or while a
// game session exists.
function _updateDiscardBtn() {
  const btn = document.getElementById('discardBtn');
  if (btn) btn.disabled = !(liveGame.hasSession || _isFormChanged());
}

// The Discard button asks with the app
// confirm sheet: the browser's native confirm() is suppressed (auto-cancelled)
// in some in-app browsers and installed web apps.
function _confirmDiscard(onConfirm) {
  openConfirmSheet({
    id:           'discardGameOverlay',
    title:        t('Discard this game?'),
    bodyHTML:     `<p class="confirm-text">${t('This resets the form (villains, players, details and draw pool) and clears any saved progress.')}</p>`,
    confirmLabel: t('Discard'),
    danger:       true,
    onConfirm,
  });
}

function discardLiveGame() { _confirmDiscard(_doDiscard); }

function _doDiscard() {

  if (liveTimerId) { clearInterval(liveTimerId); liveTimerId = null; }
  _clearLiveState();
  liveGame.emit('close');

  const sbD = document.getElementById('startBtn');
  sbD.textContent = t('Start game');   // stays purple (btn-primary)
  clearError('err');
  document.getElementById('fLocation').value = '';
  document.getElementById('fDur').value = '';
  document.getElementById('fTurns').value = '';
  _setDateToNow();

  for (const id of Object.keys(slotTimers)) { clearInterval(slotTimers[id]); }
  slotTimers = {};
  orderSlots = [];
  addOrderSlot();
  addOrderSlot();

  pace.reset();           // the pool goes back to the default too:
  pace.defaultToMine();   // every villain, or your boxes

  setLiveUI(false);
  _markFresh();
  _updateDiscardBtn();
  _saveDraft();           // nothing left to keep: drops the draft
}

// ── GAME IN PROGRESS ─────────────────────────────────────────────────────────
// There's at most one game. When one is saved (running or paused), landing on
// the page shows it straight away, the running timer included, and Start game
// reads Resume game. Starting another one takes Discard (or saving this one).

function _checkResume() {
  const state = liveGame.loadSaved();
  if (!state) {
    // Drop any stale (48h) or incomplete snapshot still sitting in storage.
    if (localStorage.getItem(liveGame.KEY)) liveGame.clear();
    return;
  }
  liveGame.restoreFrom(state);
  document.getElementById('startBtn').textContent = t('Resume game');   // stays purple (btn-primary)
  clearError('err');

  document.getElementById('fDate').value     = state.fDate     || '';
  document.getElementById('fLocation').value = state.fLocation || '';
  document.getElementById('fDur').value      = state.fDur      || '';
  document.getElementById('fTurns').value    = state.fTurns    || '';

  orderSlots = (state.slots || []).map(s => ({
    id:       orderNextId++,
    char:     s.char || '',
    isMe:     !!s.isMe,
    isWinner: !!s.isWinner,
  }));
  renderOrderSlots();

  if (state.liveStart) {
    document.getElementById('liveTurnCount').textContent = liveGame.turns;
    _renderLiveInfo();
    setLiveUI(true);
    tickLive();
    liveTimerId = setInterval(tickLive, 1000);
    // Once every script is in: new-game-audio.js (lock-screen controls) loads after this one.
    const start = () => liveGame.emit('start');
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    _saveLiveState();
    if (!_saveIntervalId) _saveIntervalId = setInterval(_saveLiveState, 30000);
  }
  _updateDiscardBtn();
}

// ── SUBMIT (Save game) ────────────────────────────────────────────────────────

async function submitForm() {
  clearError('err');

  const date     = document.getElementById('fDate').value;
  const dur      = parseInt(document.getElementById('fDur').value)   || null;
  const turns    = parseInt(document.getElementById('fTurns').value) || null;
  const location = document.getElementById('fLocation').value.trim() || null;
  const btn      = document.getElementById('submitBtn');

  if (!date) return showErr(t('Date and time is required.'));
  if (new Date(date) > new Date()) return showErr(t('Date cannot be in the future.'));

  const user    = getCurrentUser();
  const profile = getCurrentProfile();
  if (!user)    return showErr(t('Sign in to save the game.'));
  if (!profile) { _openNicknameModal(); return; }

  const lineupErr = _validateLineup();
  if (lineupErr) return showErr(lineupErr);
  if (!orderSlots.some(s => s.isWinner)) return showErr(t('Mark the winner with 👑.'));

  const ps = orderSlots.map((s, i) => ({
    position:  i,
    character: s.char,
    is_winner: s.isWinner,
    user_id:   s.isMe ? user.id          : null,
    nickname:  s.isMe ? profile.nickname : null,
  }));

  btn.disabled    = true;
  btn.textContent = t('Saving…');

  const gameData = {
    played_at:        new Date(date).toISOString(),
    duration_minutes: dur,
    num_turns:        turns,
    location:         location,
    created_by:       user.id,
    source:           'app',   // distinguishes app-recorded games from the 'csv' import script
  };

  const { data: g, error } = await db.from('games').insert(gameData).select().single();
  if (error) {
    btn.disabled    = false;
    btn.textContent = t('Save game');
    return showErr(error.message);
  }

  await db.from('game_players').insert(ps.map(p => ({ game_id: g.id, ...p })));

  btn.disabled    = false;
  btn.textContent = t('Save game');

  // Clear live state (we just saved the game) and notify hooks
  _clearLiveState();
  _dropDraft();          // saved for good: the next visit starts fresh
  _draftReady = false;   // and nothing on this page re-creates it
  liveGame.emit('close');

  showQR(g.id);
}

// ── QR CODE ───────────────────────────────────────────────────────────────────

function showQR(gameId) {
  showQRModal(new URL(`claim.html?game=${gameId}`, location.href).href, 'qrCode', 'qrOverlay');
}

function closeQR() {
  closeOverlay('qrOverlay');
  // After saving, send the user to the game log to see their new entry
  window.location.href = 'game-log.html';
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();
