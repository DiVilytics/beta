// ── STATE ─────────────────────────────────────────────────────────────────────

let glGames        = [];   // loaded glGames (current page)
let glPlayers      = [];   // game_players for loaded glGames
let glChars        = [];   // character list from DB
let glBoxInfo      = {};   // loadBoxInfo(), used to order box groups by release date

let glFilterLocation = null;

// The table size, All / 2p…6p / Solo (size-filter.js), and the period, All
// time / Year / Month (period-filter.js): any change reloads. Solo lists the
// solo games only (solo.js), never with the others.
const size   = createSizeFilter('glSize', { onChange: () => { _capWithPicks(); _syncCharModeUI(); load(true); } });
const period = createPeriodFilter('glPeriod', { onChange: () => load(true) });

// Villain filter mode. 'only': games played entirely within the included set
// (the pool built by excluding, pace and My boxes). 'with': games that have
// every selected villain at the table; the grid starts all struck through and
// a tap picks a villain (picked = not in pace.excluded). The 'only' selection
// is set aside meanwhile and comes back on switching back. In the UI the modes
// read "Among these" and "With these".
let glCharMode     = 'only';
let _onlySnapshot  = null;

// With these picks at most as many villains as the table holds: 6, the size
// picked (2p…6p), or 1 on Solo (a solo game has one villain). At the limit the
// other villains gray out; a smaller limit keeps the villains picked first.
// The same filter serves the official games and Solo.
const _withLimit = () => size.isSolo() ? 1 : typeof size.value() === 'number' ? size.value() : TABLE_SIZES[TABLE_SIZES.length - 1];
let _withOrder = [];   // With these: the picked villains, in the order they were picked

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
    (name, excluded) => {   // a single villain tapped in or out
      if (!excluded) _capWithPicks();   // never past the limit
      updateFilterUI();
      _syncResetBtn();
    },
    glBoxInfo
  );
  // A language switch brings back the filters and the games loaded (lang.js).
  const saved = takeViewState();
  if (saved) {
    size.set(saved.count);
    size.setLevel(saved.level);
    glFilterLocation = saved.location;
    if (glFilterLocation) document.getElementById('locationSearchInput').value = glFilterLocation;
    period.set(saved.period);
    glCharMode    = saved.charMode;
    _onlySnapshot = saved.onlySnapshot;
    pace.restoreState(saved.pace);
    _syncCharModeUI();
  }
  keepViewState(() => ({
    count: size.value(), level: size.level(), location: glFilterLocation, period: period.get(),
    charMode: glCharMode, onlySnapshot: _onlySnapshot,
    pace: _paceState(),
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
  if (size.isSolo()) return _loadSolo(reset, token);

  // 'only': char_filter is the INCLUDED set (everything not excluded). Nothing
  // excluded → null (no restriction); excluding everything → empty array → no
  // games. 'with': with_filter is the picked villains; none picked → no filter.
  const included = glChars.filter(c => !pace.excluded.has(c.name)).map(c => c.name);
  const withArr  = glCharMode === 'with' && included.length ? included : null;
  const charArr  = glCharMode === 'only' && pace.excluded.size ? included : null;
  const countVal = size.value() !== 'all' ? size.value() : null;
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

// Solo (solo.js): every solo game is loaded at once (they're few), then
// filtered and paged here: the level, then Among these keeps the games of an
// included villain, With these the picked villain's (one at most; none picked:
// every game).
async function _loadSolo(reset, token) {
  const solo = await loadSoloGames();
  if (token !== _loadToken) return;
  if (!solo) {
    document.getElementById('root').innerHTML = loadErrorHTML(t("Couldn't load the solo games"));
    return;
  }
  const included  = new Set(glChars.filter(c => !pace.excluded.has(c.name)).map(c => c.name));
  const villainOk = v => glCharMode === 'with' ? !included.size || included.has(v) : included.has(v);
  const villainOf = Object.fromEntries(solo.players.map(p => [p.game_id, p.character]));
  const games = soloOfLevel(soloInPeriod(solo, period.isAll() ? {} : period.range()), size.level()).games.filter(g =>
    (!glFilterLocation || g.location === glFilterLocation) && villainOk(villainOf[g.id]));

  glGames   = games.slice(0, reset ? PAGE_SIZE : glGames.length + PAGE_SIZE);
  const ids = new Set(glGames.map(g => g.id));
  glPlayers = solo.players.filter(p => ids.has(p.game_id));
  _gameOffset = glGames.length;
  _totalGames = games.length;
  _hasMore = glGames.length < _totalGames;
  _loaded  = true;
  document.getElementById('root').className = '';
  render();
}

// ── FILTER ────────────────────────────────────────────────────────────────────

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
  // With these at its limit: the villains not picked gray out.
  _syncWithOrder();
  document.getElementById('charFilterPanel').classList.toggle('with-capped', glCharMode === 'with' && _withOrder.length >= _withLimit());
  _syncBoxNames();
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

// The filter's state, to set aside and bring back.
const _paceState = () => ({ excluded: [...pace.excluded], selectedPace: pace.selectedPace, pacePlus: pace.pacePlus, mineOn: pace.mineOn });

// Keeps _withOrder in step with the picks (a new pick goes last).
function _syncWithOrder() {
  if (glCharMode !== 'with') { _withOrder = []; return; }
  const picked = new Set(glChars.filter(c => !pace.excluded.has(c.name)).map(c => c.name));
  _withOrder = _withOrder.filter(n => picked.has(n));
  for (const n of picked) if (!_withOrder.includes(n)) _withOrder.push(n);
}

// With these: a box name picks its whole box or clears it, never part of it.
// It clears the box when any of its villains is picked; it picks them all only
// if they all fit under the limit, otherwise it grays out.
function _syncBoxNames() {
  const free = _withLimit() - _withOrder.length;
  for (const group of document.querySelectorAll('#charGrid .box-group')) {
    const names = new Set([...group.querySelectorAll('.char-pill')].map(p => p.dataset.name));
    const none  = [...names].every(n => pace.excluded.has(n));   // none of the box picked
    const btn = group.querySelector('.box-name');
    if (btn) btn.disabled = glCharMode === 'with' && none && names.size > free;
  }
}

// With these: down to the limit, keeping the villains picked first.
function _capWithPicks() {
  _syncWithOrder();
  if (_withOrder.length <= _withLimit()) return;
  const keep = new Set(_withOrder.slice(0, _withLimit()));
  pace.restoreState({ ..._paceState(), excluded: glChars.map(c => c.name).filter(n => !keep.has(n)) });
}

function glSetCharMode(mode) {
  if (mode === glCharMode) return;
  if (mode === 'with') {
    _onlySnapshot = _paceState();
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
  const solo = size.isSolo();
  document.getElementById('glFilterHint').innerHTML = withMode
    ? (solo ? t('Shows the solo games of the <strong>selected</strong> villain (a solo game has only one).')
            : t('Shows games played with <strong>at least</strong> the selected villains (others can play too).'))
    : (solo ? t('Shows the solo games of the <strong>included</strong> villains.')
            : t('Shows games played <strong>only</strong> among the included villains (not necessarily all of them).'));
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
  const solo         = size.isSolo();
  const filterActive = (size.value() !== 'all' && !solo) || size.level() !== 'all' || _charFilterActive() || glFilterLocation !== null || !period.isAll();
  const root         = document.getElementById('root');

  const pillArea = document.getElementById('locationPillArea');
  if (pillArea) pillArea.innerHTML = glFilterLocation
    ? locationFilterPillHTML(glFilterLocation, 'clearLocationFilter')
    : '';

  // Solo: what it is, above its games.
  const soloHint = solo ? soloHintHTML() : '';

  if (_totalGames === 0) {
    hint.textContent = '';
    root.className = '';
    if (solo && !filterActive) {
      root.innerHTML = soloHint + emptyStateHTML('⚔️', t('No solo games yet'), t('To record one, pick Solo in New Game, where you choose the number of players.'),
        `<a class="btn btn-primary btn-sm" href="new-game.html">${t('+ New Game')}</a>`);
    } else if (!filterActive) {
      root.innerHTML = emptyStateHTML('⚔️', t('No games yet'), t('Record your first game to get started.'),
        `<a class="btn btn-primary btn-sm" href="new-game.html">${t('+ New Game')}</a>`);
    } else if (solo) {
      root.innerHTML = soloHint + emptyStateHTML('🔍', t('No games for this filter'), t('Try adjusting the filters.'));
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
  root.innerHTML = soloHint;

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
