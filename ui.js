// Theme (light/dark/auto, favicon + address-bar colour) lives in theme.js,
// loaded before this file.

// ── CHARACTER HELPERS ─────────────────────────────────────────────────────────

function charImgSrc(name) {
  return `asset/characters/${name.replace(/ /g, '_')}.webp`;
}

function charImgHTML(name) {
  return `<img class="char-portrait" src="${charImgSrc(name)}" onerror="this.src='asset/players/default.svg'" alt="">`;
}

// Avatar helpers (resolveAvatar, the builder recipe model, avatarHTML,
// playerAvatarHTML and the lightbox) live in avatar.js.

// ── CHARACTER GRIDS ───────────────────────────────────────────────────────────

// `boxInfo` (loadBoxInfo(), db.js) is optional: when given, box groups are
// ordered by its `order` field (matching the box-completion achievement tiles
// in achievements.js/account.js); when omitted, groups fall back to whatever
// order `chars` arrived in (i.e. `sort_order`), same as before this existed.
//
// `includeExtra`, when true, also lists a character under each of its
// `extraBoxes` (loadCharacters() decorates every character with this from
// character-extra-boxes.json: a reprint into another box with identical
// rules, not a [TAG] rework). Defaults to false so existing callers (the
// draw-pool grid, the new-game character picker, achievements' box
// completion) keep counting a character toward its one primary box only;
// opt in per-caller where showing every box a character appears in makes
// sense (the villains.html roster).
function groupByBox(chars, boxInfo, includeExtra = false) {
  const map = {};
  for (const c of chars) {
    if (!map[c.box]) map[c.box] = [];
    map[c.box].push(c);
    if (!includeExtra) continue;
    for (const box of c.extraBoxes || []) {
      if (!map[box]) map[box] = [];
      map[box].push(c);
    }
  }
  if (!boxInfo) return map;
  const sorted = {};
  for (const box of Object.keys(map).sort((a, b) =>
    (boxInfo[a]?.order ?? 999) - (boxInfo[b]?.order ?? 999) || a.localeCompare(b))) {
    sorted[box] = map[box];
  }
  return sorted;
}

function charSelectHTML(chars, selected = '', boxInfo) {
  const byBox = groupByBox(chars, boxInfo);
  let html = '<option value="">Villain</option>';
  for (const [box, cs] of Object.entries(byBox)) {
    html += `<optgroup label="${box}">`;
    for (const c of cs) {
      html += `<option value="${c.name}"${c.name === selected ? ' selected' : ''}>${c.name}</option>`;
    }
    html += '</optgroup>';
  }
  return html;
}

// Shared pill-grid builder. Pass `activeClass` to control which CSS class
// represents membership in `set` ("on" for filter selection, "excluded" for
// the new-game character filter). The `onToggle(name, nowActive)` callback
// fires after the set + DOM are updated.
//
// `includeExtra` (see groupByBox) lists a reprinted character under every box
// it appears in, one pill per box. Those pills toggle INDEPENDENTLY, not in
// sync: turning the character off in one box (or via that box's header)
// shouldn't pull it out of a box you're still including it from (e.g. owning
// both "Wicked to the Core" and "Darkness Brewing" should let you drop
// Darkness Brewing from today's pool without also losing Evil Queen, since
// she's still available via the other box). `set` only gains the name once
// every one of its pills is off, and loses it again the moment any single
// copy is switched back on.
function buildCharPillGrid(container, chars, set, { activeClass = 'on', onToggle, boxInfo, includeExtra = false } = {}) {
  const byBox = groupByBox(chars, boxInfo, includeExtra);
  container.innerHTML = '';

  // The pill's own class is the source of truth for "is this active": some
  // callers (new-game) reassign their backing set on every recompute, so a
  // captured set reference can go stale, the DOM class never does. We still
  // mutate `set` and fire `onToggle` so the caller's real state stays in sync.
  const pillsByName = new Map();   // name -> every pill button rendered for it (1, or more if reprinted)
  const isActive = btn => btn.classList.contains(activeClass);
  const applyPill = (btn, active) => {
    btn.classList.toggle(activeClass, active);
    const name  = btn.dataset.name;
    const pills = pillsByName.get(name);
    const allOn = pills.every(isActive);
    const wasIn = set.has(name);
    if (allOn === wasIn) return;
    if (allOn) set.add(name); else set.delete(name);
    onToggle?.(name, allOn);
  };

  for (const [box, cs] of Object.entries(byBox)) {
    const group = document.createElement('div');
    group.className = 'box-group';
    group.innerHTML = `<button type="button" class="box-name" title="Toggle all ${_esc(box)} villains">${_esc(box)}</button><div class="box-pills"></div>`;
    container.appendChild(group);
    const pillsEl = group.querySelector('.box-pills');

    const boxBtns = [];
    for (const c of cs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'char-pill' + (set.has(c.name) ? ` ${activeClass}` : '');
      btn.innerHTML = charImgHTML(c.name) + _esc(c.name);
      btn.dataset.name = c.name;
      btn.dataset.box  = box;   // which box THIS pill represents, for per-box ownership checks (pace-filter.js)
      btn.onclick = () => applyPill(btn, !isActive(btn));
      if (!pillsByName.has(c.name)) pillsByName.set(c.name, []);
      pillsByName.get(c.name).push(btn);
      boxBtns.push(btn);
      pillsEl.appendChild(btn);
    }

    // Box header toggles every character in this box at once: if all are
    // already active, clear them; otherwise activate them all. Only touches
    // this box's own pills; a reprinted character's pill in another box
    // (and the pool membership rule above) decides independently.
    group.querySelector('.box-name').onclick = () => {
      const allOn = boxBtns.every(isActive);
      boxBtns.forEach(btn => applyPill(btn, !allOn));
    };
  }
}

function buildExcludeGrid(container, chars, excludedSet, onChange, boxInfo) {
  buildCharPillGrid(container, chars, excludedSet, { activeClass: 'excluded', onToggle: onChange, boxInfo, includeExtra: true });
}

// ── FORMATTING ────────────────────────────────────────────────────────────────

function fmtDateTime(iso) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
    ', ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  );
}

function fmtDuration(min) {
  if (!min) return null;
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function fmtDateShort(iso) {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function avg(arr) {
  const valid = arr.filter(x => x != null);
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// ── DOM HELPERS ───────────────────────────────────────────────────────────────

function _resolveEl(target) {
  return typeof target === 'string' ? document.getElementById(target) : target;
}

// Toggle the .hidden utility class. Call as setVisible(id, true|false).
function setVisible(target, visible) {
  const el = _resolveEl(target);
  if (!el) return;
  el.classList.toggle('hidden', !visible);
}

// Show an error banner (.err element). The shake animation always re-plays so
// repeated submits with the same error are still noticeable. Optional
// `scroll` smooth-scrolls the banner into view.
function showError(target, msg, { scroll = false } = {}) {
  const el = _resolveEl(target);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  // Restart the animation by toggling the trigger class through one reflow.
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearError(target) {
  _resolveEl(target)?.classList.remove('show');
}

// ── OVERLAYS ──────────────────────────────────────────────────────────────────

function closeOverlay(id) {
  document.getElementById(id).classList.remove('open');
  document.body.style.overflow = '';
}

function openOverlay(id) {
  document.getElementById(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}

// The avatar zoom lightbox (showAvatarFromEl / showAvatarLightbox /
// closeAvatarLightbox) lives in avatar.js.

function showQRModal(url, codeElId, overlayId) {
  document.getElementById('qrUrlText').textContent = url;
  const el = document.getElementById(codeElId);
  el.innerHTML = '';
  new QRCode(el, { text: url, width: 200, height: 200, colorDark: '#000000', colorLight: '#ffffff' });
  openOverlay(overlayId);
}

// A reusable bottom-sheet confirmation dialog, injected once per `id` and reused
// on later calls. Replaces the per-feature "inject overlay + wire the confirm
// button + manage its loading state" boilerplate (claim, release, delete game…).
//   title        – sheet heading
//   bodyHTML     – inner HTML for the sheet body (already escaped by the caller)
//   confirmLabel – confirm button text (default "Confirm")
//   busyLabel    – confirm button text while onConfirm runs (default "Working…")
//   danger       – style the confirm button as destructive (btn-danger)
//   onConfirm()  – sync/async; the sheet closes when it resolves. The button
//                  shows busyLabel meanwhile; if onConfirm throws, the sheet stays
//                  open with the button reset so the user can retry.
function openConfirmSheet({ id, title, bodyHTML = '', confirmLabel = 'Confirm', busyLabel = 'Working…', danger = false, onConfirm }) {
  let overlay = document.getElementById(id);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.id = id;
    overlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <h3 class="confirm-sheet-title"></h3>
          <button class="sheet-close" type="button" aria-label="Close">×</button>
        </div>
        <div class="sheet-body confirm-sheet-body"></div>
        <div class="sheet-footer sheet-footer-row">
          <button class="btn btn-ghost confirm-sheet-cancel" type="button">Cancel</button>
          <button class="btn confirm-sheet-ok" type="button"></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => closeOverlay(id);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.querySelector('.sheet-close').addEventListener('click', close);
    overlay.querySelector('.confirm-sheet-cancel').addEventListener('click', close);
  }

  overlay.querySelector('.confirm-sheet-title').textContent = title;
  overlay.querySelector('.confirm-sheet-body').innerHTML = bodyHTML;

  const okBtn = overlay.querySelector('.confirm-sheet-ok');
  okBtn.className = `btn confirm-sheet-ok ${danger ? 'btn-danger' : 'btn-primary'}`;
  okBtn.textContent = confirmLabel;
  okBtn.disabled = false;
  okBtn.onclick = async () => {
    okBtn.disabled = true;
    okBtn.textContent = busyLabel;
    try {
      await onConfirm?.();
    } catch (_) {
      okBtn.disabled = false;
      okBtn.textContent = confirmLabel;
      return;
    }
    closeOverlay(id);
  };

  openOverlay(id);
}

// ── FILTER HELPERS ────────────────────────────────────────────────────────────

function updateFilterPills(selector, value) {
  document.querySelectorAll(selector).forEach((btn, i) => {
    btn.classList.toggle('on', (i === 0 ? 'all' : i + 1) === value);
  });
}

// The active location-filter pill ("<loc> | Clear"), shared by the game log and
// the player profile. `onClear` is the global handler name the button calls.
function locationFilterPillHTML(loc, onClear) {
  return `<button class="pill on" type="button" onclick="${onClear}()">${_esc(loc)} | Clear</button>`;
}

// The stat table (renderStatTableHTML + statBoxesHTML + sort/rank/bar helpers)
// lives in stats-table.js. The search box (attachSearchBox + autocomplete)
// lives in search.js. The achievements system lives in achievements.js.

// ── QR URL COPY ───────────────────────────────────────────────────────────────

function copyQrUrl() {
  const url = document.getElementById('qrUrlText')?.textContent?.trim();
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.querySelector('.qr-url-row .pf-btn');
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('copy-success');
    setTimeout(() => { btn.textContent = prev; btn.classList.remove('copy-success'); }, 1500);
  });
}

// The game card (buildGameCard / buildGameCardHTML) and the gameUserRole helper
// live in game-card.js.
