// ── STATE ─────────────────────────────────────────────────────────────────────

let pfNick      = '';
let pfGames     = [];   // games this nickname appeared in
let pfPlayers   = [];   // all players for those games
let pfCharBoxMap  = {};
let pfAvatarUrl = null;
let pfAllChars  = [];
let pfAch       = new Map();
let pfBoxInfo   = {};
let pfGlobal    = null;
let pfFriends   = [];   // top co-players by shared games (filter-independent)

let pfMode           = 'pct';   // 'pct' | 'count' | 'games'
let pfFilter         = 'all';   // 'all' | 2..6
let pfWinsOnly       = false;
let pfLocationFilter = null;

let pfDisplayLimit   = PAGE_SIZE;

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('players.html');
  await initAuth();
  _attachPlayerSearch();

  const params = new URLSearchParams(location.search);
  pfNick = (params.get('nick') || '').trim();

  if (!pfNick) {
    const loggedUser    = getCurrentUser();
    const loggedProfile = getCurrentProfile();
    if (loggedUser && loggedProfile?.nickname) {
      pfNick = loggedProfile.nickname;
      history.replaceState(null, '', `players.html?nick=${encodeURIComponent(pfNick)}`);
    } else if (loggedUser && !loggedProfile) {
      document.title = `DiVilytics | ${t('Player')}`;
      document.getElementById('pfRoot').className = '';
      document.getElementById('pfRoot').innerHTML = `
        <div class="empty">
          <div class="empty-icon">👤</div>
          <h3>${t('Welcome!')}</h3>
          <p>${t('Choose a nickname before you can record games.')}</p>
          <button class="btn btn-primary btn-sm" onclick="_openNicknameModal(newNick => { location.href = 'players.html?nick=' + encodeURIComponent(newNick); })">${t('Set nickname')}</button>
        </div>`;
      return;
    } else {
      document.getElementById('pfRoot').className = '';
      document.getElementById('pfRoot').innerHTML =
        `<div class="empty"><div class="empty-icon">👤</div><h3>${t('No player selected')}</h3><p>${t('Open a profile by tapping a nickname on the leaderboard or a game card.')}</p></div>`;
      return;
    }
  }

  document.title = `DiVilytics | ${pfNick}`;

  const [chars, viewedProfile, boxInfo] = await Promise.all([
    loadCharacters(),
    fetchProfile({ nickname: pfNick }, 'avatar_url, default_avatar, created_at'),
    loadBoxInfo(),
  ]);
  pfAllChars  = chars;
  pfBoxInfo   = boxInfo || {};
  pfAvatarUrl = resolveAvatar(viewedProfile);
  const sinceHTML = viewedProfile?.created_at
    ? `<span class="pf-since">${t('Since {date}', { date: fmtDateShort(viewedProfile.created_at) })}</span>`
    : '';
  pfCharBoxMap  = Object.fromEntries(chars.map(c => [c.name, c.box]));

  const profile = getCurrentProfile();
  const isOwnProfile = profile && profile.nickname === pfNick;
  const nameBlock = `<span class="pf-name-block"><span class="pf-nick">${_esc(pfNick)}</span>${sinceHTML}</span>`;
  let identityEl = document.getElementById('pfIdentity');
  if (!identityEl) {
    identityEl = document.createElement('div');
    identityEl.id = 'pfIdentity';
    document.getElementById('pfControls').insertAdjacentElement('beforebegin', identityEl);
  }
  identityEl.innerHTML =
    `<div class="pf-identity-row">
      <span class="pf-identity">${avatarHTML(pfAvatarUrl, { cls: 'player-avatar-lg', extraClass: 'zoomable', id: 'pfAvatar', lightbox: true })}${nameBlock}</span>
      <button class="btn btn-ghost btn-sm pf-share-btn" onclick="showProfileQR()">${t('Share')}</button>
    </div>`;

  await load();
}

async function load() {
  // 1) find all game_players rows matching this nickname
  const { rows: myRows, error } = await _fetchAllRows(() =>
    db.from('game_players').select('game_id').eq('nickname', pfNick));

  if (error) {
    document.getElementById('pfRoot').className = '';
    document.getElementById('pfRoot').innerHTML =
      `<div class="empty"><p>${t('Error: {message}', { message: _esc(error.message) })}</p></div>`;
    return;
  }

  let gameIds = myRows.map(r => r.game_id);

  // On your own profile, also include games you created, even ones you haven't
  // claimed a character in (e.g. after releasing your claim). Otherwise such a
  // game would vanish from your profile, taking its manage/QR actions with it.
  const me      = getCurrentUser();
  const profile = getCurrentProfile();
  if (me && profile && profile.nickname === pfNick) {
    const { rows: createdRows } = await _fetchAllRows(() =>
      db.from('games').select('id').eq('created_by', me.id));
    gameIds = gameIds.concat(createdRows.map(r => r.id));
  }

  gameIds = [...new Set(gameIds)];

  const { games, players } = await fetchGamesWithPlayers(gameIds, { orderByPlayedAtDesc: true });
  pfGames   = games;
  pfPlayers = players;
  pfAch     = computeCharacterAchievements(players.filter(p => p.nickname === pfNick));
  pfGlobal  = computeGlobalAchievements(games, players, p => p.nickname === pfNick, pfAllChars);
  pfFriends = await _loadFriends();

  document.getElementById('pfRoot').className = '';

  // If we just came back from opening a game, scroll that card into view once
  // the list has rendered.
  try {
    _pfScrollToId = sessionStorage.getItem('pfReturnGameId');
    if (_pfScrollToId) sessionStorage.removeItem('pfReturnGameId');
  } catch (_) { _pfScrollToId = null; }

  render();
}

// Top co-players by shared games, the people this player plays with most. Only
// counts games where THIS player actually had a seat, and ignores the page's
// player-count / location / wins-only filters (it's an all-time relationship).
async function _loadFriends() {
  const myGameIds = new Set(pfPlayers.filter(p => p.nickname === pfNick).map(p => p.game_id));
  const tally = new Map();   // co-player nickname → shared game count
  for (const p of pfPlayers) {
    if (!p.nickname || p.nickname === pfNick || !myGameIds.has(p.game_id)) continue;
    tally.set(p.nickname, (tally.get(p.nickname) || 0) + 1);
  }
  const top = [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([nick, games]) => ({ nick, games }));
  if (!top.length) return [];

  // One small query for just these nicknames' avatars.
  const { data } = await db.from('profiles')
    .select('nickname, avatar_url, default_avatar')
    .in('nickname', top.map(f => f.nick));
  const avatarByNick = Object.fromEntries((data || []).map(p => [p.nickname, resolveAvatar(p)]));
  return top.map(f => ({ ...f, avatar: avatarByNick[f.nick] || 'asset/players/default.svg' }));
}

// The "Played with" section: a ranked list of the top co-players. Empty string
// when this player has no nicknamed co-players (solo / all-unclaimed opponents).
function _friendsSectionHTML() {
  if (!pfFriends.length) return '';
  const rows = pfFriends.map((f, i) => `
    <a class="pf-friend" href="players.html?nick=${encodeURIComponent(f.nick)}">
      <span class="pf-friend-rank">${i + 1}</span>
      ${playerAvatarHTML(f.avatar)}
      <span class="pf-friend-nick">${_esc(f.nick)}</span>
      <span class="pf-friend-count">${tn(f.games, '{n} game', '{n} games')}</span>
    </a>`).join('');
  return `
    <div class="pf-games-header"><span class="pf-games-title">${t('Most played with')}</span></div>
    <div class="pf-friends">${rows}</div>`;
}

// ── CONTROLS ──────────────────────────────────────────────────────────────────

function pfSetMode(m) {
  pfMode = m;
  render();
}

function pfSetFilter(f) {
  pfFilter = f;
  updateFilterPills('#pfFilterPills .pill', f);
  render();
}

function pfToggleWinsOnly() {
  pfWinsOnly = !pfWinsOnly;
  const btn = document.getElementById('pfWinsOnlyBtn');
  if (btn) btn.classList.toggle('on', pfWinsOnly);
  pfDisplayLimit = PAGE_SIZE;
  _renderGamesList();
}

function pfJump(ev) {
  ev.preventDefault();
  const v = document.getElementById('pfJumpInput').value.trim();
  if (!v) return false;
  location.href = `players.html?nick=${encodeURIComponent(v)}`;
  return false;
}

function _attachPlayerSearch() {
  const goTo = nick => { location.href = `players.html?nick=${encodeURIComponent(nick)}`; };
  attachSearchBox({
    inputId:    'pfJumpInput',
    dropdownId: 'pfDropdown',
    debounceMs: 200,
    fetchOptions: dbSearchSource(q => db
      .from('profiles')
      .select('nickname, avatar_url, default_avatar')
      .ilike('nickname', `${q}%`)
      .not('nickname', 'is', null)
      .limit(8)),
    renderOption: p => `
      <div class="cs-option" data-nick="${_esc(p.nickname)}">
        ${playerAvatarHTML(resolveAvatar(p))}
        <span>${_esc(p.nickname)}</span>
      </div>`,
    onSelect:      opt => goTo(opt.dataset.nick),
    onDirectEnter: v   => goTo(v),
  });
}

function pfFilteredGameIds() {
  let games = pfGames;
  if (pfFilter !== 'all') {
    const countMap = {};
    for (const p of pfPlayers) countMap[p.game_id] = (countMap[p.game_id] || 0) + 1;
    games = games.filter(g => countMap[g.id] === pfFilter);
  }
  if (pfLocationFilter) games = games.filter(g => g.location === pfLocationFilter);
  return new Set(games.map(g => g.id));
}

function pfSetLocationFilter(loc) {
  pfLocationFilter = pfLocationFilter === loc ? null : loc;
  render();
}

function pfClearLocationFilter() {
  pfLocationFilter = null;
  render();
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function render() {
  pfDisplayLimit = PAGE_SIZE;
  const root = document.getElementById('pfRoot');

  if (!pfGames.length) {
    setVisible('pfControls', false);
    root.innerHTML =
      `<div class="empty"><div class="empty-icon">🎭</div><h3>${t('No games yet')}</h3><p>${t("{nick} hasn't played any recorded games.", { nick: _esc(pfNick) })}</p></div>`;
    return;
  }

  setVisible('pfControls', true);

  const keepIds = pfFilteredGameIds();
  const games   = pfGames.filter(g => keepIds.has(g.id));
  const mine    = pfPlayers.filter(p => keepIds.has(p.game_id) && p.nickname === pfNick);

  const wins   = mine.filter(p => p.is_winner).length;
  const nGames = mine.length;
  const winPct = nGames ? Math.round((wins / nGames) * 100) : 0;

  // Longest run of consecutive wins, chronological, within the current filter.
  const atById = {};
  for (const g of pfGames) atById[g.id] = g.played_at;
  let bestStreak = 0, streakRun = 0;
  for (const p of [...mine].sort((a, b) => new Date(atById[a.game_id]) - new Date(atById[b.game_id]))) {
    if (p.is_winner) { streakRun++; if (streakRun > bestStreak) bestStreak = streakRun; }
    else streakRun = 0;
  }
  // The loop ends on the latest game, so streakRun is the current streak. When it
  // equals the best one the player is on their record run right now.
  const onBestStreak = bestStreak > 0 && streakRun === bestStreak;

  const avgDur   = avg(games.map(g => g.duration_minutes));
  const avgTurns = avg(games.map(g => g.num_turns));

  if (!nGames) {
    root.innerHTML =
      `<div class="empty"><div class="empty-icon">🔍</div><h3>${t('No games for this filter')}</h3><p>${t('Try adjusting the player count.')}</p></div>`;
    return;
  }

  // Character tally
  const charMap = {};
  for (const p of mine) {
    if (!charMap[p.character]) charMap[p.character] = { character: p.character, games: 0, wins: 0 };
    charMap[p.character].games++;
    if (p.is_winner) charMap[p.character].wins++;
  }
  const charRows = Object.values(charMap);

  setAchievementsContext({
    ach: pfAch, chars: pfAllChars, boxInfo: pfBoxInfo, global: pfGlobal,
    title: pfNick ? `${t('Achievements')} | ${pfNick}` : t('Achievements'),
  });

  root.innerHTML = `
    <div class="summary">
      ${statBoxesHTML([
        { val: nGames,       lbl: t('Games') },
        { val: avgDur   != null ? Math.round(avgDur) + 'm' : '-', lbl: t('Avg duration') },
        { val: avgTurns != null ? Math.round(avgTurns)     : '-', lbl: t('Avg rounds') },
        { val: winPct + '%', lbl: t('Win rate') },
        { val: wins,         lbl: t('Wins') },
        { val: bestStreak,   lbl: t('Max streak'), hot: onBestStreak, title: onBestStreak ? t('Currently on this streak') : '' },
      ])}
    </div>

    ${statModeSegHTML(pfMode, 'pfSetMode')}

    ${renderStatTableHTML(charRows, {
      mode:        pfMode,
      headLabel:   t('Villain'),
      getKey:      r   => r.character,
      getName:     villainName,
      getHref:     key => `villains.html?vil=${encodeURIComponent(key)}`,
      getIdentity: key => charImgHTML(key),
      getSub:      key => pfCharBoxMap[key],
      getSubHref:  key => pfCharBoxMap[key] ? `villains.html?box=${boxAnchorId(pfCharBoxMap[key])}` : '',
      wrapClass:   'mb-1-25',
    })}

    ${_friendsSectionHTML()}

    ${achievementsSectionHTML({
      ach: pfAch, chars: pfAllChars, boxInfo: pfBoxInfo, global: pfGlobal,
      // The profile shows only earned achievements (mirroring the characters grid).
      onlyEarned: true,
      header: (earned, total) => `
        <div class="pf-games-header">
          <span class="pf-games-title">${t('Achievements')} | ${earned} / ${total}</span>
        </div>`,
    })}

    <div class="pf-games-header">
      <span class="pf-games-title">${t('Games')}</span>
      ${pfLocationFilter ? locationFilterPillHTML(pfLocationFilter, 'pfClearLocationFilter') : ''}
      <button class="pill" id="pfWinsOnlyBtn" onclick="pfToggleWinsOnly()" type="button">${t('Wins only')}</button>
    </div>
    <div class="games-list" id="pfGamesList"></div>
  `;

  _renderGamesList(keepIds);
}

let _pfScrollToId = null;

function _renderGamesList(keepIds = pfFilteredGameIds()) {
  let games = pfGames.filter(g => keepIds.has(g.id));

  if (pfWinsOnly) {
    const winGameIds = new Set(
      pfPlayers.filter(p => keepIds.has(p.game_id) && p.nickname === pfNick && p.is_winner).map(p => p.game_id)
    );
    games = games.filter(g => winGameIds.has(g.id));
  }

  // Returning from an opened game: make sure its card is within the rendered
  // page so we can scroll to it (it may sit beyond the current "Load more" cut).
  if (_pfScrollToId) {
    const idx = games.findIndex(g => g.id === _pfScrollToId);
    if (idx >= pfDisplayLimit) pfDisplayLimit = Math.ceil((idx + 1) / PAGE_SIZE) * PAGE_SIZE;
  }

  const visible = games.slice(0, pfDisplayLimit);
  const hasMore = games.length > visible.length;

  const list = document.getElementById('pfGamesList');
  if (!list) return;
  list.innerHTML = '';
  // Pre-group players by game_id so each card is an O(1) lookup, not an O(n) scan.
  const byGame = {};
  for (const p of pfPlayers) (byGame[p.game_id] ||= []).push(p);
  for (const g of visible) {
    const gp = sortGamePlayers(byGame[g.id] || []);
    list.appendChild(buildProfileCard(g, gp));
  }
  layoutGameCardMeta(list);
  if (hasMore) appendLoadMore(list, pfLoadMore);

  if (_pfScrollToId) {
    const target = _pfScrollToId;
    _pfScrollToId = null;
    requestAnimationFrame(() => {
      document.getElementById(`pf-game-${target}`)?.scrollIntoView({ block: 'center' });
    });
  }
}

function pfLoadMore() {
  pfDisplayLimit += PAGE_SIZE;
  _renderGamesList();
}
function buildProfileCard(g, gp) {
  const role    = gameUserRole(g, gp, getCurrentUser());
  const actions = role.isParticipant ? `
    <div class="card-actions">
      <a class="btn btn-ghost btn-sm" href="join.html?game=${g.id}" onclick="pfRememberReturn('${g.id}')">${t('Open')}</a>
      ${role.isCreator ? `<button class="btn btn-danger btn-sm" onclick="pfDeleteGame('${g.id}')">${t('Delete')}</button>` : ''}
    </div>` : '';
  const me = getCurrentUser();
  const card = buildGameCard(g, gp, { isSelf: p => me && p.user_id === me.id, actions, onLocationClick: pfSetLocationFilter, layout: 'rows' });
  card.id = `pf-game-${g.id}`;   // so we can scroll back to it after opening a game
  return card;
}

// ── GAME ACTIONS ──────────────────────────────────────────────────────────────

// Remember which game we're opening so we can scroll back to it on return.
function pfRememberReturn(id) {
  try { sessionStorage.setItem('pfReturnGameId', id); } catch (_) {}
}

function pfDeleteGame(id) {
  openConfirmSheet({
    id:           'pfDeleteGameOverlay',
    title:        t('Delete Game?'),
    bodyHTML:     `<p class="confirm-text">${t('This will permanently delete the game and all player records. This action cannot be undone.')}</p>`,
    confirmLabel: t('Delete Game'),
    busyLabel:    t('Deleting…'),
    danger:       true,
    onConfirm:    () => _pfDeleteGame(id),
  });
}

async function _pfDeleteGame(id) {
  const { error } = await db.from('games').delete().eq('id', id);
  if (error) { alert(error.message); return; }
  await load();
}

// ── SHARE PROFILE QR ─────────────────────────────────────────────────────────

function showProfileQR() {
  if (!pfNick) return;
  const title = document.getElementById('pfQrTitle');
  if (title) title.textContent = t('Share {nick}', { nick: pfNick });
  showQRModal(new URL(`players.html?nick=${encodeURIComponent(pfNick)}`, location.href).href, 'pfQrCode', 'pfQrOverlay');
}

function closeProfileQR() {
  closeOverlay('pfQrOverlay');
}

// The achievement detail overlay handlers (_showAchDetail / _showBoxDetail /
// _showGlobalDetail / _closeAchOverlay) are shared from achievements.js and read
// the context set via setAchievementsContext() in render().

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();
