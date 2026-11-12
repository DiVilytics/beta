// ── THE TOURNAMENT FORM (beta) ────────────────────────────────────────────────
// tournaments.html's New tournament (?new) and Edit tournament: the name and
// date, the format and its options (one button per rule in
// tournament-rules.js), the draw pool and its copies, the players, the draft
// kept while New tournament is open, and the save (a new tournament's insert,
// or save_tournament_setup). Loaded before tournaments.js, which uses its
// state (tnPool, tnFormFor) and opens it (tnOpenForm); it uses the page's
// (tnTour, tnPlayers, tnTables, tnChars) and helpers once it's open.

let tnPool     = null;        // the form's draw pool (pace-filter.js)
let tnCopies   = {};          // its copies: villain → 2…9 (1: not listed), the villains in the pool only
let tnFormFor  = null;        // the form edits this tournament's settings (null: a new one)
const tnRule   = { format: 'points', table_split: 'even', pairing: 'random', play_order: 'random', scoring: 'borda', bye: 'half', final: 'off' };
let   tnCustom = {};   // the custom scoring's points, { n: row } for every table size, 1st first

// ── THE FORM ──────────────────────────────────────────────────────────────────
// New tournament, or the lobby's settings: the name, the players per table
// (the largest table), the stages, the pairing and scoring rules (one button
// per rule in tournament-rules.js) and the draw pool (New Game's draw pool).

const _tnFormOpen = () => !document.getElementById('tnForm').classList.contains('hidden');
// The settings change until one of the tournament's games starts (or is
// entered): once started, saving draws stage 1 again when the draw changes.
const _tnAllOpen = tour => !tour || (tour.current_stage <= 1 && !tnTables.some(tb => tb.started_at || tb.game_id));

async function tnOpenForm(tour) {
  tnFormFor = tour;
  if (!getCurrentUser() && !tour) return goToSignIn();
  clearTimeout(tnPollTimer);
  setVisible('tnRoot', false);
  setVisible('tnForm', true);
  if (tour) {
    const back = document.getElementById('tnBack');
    back.href = `tournaments.html?t=${tour.id}`;
    back.textContent = `← ${tour.name}`;
    back.onclick = e => { e.preventDefault(); tnCloseForm(); };
    setVisible(back, true);
  } else {
    _tnSetBack();
  }
  // New tournament only: an open tournament has its ⓘ next to Options.
  setVisible('tnIntroHelp', !tour);
  document.getElementById('tnFormSave').textContent = tour ? t('Save Changes') : t('Create tournament');
  clearError('tnFormErr');
  _tnFillSettings(tour);
  // Once a game has started: only the name and the date (fixing a typo).
  const open = _tnAllOpen(tour);
  document.querySelectorAll('#tnForm .tn-fixed').forEach(el => setVisible(el, open));
  setVisible('tnRedrawNote', !!tour && open && tour.current_stage > 0);
  _tnRenderRules();
  _tnHelpButtons();

  await _tnInitPool();
  const draft = _tnFillPool(tour);
  // The players: two empty rows, or the tournament's (a default name shows as
  // the empty row's placeholder; a claimed one as its nickname).
  document.getElementById('tnFormPlayersLabel').textContent = t('Players');
  const meId = getCurrentUser()?.id;
  tnFormPlayers = tour
    ? tnPlayers.map(p => ({ id: p.id, stored: p.name, name: _tnIsDefaultName(p.name) ? '' : p.name, userId: p.user_id, isMe: !!meId && p.user_id === meId }))
    : [{ name: '', isMe: false }, { name: '', isMe: false }];
  if (draft) _tnApplyDraft(draft);
  setVisible('tnFormPlayers', open);
  _tnSyncFormat();
  _tnPoolChanged();
  // New: Discard (the Back link keeps the draft); Edit tournament: Cancel.
  setVisible('tnFormDiscard', !tour);
  setVisible('tnFormCancel', !!tour);
  _tnDraftReady = !tour;
  _tnUpdateDiscard();
}

// The settings, the tournament's (Edit tournament) or a new one's defaults.
function _tnFillSettings(tour) {
  document.getElementById('tnName').value   = tour?.name || '';
  document.getElementById('tnDate').value   = tour?.event_date || _tnToday();
  document.getElementById('tnSize').value   = String(tour?.table_size || 4);
  document.getElementById('tnStages').value = tour ? String(tour.stages ?? 'open') : 'open';
  _tnAdvanceOptions(tour?.advance || 1);
  tnRule.format      = tour?.format || 'points';
  tnRule.table_split = tour?.table_split || 'even';
  tnRule.pairing     = tour?.pairing || 'random';
  tnRule.play_order  = tour?.play_order || 'random';
  tnRule.scoring     = tour?.scoring || 'borda';
  tnRule.bye         = tour?.bye || (tour ? 'last' : 'half');
  tnRule.final       = tour?.final_table ? 'on' : 'off';
  tnCustom = tour?.custom_points?.length ? tournamentCustomRows(tour) : _tnCustomRows(tour?.table_size || 4);
}

// The draw pool: New Game's picker (pace-filter.js), made once.
async function _tnInitPool() {
  if (!tnPool) {
    tnPool = createPaceFilter({
      getChars:     () => tnChars,
      gridId:       'tnPoolGrid',
      paceColorsId: 'tnPaceColors',
      paceModeId:   'tnPaceMode',
      mineBtnId:    'tnMineBtn',
      mineTitles: {
        signIn:  t('Sign in to filter by owned boxes'),
        noBoxes: t('Mark which boxes you own on the account page first'),
        on:      t('Pool limited to your boxes'),
        off:     t('Limit the pool to your boxes'),
      },
      onChange:      _tnPoolChanged,
      onError:       msg => showError('tnFormErr', msg),
      mineByDefault: true,
    });
    buildExcludeGrid(document.getElementById('tnPoolGrid'), tnChars, tnPool.excluded, _tnPoolChanged, tnBoxInfo);
    await tnPool.loadOwnedBoxes();
  }
}

// The pool and its copies: the tournament's, or New tournament's draft (else
// your boxes, when you've marked some). Returns the draft, if any.
function _tnFillPool(tour) {
  if (tour) {
    const inPool = new Set(tour.villain_pool);
    tnPool.restoreState({ excluded: tnChars.map(c => c.name).filter(n => !inPool.has(n)) });
  } else {
    tnPool.reset();
  }
  tnCopies = Object.fromEntries(Object.entries(tournamentPoolCopies(tour?.villain_pool)).filter(([, n]) => n > 1));
  const draft = tour ? null : _tnLoadDraft();
  if (draft?.pool) tnPool.restoreState(draft.pool);
  if (draft?.copies) tnCopies = { ...draft.copies };
  else if (!tour) tnPool.defaultToMine();   // your boxes, when you've marked some
  tnPool.updatePaceUI();
  return draft;
}

// ── New tournament's draft ──
// As in New Game: the form (name, date, options, custom points, players and
// the draw pool) is kept in localStorage as you edit, so leaving the page or
// Cancel doesn't lose it. It expires an hour after the last change; Discard
// and Create tournament clear it. An untouched date isn't kept (it comes back
// as today). Edit tournament has no draft: Cancel leaves the tournament as it was.
const TN_DRAFT_KEY    = 'divilytics_tournament_draft' + STORAGE_SCOPE;   // the beta's apart (config.js)
const TN_DRAFT_MAX_MS = 60 * 60 * 1000;
let _tnDraftReady = false;   // only while New tournament's form is open

function _tnDraftState() {
  const val = id => document.getElementById(id).value;
  return {
    name:    val('tnName'),
    date:    val('tnDate') !== _tnToday() ? val('tnDate') : '',
    size:    val('tnSize'),
    stages:  val('tnStages'),
    advance: val('tnAdvance'),
    rule:    { ...tnRule },
    custom:  tnCustom,
    players: tnFormPlayers.map(p => ({ name: p.name, isMe: !!p.isMe })),
    pool:    { excluded: [...tnPool.excluded], selectedPace: tnPool.selectedPace, pacePlus: !!tnPool.selectedPace && tnPool.pacePlus, mineOn: tnPool.mineOn },
    copies:  _tnCopiesInPool(),
  };
}

// Anything changed from a fresh New tournament form?
function _tnFormChanged() {
  const d = _tnDraftState();
  return !!d.name.trim() || !!d.date || d.size !== '4' || d.stages !== 'open'
    || Object.entries({ format: 'points', table_split: 'even', pairing: 'random', play_order: 'random', scoring: 'borda', bye: 'half', final: 'off' }).some(([k, v]) => d.rule[k] !== v)
    || d.players.length !== 2 || d.players.some(p => p.name.trim() || p.isMe)
    || !tnPool.isDefault() || Object.keys(d.copies).length > 0;
}

function _tnSaveDraft() {
  if (!_tnDraftReady || tnFormFor) return;
  _tnUpdateDiscard();
  try {
    if (!_tnFormChanged()) return localStorage.removeItem(TN_DRAFT_KEY);
    localStorage.setItem(TN_DRAFT_KEY, JSON.stringify({ saved: Date.now(), ..._tnDraftState() }));
  } catch (_) {}
}

function _tnDropDraft() {
  try { localStorage.removeItem(TN_DRAFT_KEY); } catch (_) {}
}

function _tnLoadDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(TN_DRAFT_KEY)); } catch (_) {}
  if (d && !(Date.now() - d.saved <= TN_DRAFT_MAX_MS)) { _tnDropDraft(); return null; }
  return d;
}

function _tnApplyDraft(d) {
  document.getElementById('tnName').value = d.name || '';
  if (d.date) document.getElementById('tnDate').value = d.date;
  if (d.size)   document.getElementById('tnSize').value = d.size;
  if (d.stages) document.getElementById('tnStages').value = d.stages;
  for (const k of Object.keys(tnRule)) if (d.rule?.[k]) tnRule[k] = d.rule[k];
  if (d.advance) _tnAdvanceOptions(Number(d.advance));
  if (d.custom) tnCustom = d.custom;
  if (d.players?.length >= 2) tnFormPlayers = d.players.map(p => ({ name: p.name || '', isMe: !!p.isMe && !!getCurrentProfile() }));
  _tnRenderRules();
}

function _tnUpdateDiscard() {
  const btn = document.getElementById('tnFormDiscard');
  if (btn) btn.disabled = !(_tnDraftReady && _tnFormChanged());
}

function tnDiscardForm() {
  openConfirmSheet({
    id:           'tnDiscardFormSheet',
    title:        t('Discard this tournament?'),
    bodyHTML:     `<p class="confirm-text">${t('This resets the form (name, options, draw pool and players) and clears the saved draft.')}</p>`,
    confirmLabel: t('Discard'),
    danger:       true,
    onConfirm:    async () => {
      _tnDraftReady = false;
      _tnDropDraft();
      await tnOpenForm();
      window.scrollTo(0, 0);
    },
  });
}

// Every change in the form saves the draft (a tap's handler runs first).
for (const ev of ['input', 'change']) document.getElementById('tnForm')?.addEventListener(ev, _tnSaveDraft);
document.getElementById('tnForm')?.addEventListener('click', () => setTimeout(_tnSaveDraft));

function tnCloseForm() {
  if (!tnFormFor) return void (location.href = 'tournaments.html');
  _tnSetBack();
  setVisible('tnForm', false);
  setVisible('tnRoot', true);
  tnRenderTournament();
  _tnSchedulePoll();
}

// One button per rule, the picked one on, its explanation under it.
function _tnRenderRules() {
  for (const [kind, rules, segId, hintId] of [
    ['format', TOURNAMENT_FORMATS, 'tnFormat', 'tnFormatHint'],
    ['table_split', TOURNAMENT_SPLITS, 'tnSplit', 'tnSplitHint'],
    ['pairing', TOURNAMENT_PAIRINGS, 'tnPairing', 'tnPairingHint'],
    ['play_order', TOURNAMENT_PLAY_ORDERS, 'tnPlayOrder', 'tnPlayOrderHint'],
    ['scoring', TOURNAMENT_SCORINGS, 'tnScoring', 'tnScoringHint'],
    ['bye', TOURNAMENT_BYES, 'tnBye', 'tnByeHint'],
    ['final', TN_FINAL, 'tnFinal', 'tnFinalHint'],
  ]) {
    const seg = document.getElementById(segId);
    const off = seg.classList.contains('disabled');
    seg.innerHTML = Object.entries(rules).map(([id, r]) =>
      `<button class="seg-btn${id === tnRule[kind] ? ' on' : ''}" type="button" onclick="tnPickRule('${kind}', '${id}')"${off ? ' disabled' : ''}>${t(r.name)}</button>`).join('');
    document.getElementById(hintId).textContent = t(rules[tnRule[kind]]?.hint || '');
  }
  _tnRenderCustom();
}

const _tnToday     = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const _tnBordaRow  = size => Array.from({ length: size }, (_, i) => size - 1 - i);
const _tnFormSize  = () => Number(document.getElementById('tnSize').value);

// Custom scoring: a row of boxes per table size, the largest on top. The
// organizer types the largest table's points; Same win or Keep the
// average fills the smaller tables from them (TOURNAMENT_CUSTOM_FILLS), and
// each box can still be changed by hand.
const _tnCustomRows = (size, top = _tnBordaRow(size), fill = 'ends') => {
  const rows = { [size]: top };
  for (let n = size - 1; n >= 2; n--) rows[n] = tournamentCustomFill(top, n, fill);
  return rows;
};

function _tnRenderCustom() {
  const on = tnRule.scoring === 'custom';
  setVisible('tnCustom', on);
  if (!on) return;
  const size = _tnFormSize();
  if (tnCustom[size]?.length !== size) tnCustom = _tnCustomRows(size);
  // A triangle: the places once on top, a row per table size under them.
  const cells = [`<span></span>`, ...Array.from({ length: size }, (_, i) => `<span class="tn-custom-place">${fmtPlace(i + 1)}</span>`)];
  for (let n = size; n >= 2; n--) {
    cells.push(`<span class="tn-custom-n">${tn(n, '{n} player', '{n} players')}</span>`);
    tnCustom[n].forEach((v, i) => cells.push(`<input type="number" inputmode="decimal" min="0" step="any" value="${v}" aria-label="${_esc(`${tn(n, '{n} player', '{n} players')}, ${fmtPlace(i + 1)}`)}" oninput="tnCustom[${n}][${i}] = Math.max(0, Number(this.value) || 0)">`));
    for (let i = n; i < size; i++) cells.push('<span></span>');
  }
  const lines = [`<div class="tn-custom-grid" style="--places: ${size}">${cells.join('')}</div>`];
  document.getElementById('tnCustomRows').innerHTML = lines.join('');
  setVisible('tnCustomFill', size > 2);
  document.getElementById('tnCustomFill').innerHTML = `<span>${t('Fill the smaller tables:')}</span>` +
    Object.entries(TOURNAMENT_CUSTOM_FILLS).map(([id, f]) =>
      `<button class="btn btn-ghost btn-sm" type="button" onclick="tnCustomFill('${id}')">${t(f.name)}</button>`).join('');
}

function tnCustomFill(fill) {
  const size = _tnFormSize();
  tnCustom = _tnCustomRows(size, tnCustom[size], fill);
  _tnRenderCustom();
}

// Each option's ⓘ, next to its label (added once: the labels are translated first).
function _tnHelpButtons() {
  document.querySelectorAll('#tnForm [data-help] > label').forEach(label => {
    if (label.querySelector('.tn-info')) return;
    const key = label.parentElement.dataset.help;
    label.insertAdjacentHTML('beforeend', ` <button class="tn-info" type="button" onclick="event.preventDefault(); tnHelp('${key}')" title="${_esc(t('Tournament options'))}">ⓘ</button>`);
    // Only the ⓘ opens it: a label with no field of its own would otherwise
    // pass a tap anywhere on it to the button.
    if (!label.htmlFor) label.addEventListener('click', e => { if (!e.target.closest('.tn-info')) e.preventDefault(); });
  });
}

function tnSizeChanged() {
  tnCustom = _tnCustomRows(_tnFormSize());
  _tnRenderCustom();
  _tnSyncFormat();
}

function tnPickRule(kind, id) {
  tnRule[kind] = id;
  _tnRenderRules();
  if (kind === 'format') _tnSyncFormat();
}

// ── Format ──
// Points shows the stages' options (tables, pairing, scoring, bye, final);
// Knockout its bracket's: how many advance from each table (dividing the
// table size), 2 stages or more, and how many players that takes.
const _tnFormKo = () => tnRule.format === 'knockout';
const _tnFormKoTour = () => ({ format: 'knockout', table_size: _tnFormSize(), advance: Number(document.getElementById('tnAdvance').value) || 1,
  stages: Number(document.getElementById('tnStages').value) || 2 });

// Advance's choices for the table size: 1 up to half of it, those dividing it.
function _tnAdvanceOptions(keep) {
  const sel = document.getElementById('tnAdvance');
  const size = _tnFormSize(), want = keep ?? (Number(sel.value) || 1);
  const ok = Array.from({ length: size - 1 }, (_, i) => i + 1).filter(p => size % p === 0);
  sel.innerHTML = ok.map(p => `<option value="${p}"${p === (ok.includes(want) ? want : 1) ? ' selected' : ''}>${p}</option>`).join('');
}

function _tnSyncFormat() {
  const ko = _tnFormKo(), open = _tnAllOpen(tnFormFor);
  document.querySelectorAll('#tnForm .tn-points-only').forEach(el => setVisible(el, open && !ko));
  document.querySelectorAll('#tnForm .tn-ko-only').forEach(el => setVisible(el, open && ko));
  // A knockout has 2 stages or more, never open-ended.
  const stages = document.getElementById('tnStages');
  for (const o of stages.options) o.hidden = o.disabled = ko && (o.value === 'open' || o.value === '1');
  if (ko && (stages.value === 'open' || stages.value === '1')) stages.value = '2';
  _tnAdvanceOptions();
  if (ko) {
    const tour = _tnFormKoTour();
    const vars = { tables: tn(tournamentKoTables(tour, 1), '{n} table', '{n} tables'), min: tournamentKoMin(tour), max: tournamentKoMax(tour), p: tour.advance };
    document.getElementById('tnAdvanceHint').textContent = tour.advance === 1
      ? t('Stage 1 has {tables}: from {min} to {max} players. Then the winner of each table plays the next stage, down to the final.', vars)
      : t('Stage 1 has {tables}: from {min} to {max} players. Then the top {p} of each table play the next stage, down to the final.', vars);
  }
  _tnPlayersHint();
  if (!open) return;
  // A knockout starts its rows at its fewest players (no more than the pool).
  const want = Math.min(_tnFormMin(), _tnFormMax());
  while (tnFormPlayers.length < want) tnFormPlayers.push({ name: '', isMe: false });
  _tnRenderFormPlayers();
}

function _tnPlayersHint() {
  const tour = _tnFormKo() ? _tnFormKoTour() : null;
  document.getElementById('tnFormPlayersHint').textContent = tour
    ? t('From {min} to {max} players, and no more than the copies of villains in the draw pool. An empty name keeps the one shown. Players change here until the first game starts.', { min: tournamentKoMin(tour), max: tournamentKoMax(tour) })
    : t('From 2 players up to the copies of villains in the draw pool. An empty name keeps the one shown. Players change here until the first game starts.');
}

function tnTogglePool(open) {
  const body = document.getElementById('tnPoolBody');
  const isOpen = body.classList.toggle('open', open);
  document.getElementById('tnPoolChevron').classList.toggle('open', isOpen);
}

function _tnPoolChanged() {
  for (const n of Object.keys(tnCopies)) if (tnPool.excluded.has(n)) delete tnCopies[n];   // out of the pool: 0 copies (back in: 1)
  const badge = document.getElementById('tnPoolBadge');
  badge.textContent = _tnPoolSize();   // copies included
  badge.classList.add('visible');
  badge.classList.toggle('full', !tnPool.excluded.size);
  // Beside Copies: "33 villains | 36 copies".
  const sum = document.getElementById('tnCopiesSum');
  if (sum) sum.textContent = `${tn(tnChars.length - tnPool.excluded.size, '{n} villain', '{n} villains')} | ${tn(_tnPoolSize(), '{n} copy', '{n} copies')}`;
  document.getElementById('tnPoolReset').disabled = tnPool.isDefault();
  document.getElementById('tnIncludeAll').disabled = !tnPool.excluded.size;   // every villain in already
  if (!document.getElementById('tnFormPlayers').classList.contains('hidden')) _tnRenderFormPlayers();
}

// ── The form's players ──
// New Game's rows: a name each (empty: the "Player 3" shown), 👤 for you (your
// nickname, your name claimed), ❌ to remove; the count menu from 2 up to the
// villains in the draw pool (every player needs a different one per stage).
// Edit tournament starts from the tournament's players ({ id, stored, userId }):
// a name someone claimed shows their nickname and can't be typed over.
let tnFormPlayers = [];

// Copies (in the draw pool): every villain, by box as the pool, with − n +
// (0 to TN_MAX_COPIES): the copies at hand for this tournament only. A villain
// in the pool starts at its copies (1 if none set), one out of it at 0; Done
// keeps them, and the pool follows: 0 takes a villain out, 1 or more puts it
// in (and the other way, a villain taken out of the pool loses its copies).
// In a stage a villain is played at most once per copy, never twice at a
// table. Cancel leaves everything as it was.
const TN_MAX_COPIES = 9;   // the database's limit too
let _tnCopiesEdit = {};
function tnOpenCopies() {
  _tnCopiesEdit = Object.fromEntries(tnChars.map(c => [c.name, tnPool.excluded.has(c.name) ? 0 : (tnCopies[c.name] || 1)]));
  openConfirmSheet({
    id:           'tnCopiesSheet',
    title:        t('Copies'),
    bodyHTML:     `<p class="modal-hint">${t('How many copies of each villain are at hand for this tournament (0: not in the draw pool). In a stage a villain is played at most once per copy, and never twice at the same table.')}</p><div id="tnCopiesRows" class="tn-copies-rows"></div>`,
    confirmLabel: t('Done'),
    onConfirm:    () => {
      tnCopies = Object.fromEntries(Object.entries(_tnCopiesEdit).filter(([, n]) => n > 1));
      const out = tnChars.map(c => c.name).filter(n => !_tnCopiesEdit[n]);
      // The pool follows (only when its villains changed: a pace picked stays otherwise).
      if (out.length !== tnPool.excluded.size || out.some(n => !tnPool.excluded.has(n))) {
        tnPool.restoreState({ excluded: out, selectedPace: null, pacePlus: tnPool.pacePlus, mineOn: false });
      }
      _tnPoolChanged();
      _tnSaveDraft();
    },
  });
  _tnRenderCopies();
}
function tnBumpCopies(name, d) {
  _tnCopiesEdit[name] = Math.max(0, Math.min(TN_MAX_COPIES, (_tnCopiesEdit[name] || 0) + d));
  _tnRenderCopies();
}
function _tnRenderCopies() {
  const box = document.getElementById('tnCopiesRows');
  if (!box) return;
  const order = b => tnBoxInfo[b]?.order ?? 99;
  const all = tnChars.slice().sort((a, b) => order(a.box) - order(b.box) || (a.sort_order ?? 0) - (b.sort_order ?? 0));
  box.innerHTML = all.map((c, i) => {
    const n = _tnCopiesEdit[c.name] || 0;
    const arg = _esc(JSON.stringify(c.name));
    const head = i === 0 || all[i - 1].box !== c.box ? `<div class="section-label tn-copy-box">${_esc(c.box || '')}</div>` : '';
    return `${head}
      <div class="order-slot tn-copy-row${n ? '' : ' none'}">
        <img class="order-slot-portrait" src="${charImgSrc(c.name)}" onerror="this.src='asset/players/default.svg'" alt="">
        <div class="order-slot-info"><span class="order-slot-name">${villainNameHTML(c.name)}</span></div>
        <div class="order-slot-actions tn-copy-steps">
          <button class="pf-btn" type="button" onclick="tnBumpCopies(${arg}, -1)"${n <= 0 ? ' disabled' : ''} aria-label="−">−</button>
          <span class="tn-copy-n${n > 1 ? ' on' : ''}">${n}</span>
          <button class="pf-btn" type="button" onclick="tnBumpCopies(${arg}, 1)"${n >= TN_MAX_COPIES ? ` disabled title="${_esc(t('At most {n} copies', { n: TN_MAX_COPIES }))}"` : ''} aria-label="+">+</button>
        </div>
      </div>`;
  }).join('');
}

// The villains in the form's pool, once per copy (the tournament's villain_pool).
function _tnFormPool() {
  return tnChars.map(c => c.name).filter(n => !tnPool.excluded.has(n)).flatMap(n => Array(tnCopies[n] || 1).fill(n));
}
// The copies of the villains still in the pool (one taken out keeps none).
function _tnCopiesInPool() {
  return Object.fromEntries(Object.entries(tnCopies).filter(([n, c]) => c > 1 && !tnPool?.excluded.has(n)));
}
function _tnPoolSize() { return tnPool ? _tnFormPool().length : 0; }
const _tnFormMax = () => Math.max(2, Math.min(_tnPoolSize(), _tnFormKo() ? tournamentKoMax(_tnFormKoTour()) : Infinity));
// A knockout's fewest players (one more than advance at every table of stage 1), else 2.
const _tnFormMin = () => _tnFormKo() ? tournamentKoMin(_tnFormKoTour()) : 2;

// "Player 3" (or "Giocatore 3"): a name nobody typed.
const _tnIsDefaultName = name => /^(player|giocatore) \d+$/i.test(name || '');

// A row someone else claimed (locked). Your own claim follows 👤: moved to
// another row, the old one is a plain name again at once.
const _tnOthersClaim = p => !!p.userId && p.userId !== getCurrentUser()?.id;

// The nickname a row shows instead of its name: yours with 👤, or whoever
// else claimed it.
function _tnRowNick(p) {
  if (p.isMe) return getCurrentProfile()?.nickname || null;
  return _tnOthersClaim(p) ? tnProfiles.get(p.userId)?.nickname || null : null;
}

// The names to store: a claimed name stays as it is; a typed one; an existing
// name left empty keeps its own; a new one left empty (or yours) is
// "Player N" (your nickname shows while you hold it, and the name stays its own
// if you release it), never one already taken.
function _tnFormNames() {
  const kept = p => p.id && (_tnOthersClaim(p) || p.isMe || !p.name.trim()) ? p.stored : null;
  const taken = new Set();
  tnFormPlayers.forEach(p => {
    const n = kept(p) ?? (!p.isMe && p.name.trim());
    if (n) taken.add(n.toLowerCase());
  });
  return tnFormPlayers.map((p, i) => kept(p) ?? ((!p.isMe && p.name.trim()) || _tnFreeName(taken, i + 1)));
}

// "Player N" from n up, the first one not taken (and now taken).
function _tnFreeName(taken, n) {
  let name;
  for (; taken.has((name = t('Player {n}', { n })).toLowerCase()); n++);
  taken.add(name.toLowerCase());
  return name;
}

function _tnRenderFormPlayers() {
  const max = _tnFormMax();
  const n = tnFormPlayers.length;
  const sel = document.getElementById('tnPlayerCount');
  const min = _tnFormMin();
  sel.innerHTML = Array.from({ length: Math.max(max, n) - 1 }, (_, i) => i + 2)
    .map(k => `<option value="${k}"${k === n ? ' selected' : ''}${k > max || k < min ? ' disabled' : ''}>${k}p</option>`).join('');
  const signedIn = !!getCurrentUser();
  document.getElementById('tnFormRows').innerHTML = tnFormPlayers.map((p, i) => {
    const nick = _tnRowNick(p);
    const prof = p.isMe ? getCurrentProfile() : _tnOthersClaim(p) ? tnProfiles.get(p.userId) : null;
    const placeholder = p.stored && _tnIsDefaultName(p.stored) ? p.stored : t('Player {n}', { n: i + 1 });
    return `
    <div class="order-slot">
      <span class="row-num">${i + 1}.</span>
      ${prof ? avatarHTML(resolveAvatar(prof), { cls: 'order-slot-portrait' }) : '<img class="order-slot-portrait" src="asset/players/default.svg" alt="">'}
      ${nick
        ? `<input class="order-slot-name order-slot-input" type="text" value="${_esc(nick)}" readonly tabindex="-1">`
        : `<input class="order-slot-name order-slot-input" type="text" maxlength="30" value="${_esc(p.name)}" placeholder="${_esc(placeholder)}"
             oninput="tnFormPlayers[${i}].name = this.value" autocomplete="off">`}
      <div class="order-slot-actions">
        <button class="pf-btn del" type="button" onclick="tnRemoveFormPlayer(${i})" ${n > min ? `title="${t('Remove')}"` : `title="${_esc(min > 2 ? t('This knockout takes from {min} to {max} players.', { min, max: tournamentKoMax(_tnFormKoTour()) }) : t('A tournament needs at least 2 players.'))}" disabled`}>❌</button>
        <button class="pf-btn me${p.isMe ? ' on' : ''}${signedIn && !_tnOthersClaim(p) ? '' : ' locked'}" type="button" onclick="tnToggleFormMe(${i})" title="${t('Me')}">👤</button>
      </div>
    </div>`;
  }).join('');
  document.getElementById('tnAddRowBtn').disabled = n >= max;
}

function tnSetPlayerCount(n) {
  n = Math.max(_tnFormMin(), Math.min(n, _tnFormMax()));
  while (tnFormPlayers.length < n) tnFormPlayers.push({ name: '', isMe: false });
  tnFormPlayers.length = n;
  _tnRenderFormPlayers();
}

function tnRemoveFormPlayer(i) {
  if (tnFormPlayers.length <= _tnFormMin()) return;
  tnFormPlayers.splice(i, 1);
  _tnRenderFormPlayers();
}

// 👤: you play too (one row, not a name someone else claimed): your nickname
// shows, your name is claimed when the form is saved.
function tnToggleFormMe(i) {
  if (!getCurrentProfile()?.nickname) return;
  const p = tnFormPlayers[i];
  if (_tnOthersClaim(p)) return;
  const on = !p.isMe;
  tnFormPlayers.forEach(x => { x.isMe = false; });
  p.isMe = on;
  _tnRenderFormPlayers();
}

// What saving Edit tournament does to the players: removed, renamed, added, and
// your claim moved (released, claimed).
function _tnPlayersPlan(names) {
  const me = getCurrentUser()?.id;
  const before = tnFormFor ? tnPlayers : [];   // a new tournament has none yet
  const kept = new Set(tnFormPlayers.filter(p => p.id).map(p => p.id));
  const mineBefore = before.find(p => p.user_id === me);
  const mineAfter  = tnFormPlayers.find(p => p.isMe);
  return {
    removed: before.filter(p => !kept.has(p.id)).map(p => p.id),
    renamed: tnFormPlayers.map((p, i) => p.id && names[i] !== p.stored ? { id: p.id, name: names[i] } : null).filter(Boolean),
    added:   tnFormPlayers.map((p, i) => p.id ? null : { name: names[i], user_id: p.isMe ? me : null }).filter(Boolean),
    release: mineBefore && mineBefore.id !== mineAfter?.id && kept.has(mineBefore.id) ? mineBefore.id : null,
    claim:   mineAfter?.id && mineAfter.id !== mineBefore?.id ? mineAfter.id : null,
  };
}
const _tnPlanChangesDraw = plan => plan.removed.length + plan.renamed.length + plan.added.length > 0;

// Carries out the plan, in an order no unique name (or one name per player)
// trips over: removals and your old claim's release first.
async function _tnApplyPlayers(id, plan) {
  if (plan.removed.length) {
    const { error } = await db.from('tournament_players').delete().in('id', plan.removed);
    if (error) return error;
  }
  if (plan.release) {
    const { error } = await db.rpc('release_tournament_player', { target_player: plan.release });
    if (error) return error;
  }
  for (const r of plan.renamed) {
    const { error } = await db.from('tournament_players').update({ name: r.name }).eq('id', r.id);
    if (error) return error;
  }
  if (plan.added.length) {
    const { error } = await db.from('tournament_players').insert(plan.added.map(a => ({ tournament_id: id, ...a })));
    if (error) return error;
  }
  if (plan.claim) return (await db.rpc('claim_tournament_player', { target_player: plan.claim, claim_code: _tnCode() })).error;
  return null;
}

async function tnSaveForm() {
  const user = getCurrentUser();
  if (!user) return goToSignIn();
  // A game has started: the name and the date only.
  if (tnFormFor && !_tnAllOpen(tnFormFor)) return _tnSaveNameDate();
  const form = _tnReadForm();
  if (form.error) return showError('tnFormErr', form.error);
  return tnFormFor ? _tnSaveEdit(form) : _tnSaveNew(form, user);
}

// Back to the tournament, reloaded (after a save).
function _tnBackToTournament(id) {
  _tnSetBack();
  setVisible('tnForm', false);
  setVisible('tnRoot', true);
  return tnLoad(id);
}

async function _tnSaveNameDate() {
  const name = document.getElementById('tnName').value.trim();
  const date = document.getElementById('tnDate').value || _tnToday();
  if (!name) return showError('tnFormErr', t('Give the tournament a name.'));
  const btn = document.getElementById('tnFormSave');
  btn.disabled = true;
  let error = null;
  if (name !== tnFormFor.name) error = (await db.rpc('set_tournament_name', { target: tnFormFor.id, new_name: name })).error;
  if (!error && date !== tnFormFor.event_date) error = (await db.rpc('set_tournament_date', { target: tnFormFor.id, new_date: date })).error;
  btn.disabled = false;
  if (error) return showError('tnFormErr', _tnErrorMsg(error));
  return _tnBackToTournament(tnFormFor.id);
}

// The form as a tournaments row, checked: { row, names, pool, plan }, or
// { error } (the first thing to fix).
function _tnReadForm() {
  const date  = document.getElementById('tnDate').value || _tnToday();
  const names = _tnFormNames();
  const pool  = _tnFormPool();   // a villain once per copy
  const name  = document.getElementById('tnName').value.trim();
  const stagesVal = document.getElementById('tnStages').value;
  const stages = stagesVal === 'open' ? null : Number(stagesVal);
  const size  = _tnFormSize();
  const total = names.length;
  const ko = _tnFormKo() ? _tnFormKoTour() : null;
  const fail = error => ({ error });
  if (new Set(names.map(n => n.toLowerCase())).size !== total) return fail(t('Every player needs a different name.'));
  if (!name) return fail(t('Give the tournament a name.'));
  if (stages !== null && (!Number.isInteger(stages) || stages < 1 || stages > 20)) return fail(t('Stages: from 1 to 20.'));
  if (new Set(pool).size < 2) return fail(t('The draw pool needs at least 2 villains.'));
  if (total > pool.length) return fail(t('The draw pool has {v} copies of villains for {n} players: every player needs one.', { v: pool.length, n: total }));
  if (ko && !tournamentKoValid(ko.table_size, ko.advance, ko.stages)) return fail(t('Knockout: the players who advance divide the table size, and there are 2 stages or more.'));
  if (ko && (total < tournamentKoMin(ko) || total > tournamentKoMax(ko))) return fail(t('This knockout takes from {min} to {max} players.', { min: tournamentKoMin(ko), max: tournamentKoMax(ko) }));
  if (!tournamentVillainsFit(pool, ko ? tournamentKoStartSizes(ko, total) : tournamentSplit(total, size, tnRule.table_split))) {
    return fail(t("With the draw pool's copies, {n} players can't all have different villains at their tables: add villains or copies.", { n: total }));
  }
  const row = { name, stages, table_size: size, pairing: tnRule.pairing, scoring: tnRule.scoring, villain_pool: pool };
  if (tnRule.scoring === 'custom') {
    const rows = Object.keys(tnCustom).map(Number).filter(n => n <= size).sort((a, b) => b - a).map(n => tnCustom[n]);
    if (rows.some(r => r.some((v, i) => i && v > r[i - 1]))) return fail(t('Custom points: each place scores no more than the one above it.'));
    row.custom_points = rows.flat();
  }
  // The options the database adds a default for are written only when they
  // differ from it (or from what the tournament had).
  for (const [key, value, dflt] of [
    ['table_split', tnRule.table_split, 'even'], ['play_order', tnRule.play_order, 'random'],
    ['bye', tnRule.bye, 'half'], ['event_date', date, _tnToday()], ['final_table', !ko && tnRule.final === 'on', false],
  ]) {
    if (value !== dflt || (tnFormFor && (tnFormFor[key] ?? dflt) !== value)) row[key] = value;
  }
  // The format only for a knockout, or one that was (points is the default).
  if (ko || tnFormFor?.format === 'knockout') Object.assign(row, { format: tnRule.format, advance: ko ? ko.advance : null });
  return { row, names, pool, plan: _tnPlayersPlan(names) };
}

// Edit tournament: one call (save_tournament_setup), all or nothing. The
// players as they'll be, a new one with an id made here so stage 1 can be
// drawn with it.
function _tnSaveEdit({ row, names, pool, plan }) {
  const was = tnFormFor;
  const players = tnFormPlayers.map((p, i) => ({ id: p.id || crypto.randomUUID(), name: names[i], me: !!p.isMe }));
  if (was.current_stage === 0) return _tnSaveSetup({ settings: row, players });
  // Started, no game yet: a change to the draw (the players' names included)
  // draws stage 1 again; otherwise only the settings (and your name) change.
  const redraw = _tnPlanChangesDraw(plan) || row.table_size !== was.table_size || row.stages !== was.stages
    || (row.format ?? 'points') !== (was.format || 'points') || (row.advance ?? null) !== (was.advance ?? null)
    || row.table_split !== undefined && row.table_split !== (was.table_split || 'even')
    || row.play_order  !== undefined && row.play_order  !== (was.play_order || 'random')
    || [...pool].sort().join('|') !== [...was.villain_pool].sort().join('|');   // the villains or their copies
  if (!redraw) return _tnSaveSetup({ settings: row, plan });
  return openConfirmSheet({
    id:           'tnRedrawSheet',
    title:        t('Draw stage 1 again?'),
    bodyHTML:     `<p class="confirm-text">${t('The tables, the stages, the pool or the players changed: stage 1\'s tables and villains are drawn again.')}</p>`,
    confirmLabel: t('Draw again'),
    onConfirm:    async () => {
      // The new start, from the new settings and players (withdrawn ones stay so).
      const tour = { ...was, ...row };
      const drawn = players.map(x => { const p = tnPlayers.find(y => y.id === x.id); return { id: x.id, withdrawn_after: p?.withdrawn_after ?? null, joined_stage: p?.joined_stage ?? null }; });
      const tables   = tournamentDrawStage(tour, drawn, []);
      const villains = tournamentStageVillains(tour, tables, []);
      await _tnSaveSetup({ settings: row, players, villains, tables });
    },
  });
}

// New tournament: the row, then its players; on to its page.
async function _tnSaveNew({ row, plan }, user) {
  const btn = document.getElementById('tnFormSave');
  btn.disabled = true;
  const res = await db.from('tournaments').insert({ ...row, organizer: user.id }).select('id');
  btn.disabled = false;
  if (res.error || !res.data?.length) return showError('tnFormErr', _tnErrorMsg(res.error));
  const id = res.data[0].id;
  const error = await _tnApplyPlayers(id, plan);
  if (error) console.warn('tournament players', error);   // Edit tournament can still add them
  _tnDraftReady = false;
  _tnDropDraft();
  location.replace(`tournaments.html?t=${id}`);
}

// Edit tournament's save. Without the players (started, no new draw): your
// name moved apart, by claim and release.
async function _tnSaveSetup({ settings, players = null, villains = null, tables = null, plan = null }) {
  const btn = document.getElementById('tnFormSave');
  btn.disabled = true;
  let { error } = await db.rpc('save_tournament_setup', { target: tnFormFor.id, settings, players, villains, tables });
  if (!error && plan && (plan.release || plan.claim)) error = await _tnApplyPlayers(tnFormFor.id, { removed: [], renamed: [], added: [], release: plan.release, claim: plan.claim });
  btn.disabled = false;
  if (error) return showError('tnFormErr', _tnErrorMsg(error));
  await _tnBackToTournament(tnFormFor.id);
}
