const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const rateLimit = require('express-rate-limit');
const https = require('https');

const app = express();
app.set('trust proxy', 1); // Required for Railway
const PORT = process.env.PORT || 3000;

// ─── yt-dlp setup ─────────────────────────────────────────────────────────────
function getYtDlpPath() {
  const candidates = ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', 'yt-dlp'];
  for (const p of candidates) {
    try { execSync(`${p} --version`, { stdio: 'ignore' }); return p; } catch {}
  }
  return 'yt-dlp';
}
const YTDLP = getYtDlpPath();
console.log(`yt-dlp: ${YTDLP}`);

try {
  execSync(`${YTDLP} -U`, { stdio: 'ignore', timeout: 30000 });
  console.log('yt-dlp updated.');
} catch { console.log('yt-dlp update skipped.'); }

// ─── Rate limiting ────────────────────────────────────────────────────────────
const infoLimiter = rateLimit({ windowMs: 60*1000, max: 20, message: { error: 'Too many requests.' } });
const downloadLimiter = rateLimit({ windowMs: 60*1000, max: 5, message: { error: 'Too many downloads. Wait a minute.' } });

app.use(cors());
app.use(express.json());

const publicDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public') : path.join(__dirname, 'Public');
app.use(express.static(publicDir));

app.get('/', (req, res) => {
  const locs = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'Public', 'index.html'),
    path.join(__dirname, 'index.html'),
  ];
  for (const l of locs) { if (fs.existsSync(l)) return res.sendFile(l); }
  res.send('VideoSnap server is running!');
});

app.get('/api/health', (req, res) => {
  try {
    const version = execSync(`${YTDLP} --version`).toString().trim();
    res.json({ status: 'ok', ytdlp: version });
  } catch (e) { res.json({ status: 'error', error: e.message }); }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function validateUrl(url) {
  try {
    const p = new URL(url);
    return ['http:', 'https:'].includes(p.protocol);
  } catch { return false; }
}

function cleanUrl(url) {
  try {
    const p = new URL(url);
    if (/youtube\.com|youtu\.be/i.test(p.hostname)) {
      p.searchParams.delete('list');
      p.searchParams.delete('index');
      p.searchParams.delete('start_radio');
    }
    return p.toString();
  } catch { return url; }
}

function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'facebook';
  if (/instagram\.com/i.test(url)) return 'instagram';
  return null;
}

// ─── YouTube via Invidious API (bypasses bot detection) ───────────────────────
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.privacyredirect.com',
  'https://yt.cdaut.de',
];

function getVideoId(url) {
  try {
    const p = new URL(url);
    if (p.hostname === 'youtu.be') return p.pathname.slice(1).split('?')[0];
    return p.searchParams.get('v');
  } catch { return null; }
}

function fetchInvidiousInfo(videoId) {
  return new Promise((resolve, reject) => {
    let tried = 0;
    function tryNext() {
      if (tried >= INVIDIOUS_INSTANCES.length) return reject(new Error('All instances failed'));
      const base = INVIDIOUS_INSTANCES[tried++];
      const apiUrl = `${base}/api/v1/videos/${videoId}`;
      https.get(apiUrl, { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) return tryNext();
            resolve(json);
          } catch { tryNext(); }
        });
      }).on('error', () => tryNext()).on('timeout', () => tryNext());
    }
    tryNext();
  });
}

function fetchInvidiousStream(videoId, qualityLabel) {
  return new Promise((resolve, reject) => {
    let tried = 0;
    function tryNext() {
      if (tried >= INVIDIOUS_INSTANCES.length) return reject(new Error('All instances failed'));
      const base = INVIDIOUS_INSTANCES[tried++];
      const apiUrl = `${base}/api/v1/videos/${videoId}`;
      https.get(apiUrl, { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error || !json.formatStreams) return tryNext();

            // Pick best combined stream matching quality
            let streams = json.formatStreams || [];
            let stream = null;
            if (qualityLabel && qualityLabel !== 'best') {
              stream = streams.find(s => s.qualityLabel && s.qualityLabel.startsWith(qualityLabel));
            }
            if (!stream) stream = streams[0]; // best available
            if (!stream) return tryNext();
            resolve({ url: stream.url, instance: base });
          } catch { tryNext(); }
        });
      }).on('error', () => tryNext()).on('timeout', () => tryNext());
    }
    tryNext();
  });
}

// ─── /api/info ────────────────────────────────────────────────────────────────
app.post('/api/info', infoLimiter, async (req, res) => {
  const { url: _url } = req.body;
  if (!_url) return res.status(400).json({ error: 'No URL provided.' });
  if (!validateUrl(_url)) return res.status(400).json({ error: 'Invalid URL format.' });
  const url = cleanUrl(_url);
  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported platform. Supported: TikTok, YouTube, Facebook, Instagram.' });

  // YouTube: use Invidious API to bypass bot detection
  if (platform === 'youtube') {
    const videoId = getVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Could not extract YouTube video ID.' });
    try {
      const info = await fetchInvidiousInfo(videoId);
      return res.json({
        title: info.title || 'Video',
        thumbnail: info.videoThumbnails?.[0]?.url || null,
        duration: info.lengthSeconds || null,
        platform,
        uploader: info.author || null,
        filesize: null,
      });
    } catch (e) {
      return res.status(500).json({ error: 'Could not fetch YouTube info. The video may be unavailable.' });
    }
  }

  // Other platforms: use yt-dlp
  const cmd = `${YTDLP} --dump-json --no-playlist --no-warnings --socket-timeout 15 "${url}"`;
  exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
    if (err) {
      if (/private/i.test(stderr)) return res.status(500).json({ error: 'This video is private.' });
      if (/unavailable|removed/i.test(stderr)) return res.status(500).json({ error: 'This video has been removed.' });
      return res.status(500).json({ error: 'Could not fetch video info. The link may be invalid.' });
    }
    try {
      const info = JSON.parse(stdout.trim().split('\n')[0]);
      res.json({
        title: info.title || 'Video',
        thumbnail: info.thumbnail || null,
        duration: info.duration || null,
        platform,
        uploader: info.uploader || info.channel || null,
        filesize: info.filesize || info.filesize_approx || null,
      });
    } catch { res.status(500).json({ error: 'Failed to read video info.' }); }
  });
});

// ─── /api/download ────────────────────────────────────────────────────────────
app.post('/api/download', downloadLimiter, async (req, res) => {
  const { url: _url2, quality, format } = req.body;
  if (!_url2) return res.status(400).json({ error: 'No URL provided.' });
  if (!validateUrl(_url2)) return res.status(400).json({ error: 'Invalid URL format.' });
  const url = cleanUrl(_url2);
  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported platform.' });

  const isAudio = format === 'mp3';

  // YouTube: stream directly from Invidious
  if (platform === 'youtube') {
    const videoId = getVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Could not extract YouTube video ID.' });
    try {
      if (isAudio) {
        // For MP3, fall back to yt-dlp with audio only (less bot detection issues)
        const tmpFile = path.join(os.tmpdir(), `vs_${Date.now()}.mp3`);
        const ytArgs = '--extractor-args "youtube:player_client=tv_embedded,android,ios" --no-check-certificates';
        const cmd = `${YTDLP} -f bestaudio --extract-audio --audio-format mp3 --audio-quality 0 --no-warnings --socket-timeout 30 ${ytArgs} -o "${tmpFile}" "${url}"`;
        exec(cmd, { timeout: 180000 }, (err) => {
          if (err) return res.status(500).json({ error: 'Audio download failed.' });
          const actual = fs.existsSync(tmpFile) ? tmpFile : fs.existsSync(tmpFile + '.mp3') ? tmpFile + '.mp3' : null;
          if (!actual) return res.status(500).json({ error: 'File not found after download.' });
          const stat = fs.statSync(actual);
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('Content-Disposition', 'attachment; filename="videosnap.mp3"');
          res.setHeader('Content-Length', stat.size);
          const stream = fs.createReadStream(actual);
          stream.pipe(res);
          stream.on('end', () => fs.unlink(actual, () => {}));
          stream.on('error', () => res.status(500).end());
        });
      } else {
        const { url: streamUrl } = await fetchInvidiousStream(videoId, quality);
        // Proxy the stream to the client
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="videosnap.mp4"');
        https.get(streamUrl, { timeout: 60000 }, (streamRes) => {
          if (streamRes.headers['content-length']) {
            res.setHeader('Content-Length', streamRes.headers['content-length']);
          }
          streamRes.pipe(res);
          streamRes.on('error', () => res.status(500).end());
        }).on('error', () => res.status(500).json({ error: 'Stream failed. Try again.' }));
      }
    } catch (e) {
      return res.status(500).json({ error: 'YouTube download failed. The video may be unavailable.' });
    }
    return;
  }

  // Other platforms: use yt-dlp
  const ext = isAudio ? 'mp3' : 'mp4';
  const tmpFile = path.join(os.tmpdir(), `vs_${Date.now()}.${ext}`);

  let cmd;
  if (isAudio) {
    cmd = `${YTDLP} -f bestaudio --extract-audio --audio-format mp3 --audio-quality 0 --no-warnings --socket-timeout 30 -o "${tmpFile}" "${url}"`;
  } else {
    const isCombinedOnly = platform === 'facebook' || platform === 'tiktok' || platform === 'instagram';
    let fmt;
    if (isCombinedOnly) {
      const h = ['1080','720','480','360','240'].includes(quality) ? quality : null;
      fmt = h ? `best[height<=${h}][ext=mp4]/best[height<=${h}]/best[ext=mp4]/best` : `best[ext=mp4]/best`;
    } else {
      fmt = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
      if (quality === '1080') fmt = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]';
      if (quality === '720')  fmt = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]';
      if (quality === '480')  fmt = 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]';
      if (quality === '360')  fmt = 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best[height<=360]';
      if (quality === '240')  fmt = 'bestvideo[height<=240][ext=mp4]+bestaudio[ext=m4a]/best[height<=240][ext=mp4]/best[height<=240]';
    }
    cmd = `${YTDLP} -f "${fmt}" --merge-output-format mp4 --no-playlist --concurrent-fragments 4 --no-warnings --socket-timeout 30 -o "${tmpFile}" "${url}"`;
  }

  exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
    if (err) {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      if (/private/i.test(stderr)) return res.status(500).json({ error: 'This video is private.' });
      if (/unavailable|removed/i.test(stderr)) return res.status(500).json({ error: 'This video has been removed.' });
      return res.status(500).json({ error: 'Download failed. The video may be private or unavailable.' });
    }
    const actualFile = fs.existsSync(tmpFile) ? tmpFile : fs.existsSync(tmpFile + '.mp3') ? tmpFile + '.mp3' : null;
    if (!actualFile) return res.status(500).json({ error: 'File not found after download.' });
    const stat = fs.statSync(actualFile);
    const contentType = isAudio ? 'audio/mpeg' : 'video/mp4';
    const filename = isAudio ? 'videosnap.mp3' : 'videosnap.mp4';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(actualFile);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(actualFile, () => {}));
    stream.on('error', () => { if (fs.existsSync(actualFile)) fs.unlinkSync(actualFile); res.status(500).end(); });
  });
});

app.listen(PORT, () => console.log(`VideoSnap on port ${PORT} | yt-dlp: ${YTDLP} | static: ${publicDir}`));
