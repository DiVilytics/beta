// What's new: the release notes (asset/data/changelog.json, via loadChangelog),
// newest first, one entry a week (keyed by its Monday), a title and up to three
// short points (`items`): what changed that week, in a few words. Entries
// added (or extended) since the last visit are tinted purple; opening the page
// then marks everything as seen, which also clears the dot on the home page's
// card (index.js).

function _entryHTML(day, entry, unseen) {
  return `
    <article class="cl-entry${unseen ? ' cl-unseen' : ''}">
      <div class="cl-date">${_esc(t('Week of {date}', { date: fmtDayLong(day) }))}</div>
      <h3 class="cl-title">${_esc(entry.title || '')}</h3>
      <ul class="cl-list">${(entry.items || []).map(item => `<li>${_esc(item)}</li>`).join('')}</ul>
    </article>`;
}

async function init() {
  setActiveNav('changelog.html');
  const [log] = await Promise.all([loadChangelog(), initAuth()]);
  const days = Object.keys(log).sort().reverse();
  const root = document.getElementById('clRoot');
  root.className = '';
  if (!days.length) {
    root.innerHTML = loadErrorHTML(t("Couldn't load the release notes"));
    return;
  }
  const seen = changelogSeen();
  root.innerHTML = days.map(d => _entryHTML(d, log[d], changelogUnseen(d, log[d], seen))).join('');
  try { localStorage.setItem(CHANGELOG_SEEN_KEY, changelogStamp(log)); } catch (_) {}
}

init();
