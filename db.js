// ── SUPABASE ──────────────────────────────────────────────────────────────────
// SUPABASE_URL and SUPABASE_ANON_KEY come from config.js (loaded earlier).

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── UTILITIES ─────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── PAGINATION HELPERS ────────────────────────────────────────────────────────
// PostgREST caps a single response (commonly ~1000 rows). These let the client
// assemble complete result sets past that cap, no server-side RPC needed.

// Run an `.in(col, ids)` query in chunks of ids, keeping each response under the
// row cap (and the URL short), then concatenate. `build(idChunk)` returns the
// query for one chunk. Chunks run in parallel and order is NOT preserved across
// them, so sort in JS afterwards if you need a global order.
async function _fetchInChunks(ids, build, chunkSize = 150) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));
  const pages = await Promise.all(chunks.map(async chunk => {
    const { data, error } = await build(chunk);
    if (error) { console.warn('_fetchInChunks error:', error); return []; }
    return data || [];
  }));
  return pages.flat();
}

// Page through a single query past the row cap with `.range()`. `build()` must
// return a FRESH query builder each call. Returns { rows, error }, error is the
// first page error, with whatever rows were gathered before it.
async function _fetchAllRows(build, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) { console.warn('_fetchAllRows error:', error); return { rows, error }; }
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return { rows, error: null };
}

// ── PROFILE FETCH ─────────────────────────────────────────────────────────────

// Fetch a single profile row. `match` is one filter pair, e.g. { id: '...' }
// or { nickname: '...' }. Returns null on miss / error.
async function fetchProfile(match, fields = '*') {
  const [key, val] = Object.entries(match)[0];
  if (val == null) return null;
  const { data, error } = await db
    .from('profiles')
    .select(fields)
    .eq(key, val)
    .maybeSingle();
  if (error) console.warn('fetchProfile error:', error);
  return data || null;
}

// Fetch all profiles. Used by leaderboard for nickname → avatar mapping.
// Paged so the result is complete past the ~1000-row PostgREST response cap.
async function fetchAllProfiles(fields = 'nickname, avatar_url, default_avatar') {
  const { rows, error } = await _fetchAllRows(() => db.from('profiles').select(fields));
  if (error) console.warn('fetchAllProfiles error:', error);
  return rows;
}

// ── GAMES + PLAYERS HYDRATION ────────────────────────────────────────────────

// Fetch the player rows for a set of game ids, ordered by position. Returns []
// for an empty input. Used wherever we already have a list of game ids and
// want their participants (the game log, fetchGamesWithPlayers).
async function fetchPlayersForGames(ids) {
  if (!ids.length) return [];
  // Chunked so a player/character with many games never hits the row cap.
  // Callers group + sort by game, so cross-chunk order doesn't matter.
  return _fetchInChunks(ids, chunk =>
    db.from('game_players').select('*').in('game_id', chunk).order('position'));
}

// Fetch full game rows by id. `orderByPlayedAtDesc` returns newest first.
async function fetchGamesByIds(ids, { orderByPlayedAtDesc = false } = {}) {
  if (!ids.length) return [];
  const games = await _fetchInChunks(ids, chunk => db.from('games').select('*').in('id', chunk));
  // Order is lost across chunks, so sort in JS when the caller wants newest-first.
  // Games with no date go last.
  const at = g => (g.played_at ? new Date(g.played_at).getTime() : -Infinity);
  if (orderByPlayedAtDesc) games.sort((a, b) => (at(b) - at(a)) || 0);
  return games;
}

// Convenience: returns { games, players } for a set of ids in one trip. Only
// the official games among them and their players: solo games (variant
// 'solo', the unofficial solo variant, solo.js) have statistics of their own.
// { variant: 'solo' } returns those instead, { variant: 'any' } both.
async function fetchGamesWithPlayers(ids, opts = {}) {
  if (!ids.length) return { games: [], players: [] };
  const [games, players] = await Promise.all([
    fetchGamesByIds(ids, opts),
    fetchPlayersForGames(ids),
  ]);
  return opts.variant === 'any' ? { games, players } : gamesOfVariant({ games, players }, opts.variant ?? null);
}

// The games of one variant (null: official, 'solo') out of { games, players },
// with their players.
function gamesOfVariant({ games, players }, variant = null) {
  const kept = games.filter(g => (g.variant ?? null) === variant);
  const ids  = new Set(kept.map(g => g.id));
  return { games: kept, players: players.filter(p => ids.has(p.game_id)) };
}

// ── STATIC DATA LOADERS ──────────────────────────────────────────────────────
// Tiny cache of the JSON data files referenced from config.js. Each loader
// returns the parsed object on first call and serves the same instance on
// subsequent calls.

async function _fetchJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) { console.warn(`fetchJson ${url}: ${r.status}`); return {}; }
    return await r.json();
  } catch (e) {
    console.warn(`fetchJson ${url}:`, e);
    return {};
  }
}

// TRANSLATED DATA: one rule for every file. The English file is the default;
// `<file>.<LANG>.json` holds translated entries, and each translated entry
// replaces its English entry as a whole (never a mix of the two). Entries it
// doesn't have stay English; in English the translation file isn't read.
// `depth` says where entries sit: 1 = top-level keys (a villain's objective or
// guide), 2 = one level down (faq.json's villains.<name>).
function _mergeLocalized(base, over, depth) {
  const out = { ...base };
  for (const k of Object.keys(over)) {
    const both = depth > 1 && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      && over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]);
    out[k] = both ? _mergeLocalized(base[k], over[k], depth - 1) : over[k];
  }
  return out;
}

async function _fetchJsonLocalized(url, depth = 1) {
  const base = await _fetchJson(url);
  if (LANG === 'en') return base;
  try {
    const r = await fetch(url.replace(/\.json$/, `.${LANG}.json`));
    return r.ok ? _mergeLocalized(base, await r.json(), depth) : base;
  } catch (_) { return base; }
}

// What's new (changelog.html, and the home card's date and dot): { 'YYYY-MM-DD':
// { title, new?, improved?, fixed? } }, each group a list of items written for
// players. changelog.it.json translates entries whole, like the other files.
// Opening the page stores what it showed under CHANGELOG_SEEN_KEY: the newest
// entry's date and its number of items ('2026-10-07#9'), so an entry extended
// later the same day counts as new again. Item counts match in every language.
const CHANGELOG_SEEN_KEY = 'changelogSeen';
let _changelog = null;
async function loadChangelog() {
  if (!_changelog) _changelog = await _fetchJsonLocalized(DATA_CHANGELOG_URL);
  return _changelog;
}

const _changelogItems = e => ['new', 'improved', 'fixed'].reduce((n, k) => n + (e[k]?.length || 0), 0);

// The stamp of a log's newest entry, the value stored once it's been seen.
function changelogStamp(log) {
  const day = Object.keys(log).sort().pop();
  return day ? `${day}#${_changelogItems(log[day])}` : null;
}

// The stamp seen last ('' = never; an old bare date counts as fully seen).
function changelogSeen() {
  try { return localStorage.getItem(CHANGELOG_SEEN_KEY) || ''; } catch (_) { return ''; }
}

// Whether an entry is newer than `seen`: a later day, or the seen day with more
// items. Nothing counts as new before a first visit, so a newcomer's page isn't
// all purple.
function changelogUnseen(day, entry, seen) {
  if (!seen) return false;
  const [seenDay, seenCount] = seen.split('#');
  return day > seenDay || (day === seenDay && seenCount != null && _changelogItems(entry) > +seenCount);
}

let _objectives = null;
async function loadObjectives() {
  if (!_objectives) _objectives = await _fetchJsonLocalized(DATA_OBJECTIVES_URL);
  return _objectives;
}

// Rules F.A.Q.: { rulebooks: { id: { title, desc, intro, groups } },
// general: [{ title, intro?, items }], villains: { name: items } }, each group
// { title, intro?, items } and each item { term, text, villain?, source? }.
// Shown on faq.html. In Italian, faq.it.json (same shape) replaces what it
// covers, a rulebook or a villain at a time; what it lacks stays English.
let _faq = null;
async function loadFaq() {
  if (!_faq) _faq = await _fetchJsonLocalized(DATA_FAQ_URL, 2);
  return _faq;
}

// Villain Guides from the game boxes: { villain: { objective?, sections: [{ title,
// text }] } }; `objective` explains the objective (objectives.json), texts split
// paragraphs by blank lines. Translated per villain (villain-guides.it.json).
let _guides = null;
async function loadVillainGuides() {
  if (!_guides) _guides = await _fetchJsonLocalized(DATA_GUIDES_URL);
  return _guides;
}

// Villain decks from the Disney Villainous Wiki: name -> [{ name, count, type }].
let _decks = null;
async function loadVillainDecks() {
  if (!_decks) _decks = await _fetchJson(DATA_DECKS_URL);
  return _decks;
}

// Card names in the current language: { villain: { 'English name': 'translated' } }
// (card-names.it.json, from the Villainous Italia card list). Empty in English;
// any name or villain it lacks is shown in English.
let _cardNames = null;
async function loadCardNames() {
  if (LANG === 'en') return {};
  if (!_cardNames) _cardNames = await _fetchJson(DATA_CARD_NAMES_URL.replace('{lang}', LANG));
  return _cardNames;
}

// Card texts in the current language, same shape as the names (card-texts.it.json,
// transcribed from the Italian cards). Empty in English; missing cards stay English.
let _cardTexts = null;
async function loadCardTexts() {
  if (LANG === 'en') return {};
  if (!_cardTexts) _cardTexts = await _fetchJson(DATA_CARD_TEXTS_URL.replace('{lang}', LANG));
  return _cardTexts;
}

let _boxInfo = null;
async function loadBoxInfo() {
  if (!_boxInfo) _boxInfo = await _fetchJson(DATA_BOX_INFO_URL);
  return _boxInfo;
}

let _charExtraBoxes = null;
async function loadCharacterExtraBoxes() {
  if (!_charExtraBoxes) _charExtraBoxes = await _fetchJson(DATA_CHARACTER_EXTRA_BOXES_URL);
  return _charExtraBoxes;
}

// ── CHARACTER CACHE ───────────────────────────────────────────────────────────

let _chars = null;

async function loadCharacters() {
  if (_chars) return _chars;
  const [{ data, error }, extraBoxes] = await Promise.all([
    db.from('characters').select('*').order('sort_order'),
    loadCharacterExtraBoxes(),
  ]);
  if (error) {
    console.error('Failed to load characters:', error.message);
    return [];
  }
  // `extraBoxes` decorates every character with the additional boxes it's
  // reprinted into (character-extra-boxes.json), so callers get it for free.
  _chars = (data || []).map(c => ({ ...c, extraBoxes: extraBoxes[c.name] || [] }));
  return _chars;
}
