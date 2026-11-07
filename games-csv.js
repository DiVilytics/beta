// ── GAMES CSV ────────────────────────────────────────────────────────────────
// The account page's games file, both ways: Download my data writes it
// (account.js) and Upload games reads it back. One row per player per game,
// these columns in this order (GAMES_CSV_HEADER), values in English whatever
// the page's language. An upload is checked whole before anything is written:
// one wrong row and nothing goes in. Then a summary, and only on Upload are the
// games added, recorded by you (created_by), as if saved in New Game.
//   Game ID   groups a game's rows; any label for a new game (1, 2, 3...). One
//             already in DiVilytics (its id, from a download) is skipped.
//   Date      YYYY-MM-DD HH:MM, YYYY-MM-DD (at 12:00) or empty (no date); not
//             in the future.
//   Player    your nickname on your villain (claims it) or empty: nobody else's.
//   Seat      the play order, 1 to the players, or empty on every row.
//   Winner    yes / no, one yes (Solo: yes is won, no is lost).
//   Solo      yes / no; a solo game is one row, yours, with its Difficulty.
// Depends on db.js, ui.js (overlays), solo.js (SOLO_LEVELS) and shared.js
// (the signed-in user and profile).

const GAMES_CSV_HEADER = ['Game ID', 'Date', 'Location', 'Duration (min)', 'Rounds', 'Player', 'Villain', 'Seat', 'Winner', 'Solo', 'Difficulty'];
const GAMES_CSV_MAX_GAMES = 2000;   // per file: larger files go in parts
const GAMES_CSV_LEVELS    = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };   // a solo game's level, as written

// A CSV field, quoted when it has to be.
function csvField(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Rows of fields from CSV text: quoted fields (commas, quotes, line breaks
// inside), \r\n or \n, a leading BOM (spreadsheets add one). Each row keeps the
// line it starts on, for the error messages.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, line = 1, rowLine = 1;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else { if (c === '\n') line++; field += c; }
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push({ line: rowLine, cells: row });
      row = []; field = ''; line++; rowLine = line;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push({ line: rowLine, cells: row }); }
  return rows.filter(r => r.cells.some(c => c.trim() !== ''));   // blank lines
}

// "YYYY-MM-DD HH:MM" (or with a T), "YYYY-MM-DD" at 12:00, in local time, as
// New Game; '' is no date. Returns an ISO string, null for no date, or
// undefined when it isn't a date.
function _csvParseDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!m) return undefined;
  const [y, mo, d, h = 12, mi = 0] = m.slice(1).map(x => x === undefined ? undefined : Number(x));
  const dt = new Date(y, mo - 1, d, h, mi);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d || dt.getHours() !== h || dt.getMinutes() !== mi) return undefined;
  return dt.toISOString();
}

// Checks a whole file. Returns { errors: [line, message][], games (to add),
// skipped (already in DiVilytics), seats, mine (games with your villain) }.
async function checkGamesCsv(text) {
  const errors = [];
  const err = (line, msg) => errors.push([line, msg]);
  const rows = parseCsv(text);
  const head = (rows.shift()?.cells || []).map(c => c.trim());
  if (head.join('|') !== GAMES_CSV_HEADER.join('|')) {
    err(1, t('The first row must be exactly: {header}', { header: GAMES_CSV_HEADER.join(', ') }));
    return { errors };
  }

  const profile = getCurrentProfile();
  const nick    = (profile?.nickname || '').toLowerCase();
  const names   = new Set((await loadCharacters()).map(c => c.name));
  const col     = Object.fromEntries(GAMES_CSV_HEADER.map((h, i) => [h, i]));
  const yesNo   = v => ({ yes: true, no: false })[v.toLowerCase()];

  // A game's rows, in file order.
  const byId = new Map();
  for (const r of rows) {
    if (r.cells.length !== GAMES_CSV_HEADER.length) { err(r.line, t('Expected {n} columns, found {m}.', { n: GAMES_CSV_HEADER.length, m: r.cells.length })); continue; }
    const v = Object.fromEntries(GAMES_CSV_HEADER.map(h => [h, r.cells[col[h]].trim()]));
    if (!v['Game ID']) { err(r.line, t('Game ID is empty.')); continue; }
    if (!byId.has(v['Game ID'])) byId.set(v['Game ID'], []);
    byId.get(v['Game ID']).push({ line: r.line, v });
  }
  if (byId.size > GAMES_CSV_MAX_GAMES) err(2, t('At most {n} games per file: split it in parts.', { n: GAMES_CSV_MAX_GAMES }));

  // Game IDs already in DiVilytics: those games are skipped.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const asIds = [...byId.keys()].filter(id => uuid.test(id));
  const existing = new Set(asIds.length
    ? (await _fetchInChunks(asIds, chunk => db.from('games').select('id').in('id', chunk))).map(g => g.id.toLowerCase())
    : []);

  const games = [], skipped = [];
  let seats = 0, mine = 0;
  for (const [id, rs] of byId) {
    if (existing.has(id.toLowerCase())) { skipped.push(id); continue; }
    const first = rs[0], at = first.line;
    const sameGame = ['Date', 'Location', 'Duration (min)', 'Rounds', 'Solo', 'Difficulty'];
    const differ = sameGame.find(h => rs.some(r => r.v[h] !== first.v[h]));
    if (differ) { err(at, t('Game {id}: its rows have different values in {column}.', { id, column: differ })); continue; }

    const g = first.v;
    const playedAt = _csvParseDate(g.Date);
    if (playedAt === undefined) err(at, t('Game {id}: {value} is not a date (YYYY-MM-DD HH:MM or YYYY-MM-DD).', { id, value: g.Date }));
    else if (playedAt && new Date(playedAt) > new Date()) err(at, t('Game {id}: the date is in the future.', { id }));
    const whole = (h, max = Infinity) => {
      if (!g[h]) return null;
      const n = Number(g[h]);
      if (!Number.isInteger(n) || n < 1 || n > max) {
        err(at, max < Infinity ? t('Game {id}: {column} must be a whole number from 1 to {max} (a solo game on {level}).', { id, column: h, max, level: GAMES_CSV_LEVELS[level] })
                               : t('Game {id}: {column} must be a whole number from 1.', { id, column: h }));
        return null;
      }
      return n;
    };
    const solo = yesNo(g.Solo);
    if (solo === undefined) { err(at, t('Game {id}: Solo must be yes or no.', { id })); continue; }
    const level = Object.keys(GAMES_CSV_LEVELS).find(k => GAMES_CSV_LEVELS[k].toLowerCase() === g.Difficulty.toLowerCase());
    if (solo && !level) err(at, t('Game {id}: a solo game needs its Difficulty: Easy, Medium or Hard.', { id }));
    if (!solo && g.Difficulty) err(at, t('Game {id}: only a solo game has a Difficulty.', { id }));
    const dur   = whole('Duration (min)');
    const turns = whole('Rounds', solo && level ? SOLO_LEVELS[level].turns : Infinity);
    if (g.Location.length > 60) err(at, t('Game {id}: the location is longer than 60 characters.', { id }));

    // Its seats.
    const ps = [];
    for (const { line, v } of rs) {
      if (!names.has(v.Villain)) err(line, t('{villain} is not a DiVilytics villain (as written on its page, e.g. Captain Hook [I2E]).', { villain: v.Villain || '-' }));
      const won = yesNo(v.Winner);
      if (won === undefined) err(line, t('Winner must be yes or no.'));
      const isMe = v.Player !== '' && v.Player.toLowerCase() === nick;
      if (v.Player && !isMe) err(line, t("{player} isn't you: Player is your nickname on your villain, or empty (the others claim theirs with the game's QR code).", { player: v.Player }));
      ps.push({ line, character: v.Villain, is_winner: !!won, isMe, seat: v.Seat });
    }
    if (solo) {
      if (ps.length !== 1) err(at, t('Game {id}: a solo game has one row, yours.', { id }));
    } else {
      if (ps.length < 2 || ps.length > 6) err(at, t('Game {id}: a game has 2 to 6 players.', { id }));
      if (new Set(ps.map(p => p.character)).size !== ps.length) err(at, t('Game {id}: each player must use a different villain.', { id }));
      if (ps.filter(p => p.is_winner).length !== 1) err(at, t('Game {id}: exactly one winner (yes).', { id }));
      if (ps.filter(p => p.isMe).length > 1) err(at, t('Game {id}: your nickname is on more than one row.', { id }));
    }
    // The play order: 1 to the players, each once, or empty on every row.
    const seatsGiven = ps.filter(p => p.seat !== '');
    if (seatsGiven.length && (seatsGiven.length !== ps.length
        || [...ps.map(p => Number(p.seat))].sort((a, b) => a - b).join() !== ps.map((_, i) => i + 1).join())) {
      err(at, t('Game {id}: Seat is the play order, 1 to {n}, each once, or empty on every row.', { id, n: ps.length }));
    }

    games.push({
      game: { played_at: playedAt ?? null, duration_minutes: dur, num_turns: turns, location: g.Location || null,
              ...(solo ? { variant: 'solo', solo_level: level } : {}) },
      // Solo: the one seat is yours, as in New Game.
      seats: ps.map(p => ({ character: p.character, is_winner: p.is_winner, mine: solo || p.isMe,
                            position: solo ? 0 : seatsGiven.length ? Number(p.seat) - 1 : null })),
    });
    seats += ps.length;
    if (solo || ps.some(p => p.isMe)) mine++;
  }
  errors.sort((a, b) => a[0] - b[0]);
  return { errors, games, skipped, seats, mine };
}

// Adds the checked games, 100 at a time. A failure takes back every game
// added so far (their seats go with them), so a file goes in whole or not at all.
async function uploadGames(games) {
  const user = getCurrentUser(), profile = getCurrentProfile();
  const added = [];
  try {
    for (let i = 0; i < games.length; i += 100) {
      const batch = games.slice(i, i + 100).map(x => ({ ...x, id: crypto.randomUUID() }));
      const { error } = await db.from('games').insert(batch.map(x => ({ id: x.id, ...x.game, created_by: user.id, source: 'divilytics' })));
      if (error) throw error;
      added.push(...batch.map(x => x.id));
      const { error: seatsErr } = await db.from('game_players').insert(batch.flatMap(x => x.seats.map(s => ({
        game_id: x.id, character: s.character, is_winner: s.is_winner, position: s.position,
        user_id: s.mine ? user.id : null, nickname: s.mine ? profile.nickname : null,
      }))));
      if (seatsErr) throw seatsErr;
    }
    return { error: null };
  } catch (error) {
    for (let i = 0; i < added.length; i += 100) await db.from('games').delete().in('id', added.slice(i, i + 100));
    return { error };
  }
}

// ── THE SHEET (Upload games, account page) ───────────────────────────────────
// What the file is, an example, the empty file to fill in, then the file
// picked: what's wrong (nothing uploaded), or the summary and Upload.

const _GAMES_CSV_EXAMPLE = [
  ['1', '2026-10-12 21:30', 'Home', '75', '9', '', 'Maleficent', '1', 'no', 'no', ''],
  ['1', '2026-10-12 21:30', 'Home', '75', '9', 'NICK', 'Captain Hook', '2', 'yes', 'no', ''],
  ['1', '2026-10-12 21:30', 'Home', '75', '9', '', 'Ursula [I2E]', '3', 'no', 'no', ''],
  ['2', '', '', '', '', 'NICK', 'Jafar', '', 'no', 'no', ''],
  ['2', '', '', '', '', '', 'Hades', '', 'yes', 'no', ''],
  ['3', '', '', '40', '14', 'NICK', 'Yzma', '', 'yes', 'yes', 'Medium'],
];
let _gamesCsvChecked = null;

function openUploadGames() {
  const body = infoSheet('uploadGamesOverlay', t('Upload games'));
  const nick = getCurrentProfile()?.nickname || t('your nickname');
  const ex = _GAMES_CSV_EXAMPLE.map(r => r.map(c => c === 'NICK' ? nick : c));
  const p = s => `<p class="modal-hint">${s}</p>`;
  const cols = [
    ['Game ID', t('Groups the rows of one game: any label for a new game (1, 2, 3...). A game already in DiVilytics (its ID from a download) is skipped.')],
    ['Date', t('YYYY-MM-DD HH:MM, YYYY-MM-DD (taken at 12:00), or empty for no date. Not in the future.')],
    ['Location', t('Optional.')],
    ['Duration (min), Rounds', t('Optional, whole numbers.')],
    ['Player', t('Your nickname on your villain, which claims it; empty on the others (they claim theirs with the game\'s QR code).')],
    ['Villain', t('As written on its page, e.g. Captain Hook [I2E].')],
    ['Seat', t('The play order, 1 to the players, or empty on every row of the game.')],
    ['Winner', t('yes or no: one yes per game (Solo: yes if you won).')],
    ['Solo', t('yes or no. A solo game is one row, yours.')],
    ['Difficulty', t('Solo only: Easy, Medium or Hard.')],
  ];
  body.innerHTML =
    p(t('Add games from a CSV file in the format of <em>Download my data</em>: one row per player per game, these columns in this order. The file is checked first: if a row is wrong, nothing is uploaded.')) +
    `<dl class="csv-cols">${cols.map(([c, d]) => `<dt>${_esc(c)}</dt><dd>${d}</dd>`).join('')}</dl>` +
    p(t('For example, a game of 3 with its play order, a game of 2 without date or play order, and a solo game:')) +
    `<div class="csv-example-wrap"><table class="csv-example"><thead><tr>${GAMES_CSV_HEADER.map(h => `<th>${_esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${ex.map(r => `<tr>${r.map(c => `<td>${_esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` +
    `<div class="acct-actions csv-actions">
      <button class="btn btn-ghost" type="button" onclick="downloadGamesTemplate()">${t('Download empty file')}</button>
      <label class="btn btn-primary">${t('Choose file')}<input type="file" accept=".csv,text/csv" hidden onchange="pickGamesCsv(this)"></label>
    </div>
    <div id="uploadGamesResult" role="status"></div>`;
  _gamesCsvChecked = null;
  openOverlay('uploadGamesOverlay');
}

function downloadGamesTemplate() {
  const csv = GAMES_CSV_HEADER.map(csvField).join(',') + '\r\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'DiVilytics-games.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function pickGamesCsv(input) {
  const file = input.files?.[0];
  input.value = '';   // the same file can be picked again after a fix
  const out = document.getElementById('uploadGamesResult');
  if (!file) return;
  _gamesCsvChecked = null;
  if (file.size > 2 * 1024 * 1024) { out.innerHTML = `<div class="err show">${t('The file is larger than 2 MB: split it in parts.')}</div>`; return; }
  out.innerHTML = `<p class="modal-hint">${t('Checking {file}…', { file: _esc(file.name) })}</p>`;
  let res;
  try { res = await checkGamesCsv(await file.text()); }
  catch (e) { out.innerHTML = `<div class="err show">${t("Couldn't check the file. Retry.")}</div>`; return; }

  if (res.errors.length) {
    const shown = res.errors.slice(0, 12);
    out.innerHTML = `<div class="err show"><strong>${t('Nothing was uploaded.')}</strong> ${t('Fix these rows and pick the file again:')}
      <ul class="csv-errors">${shown.map(([line, msg]) => `<li>${t('Row {n}', { n: line })}: ${_esc(msg)}</li>`).join('')}</ul>
      ${res.errors.length > shown.length ? t('…and {n} more.', { n: res.errors.length - shown.length }) : ''}</div>`;
    return;
  }
  const summary = [
    tn(res.games.length, '{n} game to add', '{n} games to add') + ` (${tn(res.seats, '{n} seat', '{n} seats')})`,
    res.games.length ? t('your villain in {n}', { n: res.mine }) : null,
    res.skipped.length ? tn(res.skipped.length, '{n} already in DiVilytics, skipped', '{n} already in DiVilytics, skipped') : null,
  ].filter(Boolean).join(' | ');
  _gamesCsvChecked = res;
  out.innerHTML = `<p class="modal-hint"><strong>${_esc(file.name)}</strong>: ${summary}.</p>
    ${res.games.length ? `<button class="btn btn-primary" id="uploadGamesBtn" type="button" onclick="confirmUploadGames()">${tn(res.games.length, 'Upload {n} game', 'Upload {n} games')}</button>` : ''}`;
}

async function confirmUploadGames() {
  const res = _gamesCsvChecked;
  if (!res?.games.length) return;
  const btn = document.getElementById('uploadGamesBtn');
  btn.disabled = true;
  btn.textContent = t('Uploading…');
  const { error } = await uploadGames(res.games);
  const out = document.getElementById('uploadGamesResult');
  _gamesCsvChecked = null;
  out.innerHTML = error
    ? `<div class="err show">${t("Couldn't upload the games, nothing was added: {error}", { error: _esc(error.message || String(error)) })}</div>`
    : `<p class="modal-hint">${tn(res.games.length, '{n} game added.', '{n} games added.')} <a class="char-guide-link" href="players.html?nick=${encodeURIComponent(getCurrentProfile()?.nickname || '')}">${t('Open your page')} ›</a></p>`;
}
