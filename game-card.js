// ── GAME CARD ─────────────────────────────────────────────────────────────────
// The shared game-card markup used by the game log and the player profile, plus
// the role helper that decides what a given user may do with a game. Depends on
// `fmtDuration` / `fmtDateTime` / `charImgHTML` (ui.js) and `_esc` (db.js).

// Centralizes "what's this user's relationship to this game?" so callers
// don't re-derive the same booleans inline. Pass the current user object
// (typically `getCurrentUser()`); a missing user yields all-false.
function gameUserRole(g, gp, user) {
  if (!user) return { isCreator: false, isClaimant: false, isParticipant: false };
  const isCreator  = g.created_by === user.id;
  const isClaimant = gp.some(p => p.user_id === user.id);
  return { isCreator, isClaimant, isParticipant: isCreator || isClaimant };
}

// Pure HTML builder for a game card. The result is meant to be injected into
// a `<div class="game-card">…</div>` host. Pass `locationClickable: true` to
// render the location as a button (the caller wires the click handler).
// `layout: 'rows'` lists the players one per row in play order (seat numbers
// when the order was recorded, crown at the row's end) instead of wrapping chips. The purple highlight
// always marks the signed-in player (`isSelf`), on every page. A solo game
// (solo.js) says Solo where the others give the table size; its card is dashed.
function buildGameCardHTML(g, gp, { isSelf = () => false, actions = '', locationClickable = false, layout = 'chips' } = {}) {
  const rows = layout === 'rows';
  if (rows) gp = gp.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  // Seat numbers only when the play order was recorded: every seat has its own
  // position. Imported games without it keep the column, empty, and so does a
  // solo game (one seat).
  const ordered = g.variant !== 'solo' && gp.every(p => p.position != null) && new Set(gp.map(p => p.position)).size === gp.length;
  const locationPart = g.location
    ? (locationClickable ? `<button class="card-loc-btn">${_esc(g.location)}</button>` : _esc(g.location))
    : null;
  const meta = [
    fmtDuration(g.duration_minutes),
    g.num_turns ? tn(g.num_turns, '{n} round', '{n} rounds') : null,
    locationPart,
    g.variant === 'solo' ? t('Solo') : `${gp.length}p`,
  ].filter(Boolean);
  // Rows layout: the details may wrap, so they go in as separate items that
  // layoutGameCardMeta() splits into lines without a "|" at either end.
  const metaHTML = rows
    ? `<span class="sep-row">${meta.map(m => `<span class="sep-item">${m}</span>`).join('<span class="sep-sep"> | </span>')}</span>`
    : meta.join(' | ');

  const chipsHTML = gp.map((p, i) => {
    const cls = `chip ${p.is_winner ? 'winner' : ''}${isSelf(p) ? ' self' : ''}`;
    const star = p.is_winner ? '<span class="win-star">👑</span>' : '';
    return `<div class="${cls}">
      ${rows ? `<span class="chip-seat">${ordered ? i + 1 : ''}</span>` : star}
      <a class="char-link chip-img" href="villains.html?vil=${encodeURIComponent(p.character)}">${charImgHTML(p.character)}</a>
      <div class="chip-body">
        <div class="chip-char"><a class="char-link" href="villains.html?vil=${encodeURIComponent(p.character)}">${villainNameHTML(p.character)}</a></div>
        ${p.nickname ? `<div class="chip-nick"><a class="nick-link" href="players.html?nick=${encodeURIComponent(p.nickname)}">${_esc(p.nickname)}</a></div>` : ''}
      </div>
      ${rows ? star : ''}
    </div>`;
  }).join('');

  return `
    <div class="card-body">
      <div class="card-top${rows ? ' card-top-wrap' : ''}">
        <div class="card-date">${fmtGameDate(g)}</div>
        <div class="card-meta">${metaHTML}</div>
      </div>
      <div class="card-players${rows ? ' rows' : ''}">${chipsHTML}</div>
    </div>
    ${actions}`;
}

// Wrap the HTML in a <div class="game-card"> and attach the optional
// location-click handler. Callers that just need HTML should call
// buildGameCardHTML directly.
function buildGameCard(g, gp, { isSelf, actions, onLocationClick, layout } = {}) {
  const card = document.createElement('div');
  card.className = g.variant === 'solo' ? 'game-card solo' : 'game-card';
  card.innerHTML = buildGameCardHTML(g, gp, {
    isSelf,
    actions,
    locationClickable: !!onLocationClick,
    layout,
  });
  if (onLocationClick && g.location) {
    card.querySelector('.card-loc-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      onLocationClick(g.location);
    });
  }
  return card;
}

// ── GAME LIST HELPERS ───────────────────────────────────────────────────────
// Shared bits of the game-log / player-profile lists (the lists themselves
// paginate differently, server-side vs client-side, so only these are shared).

// A game's player rows in display order: by position, then id as a stable
// tiebreaker. Returns a new array (never mutates the input).
function sortGamePlayers(rows) {
  return [...rows].sort((a, b) => (a.position ?? 999) - (b.position ?? 999) || (a.id < b.id ? -1 : 1));
}

// Append a "Load more" button that disables itself on click, then runs onLoadMore.
function appendLoadMore(container, onLoadMore) {
  const btn = document.createElement('button');
  btn.className = 'btn-load-more';
  btn.textContent = t('Load more');
  btn.onclick = () => { btn.disabled = true; onLoadMore(); };
  container.appendChild(btn);
}

// Rows layout: split each card's details into lines that fit beside the date,
// a "|" never ending or starting a line (same logic as the New Game legend).
// Call after the cards are in the page; it re-runs by itself when the window
// width changes and once the web font has loaded.
let _cardMetaResize = null;
function layoutGameCardMeta(root = document) {
  if (!_cardMetaResize) {
    _cardMetaResize = true;
    let t = null;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => layoutGameCardMeta(), 150); });
    // A first pass may measure the fallback font: redo it once the web font is in.
    document.fonts?.ready.then(() => layoutGameCardMeta());
  }
  for (const top of root.querySelectorAll('.card-top-wrap')) {
    const date = top.querySelector('.card-date');
    const meta = top.querySelector('.card-meta');
    if (!date || !meta) continue;
    const items = [...meta.querySelectorAll('.sep-item')].map(it => it.firstChild && it.childNodes.length === 1 && it.firstChild.nodeType === 1 ? it.firstChild : it.innerHTML);
    const gap = parseFloat(getComputedStyle(top).columnGap) || 8;
    layoutSeparatedRows(meta, items, top.clientWidth - date.offsetWidth - gap);
  }
}

