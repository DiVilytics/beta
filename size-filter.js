// ── TABLE SIZE FILTER ─────────────────────────────────────────────────────────
// The table size filter of the Leaderboard, the Game Log and a player page,
// drawn like the period filter under it (period-filter.js): All (every official
// game), a Players menu (2p…6p; it reads "Players" until a size is picked, then
// the size) and Solo, dashed: the unofficial solo variant (solo.js), whose
// games are never counted with the others, so it's a world of its own rather
// than a size. On Solo a second row, right under it, picks the difficulty
// level: All, Easy, Medium or Hard (solo.js). Depends on t (lang.js), _esc
// (db.js), soloLevelPillsHTML (solo.js).
//
// createSizeFilter(rootId, { onChange }) builds the controls into #rootId,
// calls onChange() on every change, and returns:
//   value()      : 'all' | 2…6 | 'solo'
//   set(v)       : picks v without calling onChange (a language switch)
//   isSolo()     : true on Solo
//   level()      : the solo level, 'all' | 'easy' | 'medium' | 'hard' ('all' off Solo)
//   setLevel(l)  : picks it without calling onChange

const TABLE_SIZES = [2, 3, 4, 5, 6];

function createSizeFilter(rootId, { onChange }) {
  let value = 'all';
  let level = 'all';

  const root = document.getElementById(rootId);
  root.classList.add('pill-group', 'period-row');
  root.innerHTML = `
    <button class="pill" type="button" data-size="all">${t('All')}</button>
    <span class="period-pill-wrap">
      <select class="period-pill" aria-label="${t('Players')}"></select>
      <span class="chevron" aria-hidden="true">▼</span>
    </span>
    <button class="pill pill-solo" type="button" data-size="solo">${t('Solo')}</button>`;
  const allBtn  = root.querySelector('[data-size="all"]');
  const soloBtn = root.querySelector('[data-size="solo"]');
  const sel     = root.querySelector('select');
  // The level row, a sibling of the size row (the same gap as the period row).
  const levels  = document.createElement('div');
  levels.className = 'pill-group period-row solo-levels';
  root.after(levels);

  function render() {
    const sized = typeof value === 'number';
    allBtn.classList.toggle('on', value === 'all');
    soloBtn.classList.toggle('on', value === 'solo');
    sel.classList.toggle('on', sized);
    sel.innerHTML =
      `<option value="" hidden${sized ? '' : ' selected'}>${_esc(t('Players'))}</option>` +
      TABLE_SIZES.map(n => `<option value="${n}"${n === value ? ' selected' : ''}>${n}p</option>`).join('');
    levels.innerHTML = soloLevelPillsHTML(level);
    levels.classList.toggle('hidden', value !== 'solo');
  }

  const pick = v => {
    if (v === value) return;
    value = v;
    render();
    onChange();
  };
  levels.addEventListener('click', e => {
    const id = e.target.closest('[data-level]')?.dataset.level;
    if (!id || id === level) return;
    level = id;
    render();
    onChange();
  });
  allBtn.addEventListener('click', () => pick('all'));
  soloBtn.addEventListener('click', () => pick('solo'));
  sel.addEventListener('change', () => pick(sel.value ? +sel.value : 'all'));

  // Picked with a tap or a click, the menu lets go of the focus (no ring left on
  // it); with the keyboard it keeps it. As in the period filter.
  let pointer = false;
  sel.addEventListener('pointerdown', () => { pointer = true; });
  sel.addEventListener('keydown',     () => { pointer = false; });
  sel.addEventListener('change',      () => { if (pointer) sel.blur(); });

  render();

  return {
    value: () => value,
    set(v) {
      value = v === 'solo' || TABLE_SIZES.includes(v) ? v : 'all';
      render();
    },
    isSolo: () => value === 'solo',
    level:  () => value === 'solo' ? level : 'all',
    setLevel(l) {
      level = SOLO_LEVELS[l] ? l : 'all';
      render();
    },
  };
}
