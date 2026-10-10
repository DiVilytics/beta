// ── STATE ─────────────────────────────────────────────────────────────────────

let glGames        = [];   // loaded glGames (current page)
let glPlayers      = [];   // game_players for loaded glGames
let glChars        = [];   // character list from DB
let glBoxInfo      = {};   // loadBoxInfo(), used to order box groups by release date

let glFilterCount    = 'all';   // 'all' | 2 | 3 | 4 | 5 | 6
let glFilterLocation = null;

// The period, All time / Year / Month (period-filter.js): any change reloads.
const period = createPeriodFilter('glPeriod', { onChange: () => load(true) });

// Villain filter mode. 'only': games played entirely within the included set
// (the pool built by excluding, pace and My boxes). 'with': games that have
// every selected villain at the table; the grid starts all struck through and
// a tap picks a villain (picked = not in pace.excluded). The 'only' selection
// is set aside meanwhile and comes back on switching back. In the UI the modes
// read "Among these" and "With these".
let glCharMode     = 'only';
let _onlySnapshot  = null;

// The "included characters" filter (excluded set + pace + My-boxes) lives in the
// shared pace-filter controller; `pace.excluded` is the single source of truth.
const pace = createPaceFilter({
  getChars:     () => glChars,
  gridId:       'charGrid',
  paceColorsId: 'glPaceColors',
  paceModeId:   'glPaceMode',
  mineBtnId:    'glMineBtn',
  mineTitles: {
    signIn:  t('Sign in to use your boxes'),
    noBoxes: t('Mark which boxes you own on the account page first'),
    on:      t('Limited to your boxes'),
    off:     t('Limit to villains in your boxes'),
  },
  onChange: () => { updateFilterUI(); _syncResetBtn(); },
  onError:  showErr,
});

let _gameOffset     = 0;
let _totalGames     = 0;
let _hasMore        = false;
let _loaded         = false;   // true once the first load() has fetched data
// A filter can change again before its games arrive: only the latest load()
// renders (a Load more too is dropped once a new list has been asked for).
let _loadToken      = 0;

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
    () => { updateFilterUI(); _syncResetBtn(); },   // a single villain tapped in or out
    glBoxInfo
  );
  // A language switch brings back the filters and the games loaded (lang.js).
  const saved = takeViewState();
  if (saved) {
    glFilterCount = saved.count;
    updateFilterPills('#countPills .pill', glFilterCount);
    glFilterLocation = saved.location;
    if (glFilterLocation) document.getElementById('locationSearchInput').value = glFilterLocation;
    period.set(saved.period);
    glCharMode    = saved.charMode;
    _onlySnapshot = saved.onlySnapshot;
    pace.restoreState(saved.pace);
    _syncCharModeUI();
  }
  keepViewState(() => ({
    count: glFilterCount, location: glFilterLocation, period: period.get(),
    charMode: glCharMode, onlySnapshot: _onlySnapshot,
    pace: { excluded: [...pace.excluded], selectedPace: pace.selectedPace, pacePlus: pace.pacePlus, mineOn: pace.mineOn },
    loaded: glGames.length,
  }));
  await Promise.all([loadLocationOptions(), _probeWithMode(), period.load()]);
  await load();
  // Load more until as many games are listed as before (stops if one fails).
  for (let n = -1; saved && _hasMore && glGames.length < saved.loaded && glGames.length > n; ) {
    n = glGames.length;
    await load(false);
  }
  updateFilterUI();      // show the included-character count from the start
  pace.updatePaceUI();   // initialize the pace swatches + My-boxes button
}

// ── DATA ──────────────────────────────────────────────────────────────────────

async function load(reset = true) {
  if (reset) {
    _gameOffset = 0;
    // Don't wipe the DOM yet. keep current cards visible while fetching
  }
  const token = reset ? ++_loadToken : _loadToken;

  // 'only': char_filter is the INCLUDED set (everything not excluded). Nothing
  // excluded → null (no restriction); excluding everything → empty array → no
  // games. 'with': with_filter is the picked villains; none picked → no filter.
  const included = glChars.filter(c => !pace.excluded.has(c.name)).map(c => c.name);
  const withArr  = glCharMode === 'with' && included.length ? included : null;
  const charArr  = glCharMode === 'only' && pace.excluded.size ? included : null;
  const countVal = glFilterCount !== 'all' ? glFilterCount : null;
  const locVal   = glFilterLocation || null;

  // All time sends no range, the same calls as before the period existed.
  const range   = period.isAll() ? {} : period.range();
  const filters = withArr
    ? { with_filter: withArr, count_filter: countVal, location_filter: locVal, ...range }
    : { char_filter: charArr, count_filter: countVal, location_filter: locVal, ...range };
  const suffix  = withArr ? '_with' : '';
  const [{ data: newGames, error }, { data: total }] = await Promise.all([
    db.rpc('get_game_page' + suffix, { ...filters, page_offset: _gameOffset, page_size: PAGE_SIZE }),
    db.rpc('get_game_count' + suffix, filters),
  ]);
  if (token !== _loadToken) return;

  if (error) {
    document.getElementById('root').innerHTML = loadErrorHTML(t("Couldn't load the games"), error);
    return;
  }

  const g = newGames || [];
  _totalGames = Number(total) || 0;

  const newPlayers = await fetchPlayersForGames(g.map(x => x.id));
  if (token !== _loadToken) return;

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
  // The toggle sums the filter up: "Villains | among 12" or "Villains | with
  // Ursula, Jafar" (names up to two, then a count); nothing after it when off.
  const picked = glChars.filter(c => !pace.excluded.has(c.name)).map(c => c.name);
  let summary = '';
  if (_charFilterActive()) {
    summary = glCharMode === 'with'
      ? (picked.length <= 2
          ? t('with {names}', { names: picked.map(villainNameInline).join(', ') })
          : t('with {n}', { n: picked.length }))
      : t('among {n}', { n: picked.length });
  }
  document.getElementById('charFilterSummary').innerHTML = summary ? `<span class="sep"> | </span>${summary}` : '';
}

// True when the villain filter actually narrows the list.
function _charFilterActive() {
  return glCharMode === 'with' ? pace.excluded.size < glChars.length : pace.excluded.size > 0;
}

// The 'with' mode needs the get_game_page_with / get_game_count_with functions;
// without them the switch stays hidden and the filter works as before.
async function _probeWithMode() {
  const { error } = await db.rpc('get_game_count_with', { with_filter: [], count_filter: null, location_filter: null });
  setVisible('glCharMode', !error);
}

function glSetCharMode(mode) {
  if (mode === glCharMode) return;
  if (mode === 'with') {
    _onlySnapshot = { excluded: [...pace.excluded], selectedPace: pace.selectedPace, pacePlus: pace.pacePlus, mineOn: pace.mineOn };
    glCharMode = mode;
    pace.excludeAll();
  } else {
    glCharMode = mode;
    pace.restoreState(_onlySnapshot || {});
  }
  _syncCharModeUI();
}

function _syncCharModeUI() {
  const withMode = glCharMode === 'with';
  document.getElementById('charFilterPanel').classList.toggle('with-mode', withMode);
  document.querySelectorAll('#glCharMode .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.mode === glCharMode));
  // What the mode does, its key words in bold (static strings, so innerHTML is safe).
  document.getElementById('glFilterHint').innerHTML = withMode
    ? t('Shows games played with <strong>at least</strong> the selected villains (others can play too).')
    : t('Shows games played <strong>only</strong> among the included villains (not necessarily all of them).');
  updateFilterUI();
  _syncResetBtn();
}

// ── PACE / MY-BOXES SELECTION ──────────────────────────────────────────────────
// Exactly the new-game model, applied to the log: clicking a character excludes
// it (struck through), pace is a single-select that RESETS the pool to that
// color's band (Pace+ also covers the neighbors), and "My boxes" is a sticky
// toggle every reset takes into account. The included set (everything not
// excluded) feeds char_filter, so games using any excluded character drop out.
// State + DOM sync live in the shared pace-filter controller; these are just the
// filter toolbar's onclick targets.

function glSelectPace(color) { pace.selectPace(color); }
function glSetPaceMode(plus) { pace.setPaceMode(plus); }
function glToggleMine()      { pace.toggleMine(); }
function glExcludeAll()      { pace.excludeAll(); }
// Reset: back to no filter, everyone in ('only') or nobody picked ('with').
function glResetFilter()     { if (glCharMode === 'with') pace.excludeAll(); else pace.resetToStart(); }
// Reset is off while the filter is already at its start.
function _syncResetBtn() {
  const btn = document.getElementById('glResetBtn');
  if (!btn) return;
  btn.disabled = glCharMode === 'with' ? pace.excluded.size >= glChars.length : pace.isDefault();
}

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
  // The box is in the page from the start (disabled, so the header doesn't
  // jump); hide it only if no game has a location yet (cheap count-only request,
  // no rows transferred), otherwise enable it.
  const { count } = await db.from('games')
    .select('location', { count: 'exact', head: true })
    .not('location', 'is', null);
  if (!count) { setVisible('locationSearch', false); return; }
  document.getElementById('locationSearchInput').disabled = false;

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
  const filterActive = glFilterCount !== 'all' || _charFilterActive() || glFilterLocation !== null || !period.isAll();
  const root         = document.getElementById('root');

  const pillArea = document.getElementById('locationPillArea');
  if (pillArea) pillArea.innerHTML = glFilterLocation
    ? locationFilterPillHTML(glFilterLocation, 'clearLocationFilter')
    : '';

  if (_totalGames === 0) {
    hint.textContent = '';
    root.className = '';
    if (!filterActive) {
      root.innerHTML = emptyStateHTML('⚔️', t('No games yet'), t('Record your first game to get started.'),
        `<a class="btn btn-primary btn-sm" href="new-game.html">${t('+ New Game')}</a>`);
    } else {
      root.innerHTML = emptyStateHTML('🔍', t('No games for this filter'), t('Try adjusting the filters.'));
    }
    return;
  }

  hint.textContent = glGames.length < _totalGames
    ? t('Showing {shown} of {total} games', { shown: glGames.length, total: _totalGames })
    : tn(_totalGames, '{n} game', '{n} games');

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
  layoutGameCardMeta(root);

  if (_hasMore) appendLoadMore(root, () => load(false));
}

function buildCard(g, gp) {
  const me = getCurrentUser();
  return buildGameCard(g, gp, {
    isSelf: p => me && p.user_id === me.id,
    onLocationClick: loc => _applyLocationOption(loc),
    layout: 'rows',
  });
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
// The filters always start fresh: a page the browser brings back from its
// back/forward cache (Safari keeps it as you left it) is loaded again.
window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });

init();
