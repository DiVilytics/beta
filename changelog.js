// What's new: the release notes (asset/data/changelog.json, via loadChangelog),
// newest first, each entry a date, a title and up to three groups: New,
// Improved, Fixed. Entries added (or extended) since the last visit are tinted
// purple; opening the page then marks everything as seen, which also clears the
// dot on the home page's card (index.js).

const CL_GROUPS = [['new', 'New'], ['improved', 'Improved'], ['fixed', 'Fixed']];

function _entryHTML(day, entry, unseen) {
  const groups = CL_GROUPS.filter(([key]) => entry[key]?.length).map(([key, label]) => `
    <div class="cl-group">
      <div class="cl-group-lbl">${t(label)}</div>
      <ul class="cl-list">${entry[key].map(item => `<li>${_esc(item)}</li>`).join('')}</ul>
    </div>`).join('');
  return `
    <article class="cl-entry${unseen ? ' cl-unseen' : ''}">
      <div class="cl-date">${_esc(fmtDayLong(day))}</div>
      <h3 class="cl-title">${_esc(entry.title || '')}</h3>
      ${groups}
    </article>`;
}

async function init() {
  setActiveNav('changelog.html');
  const [log] = await Promise.all([loadChangelog(), initAuth()]);
  const days = Object.keys(log).sort().reverse();
  const root = document.getElementById('clRoot');
  root.className = '';
  if (!days.length) {
    root.innerHTML = `<div class="empty-state">${t("Couldn't load the release notes.")}</div>`;
    return;
  }
  const seen = changelogSeen();
  root.innerHTML = days.map(d => _entryHTML(d, log[d], changelogUnseen(d, log[d], seen))).join('');
  try { localStorage.setItem(CHANGELOG_SEEN_KEY, changelogStamp(log)); } catch (_) {}
}

init();
