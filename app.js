/**
 * Hitster × Apple Music
 * ─────────────────────
 * Scans Hitster card QR codes → looks up Spotify ID in local cards-il.json
 * → fetches Spotify oEmbed (CORS-friendly, no auth) for title + artwork
 * → searches iTunes for 30s preview + Apple Music link + year.
 * Zero backend. Zero API keys. Zero proxies.
 */

// ── Card database ────────────────────────────────────────────────────────────
let _cardDb = null;
async function getCardDb() {
  if (!_cardDb) {
    const res = await fetch('cards-il.json');
    if (!res.ok) throw new Error('Could not load card database');
    _cardDb = await res.json();
  }
  return _cardDb;
}

// ── DOM refs ────────────────────────────────────────────────────────────────
const cam          = document.getElementById('cam');
const qrCanvas     = document.getElementById('qr-canvas');
const audio        = document.getElementById('audio');
const progressFill = document.getElementById('progress-fill');
const timeLabel    = document.getElementById('time-label');
const playPauseBtn = document.getElementById('play-pause');
const toast        = document.getElementById('toast');

// ── State ───────────────────────────────────────────────────────────────────
let stream        = null;
let scanLoop      = null;
let scanActive    = false;
let lastScan      = 0;
let currentTrack  = null;

// ── Helpers ─────────────────────────────────────────────────────────────────
function setState(name) {
  document.body.dataset.state = name;
}

function showToast(msg, duration = 3000) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), duration);
}

function fmt(secs) {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccard(a, b) {
  const setA = new Set(normalize(a).split(' ').filter(Boolean));
  const setB = new Set(normalize(b).split(' ').filter(Boolean));
  if (!setA.size && !setB.size) return 1;
  if (!setA.size || !setB.size) return 0;
  const inter = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return inter / union;
}

function bestMatch(results, title) {
  if (!results?.length) return null;
  const scored = results.map(r => ({
    r,
    s: jaccard(r.trackName, title),
  }));
  scored.sort((a, b) =>
    b.s - a.s ||
    new Date(a.r.releaseDate) - new Date(b.r.releaseDate)
  );
  return scored[0].s >= 0.2 ? scored[0].r : null;
}

// ── URL parsing ──────────────────────────────────────────────────────────────
/**
 * Parse a Hitster QR URL into {sku, cardNum}.
 * Handles bare domain and https:// forms, e.g.:
 *   www.hitstergame.com/il/aaaj0001/00039
 *   https://www.hitstergame.com/il/aaaj0001/00039
 */
function parseHitsterUrl(raw) {
  const url = raw.trim().replace(/^https?:\/\//i, '');
  // www.hitstergame.com/{lang}/{sku}/{card}
  const m = url.match(/hitstergame\.com\/[^/]+\/([^/]+)\/([^/?#]+)/i);
  if (m) return { sku: m[1].toLowerCase(), cardNum: m[2].padStart(5, '0') };
  return null;
}

function extractSpotifyId(text) {
  const m =
    text.match(/open\.spotify\.com\/(?:embed\/)?track\/([\w]+)/) ||
    text.match(/spotify:track:([\w]+)/);
  return m?.[1] ?? null;
}

// ── Camera / QR scanning ────────────────────────────────────────────────────
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (e) {
    if (e.name === 'OverconstrainedError' || e.name === 'ConstraintNotSatisfiedError') {
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
    } else {
      throw e;
    }
  }
  cam.srcObject = stream;
  await cam.play().catch(() => {});
}

function stopCamera() {
  scanActive = false;
  cancelAnimationFrame(scanLoop);
  clearInterval(scanLoop);
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  cam.srcObject = null;
}

async function startScanning() {
  await startCamera();
  scanActive = true;

  if ('BarcodeDetector' in window) {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const loop = async () => {
      if (!scanActive) return;
      const now = Date.now();
      if (now - lastScan >= 200) {
        lastScan = now;
        try {
          const barcodes = await detector.detect(cam);
          if (barcodes.length) { onQRDetected(barcodes[0].rawValue); return; }
        } catch (_) {}
      }
      scanLoop = requestAnimationFrame(loop);
    };
    scanLoop = requestAnimationFrame(loop);

  } else {
    const ctx = qrCanvas.getContext('2d', { willReadFrequently: true });
    const loop = () => {
      if (!scanActive) return;
      const now = Date.now();
      if (now - lastScan >= 200 && cam.readyState === cam.HAVE_ENOUGH_DATA) {
        lastScan = now;
        qrCanvas.width  = cam.videoWidth  || 640;
        qrCanvas.height = cam.videoHeight || 480;
        ctx.drawImage(cam, 0, 0, qrCanvas.width, qrCanvas.height);
        const imageData = ctx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });
        if (code?.data) { onQRDetected(code.data); return; }
      }
      scanLoop = requestAnimationFrame(loop);
    };
    scanLoop = requestAnimationFrame(loop);
  }
}

function onQRDetected(raw) {
  stopCamera();
  console.log('[QR detected]', raw);
  document.getElementById('loading-url').textContent = raw.trim();
  setState('loading');
  lookupTrack(raw).catch(err => {
    console.error('[lookupTrack error]', err);
    showError(err.message || 'Could not load track. Please try again.');
  });
}

// ── Track lookup ────────────────────────────────────────────────────────────
async function lookupTrack(rawUrl) {
  const url = rawUrl.trim();

  // ① Check if it's a direct Spotify link (manual paste flow)
  const directSpotifyId = extractSpotifyId(url) ||
    (url.match(/^[\w]{22}$/) ? url : null);
  if (directSpotifyId) {
    return lookupBySpotifyId(directSpotifyId);
  }

  // ② Parse Hitster QR URL
  const parsed = parseHitsterUrl(url);
  if (!parsed) {
    throw new Error(`Not a Hitster card QR code:\n"${url.slice(0, 80)}"`);
  }

  const { sku, cardNum } = parsed;
  document.getElementById('loading-url').textContent = `${sku} / card ${cardNum}`;

  // ③ Look up in local card database
  const db = await getCardDb();
  const spotifyId = db[sku]?.[cardNum];

  if (!spotifyId) {
    const knownSkus = Object.keys(db).join(', ');
    throw new Error(
      `Card ${cardNum} not found in edition "${sku}".\n` +
      `Supported editions: ${knownSkus}`
    );
  }

  return lookupBySpotifyId(spotifyId);
}

/**
 * Given a Spotify track ID, resolve full track info:
 * oEmbed → title + artwork, then iTunes → year + preview + Apple Music URL.
 */
async function lookupBySpotifyId(spotifyId) {
  // ① Spotify oEmbed (CORS-friendly, no auth required)
  const spotifyTrackUrl = `https://open.spotify.com/track/${spotifyId}`;
  let oembedTitle = null;
  let oembedArt   = null;

  try {
    const oembed = await fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyTrackUrl)}`
    ).then(r => {
      if (!r.ok) throw new Error(`oEmbed HTTP ${r.status}`);
      return r.json();
    });
    oembedTitle = oembed.title  || null;
    oembedArt   = oembed.thumbnail_url || null;
  } catch (e) {
    console.warn('[oEmbed failed]', e.message);
    // Non-fatal — fall through; iTunes might still find the track
  }

  if (!oembedTitle) {
    throw new Error('Could not retrieve song info from Spotify. Try again.');
  }

  // ② iTunes search by title
  const q = encodeURIComponent(oembedTitle);
  let itunesData = { results: [] };
  try {
    itunesData = await fetch(
      `https://itunes.apple.com/search?term=${q}&entity=song&limit=10&media=music`
    ).then(r => r.json());
  } catch (e) {
    console.warn('[iTunes search failed]', e.message);
  }

  const best = bestMatch(itunesData.results, oembedTitle);

  // High-res artwork
  const artwork = best?.artworkUrl100
    ? best.artworkUrl100.replace('100x100bb', '600x600bb')
    : oembedArt;

  const year = best?.releaseDate ? best.releaseDate.slice(0, 4) : '';

  const track = {
    title:         oembedTitle,
    artist:        best?.artistName ?? '',
    year,
    artwork,
    previewUrl:    best?.previewUrl ?? null,
    appleMusicUrl: best?.trackViewUrl ?? buildAmSearchUrl(oembedTitle),
    spotifyId,
  };

  renderTrack(track);
  return track;
}

function buildAmSearchUrl(title) {
  return `https://music.apple.com/search?term=${encodeURIComponent(title)}`;
}



// ── Audio player ─────────────────────────────────────────────────────────────
function setupAudio(previewUrl) {
  audio.pause();
  audio.src = '';
  const noPreview = document.getElementById('no-preview');

  if (!previewUrl) {
    noPreview.style.display = 'block';
    progressFill.style.width = '0%';
    timeLabel.textContent = '--';
    return;
  }

  noPreview.style.display = 'none';
  audio.src = previewUrl;
  audio.currentTime = 0;
  audio.play().then(() => {
    document.body.classList.add('playing');
  }).catch(() => {});

  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('error', onAudioError);
}

function onTimeUpdate() {
  const dur = audio.duration || 30;
  const pct = (audio.currentTime / dur) * 100;
  progressFill.style.width = `${pct}%`;
  timeLabel.textContent = fmt(dur - audio.currentTime);
}

function onEnded() {
  document.body.classList.remove('playing');
  progressFill.style.width = '100%';
  timeLabel.textContent = '0:00';

  if (currentTrack) loadEmbed(currentTrack);
}

function loadEmbed(track) {
  const url = toEmbedUrl(track.appleMusicUrl);
  if (!url) return;
  document.getElementById('am-embed').src = url;
  document.getElementById('am-embed-wrap').classList.add('visible');
  document.getElementById('preview-controls').style.display = 'none';
}

function resetEmbed() {
  document.getElementById('am-embed').src = '';
  document.getElementById('am-embed-wrap').classList.remove('visible');
  document.getElementById('preview-controls').style.display = 'block';
}

/**
 * music.apple.com  →  embed.music.apple.com  (+ autoplay attempt)
 */
function toEmbedUrl(url) {
  if (!url || url.includes('/search')) return null;
  const embed = url.replace('https://music.apple.com/', 'https://embed.music.apple.com/');
  return embed + (embed.includes('?') ? '&' : '?') + 'autoplay=1';
}


function onAudioError() {
  const np = document.getElementById('no-preview');
  np.style.display = 'block';
  np.textContent = 'Preview unavailable';
  document.body.classList.remove('playing');
}

function teardownAudio() {
  audio.pause();
  audio.removeEventListener('timeupdate', onTimeUpdate);
  audio.removeEventListener('ended', onEnded);
  audio.removeEventListener('error', onAudioError);
  audio.src = '';
  document.body.classList.remove('playing');
  progressFill.style.width = '0%';
  timeLabel.textContent = '0:30';
  resetEmbed();
}

// ── Render song card ─────────────────────────────────────────────────────────
function renderTrack(track) {
  currentTrack = track;

  document.getElementById('track-title').textContent  = track.title  || 'Unknown title';
  document.getElementById('track-artist').textContent = track.artist || '';

  const img = document.getElementById('album-art');
  if (track.artwork) {
    img.src = track.artwork;
    img.onerror = () => { img.src = ''; };
  } else {
    img.src = '';
  }

  document.getElementById('year-number').textContent = track.year || '?';
  document.getElementById('year-display').classList.remove('animate');


  setState('playing');
  setupAudio(track.previewUrl);
}

// ── Error screen ─────────────────────────────────────────────────────────────
function showError(msg) {
  document.getElementById('error-msg').textContent = msg;
  teardownAudio();
  setState('error');
}

// ── Manual Spotify paste (fallback for unknown editions) ─────────────────────
window.submitManualSpotify = function submitManualSpotify() {
  const input = document.getElementById('spotify-paste').value.trim();
  if (!input) return;
  const trackId = extractSpotifyId(input) ||
    (input.match(/^[\w]{22}$/) ? input : null);
  if (!trackId) {
    showToast('Paste a Spotify track link, e.g. open.spotify.com/track/...');
    return;
  }
  document.getElementById('loading-url').textContent = `spotify:track:${trackId}`;
  setState('loading');
  lookupBySpotifyId(trackId).catch(err => {
    showError(err.message || 'Could not load track.');
  });
};

// ── Event listeners ──────────────────────────────────────────────────────────
document.getElementById('btn-reveal').addEventListener('click', () => {
  setState('revealed');
  const yd = document.getElementById('year-display');
  yd.classList.remove('animate');
  void yd.offsetWidth;
  yd.classList.add('animate');
});

document.getElementById('btn-next').addEventListener('click', () => {
  teardownAudio();
  currentTrack = null;
  setState('scanning');
  startScanning().catch(onCameraError);
});

document.getElementById('btn-retry').addEventListener('click', () => {
  setState('scanning');
  startScanning().catch(onCameraError);
});

document.getElementById('btn-pf-retry').addEventListener('click', () => {
  setState('scanning');
  startScanning().catch(onCameraError);
});

playPauseBtn.addEventListener('click', () => {
  if (!audio.src) return;
  if (audio.paused) {
    audio.play();
    document.body.classList.add('playing');
  } else {
    audio.pause();
    document.body.classList.remove('playing');
  }
});

function onCameraError(e) {
  console.error('Camera error:', e);
  let msg = 'Could not access camera.';
  if (e.name === 'NotAllowedError') {
    msg = 'Camera permission denied. Please allow camera access and reload.';
  } else if (e.name === 'NotFoundError') {
    msg = 'No camera found on this device.';
  }
  showError(msg);
}

// ── Setup / first-launch ─────────────────────────────────────────────────────
const AM_SETUP_KEY = 'hs4am_am_setup_done';

function finishSetup() {
  localStorage.setItem(AM_SETUP_KEY, '1');
  setState('scanning');
  startScanning().catch(onCameraError);
}

document.getElementById('btn-setup-done').addEventListener('click', finishSetup);
document.getElementById('btn-setup-skip').addEventListener('click', finishSetup);

// ── Boot ─────────────────────────────────────────────────────────────────────
// Pre-fetch card DB in background so the first scan is instant
getCardDb().catch(() => {});

if (localStorage.getItem(AM_SETUP_KEY)) {
  // Returning user — go straight to scanner
  setState('scanning');
  startScanning().catch(onCameraError);
} else {
  // First launch — show Apple Music sign-in screen
  setState('setup');
}
