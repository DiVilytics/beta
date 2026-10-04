// ── AVATAR ─────────────────────────────────────────────────────────────────────
// Everything to do with player avatars: resolving the stored value, the builder
// "recipe" model, rendering to markup, and the click-to-zoom lightbox. Depends
// on `_esc` (db.js). Loaded before shared.js, which renders the nav avatar.

function resolveAvatar(profile) {
  return profile?.avatar_url || profile?.default_avatar || 'asset/players/default.svg';
}

// The bundled preset avatars live at asset/players/1.jpeg … N.jpeg.
const AVATAR_PRESET_COUNT = 19;
function presetAvatarSrc(i) { return `asset/players/${i}.jpeg`; }

// ── AVATAR MODEL ──────────────────────────────────────────────────────────────
// An avatar value (the `avatar_url` column) is either a plain image path/URL
// (preset photos, the default svg) OR a compact "recipe" describing a player-
// built icon: a background color plus one transparent PNG part per body slot,
// stacked back-to-front. Recipes are rendered on the fly everywhere via
// avatarHTML(), nothing rasterized is ever stored. Single source of truth for
// the parts, their order (= draw order), and per-part option counts:
const AVATAR_BUILDER = {
  parts: [
    { key: 'corpo',        label: 'Body',     count: 1 },
    { key: 'orecchie',     label: 'Ears',     count: 2 },
    { key: 'faccia',       label: 'Face',     count: 3 },
    { key: 'naso',         label: 'Nose',     count: 3 },
    { key: 'bocca',        label: 'Mouth',    count: 2 },
    { key: 'occhi',        label: 'Eyes',     count: 3 },
    { key: 'sopracciglia', label: 'Eyebrows', count: 2 },
    { key: 'capelli',      label: 'Hair',     count: 3 },
  ],
  dir: 'asset/players/parts',
  defaultBg: '#4a1d6e',
  prefix: 'builder:',
};

function isAvatarRecipe(v) {
  return typeof v === 'string' && v.startsWith(AVATAR_BUILDER.prefix);
}

// Serialize selections + bg into a stored value, e.g.
//   builder:bg=a7d8f0;corpo-1,orecchie-2,faccia-3,...
function serializeAvatarRecipe(sel, bg) {
  const body = AVATAR_BUILDER.parts.map(p => `${p.key}-${sel?.[p.key] || 1}`).join(',');
  const hex  = String(bg || AVATAR_BUILDER.defaultBg).replace('#', '').toLowerCase();
  return `${AVATAR_BUILDER.prefix}bg=${hex};${body}`;
}

// Parse a recipe string into { parts: {key:n}, bg: '#rrggbb' }, clamping every
// slot to a valid option and filling any missing slot with 1. Returns null for
// non-recipe values.
function parseAvatarRecipe(v) {
  if (!isAvatarRecipe(v)) return null;
  const [meta, body = ''] = v.slice(AVATAR_BUILDER.prefix.length).split(';');
  const bgMatch = /bg=([0-9a-fA-F]{6})/.exec(meta || '');
  const bg = bgMatch ? '#' + bgMatch[1].toLowerCase() : AVATAR_BUILDER.defaultBg;
  const raw = {};
  for (const tok of body.split(',')) {
    const m = /^([a-z]+)-(\d+)$/.exec(tok.trim());
    if (m) raw[m[1]] = parseInt(m[2], 10);
  }
  const parts = {};
  for (const p of AVATAR_BUILDER.parts) {
    const n = raw[p.key];
    parts[p.key] = (Number.isInteger(n) && n >= 1 && n <= p.count) ? n : 1;
  }
  return { parts, bg };
}

// Ordered list of layer image srcs (back-to-front) for a parsed recipe.
function avatarLayerSrcs(recipe) {
  return AVATAR_BUILDER.parts.map(p => `${AVATAR_BUILDER.dir}/${p.key}-${recipe.parts[p.key]}.png`);
}

// ── AVATAR RENDERING ──────────────────────────────────────────────────────────
// THE single place avatars become markup. `value` is a raw avatar_url (plain
// path or recipe). Use this everywhere an avatar is shown.
//   cls        – base size class ('player-avatar', 'player-avatar-lg', 'nav-avatar', …)
//   extraClass – extra classes (e.g. 'zoomable')
//   id         – element id
//   lightbox   – wire up click-to-zoom
//   fallback   – src used when value is empty / fails to load
function avatarHTML(value, { cls = 'player-avatar', extraClass = '', id = '', lightbox = false, fallback = 'asset/players/default.svg' } = {}) {
  const idAttr  = id ? ` id="${_esc(id)}"` : '';
  const classes = `${cls}${extraClass ? ' ' + extraClass : ''}`;

  if (isAvatarRecipe(value)) {
    const recipe = parseAvatarRecipe(value);
    const layers = avatarLayerSrcs(recipe)
      .map(s => `<img src="${_esc(s)}" alt="" draggable="false">`).join('');
    const lb = lightbox ? ` data-avatar="${_esc(value)}" onclick="showAvatarFromEl(this)"` : '';
    return `<span${idAttr} class="${classes} avatar-stack" style="background:${_esc(recipe.bg)}"${lb}>${layers}</span>`;
  }

  const src = (value || '').trim() || fallback;
  const lb  = lightbox ? ` onclick="showAvatarLightbox(this.src, '${_esc(fallback)}')"` : '';
  return `<img${idAttr} class="${classes}" src="${_esc(src)}" alt="" onerror="this.src='${_esc(fallback)}'"${lb}>`;
}

function playerAvatarHTML(url, large, fallback = 'asset/players/default.svg') {
  return avatarHTML(url, { cls: large ? 'player-avatar-lg' : 'player-avatar', fallback });
}

// ── AVATAR LIGHTBOX ───────────────────────────────────────────────────────────
// Avatar zoom: full-screen circular preview of an image. Click anywhere
// outside the image (or on the close button) to dismiss. The overlay is
// injected once per page on first use.
// Zoom a composite avatar from its rendered element (reads the recipe stored on
// the element, so click-to-zoom works without rasterizing).
function showAvatarFromEl(el) {
  if (el) showAvatarLightbox(el.dataset.avatar, 'asset/players/default.svg');
}

function showAvatarLightbox(value, fallback) {
  let overlay = document.getElementById('avatarLightbox');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'avatarLightbox';
    overlay.className = 'avatar-lightbox';
    // Any click anywhere on the overlay (image, backdrop, close button) dismisses.
    overlay.onclick = () => closeAvatarLightbox();
    overlay.innerHTML = `
      <button class="avatar-lightbox-close" type="button" aria-label="${t('Close')}">×</button>
      <div id="avatarLightboxContent"></div>
    `;
    document.body.appendChild(overlay);
  }
  const host = document.getElementById('avatarLightboxContent');
  if (isAvatarRecipe(value)) {
    const recipe = parseAvatarRecipe(value);
    const layers = avatarLayerSrcs(recipe)
      .map(s => `<img src="${_esc(s)}" alt="" draggable="false">`).join('');
    host.innerHTML = `<span class="avatar-lightbox-img avatar-stack" style="background:${_esc(recipe.bg)}">${layers}</span>`;
  } else {
    const src = (value || '').trim() || fallback || '';
    host.innerHTML = `<img class="avatar-lightbox-img" src="${_esc(src)}" alt=""${fallback ? ` onerror="this.src='${_esc(fallback)}'"` : ''}>`;
  }
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeAvatarLightbox() {
  const overlay = document.getElementById('avatarLightbox');
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.style.overflow = '';
}
