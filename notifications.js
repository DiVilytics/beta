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
};
const ntError = e => {
  const code = Object.keys(NT_ERRORS).find(k => e?.message?.includes(k));
  if (!code) console.warn('notification answer failed:', e);
  return t(code ? NT_ERRORS[code] : 'Something went wrong. Try again.');
};

let ntInvites = [];   // [{ id, created_at, inviter, name, pid, games: [{ g, seats }] }]

async function ntLoad() {
  const root = document.getElementById('ntRoot');
  root.classList.remove('spinner');
  const me = getCurrentUser();
  if (!me) {
    root.innerHTML = emptyStateHTML('🔔', t('Notifications'), t('Sign in to see your invitations.'),
      `<button class="btn btn-primary btn-sm" type="button" onclick="goToSignIn()">${t('Sign in')}</button>`);
    return;
  }
  const { data: invites, error } = await db.from('pending_invites')
    .select('id, created_at, invited_by, pending_player_id, pending_players(name)')
    .eq('invited_user', me.id).order('created_at', { ascending: false });
  if (error) { root.innerHTML = loadErrorHTML(t('Could not load your notifications.'), error); return; }
  if (!invites.length) {
    root.innerHTML = emptyStateHTML('🔔', t('No notifications'), t('When someone names you in a game, the invitation shows up here.'));
    return;
  }
  // The invitations' seats, their games with every seat, and who invited.
  const pids = invites.map(i => i.pending_player_id);
  const mine = await _fetchInChunks(pids, ch => db.from('game_players').select('game_id, pending_player_id').in('pending_player_id', ch));
  const gameIds = [...new Set(mine.map(s => s.game_id))];
  const [games, seats, people] = await Promise.all([
    _fetchInChunks(gameIds, ch => db.from('games').select('*').in('id', ch)),
    _fetchInChunks(gameIds, ch => db.from('game_players').select('*').in('game_id', ch)),
    _fetchInChunks([...new Set(invites.map(i => i.invited_by))], ch => db.from('profiles').select('id, nickname').in('id', ch)),
  ]);
  const nick = Object.fromEntries(people.map(p => [p.id, p.nickname]));
  const seatsOf = {};
  for (const s of seats) (seatsOf[s.game_id] ||= []).push(s);
  ntInvites = invites.map(i => ({
    id: i.id, created_at: i.created_at, inviter: nick[i.invited_by] || t('A player'), name: i.pending_players?.name || '', pid: i.pending_player_id,
    games: games.filter(g => mine.some(s => s.game_id === g.id && s.pending_player_id === i.pending_player_id))
      .sort((a, b) => Date.parse(b.played_at || b.created_at) - Date.parse(a.played_at || a.created_at))
      .map(g => ({ g, seats: sortGamePlayers(seatsOf[g.id] || []) })),
  }));
  ntRender();
}

function ntRender() {
  const root = document.getElementById('ntRoot');
  root.innerHTML = ntInvites.map(i => `
    <section class="nt-card" id="nt-${i.id}">
      <div class="nt-head">
        <p class="nt-title">${t('{who} says you played {n}', { who: `<strong>${_esc(i.inviter)}</strong>`, n: tn(i.games.length, '{n} game', '{n} games') })}
          <span class="nt-as">${t('as {name}', { name: `<span class="chip-pending">⏳ ${_esc(i.name)}</span>` })}</span></p>
        <p class="nt-when">${fmtDateShort(i.created_at)}</p>
      </div>
      <div class="nt-games"></div>
      <p class="modal-hint nt-error hidden"></p>
      <div class="nt-actions">
        <button class="btn btn-ghost btn-sm" type="button" onclick="ntDecline('${i.id}')">${t('Decline')}</button>
        <button class="btn btn-primary btn-sm" type="button" onclick="ntAccept('${i.id}')">${t('Accept')}</button>
      </div>
    </section>`).join('');
  // The games' cards (game-card.js): your seat as the pending name, linked to the game's page.
  for (const i of ntInvites) {
    const box = document.querySelector(`#nt-${i.id} .nt-games`);
    for (const { g, seats } of i.games) {
      const gp = seats.map(s => s.pending_player_id === i.pid ? { ...s, pending: { name: i.name } } : s);
      const card = buildGameCard(g, gp, { isSelf: p => p.pending_player_id === i.pid, layout: 'rows' });
      const link = document.createElement('a');
      link.className = 'nt-game-link';
      link.href = `claim.html?game=${g.id}`;
      link.append(card);
      box.append(link);
    }
  }
  layoutGameCardMeta(root);   // the details on as many lines as they need, as in the game log
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
