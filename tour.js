// ── GUIDED TOUR ───────────────────────────────────────────────────────────────
// A short tour of a page: one element at a time stays lit while the rest of
// the page dims, with a bubble next to it (its text, Back / Next, × to stop).
// The page builds its steps and any demo state; startTour only shows them.
//
//   startTour(steps, { onEnd })
//     steps: [{ el: selector, [selectors] (lit together) or () => element, text,
//     prep?: () => void }],
//     prep runs before its step is shown (a step whose element is missing or
//     hidden is skipped); onEnd runs once, however the tour stops (Done, ×,
//     Esc, a tap on the dimmed page).
//
// Keys: → / Enter next, ← back, Esc stops. Follows the page's scroll, size and
// text size; colors from the theme's tokens (style.css, .tour-*).

let _tour = null;   // { steps, i, onEnd, spot, bubble }

function startTour(steps, { onEnd } = {}) {
  endTour(false);
  const spot = document.createElement('div');
  spot.className = 'tour-spot';
  const bubble = document.createElement('div');
  bubble.className = 'tour-bubble';
  bubble.setAttribute('role', 'dialog');
  bubble.setAttribute('aria-live', 'polite');
  // A tap on the dimmed page (outside the bubble) stops the tour.
  const shade = document.createElement('div');
  shade.className = 'tour-shade';
  shade.addEventListener('click', () => endTour());
  document.body.append(shade, spot, bubble);
  // The page's layout can move without a scroll (a panel shown, an image
  // loaded): the lit box follows it too.
  const resize = new ResizeObserver(() => _tourPlace());
  resize.observe(document.body);
  _tour = { steps, i: -1, onEnd, spot, bubble, shade, resize };
  document.addEventListener('keydown', _tourKey, true);
  document.addEventListener('load', _tourPlace, true);   // an image above the step loaded: it moved
  window.addEventListener('resize', _tourPlace);
  window.addEventListener('scroll', _tourPlace, true);
  _tourGo(1);
}

function endTour(callOnEnd = true) {
  if (!_tour) return;
  const { spot, bubble, shade, onEnd, resize } = _tour;
  _tour = null;
  resize.disconnect();
  spot.remove(); bubble.remove(); shade.remove();
  document.removeEventListener('keydown', _tourKey, true);
  document.removeEventListener('load', _tourPlace, true);
  window.removeEventListener('resize', _tourPlace);
  window.removeEventListener('scroll', _tourPlace, true);
  if (callOnEnd) onEnd?.();
}

const _tourEls = step => (typeof step.el === 'function' ? [step.el()] : [].concat(step.el).map(sel => document.querySelector(sel))).filter(Boolean);
const _tourEl = step => _tourEls(step)[0];
const _tourShown = el => !!el && el.getClientRects().length > 0 && !el.closest('.hidden');

// The next (or previous) step whose element is on the page.
function _tourGo(dir) {
  const t0 = _tour;
  let i = t0.i;
  for (;;) {
    i += dir;
    if (i < 0) return;
    if (i >= t0.steps.length) return endTour();
    t0.steps[i].prep?.();
    if (_tourShown(_tourEl(t0.steps[i]))) break;
  }
  t0.i = i;
  _tourRender();
}

function _tourRender() {
  const { steps, i, bubble } = _tour;
  const last = i === steps.length - 1;
  bubble.innerHTML = `
    <button class="tour-close" type="button" title="${_esc(t('Close'))}" aria-label="${_esc(t('Close'))}">×</button>
    <p class="tour-text">${steps[i].text}</p>
    <div class="tour-actions">
      <span class="tour-count">${i + 1} / ${steps.length}</span>
      ${i > 0 ? `<button class="btn btn-ghost btn-sm tour-back" type="button">${t('Back')}</button>` : ''}
      <button class="btn btn-primary btn-sm tour-next" type="button">${last ? t('Done') : t('Next')}</button>
    </div>`;
  bubble.querySelector('.tour-close').onclick = () => endTour();
  bubble.querySelector('.tour-back')?.addEventListener('click', () => _tourGo(-1));
  bubble.querySelector('.tour-next').onclick = () => _tourGo(1);
  const el = _tourEl(steps[i]);
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  _tourPlace();
  requestAnimationFrame(() => { el.scrollIntoView({ block: 'center', behavior: 'instant' }); _tourPlace(); });   // once the step's layout has settled
  bubble.querySelector('.tour-next').focus({ preventScroll: true });
}

// The lit box around the element, and the bubble under it (above it when
// there's no room below), kept inside the window.
function _tourPlace() {
  if (!_tour) return;
  const els = _tourEls(_tour.steps[_tour.i]).filter(_tourShown);
  if (!els.length) return;
  // Several elements: the box around all of them.
  const rs = els.map(e => e.getBoundingClientRect());
  const r = { left: Math.min(...rs.map(x => x.left)), top: Math.min(...rs.map(x => x.top)), right: Math.max(...rs.map(x => x.right)), bottom: Math.max(...rs.map(x => x.bottom)) };
  r.width = r.right - r.left; r.height = r.bottom - r.top;
  const pad = 6, gap = 10;
  Object.assign(_tour.spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
  const b = _tour.bubble, bw = b.offsetWidth, bh = b.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const below = r.bottom + pad + gap, above = r.top - pad - gap - bh;
  const top = below + bh <= vh - 8 || above < 8 ? Math.min(below, vh - bh - 8) : above;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - bw / 2, vw - bw - 8));
  Object.assign(b.style, { left: `${left}px`, top: `${Math.max(8, top)}px` });
}

function _tourKey(e) {
  if (!_tour) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTour(); }
  else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !e.target.closest('.tour-back, .tour-close'))) { e.preventDefault(); e.stopPropagation(); _tourGo(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); _tourGo(-1); }
}
