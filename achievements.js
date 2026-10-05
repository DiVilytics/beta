// ── ACHIEVEMENTS ──────────────────────────────────────────────────────────────
// Compute + render the achievement system: per-character tiers (plays/wins),
// per-box completion, and profile-wide (global) achievements. Depends on
// `groupByBox` / `charImgSrc` (ui.js), `_esc` (db.js) and, for the shared
// section/modal helpers at the bottom, `openOverlay` / `closeOverlay` (ui.js).

const ACH_TIERS = [
  { id: 'bronze', threshold: 1,  label: 'Bronze', icon: '⭐', cupIcon: '🏆' },
  { id: 'silver', threshold: 5,  label: 'Silver', icon: '⭐', cupIcon: '🏆' },
  { id: 'gold',   threshold: 10, label: 'Gold',   icon: '⭐', cupIcon: '🏆' },
];
// Locked / not-yet-earned slots render as a subtle dot rather than a grayed
// trophy/star, so they read as "empty" instead of "dim silver".
const ACH_EMPTY_ICON       = '·';
const ACH_EMPTY_MEDAL_ICON = '·';


function achTierFor(count) {
  let tier = -1;
  for (let i = 0; i < ACH_TIERS.length; i++) {
    if (count >= ACH_TIERS[i].threshold) tier = i;
  }
  return tier;
}

function countAchievements(charAch, allChars) {
  let earned = 0;
  for (const c of allChars) {
    const stats = charAch.get(c.name) || { plays: 0, wins: 0 };
    const pt = achTierFor(stats.plays);
    const wt = achTierFor(stats.wins);
    if (pt >= 0) earned += pt + 1;
    if (wt >= 0) earned += wt + 1;
  }
  return { earned, total: allChars.length * 2 * ACH_TIERS.length };
}

function computeCharacterAchievements(playerRows) {
  const out = new Map();
  for (const p of playerRows) {
    if (!p.character) continue;
    const entry = out.get(p.character) || { plays: 0, wins: 0 };
    entry.plays++;
    if (p.is_winner) entry.wins++;
    out.set(p.character, entry);
  }
  return out;
}

// ── BOX COMPLETION ACHIEVEMENTS ────────────────────────────────────────────────
// Two gold achievements per box: play every character in it, and win with every
// character in it. Binary (gold at completion) rather than tiered, since box
// sizes are small (1–6) and "completion" is all-or-nothing.

// Per-box completion from a character→{plays,wins} map. Returns rows in release
// order: { box, slug, size, played, won }.
function computeBoxCompletion(charAch, allChars, boxInfo) {
  boxInfo = boxInfo || {};
  const byBox = groupByBox(allChars);
  const rows = Object.entries(byBox).map(([box, cs]) => {
    let played = 0, won = 0;
    for (const c of cs) {
      const s = charAch.get(c.name);
      if (s && s.plays > 0) played++;
      if (s && s.wins  > 0) won++;
    }
    return { box, slug: boxInfo[box]?.slug || '', size: cs.length, played, won };
  });
  rows.sort((a, b) =>
    (boxInfo[a.box]?.order ?? 999) - (boxInfo[b.box]?.order ?? 999) || a.box.localeCompare(b.box));
  return rows;
}

function countBoxAchievements(boxRows) {
  let earned = 0;
  for (const r of boxRows) {
    if (r.size > 0 && r.played >= r.size) earned++;
    if (r.size > 0 && r.won    >= r.size) earned++;
  }
  return { earned, total: boxRows.length * 2 };
}

// Compact strip of box covers, grayscale until the box is fully played (then
// full color, mirroring the box picker), with a gold star (played all) and cup
// (won all) marker beneath.
function renderBoxStripHTML(boxRows, onClickFn = '_showBoxDetail') {
  const tiles = boxRows.map(r => {
    const src      = r.slug ? `asset/boxes/${r.slug}.webp` : 'asset/players/default.svg';
    const playDone = r.size > 0 && r.played >= r.size;
    const winDone  = r.size > 0 && r.won    >= r.size;
    return `
      <button class="box-ach${playDone ? ' played' : ''}${winDone ? ' won' : ''}" type="button" data-box="${_esc(r.box)}" onclick="${onClickFn}(this.dataset.box)" title="${_esc(r.box)}">
        <img class="box-ach-img" src="${src}" onerror="this.src='asset/players/default.svg'" alt="${_esc(r.box)}">
        <div class="box-ach-medals">
          <span class="box-ach-medal${playDone ? ' on' : ''}">${playDone ? '⭐' : '·'}</span>
          <span class="box-ach-medal${winDone ? ' on' : ''}">${winDone ? '🏆' : '·'}</span>
        </div>
      </button>`;
  }).join('');
  return `<div class="box-ach-grid">${tiles}</div>`;
}

// Detail sheet for one box: completion status of the two tracks, then a list of
// the box's characters with their played/won marks (so you can see what's left).
function renderBoxDetailHTML(boxRow, boxChars, charAch) {
  const src      = boxRow.slug ? `asset/boxes/${boxRow.slug}.webp` : 'asset/players/default.svg';
  const playDone = boxRow.size > 0 && boxRow.played >= boxRow.size;
  const winDone  = boxRow.size > 0 && boxRow.won    >= boxRow.size;

  const trackRow = (done, count, label, kind) => {
    const isCup = kind === 'cup';
    const tierCls = isCup ? ' ach-cup ach-cup-gold' : ' ach-star ach-star-gold';
    return `
    <div class="ach-track-tier${done ? ' earned' : ''}">
      <span class="ach-track-icon${tierCls}">${isCup ? '🏆' : '⭐'}</span>
      <span class="ach-track-name">${label}</span>
      <span class="ach-track-status">${done ? t('Completed') : `${count} / ${boxRow.size}`}</span>
    </div>`;
  };

  const charList = boxChars.map(c => {
    const s = charAch.get(c.name) || { plays: 0, wins: 0 };
    return `
      <div class="box-detail-char">
        <img class="char-portrait" src="${charImgSrc(c.name)}" onerror="this.src='asset/players/default.svg'" alt="">
        <span class="box-detail-char-name">${villainNameInline(c.name)}</span>
        <span class="box-detail-marks">
          <span class="${s.plays > 0 ? 'on ach-star ach-star-gold' : ''}">${s.plays > 0 ? '⭐' : '·'}</span>
          <span class="${s.wins  > 0 ? 'on ach-cup ach-cup-gold' : ''}">${s.wins  > 0 ? '🏆' : '·'}</span>
        </span>
      </div>`;
  }).join('');

  return `
    <div class="ach-detail-head${winDone ? ' crowned' : ''}">
      <img class="box-detail-cover" src="${src}" onerror="this.src='asset/players/default.svg'" alt="">
      <div class="ach-detail-name">${_esc(boxRow.box)}</div>
    </div>
    <div class="ach-track">
      ${trackRow(playDone, boxRow.played, t('Play all'),  'medal')}
      ${trackRow(winDone,  boxRow.won,    t('Win all'),   'cup')}
    </div>
    <div class="box-detail-list">${charList}</div>`;
}

// ── GLOBAL (PROFILE-WIDE) ACHIEVEMENTS ─────────────────────────────────────────
// Table sizes (played/won at 2p…6p), volume (games/wins, tiered 10/50/100), and
// locations (distinct places played/won, tiered 1/5/10).

const VOLUME_TIERS = [
  { id: 'bronze', threshold: 10,  label: 'Bronze' },
  { id: 'silver', threshold: 50,  label: 'Silver' },
  { id: 'gold',   threshold: 100, label: 'Gold' },
];
const DONE_TIER = [{ id: 'gold', threshold: 1, label: 'Done' }];  // binary: gold at 1

function _tierIndex(count, tiers) {
  let t = -1;
  for (let i = 0; i < tiers.length; i++) if (count >= tiers[i].threshold) t = i;
  return t;
}

// Tiered medal for any tier set, star (plays) / cup (wins), tinted by tier.
function tierMedalHTML(count, tiers, kind) {
  const isCup = kind === 'cup';
  const t = _tierIndex(count, tiers);
  if (t < 0) return `<span class="ach-medal locked">·</span>`;
  const cls = isCup ? `ach-cup ach-cup-${tiers[t].id}` : `ach-star ach-star-${tiers[t].id}`;
  return `<span class="ach-medal ${cls}">${isCup ? '🏆' : '⭐'}</span>`;
}

// Pace bands a character can have, and the 0-based seat positions, for the
// "play/win with every pace" and "play/win from every seat" achievements.
const PACE_KEYS = ['green', 'yellow', 'orange', 'red'];
const SEAT_KEYS = [0, 1, 2, 3, 4, 5];

// Detail panel for a binary "do X for every member of a set" achievement (table
// sizes, pace rainbow, starting position): two gold tracks plus a per-member
// played/won checklist. `members` is [{ label, played, won }].
function _setCompletionDetailHTML(emojiTitle, members, playedLabel, wonLabel) {
  const goldRow = (done, label, kind) => {
    const isCup = kind === 'cup';
    const tierCls = isCup ? ' ach-cup ach-cup-gold' : ' ach-star ach-star-gold';
    return `
      <div class="ach-track-tier${done ? ' earned' : ''}">
        <span class="ach-track-icon${tierCls}">${isCup ? '🏆' : '⭐'}</span>
        <span class="ach-track-name">${label}</span>
        <span class="ach-track-status">${done ? t('Earned') : t('Not yet')}</span>
      </div>`;
  };
  const rows = members.map(m => `
    <div class="box-detail-char">
      <span class="box-detail-char-name">${m.label}</span>
      <span class="box-detail-marks">
        <span class="${m.played > 0 ? 'on ach-star ach-star-gold' : ''}">${m.played > 0 ? '⭐' : '·'}</span>
        <span class="${m.won  > 0 ? 'on ach-cup ach-cup-gold' : ''}">${m.won  > 0 ? '🏆' : '·'}</span>
      </span>
    </div>`).join('');
  return `
    <div class="ach-detail-head"><div class="ach-detail-name">${emojiTitle}</div></div>
    <div class="ach-track">
      ${goldRow(members.every(m => m.played > 0), playedLabel, 'medal')}
      ${goldRow(members.every(m => m.won    > 0), wonLabel,    'cup')}
    </div>
    <div class="box-detail-list">${rows}</div>`;
}

// Compute the viewer's profile-wide stats. `isMine(playerRow)` selects the
// viewer's rows out of all the players of their games. `chars` (the character
// list, each with a `.pace`) powers the pace-rainbow achievement.
function computeGlobalAchievements(games, players, isMine, chars = []) {
  const paceByChar = new Map(chars.map(c => [c.name, c.pace]));

  const countByGame = {};
  const byGame      = {};
  for (const p of players) {
    countByGame[p.game_id] = (countByGame[p.game_id] || 0) + 1;
    (byGame[p.game_id] ||= []).push(p);
  }
  const locByGame = {};
  for (const g of games) locByGame[g.id] = g.location || null;

  const tableSizes = {};
  for (let s = 2; s <= 6; s++) tableSizes[s] = { played: 0, won: 0 };
  const pace = {};
  for (const k of PACE_KEYS) pace[k] = { played: 0, won: 0 };
  const positions = {};
  for (const i of SEAT_KEYS) positions[i] = { played: 0, won: 0 };
  let games_ = 0, wins_ = 0;
  const playedLocs = new Set(),    wonLocs = new Set();
  const playedPlayers = new Set(), wonPlayers = new Set();   // distinct co-players, keyed by nickname

  for (const p of players) {
    if (!isMine(p)) continue;
    games_++;
    const won = !!p.is_winner;
    if (won) wins_++;
    const size = countByGame[p.game_id] || 0;
    if (size >= 2 && size <= 6) {
      tableSizes[size].played++;
      if (won) tableSizes[size].won++;
    }
    const loc = locByGame[p.game_id];
    if (loc) { playedLocs.add(loc); if (won) wonLocs.add(loc); }

    const pc = paceByChar.get(p.character);
    if (pace[pc]) { pace[pc].played++; if (won) pace[pc].won++; }

    if (positions[p.position]) { positions[p.position].played++; if (won) positions[p.position].won++; }

    // The *other* players in this game who have claimed it (have a nickname);
    // unclaimed seats are anonymous and don't count toward distinct players.
    for (const q of byGame[p.game_id] || []) {
      if (isMine(q) || !q.nickname) continue;
      playedPlayers.add(q.nickname);
      if (won) wonPlayers.add(q.nickname);
    }
  }
  return {
    tableSizes,
    pace,
    positions,
    volume:    { games: games_, wins: wins_ },
    locations: { played: playedLocs.size,    won: wonLocs.size },
    players:   { played: playedPlayers.size, won: wonPlayers.size },
  };
}

function countGlobalAchievements(g) {
  let earned = 0, total = 0;
  // Table sizes: a single binary play-all + win-all (across 2p–6p).
  const sizes = [2, 3, 4, 5, 6];
  total += 2;
  if (sizes.every(s => g.tableSizes[s].played > 0)) earned++;
  if (sizes.every(s => g.tableSizes[s].won    > 0)) earned++;
  total += VOLUME_TIERS.length * 2;
  const vg = _tierIndex(g.volume.games, VOLUME_TIERS); if (vg >= 0) earned += vg + 1;
  const vw = _tierIndex(g.volume.wins,  VOLUME_TIERS); if (vw >= 0) earned += vw + 1;
  total += ACH_TIERS.length * 2;
  const lp = _tierIndex(g.locations.played, ACH_TIERS); if (lp >= 0) earned += lp + 1;
  const lw = _tierIndex(g.locations.won,    ACH_TIERS); if (lw >= 0) earned += lw + 1;
  total += ACH_TIERS.length * 2;
  const pp = _tierIndex(g.players.played, ACH_TIERS); if (pp >= 0) earned += pp + 1;
  const pw = _tierIndex(g.players.won,    ACH_TIERS); if (pw >= 0) earned += pw + 1;
  // Pace rainbow + starting position: a single binary play-all + win-all each.
  total += 2;
  if (PACE_KEYS.every(k => g.pace[k].played > 0)) earned++;
  if (PACE_KEYS.every(k => g.pace[k].won    > 0)) earned++;
  total += 2;
  if (SEAT_KEYS.every(i => g.positions[i].played > 0)) earned++;
  if (SEAT_KEYS.every(i => g.positions[i].won    > 0)) earned++;
  return { earned, total };
}

function renderGlobalStripHTML(global, onlyEarned = false, onClickFn = '_showGlobalDetail') {
  const tile = (key, badge, playCount, playTiers, winCount, winTiers) => {
    const earned  = _tierIndex(playCount, playTiers) >= 0 || _tierIndex(winCount, winTiers) >= 0;
    if (onlyEarned && !earned) return '';
    // Crowned when both tracks reach their top tier (fully completed).
    const crowned = _tierIndex(playCount, playTiers) === playTiers.length - 1
                 && _tierIndex(winCount,  winTiers)  === winTiers.length  - 1;
    // Grayed out when no achievement is earned yet on either track.
    return `
      <button class="ach-tile${crowned ? ' crowned' : ''}${earned ? '' : ' dim'}" type="button" data-gl="${key}" onclick="${onClickFn}(this.dataset.gl)">
        <span class="ach-tile-imgwrap"><span class="gl-badge gl-badge-emoji">${badge}</span></span>
        <div class="ach-tile-medals">
          <span aria-label="${t('Plays')}">${tierMedalHTML(playCount, playTiers, 'medal')}</span>
          <span aria-label="${t('Wins')}">${tierMedalHTML(winCount, winTiers, 'cup')}</span>
        </div>
      </button>`;
  };
  const sizes     = [2, 3, 4, 5, 6];
  const playedAll = sizes.every(s => global.tableSizes[s].played > 0);
  const wonAll    = sizes.every(s => global.tableSizes[s].won > 0);
  const tiles = [
    tile('volume',    '👤', global.volume.games,     VOLUME_TIERS, global.volume.wins,   VOLUME_TIERS),
    tile('tables',    '👥', playedAll ? 1 : 0,       DONE_TIER,    wonAll ? 1 : 0,       DONE_TIER),
    tile('locations', '📍', global.locations.played, ACH_TIERS,    global.locations.won, ACH_TIERS),
    tile('players',   '🤝', global.players.played,   ACH_TIERS,    global.players.won,   ACH_TIERS),
    tile('pace',      '🌈', PACE_KEYS.every(k => global.pace[k].played > 0) ? 1 : 0, DONE_TIER, PACE_KEYS.every(k => global.pace[k].won > 0) ? 1 : 0, DONE_TIER),
    tile('positions', '🪑', SEAT_KEYS.every(i => global.positions[i].played > 0) ? 1 : 0, DONE_TIER, SEAT_KEYS.every(i => global.positions[i].won > 0) ? 1 : 0, DONE_TIER),
  ];
  return `<div class="ach-grid">${tiles.join('')}</div>`;
}

function renderGlobalDetailHTML(key, global) {
  // One tier row, colored by tier (bronze/silver/gold) like the character sheet.
  const tierTrack = (count, tiers, label, kind) => {
    const isCup = kind === 'cup';
    const idx   = _tierIndex(count, tiers);
    return `
      <div class="ach-track">
        <div class="ach-track-label">${label} | ${count}</div>
        ${tiers.map((tier, i) => {
          const earned  = i <= idx;
          const tierCls = isCup ? ` ach-cup ach-cup-${tier.id}` : ` ach-star ach-star-${tier.id}`;
          return `<div class="ach-track-tier${earned ? ' earned' : ''}">
            <span class="ach-track-icon${tierCls}">${isCup ? '🏆' : '⭐'}</span>
            <span class="ach-track-name">${t(tier.label)} | ${tier.threshold}</span>
            <span class="ach-track-status">${earned ? t('Earned') : `${count} / ${tier.threshold}`}</span>
          </div>`;
        }).join('')}
      </div>`;
  };
  if (key === 'volume') {
    return `
      <div class="ach-detail-head"><div class="ach-detail-name">👤 ${t('Volume')}</div></div>
      ${tierTrack(global.volume.games, VOLUME_TIERS, t('Games played'), 'medal')}
      ${tierTrack(global.volume.wins,  VOLUME_TIERS, t('Wins'),         'cup')}`;
  }
  if (key === 'locations') {
    return `
      <div class="ach-detail-head"><div class="ach-detail-name">📍 ${t('Locations')}</div></div>
      ${tierTrack(global.locations.played, ACH_TIERS, t('Distinct locations played'), 'medal')}
      ${tierTrack(global.locations.won,    ACH_TIERS, t('Distinct locations won'),    'cup')}`;
  }
  if (key === 'players') {
    return `
      <div class="ach-detail-head"><div class="ach-detail-name">🤝 ${t('Players')}</div></div>
      ${tierTrack(global.players.played, ACH_TIERS, t('Distinct players played with'), 'medal')}
      ${tierTrack(global.players.won,    ACH_TIERS, t('Distinct players beaten'),      'cup')}
      <p class="modal-hint">${t("Only players who've claimed their villain in a game count.")}</p>`;
  }
  if (key === 'tables') {
    return _setCompletionDetailHTML(`👥 ${t('Table sizes')}`,
      [2, 3, 4, 5, 6].map(s => ({ label: t('{n} players', { n: s }), played: global.tableSizes[s].played, won: global.tableSizes[s].won })),
      t('Played every size (2–6p)'), t('Won every size (2–6p)'));
  }
  if (key === 'pace') {
    const names = { green: `🟢 ${t('Green')}`, yellow: `🟡 ${t('Yellow')}`, orange: `🟠 ${t('Orange')}`, red: `🔴 ${t('Red')}` };
    return _setCompletionDetailHTML(`🌈 ${t('Pace rainbow')}`,
      PACE_KEYS.map(k => ({ label: names[k], played: global.pace[k].played, won: global.pace[k].won })),
      t('Played a villain of every pace'), t('Won with a villain of every pace'));
  }
  if (key === 'positions') {
    const ord = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
    return _setCompletionDetailHTML(`🪑 ${t('Starting position')}`,
      SEAT_KEYS.map(i => ({ label: t(`${ord[i]} seat`), played: global.positions[i].played, won: global.positions[i].won })),
      t('Played from every seat (1st–6th)'), t('Won from every seat (1st–6th)'));
  }
  return '';
}

function renderAchievementsGridHTML(charAch, allChars, onClickFn = '_showAchDetail') {
  const topMedal = (count, kind) => {
    const ti = achTierFor(count);
    const isCup = kind === 'cup';
    const emptyIcon = isCup ? ACH_EMPTY_ICON : ACH_EMPTY_MEDAL_ICON;
    if (ti < 0) {
      return `<span class="ach-medal locked" title="${t('None earned ({n})', { n: count })}">${emptyIcon}</span>`;
    }
    const tier = ACH_TIERS[ti];
    const icon = isCup ? tier.cupIcon : tier.icon;
    const tierCls = isCup
      ? ` ach-cup ach-cup-${tier.id}`
      : ` ach-star ach-star-${tier.id}`;
    return `<span class="ach-medal${tierCls}" title="${t(tier.label)} (${count})">${icon}</span>`;
  };
  const tiles = allChars.map(c => {
    const stats = charAch.get(c.name) || { plays: 0, wins: 0 };
    // Crown a character that has reached the top (gold) tier on BOTH plays and wins.
    const goldIdx   = ACH_TIERS.length - 1;
    const bothGold  = achTierFor(stats.plays) === goldIdx && achTierFor(stats.wins) === goldIdx;
    return `
      <button class="ach-tile${bothGold ? ' crowned' : ''}${(stats.plays === 0 && stats.wins === 0) ? ' dim' : ''}" data-char="${_esc(c.name)}" onclick="${onClickFn}(this.dataset.char)" type="button" title="${_esc(villainName(c.name))}">
        <span class="ach-tile-imgwrap">
          <img class="ach-tile-img" src="${charImgSrc(c.name)}" onerror="this.src='asset/players/default.svg'" alt="${_esc(villainName(c.name))}">
        </span>
        <div class="ach-tile-medals">
          <span aria-label="${t('Plays')}">${topMedal(stats.plays, 'medal')}</span>
          <span aria-label="${t('Wins')}">${topMedal(stats.wins, 'cup')}</span>
        </div>
      </button>`;
  }).join('');
  return `
    <div class="ach-grid">${tiles}</div>`;
}

function renderAchievementDetailHTML(charName, stats) {
  stats = stats || { plays: 0, wins: 0 };
  const goldIdx  = ACH_TIERS.length - 1;
  const bothGold = achTierFor(stats.plays) === goldIdx && achTierFor(stats.wins) === goldIdx;
  const track = (count, label, verb, kind) => {
    const tier = achTierFor(count);
    const isCup = kind === 'cup';
    return `
      <div class="ach-track">
        <div class="ach-track-label">${label} | ${count}</div>
        ${ACH_TIERS.map((ti, i) => {
          const earned = i <= tier;
          const cond   = verb === 'Win' ? tn(ti.threshold, 'Win {n} game', 'Win {n} games') : tn(ti.threshold, 'Play {n} game', 'Play {n} games');
          const status = earned ? `${t('Earned')} | ${cond}` : `${count} / ${ti.threshold} | ${cond}`;
          const icon   = isCup ? ti.cupIcon : ti.icon;
          const tierCls = isCup
            ? ` ach-cup ach-cup-${ti.id}`
            : ` ach-star ach-star-${ti.id}`;
          return `<div class="ach-track-tier${earned ? ' earned' : ''}">
            <span class="ach-track-icon${tierCls}">${icon}</span>
            <span class="ach-track-name">${t(ti.label)}</span>
            <span class="ach-track-status">${status}</span>
          </div>`;
        }).join('')}
      </div>`;
  };
  return `
    <div class="ach-detail-head${bothGold ? ' crowned' : ''}">
      <img class="char-portrait identity-portrait" src="${charImgSrc(charName)}" onerror="this.src='asset/players/default.svg'" alt="">
      <div class="ach-detail-name">${villainNameInline(charName)}</div>
    </div>
    ${track(stats.plays, t('Plays'), 'Play', 'medal')}
    ${track(stats.wins,  t('Wins'),  'Win',  'cup')}`;
}

// ── ACHIEVEMENTS SECTION + DETAIL MODAL ────────────────────────────────────────
// Shared by the player profile and the account page, which render the same
// Global / Boxes / Characters strips and wire the same detail overlay (#achOverlay).
// The pages differ only in: whether they show all entries or only earned ones,
// and the section header markup. Set the context once (so the detail handlers
// know which stats to show), then drop the section HTML into a host element.

let _achCtx = null;   // { ach, chars, boxInfo, global, title }

// Provide the data the #achOverlay detail handlers read. Call before/at render.
function setAchievementsContext(ctx) {
  _achCtx = ctx;
}

// Build the Global / Boxes / Characters achievement section.
//   ach, chars, boxInfo, global – the viewer's computed achievement data
//   onlyEarned – true on the profile (show only earned), false on the account page
//   header(earned, total) – returns the section's header markup
function achievementsSectionHTML({ ach, chars, boxInfo, global, onlyEarned = false, header }) {
  const ch  = countAchievements(ach, chars);
  const box = computeBoxCompletion(ach, chars, boxInfo);
  const bc  = countBoxAchievements(box);
  const gc  = global ? countGlobalAchievements(global) : { earned: 0, total: 0 };
  const totalEarned = ch.earned + bc.earned + gc.earned;
  const totalAll    = ch.total  + bc.total  + gc.total;

  // The profile shows only what's been earned; the account page shows everything.
  const boxesToShow = onlyEarned
    ? box.filter(r => r.size > 0 && (r.played >= r.size || r.won >= r.size))
    : box;
  const charsToShow = onlyEarned
    ? chars.filter(c => { const s = ach.get(c.name); return s && (s.plays > 0 || s.wins > 0); })
    : chars;

  return `
    ${header(totalEarned, totalAll)}
    ${global ? `
      <div class="ach-group-label">${t('Global')} | ${gc.earned} / ${gc.total}</div>
      ${renderGlobalStripHTML(global, onlyEarned)}` : ''}
    <div class="ach-group-label">${t('Boxes')} | ${bc.earned} / ${bc.total}</div>
    ${renderBoxStripHTML(boxesToShow)}
    <div class="ach-group-label">${t('Villains')} | ${ch.earned} / ${ch.total}</div>
    ${renderAchievementsGridHTML(ach, charsToShow)}`;
}

function _achModal(html) {
  const body  = document.getElementById('achBody');
  const title = document.getElementById('achTitle');
  if (!body || !title || !_achCtx) return;
  title.textContent = _achCtx.title || t('Achievements');
  body.innerHTML = html;
  openOverlay('achOverlay');
}

function _showAchDetail(charName) {
  _achModal(renderAchievementDetailHTML(charName, _achCtx?.ach.get(charName)));
}

function _showBoxDetail(boxName) {
  if (!_achCtx) return;
  const row = computeBoxCompletion(_achCtx.ach, _achCtx.chars, _achCtx.boxInfo).find(r => r.box === boxName);
  if (!row) return;
  _achModal(renderBoxDetailHTML(row, groupByBox(_achCtx.chars)[boxName] || [], _achCtx.ach));
}

function _showGlobalDetail(key) {
  if (!_achCtx?.global) return;
  _achModal(renderGlobalDetailHTML(key, _achCtx.global));
}

function _closeAchOverlay() { closeOverlay('achOverlay'); }
