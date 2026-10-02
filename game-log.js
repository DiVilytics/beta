// ── STATE ─────────────────────────────────────────────────────────────────────

let glGames        = [];   // loaded glGames (current page)
let glPlayers      = [];   // game_players for loaded glGames
let glChars        = [];   // character list from DB
let glBoxInfo      = {};   // loadBoxInfo(), used to order box groups by release date

let glFilterCount    = 'all';   // 'all' | 2 | 3 | 4 | 5 | 6
let glFilterLocation = null;

// The "included characters" filter (excluded set + pace + My-boxes) lives in the
// shared pace-filter controller; `pace.excluded` is the single source of truth.
const pace = createPaceFilter({
  getChars:     () => glChars,
  gridId:       'charGrid',
  paceColorsId: 'glPaceColors',
  paceModeId:   'glPaceMode',
  mineBtnId:    'glMineBtn',
  mineTitles: {
    signIn:  'Sign in to use your boxes',
    noBoxes: 'Mark which boxes you own on the account page first',
    on:      'Limited to your boxes',
    off:     'Limit to villains in your boxes',
  },
  onChange: () => updateFilterUI(),
  onError:  showErr,
});

let _gameOffset     = 0;
let _totalGames     = 0;
let _hasMore        = false;
let _loaded         = false;   // true once the first load() has fetched data

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  setActiveNav('game-log.html');
  await initAuth(async () => {
    await pace.loadOwnedBoxes();
    pace.updatePaceUI();
    render();
  });
  [glChars, glBoxInfo] = await Promise.all([loadCharacters(), loadBoxInfo()]);
  await pace.loadOwnedBoxes();
  buildExcludeGrid(
    document.getElementById('charGrid'),
    glChars,
    pace.excluded,
    () => updateFilterUI(),
    glBoxInfo
  );
  await loadLocationOptions();
  await load();
  updateFilterUI();      // show the included-character count from the start
  pace.updatePaceUI();   // initialise the pace swatches + My-boxes button
}

// ── DATA ──────────────────────────────────────────────────────────────────────

async function load(reset = true) {
  if (reset) {
    _gameOffset = 0;
    // Don't wipe the DOM yet. keep current cards visible while fetching
  }

  // char_filter is the INCLUDED set (everything not excluded). Nothing excluded →
  // null (no restriction); excluding everything → empty array → no games.
  const charArr  = pace.excluded.size === 0 ? null : glChars.filter(c => !pace.excluded.has(c.name)).map(c => c.name);
  const countVal = glFilterCount !== 'all' ? glFilterCount : null;
  const locVal   = glFilterLocation || null;

  const [{ data: newGames, error }, { data: total }] = await Promise.all([
    db.rpc('get_game_page', {
      char_filter:     charArr,
      count_filter:    countVal,
      location_filter: locVal,
      page_offset:     _gameOffset,
      page_size:       PAGE_SIZE,
    }),
    db.rpc('get_game_count', {
      char_filter:     charArr,
      count_filter:    countVal,
      location_filter: locVal,
    }),
  ]);

  if (error) {
    document.getElementById('root').innerHTML =
      `<div class="empty"><p>Error: ${error.message}</p></div>`;
    return;
  }

  const g = newGames || [];
  _totalGames = Number(total) || 0;

  const newPlayers = await fetchPlayersForGames(g.map(x => x.id));

  // Update state atomically so render() sees a consistent snapshot
  if (reset) {
    glGames   = g;
    glPlayers = newPlayers;
    _gameOffset = g.length;
  } else {
    const existingGameIds = new Set(glGames.map(x => x.id));
    const freshGames   = g.filter(x => !existingGameIds.has(x.id));
    const freshPlayers = newPlayers.filter(p => !existingGameIds.has(p.game_id));
    glGames   = [...glGames, ...freshGames];
    glPlayers = [...glPlayers, ...freshPlayers];
    _gameOffset += g.length;
  }

  _hasMore = glGames.length < _totalGames;
  _loaded  = true;

  document.getElementById('root').className = '';
  render();
}

// ── FILTER ────────────────────────────────────────────────────────────────────

function setCountFilter(value) {
  glFilterCount = value;
  updateFilterPills('#countPills .pill', value);
  load(true);
}

function toggleCharFilter() {
  const panel   = document.getElementById('charFilterPanel');
  const chevron = document.getElementById('charChevron');
  const open    = panel.classList.toggle('open');
  chevron.classList.toggle('open', open);
  if (!open) load(true);   // closing the menu commits the selection
}

// Updates the panel UI only. The game list is NOT refetched here, that happens
// when the panel closes (Done or the toggle), so toggling characters never
// reloads mid-edit.
function updateFilterUI() {
  const badge = document.getElementById('charBadge');
  badge.textContent = glChars.length - pace.excluded.size;   // characters still included
  badge.classList.add('visible');
}

// ── PACE / MY-BOXES SELECTION ──────────────────────────────────────────────────
// Exactly the new-game model, applied to the log: clicking a character excludes
// it (struck through), pace is a single-select that RESETS the pool to that
// colour's band (Pace+ also covers the neighbours), and "My boxes" is a sticky
// toggle every reset takes into account. The included set (everything not
// excluded) feeds char_filter, so games using any excluded character drop out.
// State + DOM sync live in the shared pace-filter controller; these are just the
// filter toolbar's onclick targets.

function glSelectPace(color) { pace.selectPace(color); }
function glSetPaceMode(plus) { pace.setPaceMode(plus); }
function glToggleMine()      { pace.toggleMine(); }
function glExcludeAll()      { pace.excludeAll(); }
function glClearExcluded()   { pace.clearExcluded(); }

function showErr(msg) {
  showError('err', msg, { scroll: true });
}

// "Done" just closes the panel, closing is what commits the selection.
function applyCharFilter() {
  if (document.getElementById('charFilterPanel').classList.contains('open')) toggleCharFilter();
}

function setLocationFilter(value) {
  glFilterLocation = value || null;
  load(true);
}

function clearLocationFilter() {
  glFilterLocation = null;
  const input = document.getElementById('locationSearchInput');
  if (input) input.value = '';
  load(true);
}

async function loadLocationOptions() {
  // Show the location search only if at least one game has a location (cheap
  // count-only request, no rows transferred).
  const { count } = await db.from('games')
    .select('location', { count: 'exact', head: true })
    .not('location', 'is', null);
  setVisible('locationSearch', (count || 0) > 0);

  // Same strategy as the player search: query the DB per keystroke. The
  // search_locations(q) RPC does the DISTINCT + LIMIT server-side, so we never
  // pull every game's location into the browser (and never hit the row cap).
  attachSearchBox({
    inputId:    'locationSearchInput',
    dropdownId: 'locationDropdown',
    debounceMs: 200,
    fetchOptions: dbSearchSource(q => db.rpc('search_locations', { q })),
    renderOption: l => `<div class="cs-option" data-loc="${_esc(l)}">${_esc(l)}</div>`,
    onSelect:     opt => _applyLocationOption(opt.dataset.loc),
    onEmpty:      () => { if (glFilterLocation) { glFilterLocation = null; load(true); } },
  });
}

function _applyLocationOption(loc) {
  glFilterLocation = loc;
  document.getElementById('locationSearchInput').value = loc;
  document.getElementById('locationDropdown').classList.remove('open');
  load(true);
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function render() {
  // Don't render the empty/"no games" state before the first load has run,
  // otherwise the initAuth callback flashes it over the loading spinner.
  if (!_loaded) return;

  const hint         = document.getElementById('resultsHint');
  const filterActive = glFilterCount !== 'all' || pace.excluded.size > 0 || glFilterLocation !== null;
  const root         = document.getElementById('root');

  const pillArea = document.getElementById('locationPillArea');
  if (pillArea) pillArea.innerHTML = glFilterLocation
    ? locationFilterPillHTML(glFilterLocation, 'clearLocationFilter')
    : '';

  if (_totalGames === 0) {
    hint.textContent = '';
    root.className = '';
    if (!filterActive) {
      root.innerHTML = `
        <div class="empty">
          <div class="empty-icon">🕒</div>
          <h3>No games yet</h3>
          <p>Record your first game to get started.</p>
          <a class="btn btn-primary btn-sm" href="new-game.html">+ New Game</a>
        </div>`;
    } else {
      root.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><h3>No matches</h3><p>Try adjusting the filters.</p></div>`;
    }
    return;
  }

  hint.textContent = glGames.length < _totalGames
    ? `Showing ${glGames.length} of ${_totalGames} games`
    : `${_totalGames} game${_totalGames !== 1 ? 's' : ''}`;

  // Pre-group glPlayers by game_id to avoid O(n²) scans in the render loop
  const byGame = {};
  for (const p of glPlayers) {
    if (!byGame[p.game_id]) byGame[p.game_id] = [];
    byGame[p.game_id].push(p);
  }

  root.className = 'games-list';
  root.innerHTML = '';

  for (const g of glGames) {
    const gp = sortGamePlayers(byGame[g.id] || []);
    root.appendChild(buildCard(g, gp));
  }

  if (_hasMore) appendLoadMore(root, () => load(false));
}

function buildCard(g, gp) {
  const me = getCurrentUser();
  return buildGameCard(g, gp, {
    isSelf: p => me && p.user_id === me.id,
    onLocationClick: loc => _applyLocationOption(loc),
  });
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
init();
