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
function buildGameCardHTML(g, gp, { isSelf = () => false, actions = '', locationClickable = false } = {}) {
  const locationPart = g.location
    ? (locationClickable ? `<button class="card-loc-btn">${_esc(g.location)}</button>` : _esc(g.location))
    : null;
  const meta = [
    fmtDuration(g.duration_minutes),
    g.num_turns ? `${g.num_turns} rounds` : null,
    locationPart,
    `${gp.length}p`,
  ].filter(Boolean).join(' | ');

  const chipsHTML = gp.map(p => {
    const cls = `chip ${p.is_winner ? 'winner' : ''}${isSelf(p) ? ' self' : ''}`;
    return `<div class="${cls}">
      ${p.is_winner ? '<span class="win-star">👑</span>' : ''}
      <a class="char-link chip-img" href="villains.html?vil=${encodeURIComponent(p.character)}">${charImgHTML(p.character)}</a>
      <div class="chip-body">
        <div class="chip-char"><a class="char-link" href="villains.html?vil=${encodeURIComponent(p.character)}">${_esc(p.character)}</a></div>
        ${p.nickname ? `<div class="chip-nick"><a class="nick-link" href="players.html?nick=${encodeURIComponent(p.nickname)}">${_esc(p.nickname)}</a></div>` : ''}
      </div>
    </div>`;
  }).join('');

  return `
    <div class="card-body">
      <div class="card-top">
        <div class="card-date">${fmtDateTime(g.played_at)}</div>
        <div class="card-meta">${meta}</div>
      </div>
      <div class="card-players">${chipsHTML}</div>
    </div>
    ${actions}`;
}

// Wrap the HTML in a <div class="game-card"> and attach the optional
// location-click handler. Callers that just need HTML should call
// buildGameCardHTML directly.
function buildGameCard(g, gp, { isSelf, actions, onLocationClick } = {}) {
  const card = document.createElement('div');
  card.className = 'game-card';
  card.innerHTML = buildGameCardHTML(g, gp, {
    isSelf,
    actions,
    locationClickable: !!onLocationClick,
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
  btn.textContent = 'Load more';
  btn.onclick = () => { btn.disabled = true; onLoadMore(); };
  container.appendChild(btn);
}
