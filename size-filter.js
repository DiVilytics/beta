// ── TABLE SIZE FILTER ─────────────────────────────────────────────────────────
// The table size filter of the Leaderboard, the Game Log and a player page,
// drawn like the period filter under it (period-filter.js): All (every official
// game), a Players menu (2p…6p; it reads "Players" until a size is picked, then
// the size), then Solo and a Difficulty menu, dashed: the unofficial solo
// variant (solo.js), whose games are never counted with the others, so it's a
// world of its own rather than a size. Solo is every solo game; the Difficulty
// menu works like Players: it reads "Difficulty" until a level is picked (Easy,
// Medium or Hard), then the level, and only that level's solo games count.
// Depends on t (lang.js), _esc (db.js), SOLO_LEVELS, SOLO_LEVEL_IDS and
// soloLevelName (solo.js).
//
// createSizeFilter(rootId, { onChange }) builds the controls into #rootId,
// calls onChange() on every change, and returns:
//   value()      : 'all' | 2…6 | 'solo'
//   set(v)       : picks v without calling onChange (a language switch)
//   isSolo()     : true on Solo, any level
//   level()      : the solo level, 'all' | 'easy' | 'medium' | 'hard' ('all' off Solo)
//   setLevel(l)  : picks it without calling onChange (after set('solo'))

const TABLE_SIZES = [2, 3, 4, 5, 6];

function createSizeFilter(rootId, { onChange }) {
  let value = 'all';
  let level = 'all';

  const root = document.getElementById(rootId);
  root.classList.add('pill-group', 'period-row');
  root.innerHTML = `
    <button class="pill" type="button" data-size="all">${t('All')}</button>
    <span class="period-pill-wrap">
      <select class="period-pill" data-menu="size" aria-label="${t('Players')}"></select>
      <span class="chevron" aria-hidden="true">▼</span>
    </span>
    <button class="pill pill-solo" type="button" data-size="solo">${t('Solo')}</button>
    <span class="period-pill-wrap">
      <select class="period-pill pill-solo" data-menu="level" aria-label="${t('Difficulty')}"></select>
      <span class="chevron" aria-hidden="true">▼</span>
    </span>`;
  const allBtn  = root.querySelector('[data-size="all"]');
  const soloBtn = root.querySelector('[data-size="solo"]');
  const sel     = root.querySelector('[data-menu="size"]');
  const lvlSel  = root.querySelector('[data-menu="level"]');

  function render() {
    const sized   = typeof value === 'number';
    const leveled = value === 'solo' && level !== 'all';
    allBtn.classList.toggle('on', value === 'all');
    soloBtn.classList.toggle('on', value === 'solo' && !leveled);
    sel.classList.toggle('on', sized);
    lvlSel.classList.toggle('on', leveled);
    sel.innerHTML =
      `<option value="" hidden${sized ? '' : ' selected'}>${_esc(t('Players'))}</option>` +
      TABLE_SIZES.map(n => `<option value="${n}"${n === value ? ' selected' : ''}>${n}p</option>`).join('');
    lvlSel.innerHTML =
      `<option value="" hidden${leveled ? '' : ' selected'}>${_esc(t('Difficulty'))}</option>` +
      SOLO_LEVEL_IDS.map(id => `<option value="${id}"${leveled && id === level ? ' selected' : ''}>${_esc(soloLevelName(id))}</option>`).join('');
  }

  // v: 'all' | 2…6 | 'solo'; l: the solo level ('all': every one).
  const pick = (v, l = 'all') => {
    if (v === value && l === level) return;
    value = v;
    level = v === 'solo' ? l : 'all';
    render();
    onChange();
  };
  allBtn.addEventListener('click', () => pick('all'));
  soloBtn.addEventListener('click', () => pick('solo'));
  sel.addEventListener('change', () => pick(sel.value ? +sel.value : 'all'));
  lvlSel.addEventListener('change', () => pick('solo', lvlSel.value || 'all'));

  // Picked with a tap or a click, a menu lets go of the focus (no ring left on
  // it); with the keyboard it keeps it. As in the period filter.
  for (const menu of [sel, lvlSel]) {
    let pointer = false;
    menu.addEventListener('pointerdown', () => { pointer = true; });
    menu.addEventListener('keydown',     () => { pointer = false; });
    menu.addEventListener('change',      () => { if (pointer) menu.blur(); });
  }

  render();

  return {
    value: () => value,
    set(v) {
      value = v === 'solo' || TABLE_SIZES.includes(v) ? v : 'all';
      if (value !== 'solo') level = 'all';
      render();
    },
    isSolo: () => value === 'solo',
    level:  () => value === 'solo' ? level : 'all',
    setLevel(l) {
      level = value === 'solo' && SOLO_LEVELS[l] ? l : 'all';
      render();
    },
  };
}
