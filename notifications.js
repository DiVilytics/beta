// ── NOTIFICATIONS PAGE (beta) ────────────────────────────────────────────────
// Your open invitations, newest first (pending players, PLAYERS_SPEC.md):
// who named you, as which name, and the games it covers (their cards, your
// seat marked pending), with Accept (the games go on your page, all at once)
// and Decline (nobody can invite you to them again; you can still claim them
// yourself with their QR code). The count beside the nav's avatar follows
// (refreshNotificationCount, shared.js).

// The database's refusals (accept_invite / decline_invite), as players read them.
const NT_ERRORS = {
  no_invite:       'This invitation was withdrawn or already answered. The page is up to date now.',
  already_in_game: 'You already have a villain in one of these games.',
  no_profile:      'You need a nickname before you can accept.',
  seat_changed:    'This game was just changed or claimed. The page is up to date now.',
};
const ntError = e => {
  const code = Object.keys(NT_ERRORS).find(k => e?.message?.includes(k));
  if (!code) console.warn('notification answer failed:', e);
  return t(code ? NT_ERRORS[code] : 'Something went wrong. Try again.');
};

// 20 invitations at a time (Load more); each shows its first 3 games (Show
// all for the rest, an upload's name can cover many), its count always whole.
const NT_PAGE = 20, NT_SHOWN = 3;
let ntInvites = [];   // [{ id, created_at, inviter, name, pid, games: [g, newest first], seats: { gameId: [seat] } }]
let ntMore = false;   // more invitations after these

async function ntLoad() {
  const root = document.getElementById('ntRoot');
  root.classList.remove('spinner');
  const me = getCurrentUser();
  if (!me) {
    root.innerHTML = emptyStateHTML('🔔', t('Notifications'), t('Sign in to see your invitations.'),
      `<button class="btn btn-primary btn-sm" type="button" onclick="goToSignIn()">${t('Sign in')}</button>`);
    return;
  }
  ntInvites = [];
  const ok = await ntLoadPage();
  if (!ok) { root.innerHTML = loadErrorHTML(t('Could not load your notifications.')); return; }
  if (!ntInvites.length) {
    root.innerHTML = emptyStateHTML('🔔', t('No notifications'), t('When someone names you in a game, the invitation shows up here.'));
    return;
  }
  ntRender();
}

// The next invitations, with their games (the shown ones' seats only) and who
// invited; false if they couldn't load.
async function ntLoadPage() {
  const me = getCurrentUser();
  const { data: invites, error } = await db.from('pending_invites')
    .select('id, created_at, invited_by, pending_player_id, pending_players(name)')
    .eq('invited_user', me.id).order('created_at', { ascending: false })
    .range(ntInvites.length, ntInvites.length + NT_PAGE);   // one more: is there a next page?
  if (error) { console.warn('notifications:', error); return false; }
  ntMore = invites.length > NT_PAGE;
  const page = invites.slice(0, NT_PAGE);
  if (!page.length) return true;
  const mine = await _fetchInChunks(page.map(i => i.pending_player_id), ch => db.from('game_players').select('game_id, pending_player_id').in('pending_player_id', ch));
  const [games, people] = await Promise.all([
    _fetchInChunks([...new Set(mine.map(s => s.game_id))], ch => db.from('games').select('*').in('id', ch)),
    _fetchInChunks([...new Set(page.map(i => i.invited_by))], ch => db.from('profiles').select('id, nickname').in('id', ch)),
  ]);
  const nick = Object.fromEntries(people.map(p => [p.id, p.nickname]));
  const added = page.map(i => {
    const ids = new Set(mine.filter(s => s.pending_player_id === i.pending_player_id).map(s => s.game_id));
    return {
      id: i.id, created_at: i.created_at, inviter: nick[i.invited_by] || t('A player'), name: i.pending_players?.name || '', pid: i.pending_player_id,
      games: games.filter(g => ids.has(g.id)).sort((a, b) => Date.parse(b.played_at || b.created_at) - Date.parse(a.played_at || a.created_at)),
      seats: {},
    };
  });
  await ntLoadSeats(added.flatMap(i => i.games.slice(0, NT_SHOWN).map(g => [i, g.id])));
  ntInvites.push(...added);
  return true;
}

// Every seat of these games ([invitation, game id] pairs), for their cards.
async function ntLoadSeats(pairs) {
  const ids = [...new Set(pairs.map(([, id]) => id))];
  const seats = await _fetchInChunks(ids, ch => db.from('game_players').select('*').in('game_id', ch));
  for (const [i, id] of pairs) i.seats[id] = sortGamePlayers(seats.filter(s => s.game_id === id));
}

function ntCardHTML(i) {
  return `
    <section class="nt-card" id="nt-${i.id}">
      <div class="nt-head">
        <p class="nt-title">${t('{who} says you played {n}', { who: `<strong>${_esc(i.inviter)}</strong>`, n: tn(i.games.length, '{n} game', '{n} games') })}
          <span class="nt-as">${t('as {name}', { name: `<span class="chip-pending">⏳ ${_esc(i.name)}</span>` })}</span></p>
        <p class="nt-when">${fmtDateShort(i.created_at)}</p>
      </div>
      <div class="nt-games"></div>
      <p class="modal-hint nt-error hidden"></p>
      <div class="nt-actions">
        <button class="btn btn-ghost btn-sm" type="button" onclick="ntDecline('${i.id}')">${i.games.length > 1 ? t('Decline all') : t('Decline')}</button>
        <button class="btn btn-primary btn-sm" type="button" onclick="ntAccept('${i.id}')">${i.games.length > 1 ? t('Accept all') : t('Accept')}</button>
      </div>
    </section>`;
}

// An invitation's game cards (game-card.js): your seat as the pending name,
// each to the game's page (a tap outside its buttons); the first NT_SHOWN, or
// all. With more than one game, each has its own Accept and Decline.
function ntFillGames(i, all = false) {
  const box = document.querySelector(`#nt-${i.id} .nt-games`);
  if (!box) return;
  box.innerHTML = '';
  for (const g of all ? i.games : i.games.slice(0, NT_SHOWN)) {
    const gp = (i.seats[g.id] || []).map(s => s.pending_player_id === i.pid ? { ...s, pending: { name: i.name } } : s);
    const seat = gp.find(s => s.pending_player_id === i.pid);
    const actions = i.games.length > 1 && seat ? `<div class="nt-game-actions">
        <button class="btn btn-ghost btn-sm" type="button" onclick="ntDeclineGame('${i.id}', '${g.id}', '${seat.id}')">${t('Decline')}</button>
        <button class="btn btn-ghost btn-sm nt-accept-one" type="button" onclick="ntAnswerGame('${i.id}', '${g.id}', '${seat.id}', 'accept_invite_seat')">${t('Accept')}</button>
      </div>` : '';
    const card = buildGameCard(g, gp, { isSelf: p => p.pending_player_id === i.pid, layout: 'rows', actions });
    card.classList.add('nt-game');
    card.addEventListener('click', e => { if (!e.target.closest('button, a')) location.href = `claim.html?game=${g.id}`; });
    box.append(card);
  }
  if (!all && i.games.length > NT_SHOWN) {
    box.insertAdjacentHTML('beforeend', `<button class="btn-load-more nt-show-all" type="button" onclick="ntShowAll('${i.id}', this)">${t('Show all {n} games', { n: i.games.length })}</button>`);
  }
  layoutGameCardMeta(box);   // the details on as many lines as they need, as in the game log
}

async function ntShowAll(id, btn) {
  const i = ntInvites.find(x => x.id === id);
  if (!i) return;
  btn.disabled = true;
  await ntLoadSeats(i.games.filter(g => !i.seats[g.id]).map(g => [i, g.id]));
  ntFillGames(i, true);
}

function ntRender() {
  const root = document.getElementById('ntRoot');
  root.innerHTML = ntInvites.map(ntCardHTML).join('');
  for (const i of ntInvites) ntFillGames(i);
  if (ntMore) appendLoadMore(root, async () => { if (await ntLoadPage()) ntRender(); });
}

// One game of an invitation: Decline asks first (no invitation to it again).
function ntDeclineGame(id, gameId, seatId) {
  const i = ntInvites.find(x => x.id === id);
  openConfirmSheet({
    id: 'ntDeclineSheet',
    title: t('Decline this game?'),
    bodyHTML: `<p class="modal-hint">${t('{who} won\'t be able to invite you to this game again. You can still claim it yourself with its QR code.', { who: _esc(i?.inviter || '') })}</p>`,
    confirmLabel: t('Decline'),
    danger: true,
    onConfirm: () => ntAnswerGame(id, gameId, seatId, 'decline_invite_seat'),
  });
}

// One game answered: it leaves the invitation (the whole card once none is left).
async function ntAnswerGame(id, gameId, seatId, fn) {
  const i = ntInvites.find(x => x.id === id);
  const card = document.getElementById(`nt-${id}`);
  card?.querySelectorAll('button').forEach(b => { b.disabled = true; });
  const { error } = await db.rpc(fn, { target: id, seat_id: seatId });
  if (error) {
    const msg = card?.querySelector('.nt-error');
    if (msg) { msg.textContent = ntError(error); msg.classList.remove('hidden'); }
    card?.querySelectorAll('button').forEach(b => { b.disabled = false; });
    if (/no_invite|seat_changed/.test(error.message || '')) await ntLoad();
    return;
  }
  i.games = i.games.filter(g => g.id !== gameId);
  if (!i.games.length) { ntInvites = ntInvites.filter(x => x.id !== id); card?.remove(); }
  else if (card) {
    const all = !card.querySelector('.nt-show-all');
    card.outerHTML = ntCardHTML(i);
    await ntLoadSeats(i.games.filter(g => !i.seats[g.id]).slice(0, all ? undefined : NT_SHOWN).map(g => [i, g.id]));
    ntFillGames(i, all);
  }
  if (!ntInvites.length) await ntLoad();
  refreshNotificationCount();
}

async function ntAccept(id) {
  await ntAnswer(id, 'accept_invite');
}

function ntDecline(id) {
  const i = ntInvites.find(x => x.id === id);
  openConfirmSheet({
    id: 'ntDeclineSheet',
    title: t('Decline the invitation?'),
    bodyHTML: `<p class="modal-hint">${t('{who} won\'t be able to invite you to these games again. You can still claim them yourself with their QR code.', { who: _esc(i?.inviter || '') })}</p>`,
    confirmLabel: t('Decline'),
    danger: true,
    onConfirm: () => ntAnswer(id, 'decline_invite'),
  });
}

async function ntAnswer(id, fn) {
  const card = document.getElementById(`nt-${id}`);
  card?.querySelectorAll('button').forEach(b => { b.disabled = true; });
  const { error } = await db.rpc(fn, { target: id });
  if (error) {
    const msg = card?.querySelector('.nt-error');
    if (msg) { msg.textContent = ntError(error); msg.classList.remove('hidden'); }
    card?.querySelectorAll('button').forEach(b => { b.disabled = false; });
    if (error.message?.includes('no_invite')) await ntLoad();
    return;
  }
  await Promise.all([ntLoad(), refreshNotificationCount()]);
}

(async () => {
  await initAuth(() => ntLoad());
  ntLoad();
})();
