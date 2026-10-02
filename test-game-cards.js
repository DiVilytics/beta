// Test page for the game card redesign (test-game-cards.html, not linked from
// the app). Renders real games with the app's own card builder, either in the
// new `layout: 'rows'` or today's chips, with the same options the Game Log
// and player pages pass.

const NICK = new URLSearchParams(location.search).get('nick') || 'Norrell';
let gcMode = 'rows';
let gcLog = null, gcPlayer = null;   // { games, players } for each section

// Same buttons as the player page (players.js buildProfileCard); Delete is
// disabled on this test page.
function _testDelete() {
  openConfirmSheet({ id: 'testDeleteOverlay', title: 'Delete Game?', bodyHTML: '<p class="confirm-text">Deleting is disabled on this test page.</p>', confirmLabel: 'OK', onConfirm: () => {} });
}

function _card(g, gp, { playerPage }) {
  const me = getCurrentUser();
  const role = gameUserRole(g, gp, me);
  const actions = playerPage && role.isParticipant ? `
    <div class="card-actions">
      <a class="btn btn-ghost btn-sm" href="join.html?game=${g.id}">Open</a>
      ${role.isCreator ? `<button class="btn btn-danger btn-sm" onclick="_testDelete()">Delete</button>` : ''}
    </div>` : '';
  return buildGameCard(g, gp, {
    isSelf: p => me && p.user_id === me.id,
    actions,
    onLocationClick: () => {},
    layout: gcMode,
  });
}

function _renderSection(id, data, opts) {
  const host = document.getElementById(id);
  host.innerHTML = '';
  if (!data || !data.games.length) { host.innerHTML = '<div class="empty"><p>No games.</p></div>'; return; }
  const byGame = {};
  for (const p of data.players) (byGame[p.game_id] ||= []).push(p);
  for (const g of data.games) host.appendChild(_card(g, byGame[g.id] || [], opts));
}

function render() {
  _renderSection('gcLog', gcLog, { playerPage: false });
  _renderSection('gcPlayer', gcPlayer, { playerPage: true });
  layoutGameCardMeta();
}


function setMode(m) {
  gcMode = m;
  document.querySelectorAll('#gcMode .seg-btn').forEach((b, i) => b.classList.toggle('on', (i === 0) === (m === 'rows')));
  render();
}

async function init() {
  initAuth(() => { if (gcLog) render(); });
  document.getElementById('gcPlayerTitle').innerHTML = `Player page <span>${_esc(NICK)}</span>`;

  const { data: page } = await db.rpc('get_game_page', { char_filter: null, count_filter: null, location_filter: null, page_offset: 0, page_size: 8 });
  const logGames = page || [];
  gcLog = { games: logGames, players: await fetchPlayersForGames(logGames.map(g => g.id)) };

  const { data: rows } = await db.from('game_players').select('game_id').eq('nickname', NICK);
  const ids = [...new Set((rows || []).map(r => r.game_id))];
  const all = await fetchGamesWithPlayers(ids, { orderByPlayedAtDesc: true });
  const keep = new Set(all.games.slice(0, 8).map(g => g.id));
  gcPlayer = { games: all.games.filter(g => keep.has(g.id)), players: all.players.filter(p => keep.has(p.game_id)) };

  render();
}

init();
