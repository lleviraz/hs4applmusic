/**
 * Hitster × Apple Music
 * ─────────────────────
 * Scans Hitster card QR codes → resolves the Spotify track via allorigins.win
 * CORS proxy → parses Open Graph meta tags → searches iTunes → plays the 30s
 * preview and links to Apple Music. Zero backend, zero API keys.
 */

// ── CORS proxy ─────────────────────────────────────────────────────────────
const PROXY = 'https://api.allorigins.win/get?url=';

// ── DOM refs ────────────────────────────────────────────────────────────────
const cam          = document.getElementById('cam');
const qrCanvas     = document.getElementById('qr-canvas');
const audio        = document.getElementById('audio');
const progressFill = document.getElementById('progress-fill');
const timeLabel    = document.getElementById('time-label');
const playPauseBtn = document.getElementById('play-pause');
const toast        = document.getElementById('toast');

// ── State ───────────────────────────────────────────────────────────────────
let stream         = null;     // MediaStream from camera
let scanLoop       = null;     // rAF id or interval id
let scanActive     = false;
let lastScan       = 0;        // throttle timestamp
let currentTrack   = null;     // resolved track data

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
  const inter = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return inter / union;
}

function bestMatch(results, artist, title) {
  if (!results?.length) return null;
  const scored = results.map(r => ({
    r,
    s: 0.5 * jaccard(r.artistName, artist) + 0.5 * jaccard(r.trackName, title),
  }));
  scored.sort((a, b) =>
    b.s - a.s ||
    new Date(a.r.releaseDate) - new Date(b.r.releaseDate) // prefer earliest on tie
  );
  return scored[0].s >= 0.25 ? scored[0].r : null;
}

function parseMeta(html, property) {
  // handles both property="…" and property='…' and content before or after property
  const re1 = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i');
  return (html.match(re1) || html.match(re2))?.[1] ?? null;
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
  await cam.play().catch(() => {}); // Safari sometimes needs explicit play()
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
    // ── Native BarcodeDetector (Android Chrome, recent Safari) ──────────────
    const detector = new BarcodeDetector({ formats: ['qr_code'] });

    const loop = async () => {
      if (!scanActive) return;
      const now = Date.now();
      if (now - lastScan >= 200) {
        lastScan = now;
        try {
          const barcodes = await detector.detect(cam);
          if (barcodes.length) {
            onQRDetected(barcodes[0].rawValue);
            return;
          }
        } catch (_) { /* camera not ready yet */ }
      }
      scanLoop = requestAnimationFrame(loop);
    };
    scanLoop = requestAnimationFrame(loop);

  } else {
    // ── jsQR fallback ────────────────────────────────────────────────────────
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
        if (code?.data) {
          onQRDetected(code.data);
          return;
        }
      }
      scanLoop = requestAnimationFrame(loop);
    };
    scanLoop = requestAnimationFrame(loop);
  }
}

function onQRDetected(raw) {
  stopCamera();
  const url = raw.trim();
  console.log('[QR detected]', url);
  document.getElementById('loading-url').textContent = url;
  setState('loading');
  lookupTrack(url).catch(err => {
    console.error('[lookupTrack error]', err, '| raw QR:', url);
    showError(err.message || 'Could not load track. Please try again.');
  });
}

// ── Track lookup ────────────────────────────────────────────────────────────
async function lookupTrack(rawUrl) {
  let url = rawUrl.trim();

  // ① Normalise the many URL/URI formats a Hitster QR might contain

  // spotify:track:XXXX  →  convert to https URL
  const spotifyUri = url.match(/^spotify:track:([\w]+)$/i);
  if (spotifyUri) {
    url = `https://open.spotify.com/track/${spotifyUri[1]}`;
  }

  // bare domain (no scheme) — e.g. "www.hitstergame.com/..."
  if (!/^https?:\/\//i.test(url)) {
    if (/^(www\.|hitstergame|open\.spotify)/i.test(url)) {
      url = 'https://' + url;
    } else {
      // Unknown format — show it so the user can report it
      throw new Error(`Unrecognised QR content:\n"${rawUrl.slice(0, 80)}"\nThis doesn't look like a Hitster card.`);
    }
  }

  // ② Resolve Hitster / Spotify redirect via CORS proxy
  const proxyUrl = PROXY + encodeURIComponent(url);
  let res1;
  try {
    res1 = await fetch(proxyUrl).then(r => r.json());
  } catch (e) {
    throw new Error('Network error — check your connection and try again.');
  }

  const finalUrl = res1?.status?.url ?? '';
  const body1    = res1?.contents ?? '';

  // ③ Extract Spotify track ID from final URL or page HTML
  let trackId = extractSpotifyId(finalUrl) || extractSpotifyId(body1);
  if (!trackId) {
    console.warn('[no track id] finalUrl:', finalUrl, '| body preview:', body1.slice(0, 300));
    throw new Error(`Could not find Spotify track.\nResolved to: ${finalUrl.slice(0, 80)}`);
  }

  // ④ Fetch Spotify track page for OG metadata
  const spotifyUrl = `https://open.spotify.com/track/${trackId}`;
  let res2;
  try {
    res2 = await fetch(PROXY + encodeURIComponent(spotifyUrl)).then(r => r.json());
  } catch (e) {
    throw new Error('Could not reach Spotify metadata. Try again.');
  }
  const html = res2?.contents ?? '';

  const title  = parseMeta(html, 'og:title')       || '';
  const desc   = parseMeta(html, 'og:description') || '';
  // Spotify's og:description format: "Song Name, a song by Artist Name on Spotify"
  const artistMatch = desc.match(/,?\s*a song by ([^"]+?) on Spotify/i);
  const artist = (artistMatch?.[1] ?? '').trim();
  // music:release_date or og:music:release_date
  const releaseRaw = parseMeta(html, 'music:release_date') || parseMeta(html, 'og:music:release_date') || '';
  const year   = releaseRaw.slice(0, 4) || '';
  const artRaw = parseMeta(html, 'og:image') || '';

  if (!title) throw new Error('Could not read song info from Spotify. Try again.');

  // ⑤ Search iTunes
  const q = encodeURIComponent(`${artist} ${title}`);
  let itunesData;
  try {
    // Try direct first (usually works; iTunes does send CORS headers)
    itunesData = await fetch(
      `https://itunes.apple.com/search?term=${q}&entity=song&limit=10&media=music&explicit=No`
    ).then(r => r.json());
  } catch (_) {
    // Fall back through proxy
    try {
      const r = await fetch(
        PROXY + encodeURIComponent(`https://itunes.apple.com/search?term=${q}&entity=song&limit=10&media=music`)
      ).then(r => r.json());
      itunesData = JSON.parse(r.contents);
    } catch (e) {
      // Non-fatal: show info without preview
      itunesData = { results: [] };
    }
  }

  const best = bestMatch(itunesData.results, artist, title);

  // High-res artwork: swap 100x100bb → 600x600bb in iTunes URL
  const artwork = best?.artworkUrl100
    ? best.artworkUrl100.replace('100x100bb', '600x600bb')
    : artRaw;

  return {
    title,
    artist,
    year,
    artwork,
    previewUrl:    best?.previewUrl    ?? null,
    appleMusicUrl: best?.trackViewUrl  ?? buildAmSearchUrl(artist, title),
    spotifyId:     trackId,
  };
}

function extractSpotifyId(text) {
  // Match all Spotify track reference formats found in URLs and HTML:
  //   https://open.spotify.com/track/XXXXX
  //   https://open.spotify.com/embed/track/XXXXX   (iframe src in hitstergame.com pages)
  //   spotify:track:XXXXX                          (Spotify URI)
  const m =
    text.match(/open\.spotify\.com\/(?:embed\/)?track\/([\w]+)/) ||
    text.match(/spotify:track:([\w]+)/);
  return m?.[1] ?? null;
}

function buildAmSearchUrl(artist, title) {
  return `https://music.apple.com/search?term=${encodeURIComponent(`${artist} ${title}`)}`;
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
  }).catch(() => {
    // autoplay blocked — user can tap play manually
  });

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
}

function onAudioError() {
  document.getElementById('no-preview').style.display = 'block';
  document.getElementById('no-preview').textContent = 'Preview unavailable';
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
}

// ── Render song card ─────────────────────────────────────────────────────────
function renderTrack(track) {
  currentTrack = track;

  document.getElementById('track-title').textContent  = track.title  || 'Unknown title';
  document.getElementById('track-artist').textContent = track.artist || 'Unknown artist';

  const img = document.getElementById('album-art');
  if (track.artwork) {
    img.src = track.artwork;
    img.onerror = () => { img.src = ''; };
  } else {
    img.src = '';
  }

  document.getElementById('year-number').textContent = track.year || '?';
  document.getElementById('year-display').classList.remove('animate');

  const amBtn = document.getElementById('btn-apple-music');
  amBtn.onclick = () => window.open(track.appleMusicUrl, '_blank');

  setState('playing');
  setupAudio(track.previewUrl);
}

// ── Error screen ─────────────────────────────────────────────────────────────
function showError(msg) {
  document.getElementById('error-msg').textContent = msg;
  teardownAudio();
  setState('error');
}

// ── Event listeners ──────────────────────────────────────────────────────────
document.getElementById('btn-reveal').addEventListener('click', () => {
  setState('revealed');
  const yd = document.getElementById('year-display');
  yd.classList.remove('animate');
  // force reflow so animation replays
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

// ── Handle QR codes that are direct Spotify URLs ─────────────────────────────
// (some editions embed spotify: URIs instead of https:// URLs)
const _origOnQR = onQRDetected;

// ── Boot ─────────────────────────────────────────────────────────────────────
setState('scanning');
startScanning().catch(onCameraError);
