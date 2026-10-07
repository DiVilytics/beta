// What's new: the release notes (asset/data/changelog.json, via loadChangelog),
// newest first, each entry a date, a title and up to three groups: New,
// Improved, Fixed. Opening the page marks the newest entry as seen, which
// clears the dot on the home page's card (index.js).

const CL_GROUPS = [['new', 'New'], ['improved', 'Improved'], ['fixed', 'Fixed']];

function _entryHTML(day, entry) {
  const groups = CL_GROUPS.filter(([key]) => entry[key]?.length).map(([key, label]) => `
    <div class="cl-group">
      <div class="cl-group-lbl">${t(label)}</div>
      <ul class="cl-list">${entry[key].map(item => `<li>${_esc(item)}</li>`).join('')}</ul>
    </div>`).join('');
  return `
    <article class="cl-entry">
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
  try { localStorage.setItem(CHANGELOG_SEEN_KEY, days[0]); } catch (_) {}
  root.innerHTML = days.map(d => _entryHTML(d, log[d])).join('');
}

init();
