// ── PERIOD FILTER ─────────────────────────────────────────────────────────────
// The time filter of the Leaderboard and the Game Log: three pills, always, each
// narrowing the one before. All time (no filter); Year, a menu: picking a year
// filters to it and the pill shows it ("2025"); Month, a menu once a year is
// picked: picking a month narrows to it ("Sep"), picking Month again widens back
// to the year.
// All time clears both. The menus list only what can have games: from the month of
// the oldest dated game to the current one, newest first. Months are three
// letters (Sep, Set) so the row fits a phone. The ▼ is New Game's (.chevron). Depends on db + _esc (db.js), t + LOCALE (lang.js).
//
// createPeriodFilter(rootId, { onChange }) builds the controls into #rootId,
// calls onChange() on every change, and returns:
//   load()  : reads the site's oldest dated game; call once at page init
//   setFirst(iso) : starts the menus from this date instead (a player page: that
//             player's first dated game; null = this month)
//   range() : { from_ts, to_ts }, ISO strings for the RPCs ([from, to), local
//             midnight), both null for All time
//   get() / set(s) : the picked { year, month }, kept across a language switch
//   id()    : 'all' | '2025' | '2025-09', a key for caches
//   isAll() : true on All time

function createPeriodFilter(rootId, { onChange }) {
  const now   = new Date();
  const state = { year: null, month: null };   // null: not narrowed
  let first   = new Date(now.getFullYear(), now.getMonth(), 1);   // until load()

  const root = document.getElementById(rootId);
  root.classList.add('pill-group', 'period-row');
  root.innerHTML = `
    <button class="pill" type="button" data-period="all">${t('All time')}</button>
    <span class="period-pill-wrap">
      <select class="period-pill" data-sel="year" aria-label="${t('Year')}"></select>
      <span class="chevron" aria-hidden="true">▼</span>
    </span>
    <span class="period-pill-wrap">
      <select class="period-pill" data-sel="month" aria-label="${t('Month')}"></select>
      <span class="chevron" aria-hidden="true">▼</span>
    </span>`;
  const allBtn   = root.querySelector('[data-period="all"]');
  const yearSel  = root.querySelector('[data-sel="year"]');
  const monthSel = root.querySelector('[data-sel="month"]');

  // The months (0-11) of `year` between the first month and now.
  function monthsOf(year) {
    const from = year === first.getFullYear() ? first.getMonth() : 0;
    const to   = year === now.getFullYear()   ? now.getMonth()   : 11;
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }

  const monthName = m => {
    // Some locales' short form is longer ("Sept") or has a dot: cut to three.
    const n = new Date(2000, m, 1).toLocaleDateString(LOCALE, { month: 'short' }).replace('.', '').slice(0, 3);
    return n.charAt(0).toUpperCase() + n.slice(1);
  };

  // Each menu starts with its label ("Year", "Month"), shown while nothing is
  // picked, so the pill reads like the others until it's used. Year's is hidden
  // (All time clears it); Month's stays in the list: picking it is the way back
  // to the whole year. A menu is as wide as its longest entry: all are short.
  function render() {
    allBtn.classList.toggle('on', state.year == null);
    yearSel.classList.toggle('on', state.year != null);
    monthSel.classList.toggle('on', state.month != null);
    const years = [];
    for (let y = now.getFullYear(); y >= first.getFullYear(); y--) years.push(y);
    yearSel.innerHTML =
      `<option value="" hidden${state.year == null ? ' selected' : ''}>${_esc(t('Year'))}</option>` +
      years.map(y => `<option value="${y}"${y === state.year ? ' selected' : ''}>${y}</option>`).join('');
    monthSel.disabled = state.year == null;
    monthSel.innerHTML =
      `<option value=""${state.month == null ? ' selected' : ''}>${_esc(t('Month'))}</option>` +
      (state.year == null ? '' :
        monthsOf(state.year).reverse().map(m => `<option value="${m}"${m === state.month ? ' selected' : ''}>${_esc(monthName(m))}</option>`).join(''));
  }

  allBtn.addEventListener('click', () => {
    if (state.year == null) return;
    state.year = state.month = null;
    render();
    onChange();
  });
  yearSel.addEventListener('change', () => {
    state.year = yearSel.value ? +yearSel.value : null;
    // A year without the chosen month moves to its nearest one (October 2026 →
    // 2024: December, its only month).
    if (state.year == null) state.month = null;
    else if (state.month != null) {
      const ms = monthsOf(state.year);
      state.month = Math.min(Math.max(state.month, ms[0]), ms[ms.length - 1]);
    }
    render();
    onChange();
  });
  monthSel.addEventListener('change', () => {
    state.month = monthSel.value ? +monthSel.value : null;
    render();
    onChange();
  });

  // Picked with a tap or a click, a menu lets go of the focus (no ring left on
  // it); with the keyboard it keeps it.
  for (const sel of [yearSel, monthSel]) {
    let pointer = false;
    sel.addEventListener('pointerdown', () => { pointer = true; });
    sel.addEventListener('keydown',     () => { pointer = false; });
    sel.addEventListener('change',      () => { if (pointer) sel.blur(); });
  }

  render();

  return {
    async load() {
      const { data } = await db.from('games').select('played_at').not('played_at', 'is', null)
        .order('played_at', { ascending: true }).limit(1);
      const oldest = data?.[0]?.played_at;
      if (oldest) { const d = new Date(oldest); first = new Date(d.getFullYear(), d.getMonth(), 1); }
      render();
    },
    setFirst(iso) {
      const d = iso ? new Date(iso) : now;
      first = new Date(d.getFullYear(), d.getMonth(), 1);
      render();
    },
    range() {
      if (state.year == null) return { from_ts: null, to_ts: null };
      const from = state.month == null ? new Date(state.year, 0, 1)     : new Date(state.year, state.month, 1);
      const to   = state.month == null ? new Date(state.year + 1, 0, 1) : new Date(state.year, state.month + 1, 1);
      return { from_ts: from.toISOString(), to_ts: to.toISOString() };
    },
    // The picked year and month ({ year, month }, null = not narrowed), to put
    // back after a reload (keepViewState, lang.js); set() doesn't call onChange.
    get: () => ({ year: state.year, month: state.month }),
    set(s) {
      state.year  = s?.year  ?? null;
      state.month = state.year == null ? null : (s?.month ?? null);
      render();
    },
    id() {
      if (state.year == null) return 'all';
      return state.month == null ? String(state.year) : `${state.year}-${String(state.month + 1).padStart(2, '0')}`;
    },
    isAll: () => state.year == null,
  };
}
