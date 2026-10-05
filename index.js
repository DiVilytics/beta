// Show a QR (and copyable link) pointing at the app's home page, so someone at
// the table can scan to open DiVilytics, or you can copy the link to share remotely.
function shareApp() {
  showQRModal(location.origin + '/', 'shareAppQrCode', 'shareAppOverlay');
}

// ── INSTALL ──────────────────────────────────────────────────────────────────
// "📲 Install" next to Share, shown only where it can help:
// • Chrome / Edge / Samsung Internet (Android and desktop): the browser offers
//   installation (beforeinstallprompt), so the button opens its own install prompt.
// • iPhone / iPad (any browser) and Mac Safari: no website can install itself
//   there, so the button opens a sheet with the steps.
// • Already installed (opened from the icon), or Firefox and the like: hidden.
let _installPrompt = null;

const _isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const _isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);   // iPadOS reports a Mac
const _isMacSafari = () => /Macintosh/.test(navigator.userAgent) && /Safari\//.test(navigator.userAgent)
  && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(navigator.userAgent) && navigator.maxTouchPoints <= 1;

function _installMode() {
  if (_isStandalone()) return null;
  if (_installPrompt)  return 'prompt';
  if (_isIOS())        return 'ios';
  if (_isMacSafari())  return 'mac';
  return null;
}

function _updateInstallBtn() {
  document.getElementById('installBtn')?.classList.toggle('hidden', !_installMode());
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();   // our button shows it instead of the browser's own banner
  _installPrompt = e;
  _updateInstallBtn();
});
window.addEventListener('appinstalled', () => { _installPrompt = null; _updateInstallBtn(); });

async function installApp(mode = _installMode()) {
  if (mode === 'prompt' && _installPrompt) {
    _installPrompt.prompt();
    await _installPrompt.userChoice;
    _installPrompt = null;   // a prompt can be shown only once
    _updateInstallBtn();
    return;
  }
  if (mode !== 'ios' && mode !== 'mac') return;
  const steps = mode === 'ios'
    ? [t('Tap the Share button <svg class="install-ico" viewBox="0 0 16 20" width="13" height="16" aria-hidden="true"><path d="M8 1v11M4.5 4.5 8 1l3.5 3.5M5 8H2.5v10.5h11V8H11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg> (in Safari it\'s in the bottom bar; in other browsers, in the address bar or the menu).'),
       t('Scroll down and tap <strong>Add to Home Screen</strong>.'),
       t('Tap <strong>Add</strong>. DiVilytics is now on your home screen.')]
    : [t('In the menu bar, open <strong>File</strong>.'),
       t('Choose <strong>Add to Dock</strong>.'),
       t('Click <strong>Add</strong>. DiVilytics is now in your Dock and Launchpad.')];
  document.getElementById('installTitle').textContent = mode === 'ios' ? t('Add to Home Screen') : t('Add to Dock');
  document.getElementById('installHint').textContent  = mode === 'ios'
    ? t('It opens full screen, like an app, straight from its icon.')
    : t('It opens in its own window, like an app, straight from its icon.');
  document.getElementById('installSteps').innerHTML = steps.map(s => `<li>${s}</li>`).join('');
  openOverlay('installOverlay');
}

_updateInstallBtn();

initAuth();

