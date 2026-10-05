// ── AUDIO / MEDIA SESSION ──────────────────────────────────────────────────────
// Depends on: shared.js (liveGame), new-game.js (startLive, stopLive, bumpTurn)

const _bgAudio = document.getElementById('bgAudio');
let _audioCtx, _gainNode, _mediaReady = false;

function _initGain() {
  if (_audioCtx) return;
  _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = _audioCtx.createMediaElementSource(_bgAudio);
  _gainNode = _audioCtx.createGain();
  _gainNode.gain.value = 0.001; // near-silent; keeps iOS session alive without audible output
  source.connect(_gainNode);
  _gainNode.connect(_audioCtx.destination);
}

function _audioPlay() {
  _initGain();
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  _bgAudio.play()
    .then(() => {
      if (!_mediaReady) _setupMediaSession();
      navigator.mediaSession && (navigator.mediaSession.playbackState = 'playing');
    })
    .catch(() => {
      // Blocked without a tap (a running game shown on page load): ask for one,
      // full screen, so nobody locks the phone without the controls.
      if (liveGame.isRunning) document.getElementById('tapResume')?.classList.remove('hidden');
    });
}

// The tap the browser needs: hide the prompt and start the lock-screen controls.
function resumeLockScreen() {
  document.getElementById('tapResume')?.classList.add('hidden');
  if (liveGame.isRunning) _audioPlay();
}

function _audioPause() {
  _bgAudio.pause();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
}

function _audioStop() {
  clearInterval(_metaInterval); _metaInterval = null;
  _bgAudio.pause();
  _bgAudio.currentTime = 0;
  _mediaReady = false;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'none';
    navigator.mediaSession.setActionHandler('previoustrack', null);
    navigator.mediaSession.setActionHandler('nexttrack', null);
  }
}

function _updateMediaMetadata() {
  if (!_mediaReady || !('mediaSession' in navigator)) return;
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const icon = dark ? 'asset/logos/logo-b.png' : 'asset/logos/logo-w.png';
  // const icon = new URL(dark ? 'asset/logos/logo-b.png' : 'asset/logos/logo-w.png', location.href).href;  // not working for some reason!
  const location = document.getElementById('fLocation')?.value.trim();
  navigator.mediaSession.metadata = new MediaMetadata({
    title:  t('Round {n}', { n: liveGame.turns }),
    artist: t('Update Timer and Rounds'),
    album:  location ? `DiVilytics | ${t('Playing at {location}', { location })}` : `DiVilytics | ${t('New Game')}`,
    artwork: [
      { src: icon, sizes: '96x96',  type: 'image/png' },
      { src: icon, sizes: '512x512', type: 'image/png' },
    ]
  });
  _updatePositionState();
}

function _updatePositionState() {
  if (!_mediaReady || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!liveGame.isRunning) return;
  const position = liveGame.elapsedMs / 1000;
  navigator.mediaSession.setPositionState({
    duration: position,  // duration = position does not seem to be a problem!
    playbackRate: 1,
    position,
  });
}

function _setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  _mediaReady = true;
  _updateMediaMetadata();
  _registerMediaHandlers();
}

function _registerMediaHandlers() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', () => {
    startLive(); // resumes game timer + plays audio via wrapped startLive
    // safety net: if game is active but audio died (e.g. iOS killed session), restart it
    if (liveGame.isRunning && _bgAudio.paused) _audioPlay();
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    stopLive(); // pauses game timer + pauses audio via wrapped stopLive
  });
  navigator.mediaSession.setActionHandler('previoustrack', () => bumpTurn(-1));
  navigator.mediaSession.setActionHandler('nexttrack',     () => bumpTurn(1));
  navigator.mediaSession.setActionHandler('seekbackward',  () => bumpTurn(-1));
  navigator.mediaSession.setActionHandler('seekforward',   () => bumpTurn(1));
}

// ── GAME EVENT HOOKS ──────────────────────────────────────────────────────────

let _metaInterval = null;

liveGame.on('start', () => {
  if (liveGame.isRunning) {
    _audioPlay();
    if (!_metaInterval) _metaInterval = setInterval(_updatePositionState, 1000);
  }
});

liveGame.on('stop', () => {
  _audioPause();
  clearInterval(_metaInterval); _metaInterval = null;
  _updatePositionState();
});

liveGame.on('turnBump', () => {
  _updateMediaMetadata();
});

liveGame.on('close', () => {
  document.getElementById('tapResume')?.classList.add('hidden');
  _audioStop();
});

window.addEventListener('pagehide', _audioStop);
