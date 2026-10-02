// Tutorial page: static content, so the script only wires up the shared nav
// (live-game badge, signed-in avatar).

async function init() {
  setActiveNav('tutorial.html');
  await initAuth();
}

init();
