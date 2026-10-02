// Show a QR (and copyable link) pointing at the app's home page, so someone at
// the table can scan to open DiVilytics, or you can copy the link to share remotely.
function shareApp() {
  showQRModal(location.origin + '/', 'shareAppQrCode', 'shareAppOverlay');
}

initAuth();
