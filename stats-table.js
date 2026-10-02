// ── STATS TABLE ────────────────────────────────────────────────────────────────
// The shared "rank | identity | bar | value | sub" stat table used by the
// leaderboard and the player profile, plus the summary stat-box trio and the
// sort/rank/bar maths behind them. Depends on `_esc` (db.js).

// Renders the standard summary trio: e.g.
//   statBoxesHTML([{ val: '12', lbl: 'Games' }, { val: '23m', lbl: 'Avg duration' }])
// Returns an HTML string of three `.stat-box` divs (no wrapping element).
// A box may set `hot: true` (+ an optional `title` tooltip) to be highlighted,
// for a stat that is currently sitting at its record.
function statBoxesHTML(boxes) {
  return boxes.map(b =>
    `<div class="stat-box${b.hot ? ' hot' : ''}"${b.title ? ` title="${_esc(b.title)}"` : ''}><div class="stat-val">${b.val}</div><div class="stat-lbl">${b.lbl}</div></div>`
  ).join('');
}

// ── STAT MODE: the pct | count | games metric shared by every win-rate surface ──
// statValue → the numeric metric (pct is a 0..1 fraction); statValueDisplay →
// the formatted primary cell; *Label → column headers; statSecondary* → the
// trailing "# Games" / "# Wins" column. statModeSegHTML renders the toggle
// control (`fn` is the global handler name the buttons call, e.g. 'setMode').
function statValue(r, mode) {
  if (mode === 'count') return r.wins;
  if (mode === 'games') return r.games;
  return r.games ? r.wins / r.games : 0;
}
function statValueDisplay(r, mode) {
  if (mode === 'count') return r.wins;
  if (mode === 'games') return r.games;
  return (r.games ? Math.round((r.wins / r.games) * 100) : 0) + '%';
}
function statValueLabel(mode)        { return mode === 'count' ? '# Wins' : mode === 'games' ? '# Games' : '% Wins'; }
function statSecondaryValue(r, mode) { return mode === 'games' ? r.wins : r.games; }
function statSecondaryLabel(mode)    { return mode === 'games' ? '# Wins' : '# Games'; }

function statModeSegHTML(mode, fn) {
  const btn = (m, label) =>
    `<button class="seg-btn ${mode === m ? 'on' : ''}" type="button" onclick="${fn}('${m}')">${label}</button>`;
  return `<div class="controls mb-1"><div class="seg">${btn('pct', '% Wins')}${btn('count', '# Wins')}${btn('games', '# Games')}</div></div>`;
}

function sortStatRows(rows, mode) {
  const sorted = [...rows];
  if (mode === 'count') return sorted.sort((a, b) => b.wins - a.wins || b.games - a.games);
  if (mode === 'games') return sorted.sort((a, b) => b.games - a.games || b.wins - a.wins);
  return sorted.sort((a, b) => {
    const pa = a.games ? a.wins / a.games : 0;
    const pb = b.games ? b.wins / b.games : 0;
    // Tiebreak by wins then games, so e.g. 0% with games ranks above 0 games.
    return pb - pa || b.wins - a.wins || b.games - a.games;
  });
}

function computeRanks(rows, mode) {
  const primaryVal = r => statValue(r, mode);
  const ranks = [];
  for (let i = 0; i < rows.length; i++) {
    ranks.push(i === 0 || primaryVal(rows[i]) !== primaryVal(rows[i - 1]) ? i + 1 : ranks[i - 1]);
  }
  return ranks;
}

// Bar width as a % of the largest value across rows in the current mode.
function statBarWidth(r, mode, maxVal) {
  return Math.round((statValue(r, mode) / (maxVal || 1)) * 100);
}

// Anchor id for a character's box group on the characters roster page.
function boxAnchorId(box) {
  return 'box-' + String(box || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Renders the rank | identity | bar | value | sub stat table. Used by the
// leaderboard and the player profile (the character-detail stat table has a
// different shape and is built inline in villains.js).
//
// Required opts:
//   mode          : 'pct' | 'count' | 'games'
//   headLabel     : column header for the identity column ("Character" | "Player")
//   getKey(r)     : returns the row's display name (string)
//   getHref(key)  : returns the link target
//   getIdentity(key): returns the inline HTML for the row's avatar/portrait
//   getSub(key)   : optional, returns small grey sub-text under the name
//   wrapClass     : optional extra class on the `lb-table` wrapper
//   limit         : render only the top N rows (default: all).
//   selfKey       : highlight the row whose key matches; if that row falls beyond
//                   `limit`, pin it at the bottom under a "Your position" divider
//                   so the viewer always sees their standing for the current sort.
function renderStatTableHTML(rows, opts) {
  const { mode, headLabel, getKey, getHref, getIdentity, getSub, getSubHref,
          wrapClass = '', limit = Infinity, selfKey = null } = opts;
  const sorted = sortStatRows(rows, mode);

  const maxVal = Math.max(...sorted.map(r => statValue(r, mode))) || 1;

  const ranks      = computeRanks(sorted, mode);
  const medalClass = rank => rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';

  const rowHTML = (r, i) => {
    const rank    = ranks[i];
    const key     = getKey(r);
    const barW    = statBarWidth(r, mode, maxVal);
    const dispVal = statValueDisplay(r, mode);
    const dispSub = statSecondaryValue(r, mode);
    const sub     = getSub ? (getSub(key, r) || '') : '';
    const subHref = (sub && getSubHref) ? (getSubHref(key, r) || '') : '';
    const selfCls = (selfKey != null && key === selfKey) ? ' lb-row-self' : '';
    // The name and the box are each their own link (to the character/player and to
    // the box), rather than one row-wide anchor, so each is independently clickable.
    return `
      <div class="lb-row${selfCls}">
        <div class="rank-num ${medalClass(rank)}">${rank}</div>
        <div class="row-identity">
          ${getIdentity(key, r)}
          <div class="row-id-text">
            <a class="row-name row-name-link" href="${getHref(key, r)}">${_esc(key)}</a>
            ${sub ? (subHref
              ? `<a class="row-sub row-sub-link" href="${_esc(subHref)}" title="View ${_esc(sub)} villains">${_esc(sub)}</a>`
              : `<div class="row-sub">${_esc(sub)}</div>`) : ''}
          </div>
        </div>
        <div class="bar-cell">
          <div class="bar-bg">
            <div class="bar-fill${rank === 1 ? ' gold' : ''}" style="width:${barW}%"></div>
          </div>
        </div>
        <div class="row-val">${dispVal}</div>
        <div class="row-games">${dispSub}</div>
      </div>`;
  };

  let body = sorted.slice(0, limit).map((r, i) => rowHTML(r, i)).join('');

  // Pin the viewer's row if it ranks below the visible cut.
  const selfIdx = selfKey != null ? sorted.findIndex(r => getKey(r) === selfKey) : -1;
  if (selfIdx >= limit) {
    body += `<div class="lb-row-sep">Your position</div>${rowHTML(sorted[selfIdx], selfIdx)}`;
  }

  return `
    <div class="lb-table${wrapClass ? ' ' + wrapClass : ''}">
      <div class="lb-head">
        <span>#</span>
        <span>${headLabel}</span>
        <span></span>
        <span class="text-right">${statValueLabel(mode)}</span>
        <span class="text-right">${statSecondaryLabel(mode)}</span>
      </div>
      ${body}
    </div>`;
}
