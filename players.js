// ── STATE ─────────────────────────────────────────────────────────────────────

let pfNick      = '';
let pfGames     = [];   // official games this nickname appeared in
let pfPlayers   = [];   // all players for those games
let pfSolo      = { games: [], players: [] };   // their solo games (solo.js), a world of their own
let pfCharBoxMap  = {};
let pfAllChars  = [];
let pfAch       = new Map();
let pfBoxInfo   = {};
let pfGlobal    = null;
let pfFriends   = [];   // top co-players by shared games (filter-independent)
let pfLoaded    = false;  // the filters show before the games: render() waits for them

let pfMode           = 'pct';   // 'pct' | 'count' | 'games'
let pfWinsOnly       = false;
let pfAchAll         = false;   // achievements: the earned ones, or (Show all) every one
let pfLocationFilter = null;

// The table size, All / 2p…6p / Solo (size-filter.js), and the period, All
// time / Year / Month (period-filter.js), its menus starting from this player's
// first dated game. They filter the stats, the villain table and the games;
// achievements and Most played with stay all-time. Solo shows the solo games
// only, without achievements or Most played with (solo games have neither).
const size   = createSizeFilter('pfSize', { onChange: () => render() });
const period = createPeriodFilter('pfPeriod', { onChange: () => render() });

let pfDisplayLimit   = PAGE_SIZE;

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('players.html');
  const authReady = initAuth();
  _attachPlayerSearch();

  const params = new URLSearchParams(location.search);
  pfNick = (params.get('nick') || '').trim();

  // The nickname in the link is enough for the name, Share and the filters: they
  // show at once, the avatar as soon as the profile arrives, the stats last. Your
  // own page (no nickname in the link) waits for the sign-in, which brings your
  // profile along.
  let profileReady;
  if (pfNick) {
    profileReady = fetchProfile({ nickname: pfNick }, 'avatar_url, default_avatar, created_at');
  } else {
    await authReady;
    const loggedUser    = getCurrentUser();
    const loggedProfile = getCurrentProfile();
    if (loggedUser && loggedProfile?.nickname) {
      pfNick = loggedProfile.nickname;
      profileReady = Promise.resolve(loggedProfile);
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
  _renderIdentity();
  setVisible('pfControls', true);
  profileReady.then(_renderIdentity);

  // A language switch brings back the filters and the games loaded (lang.js).
  const saved = takeViewState();
  if (saved) {
    pfMode = saved.mode; pfWinsOnly = saved.winsOnly; pfLocationFilter = saved.location; pfAchAll = !!saved.achAll;
    size.set(saved.filter);
    period.set(saved.period);
  }
  keepViewState(() => ({
    filter: size.value(), mode: pfMode, winsOnly: pfWinsOnly, location: pfLocationFilter, achAll: pfAchAll,
    period: period.get(), limit: pfDisplayLimit,
  }));

  const [chars, boxInfo] = await Promise.all([loadCharacters(), loadBoxInfo(), authReady]);
  pfAllChars   = chars;
  pfBoxInfo    = boxInfo || {};
  pfCharBoxMap = Object.fromEntries(chars.map(c => [c.name, c.box]));

  await load();
  if (saved?.limit > pfDisplayLimit && document.getElementById('pfGamesList')) {
    pfDisplayLimit = saved.limit;
    _renderGamesList();
  }
}

// Avatar, nickname, "Since" and Share. Called first without the profile: an
// empty circle holds the avatar's place and a blank line the date's, so nothing
// moves when they arrive. A name without a profile gets the default avatar and
// keeps the blank line.
function _renderIdentity(profile) {
  const avatar = profile === undefined
    ? '<span class="player-avatar-lg pf-avatar-ph"></span>'
    : avatarHTML(resolveAvatar(profile), { cls: 'player-avatar-lg', extraClass: 'zoomable', id: 'pfAvatar', lightbox: true });
  const since = profile?.created_at ? t('Since {date}', { date: fmtDateShort(profile.created_at) }) : '&nbsp;';
  document.getElementById('pfIdentity').innerHTML =
    `<div class="pf-identity-row">
      <span class="pf-identity">${avatar}<span class="pf-name-block"><span class="pf-nick">${_esc(pfNick)}</span><span class="pf-since">${since}</span></span></span>
      <button class="btn btn-ghost btn-sm pf-share-btn" onclick="showProfileQR()">${t('Share')}</button>
    </div>`;
}

async function load() {
  // The games this nickname played and, on your own profile, the games you
  // created, even ones you haven't claimed a villain in (e.g. after releasing
  // your claim): otherwise such a game would vanish from your profile, taking
  // its manage/QR actions with it. Both at once.
  const me      = getCurrentUser();
  const profile = getCurrentProfile();
  const own     = me && profile && profile.nickname === pfNick;
  const [{ rows: myRows, error }, created] = await Promise.all([
    _fetchAllRows(() => db.from('game_players').select('game_id').eq('nickname', pfNick)),
    own ? _fetchAllRows(() => db.from('games').select('id').eq('created_by', me.id)) : null,
  ]);

  if (error) {
    setVisible('pfControls', false);
    document.getElementById('pfRoot').className = '';
    document.getElementById('pfRoot').innerHTML =
      `<div class="empty"><p>${t('Error: {message}', { message: _esc(error.message) })}</p></div>`;
    return;
  }

  const gameIds = [...new Set(myRows.map(r => r.game_id).concat((created?.rows || []).map(r => r.id)))];

  const all = await fetchGamesWithPlayers(gameIds, { orderByPlayedAtDesc: true, variant: 'any' });
  const { games, players } = gamesOfVariant(all);
  pfGames   = games;
  pfPlayers = players;
  pfSolo    = gamesOfVariant(all, 'solo');
  pfAch     = computeCharacterAchievements(players.filter(p => p.nickname === pfNick));
  pfGlobal  = computeGlobalAchievements(games, players, p => p.nickname === pfNick, pfAllChars);
  pfFriends = await _loadFriends();
  pfLoaded  = true;
  // Oldest first: the games come newest first, undated ones last.
  period.setFirst(all.games.map(g => g.played_at).filter(Boolean).sort()[0] || null);

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

// The achievements: the earned ones, or every one with Show all (the pill in
// their header, like Wins only on the games).
function _achievementsHTML() {
  return achievementsSectionHTML({
    ach: pfAch, chars: pfAllChars, boxInfo: pfBoxInfo, global: pfGlobal,
    onlyEarned: !pfAchAll,
    header: (earned, total) => `
      <div class="pf-games-header">
        <span class="pf-games-title">${t('Achievements')} | ${earned} / ${total}</span>
        <button class="pill${pfAchAll ? ' on' : ''}" onclick="pfToggleAchAll()" type="button">${t('Show all')}</button>
      </div>`,
  });
}

function pfToggleAchAll() {
  pfAchAll = !pfAchAll;
  const box = document.getElementById('pfAch');
  if (box) box.innerHTML = _achievementsHTML();
}

// ── CONTROLS ──────────────────────────────────────────────────────────────────

function pfSetMode(m) {
  pfMode = m;
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

// The games the page is showing: the official ones, or on Solo the solo ones.
const _pfData = () => size.isSolo() ? pfSolo : { games: pfGames, players: pfPlayers };

function pfFilteredGameIds() {
  let { games, players } = _pfData();
  const n = size.value();
  if (typeof n === 'number') {
    const countMap = {};
    for (const p of players) countMap[p.game_id] = (countMap[p.game_id] || 0) + 1;
    games = games.filter(g => countMap[g.id] === n);
  }
  if (pfLocationFilter) games = games.filter(g => g.location === pfLocationFilter);
  if (!period.isAll()) {
    const { from_ts, to_ts } = period.range();
    const from = new Date(from_ts), to = new Date(to_ts);
    games = games.filter(g => g.played_at && new Date(g.played_at) >= from && new Date(g.played_at) < to);
  }
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
  if (!pfLoaded) return;
  pfDisplayLimit = PAGE_SIZE;
  const root = document.getElementById('pfRoot');

  const solo    = size.isSolo();
  const data    = _pfData();
  const keepIds = pfFilteredGameIds();
  const games   = data.games.filter(g => keepIds.has(g.id));
  const mine    = data.players.filter(p => keepIds.has(p.game_id) && p.nickname === pfNick);

  const wins   = mine.filter(p => p.is_winner).length;
  const nGames = mine.length;
  const winPct = nGames ? Math.round((wins / nGames) * 100) : 0;

  // Longest run of consecutive wins, chronological, within the current filter.
  const atById = {};
  for (const g of data.games) atById[g.id] = g.played_at;
  let bestStreak = 0, streakRun = 0;
  for (const p of [...mine].sort((a, b) => new Date(atById[a.game_id]) - new Date(atById[b.game_id]))) {
    if (p.is_winner) { streakRun++; if (streakRun > bestStreak) bestStreak = streakRun; }
    else streakRun = 0;
  }
  // The loop ends on the latest game, so streakRun is the current streak. When it
  // equals the best one the player is on their record run right now: only said
  // for a period that reaches today (All time, this year, this month).
  const { to_ts } = period.range();
  const reachesToday = !to_ts || new Date(to_ts) > new Date();
  const onBestStreak = reachesToday && bestStreak > 0 && streakRun === bestStreak;

  const avgDur   = avg(games.map(g => g.duration_minutes));
  const avgTurns = avg(games.map(g => g.num_turns));

  setAchievementsContext({
    ach: pfAch, chars: pfAllChars, boxInfo: pfBoxInfo, global: pfGlobal,
    title: pfNick ? `${t('Achievements')} | ${pfNick}` : t('Achievements'),
  });
  // All-time sections, shown whatever the filters (not on Solo).
  const achHTML = solo ? '' : `<div id="pfAch">${_achievementsHTML()}</div>`;

  const soloHint = solo ? soloHintHTML() : '';
  const friends  = solo ? '' : _friendsSectionHTML();

  // No games: the sentence takes the place of the stats, the filters stay. A
  // player who never played has no achievements to show either.
  if (!nGames) {
    root.innerHTML = solo && !pfSolo.games.length
      ? `${soloHint}<div class="empty"><div class="empty-icon">🎲</div><h3>${t('No solo games yet')}</h3><p>${t("{nick} hasn't recorded any solo games.", { nick: _esc(pfNick) })}</p></div>`
      : data.games.length
      ? `${soloHint}<div class="empty"><div class="empty-icon">🔍</div><h3>${t('No games for this filter')}</h3><p>${t('Try adjusting the filters.')}</p></div>
        ${friends}
        ${achHTML}`
      : `<div class="empty"><div class="empty-icon">⚔️</div><h3>${t('No games yet')}</h3><p>${t("{nick} hasn't played any recorded games.", { nick: _esc(pfNick) })}</p></div>`;
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

  root.innerHTML = `
    ${soloHint}
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
      getNameHTML: villainNameInline,
      getHref:     key => `villains.html?vil=${encodeURIComponent(key)}`,
      getIdentity: key => charImgHTML(key),
      getSub:      key => pfCharBoxMap[key],
      getSubHref:  key => pfCharBoxMap[key] ? `villains.html?box=${boxAnchorId(pfCharBoxMap[key])}` : '',
      wrapClass:   'mb-1-25',
    })}

    ${friends}

    ${achHTML}

    <div class="pf-games-header">
      <span class="pf-games-title">${t('Games')}</span>
      ${pfLocationFilter ? locationFilterPillHTML(pfLocationFilter, 'pfClearLocationFilter') : ''}
      <button class="pill${pfWinsOnly ? ' on' : ''}" id="pfWinsOnlyBtn" onclick="pfToggleWinsOnly()" type="button">${t('Wins only')}</button>
    </div>
    <div class="games-list" id="pfGamesList"></div>
  `;

  _renderGamesList(keepIds);
}

let _pfScrollToId = null;

function _renderGamesList(keepIds = pfFilteredGameIds()) {
  const data = _pfData();
  let games = data.games.filter(g => keepIds.has(g.id));

  if (pfWinsOnly) {
    const winGameIds = new Set(
      data.players.filter(p => keepIds.has(p.game_id) && p.nickname === pfNick && p.is_winner).map(p => p.game_id)
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
  for (const p of data.players) (byGame[p.game_id] ||= []).push(p);
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
      <a class="btn btn-ghost btn-sm" href="claim.html?game=${g.id}" onclick="pfRememberReturn('${g.id}')">${t('Open')}</a>
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
    title:        t('Delete game?'),
    bodyHTML:     `<p class="confirm-text">${t('This will permanently delete the game and all player records. This action cannot be undone.')}</p>`,
    confirmLabel: t('Delete game'),
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
