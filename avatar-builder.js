// ── AVATAR BUILDER ─────────────────────────────────────────────────────────────
// The account page's "compose your own icon" UI: pick one transparent PNG part
// per body slot over a background color. The parts, draw order and per-part
// option counts live in AVATAR_BUILDER (avatar.js), the same config the renderer
// uses, so the builder and every display point can never drift. Saving stores a
// compact recipe string in avatar_url; avatarHTML() composes it on the fly. The
// live preview uses that same render path (no rasterization anywhere).
//
// The host (account.js) wires it up with configure({ getSavedAvatar, onPreview }):
//   getSavedAvatar(), the avatar currently saved on the profile (to seed from)
//   onPreview()     , called after any edit so the host can re-render the preview
const avatarBuilder = (() => {
  // Disney Villainous jewel tones, villain signature colors over a dark, moody
  // base (Maleficent purple/green, Ursula teal, Jafar/Hook crimson, Prince John
  // gold, Hades blue, the black-and-gold box).
  const BG_SWATCHES = ['#4a1d6e', '#6b2d8c', '#7d1f3f', '#a01515', '#b8621b', '#c9a227', '#1f7a4d', '#0e5c6b', '#15182e'];
  const LS = 'divilytics:avatarBuilder';

  let sel = {};
  let bg  = AVATAR_BUILDER.defaultBg;
  let _getSavedAvatar = () => null;
  let _onPreview      = () => {};

  function configure({ getSavedAvatar, onPreview } = {}) {
    if (getSavedAvatar) _getSavedAvatar = getSavedAvatar;
    if (onPreview)      _onPreview = onPreview;
  }

  // Seed from the saved avatar if it's already a recipe, else from the last edit
  // kept in localStorage, else defaults.
  function loadState() {
    const fromRecipe = parseAvatarRecipe(_getSavedAvatar());
    let saved = null;
    if (!fromRecipe) {
      try { saved = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (_) {}
    }
    sel = {};
    for (const part of AVATAR_BUILDER.parts) {
      const n = fromRecipe ? fromRecipe.parts[part.key] : saved?.sel?.[part.key];
      sel[part.key] = (Number.isInteger(n) && n >= 1 && n <= part.count) ? n : 1;
    }
    if (fromRecipe)                                                             bg = fromRecipe.bg;
    else if (typeof saved?.bg === 'string' && /^#[0-9a-f]{6}$/i.test(saved.bg)) bg = saved.bg;
    else                                                                        bg = AVATAR_BUILDER.defaultBg;
  }

  function saveState() {
    try { localStorage.setItem(LS, JSON.stringify({ sel, bg })); } catch (_) {}
  }

  function recipe() {
    return serializeAvatarRecipe(sel, bg);
  }

  // Render the builder controls into the given pane, seeding from saved state.
  function build(paneId) {
    const pane = document.getElementById(paneId);
    if (!pane) return;
    loadState();

    const rows = AVATAR_BUILDER.parts.map(part => `
      <div class="builder-row" data-key="${part.key}">
        <span class="builder-row-label">${t(part.label)}</span>
        <div class="builder-stepper">
          <button class="cs-month-nav" type="button" onclick="avatarBuilder.cyclePart('${part.key}', -1)" ${part.count < 2 ? 'disabled' : ''} aria-label="${t('Previous')}: ${t(part.label)}">‹</button>
          <span class="builder-count"><span class="builder-num">${sel[part.key]}</span> / ${part.count}</span>
          <button class="cs-month-nav" type="button" onclick="avatarBuilder.cyclePart('${part.key}', 1)" ${part.count < 2 ? 'disabled' : ''} aria-label="${t('Next')}: ${t(part.label)}">›</button>
        </div>
      </div>`).join('');

    const swatches = BG_SWATCHES.map(c =>
      `<button class="builder-swatch${c === bg ? ' selected' : ''}" type="button" data-color="${c}" style="background:${c}" onclick="avatarBuilder.setBg('${c}')" aria-label="${t('Background')} ${c}"></button>`
    ).join('');

    pane.innerHTML = `
      <div class="builder-wrap">
        <div class="builder-controls">
          ${rows}
          <div class="builder-row builder-row-bg">
            <span class="builder-row-label">${t('Background')}</span>
            <div class="builder-swatches">
              ${swatches}
              <label class="builder-swatch builder-swatch-custom" title="${t('Custom color')}">
                <input type="color" id="builderBgInput" value="${bg}" oninput="avatarBuilder.setBg(this.value)">
              </label>
            </div>
          </div>
        </div>
      </div>`;
    // The Randomize / "Use this icon" actions live in the toolbar above (shared
    // with Presets); the build is previewed when its tab opens.
  }

  function cyclePart(key, dir) {
    const part = AVATAR_BUILDER.parts.find(p => p.key === key);
    if (!part || part.count < 2) return;
    sel[key] = ((sel[key] - 1 + dir + part.count) % part.count) + 1;
    const row = document.querySelector(`.builder-row[data-key="${key}"] .builder-num`);
    if (row) row.textContent = sel[key];
    saveState();
    _onPreview();
  }

  // Roll a random part for every slot and a random villain background, then sync
  // the steppers, swatches and preview (without persisting a new avatar, the
  // user still confirms with "Use this icon").
  function randomize() {
    for (const part of AVATAR_BUILDER.parts) {
      sel[part.key] = 1 + Math.floor(Math.random() * part.count);
      const num = document.querySelector(`.builder-row[data-key="${part.key}"] .builder-num`);
      if (num) num.textContent = sel[part.key];
    }
    bg = BG_SWATCHES[Math.floor(Math.random() * BG_SWATCHES.length)];
    document.querySelectorAll('.builder-swatch[data-color]').forEach(el => {
      el.classList.toggle('selected', el.dataset.color === bg);
    });
    const inp = document.getElementById('builderBgInput');
    if (inp) inp.value = bg;
    saveState();
    _onPreview();
  }

  function setBg(color) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    bg = color.toLowerCase();
    document.querySelectorAll('.builder-swatch[data-color]').forEach(el => {
      el.classList.toggle('selected', el.dataset.color === bg);
    });
    saveState();
    _onPreview();
  }

  return { configure, build, recipe, cyclePart, randomize, setBg };
})();
