const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const rateLimit = require('express-rate-limit');
const https = require('https');

const app = express();
app.set('trust proxy', 1);
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
try { execSync(`${YTDLP} -U`, { stdio: 'ignore', timeout: 30000 }); console.log('yt-dlp updated.'); }
catch { console.log('yt-dlp update skipped.'); }

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
  try { res.json({ status: 'ok', ytdlp: execSync(`${YTDLP} --version`).toString().trim() }); }
  catch (e) { res.json({ status: 'error', error: e.message }); }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function validateUrl(url) {
  try { const p = new URL(url); return ['http:', 'https:'].includes(p.protocol); }
  catch { return false; }
}

function cleanUrl(url) {
  try {
    const p = new URL(url);
    if (/youtube\.com|youtu\.be/i.test(p.hostname)) {
      ['list','index','start_radio','si'].forEach(k => p.searchParams.delete(k));
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

function getVideoId(url) {
  try {
    const p = new URL(url);
    if (p.hostname === 'youtu.be') return p.pathname.slice(1).split('?')[0];
    return p.searchParams.get('v');
  } catch { return null; }
}

// ─── Generic HTTPS GET helper ─────────────────────────────────────────────────
function httpsGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

// ─── YouTube info via oEmbed (always free, no bot check) ─────────────────────
async function getYouTubeInfo(videoId) {
  const oEmbedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const raw = await httpsGet(oEmbedUrl);
  const data = JSON.parse(raw);
  return {
    title: data.title || 'Video',
    thumbnail: data.thumbnail_url || null,
    uploader: data.author_name || null,
    duration: null,
  };
}

// ─── YouTube stream via Invidious (multiple fallbacks) ────────────────────────
const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.privacyredirect.com',
  'https://iv.datura.network',
  'https://invidious.lunar.icu',
  'https://invidious.nerdvpn.de',
  'https://vid.puffyan.us',
];

async function getInvidiousStream(videoId, quality) {
  for (const base of INVIDIOUS) {
    try {
      const raw = await httpsGet(`${base}/api/v1/videos/${videoId}`, 8000);
      const json = JSON.parse(raw);
      if (json.error || !json.formatStreams?.length) continue;

      const streams = json.formatStreams;
      let picked = null;
      if (quality && quality !== 'best') {
        picked = streams.find(s => s.qualityLabel?.startsWith(quality));
      }
      if (!picked) picked = streams[0];
      if (picked?.url) return picked.url;
    } catch { continue; }
  }
  throw new Error('No Invidious instance available');
}

// ─── /api/info ────────────────────────────────────────────────────────────────
app.post('/api/info', infoLimiter, async (req, res) => {
  const { url: _url } = req.body;
  if (!_url) return res.status(400).json({ error: 'No URL provided.' });
  if (!validateUrl(_url)) return res.status(400).json({ error: 'Invalid URL format.' });
  const url = cleanUrl(_url);
  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported platform. Supported: TikTok, YouTube, Facebook, Instagram.' });

  if (platform === 'youtube') {
    const videoId = getVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Could not read YouTube video ID.' });
    try {
      const info = await getYouTubeInfo(videoId);
      return res.json({ ...info, platform });
    } catch (e) {
      return res.status(500).json({ error: 'Could not fetch YouTube info. The video may be unavailable or private.' });
    }
  }

  // Other platforms
  const cmd = `${YTDLP} --dump-json --no-playlist --no-warnings --socket-timeout 15 "${url}"`;
  exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
    if (err) {
      if (/private/i.test(stderr)) return res.status(500).json({ error: 'This video is private.' });
      if (/unavailable|removed/i.test(stderr)) return res.status(500).json({ error: 'This video has been removed.' });
      return res.status(500).json({ error: 'Could not fetch video info.' });
    }
    try {
      const info = JSON.parse(stdout.trim().split('\n')[0]);
      res.json({
        title: info.title || 'Video',
        thumbnail: info.thumbnail || null,
        duration: info.duration || null,
        platform,
        uploader: info.uploader || info.channel || null,
      });
    } catch { res.status(500).json({ error: 'Failed to parse video info.' }); }
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

  if (platform === 'youtube') {
    const videoId = getVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Could not read YouTube video ID.' });

    if (isAudio) {
      // Audio: use yt-dlp with tv_embedded (less restricted for audio)
      const tmpFile = path.join(os.tmpdir(), `vs_${Date.now()}.mp3`);
      const ytArgs = '--extractor-args "youtube:player_client=tv_embedded,android,ios;po_token=tv_embedded+jJ5nYqBjGMR7RHHNLjAIHn5xEuAGbv9Zy1mVXqDMz8Y=" --no-check-certificates --add-header "User-Agent:Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/91.0.4472.120 Mobile Safari/537.36"';
      const cmd = `${YTDLP} -f bestaudio --extract-audio --audio-format mp3 --audio-quality 0 --no-warnings --socket-timeout 30 ${ytArgs} -o "${tmpFile}" "${url}"`;
      exec(cmd, { timeout: 180000 }, (err) => {
        if (err) return res.status(500).json({ error: 'Audio download failed. Try MP4 instead.' });
        const actual = fs.existsSync(tmpFile) ? tmpFile : fs.existsSync(tmpFile + '.mp3') ? tmpFile + '.mp3' : null;
        if (!actual) return res.status(500).json({ error: 'File not found after download.' });
        const stat = fs.statSync(actual);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', 'attachment; filename="videosnap.mp3"');
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(actual).pipe(res).on('finish', () => fs.unlink(actual, () => {}));
      });
    } else {
      // Video: use yt-dlp with multiple client fallbacks
      const tmpFile = path.join(os.tmpdir(), `vs_${Date.now()}.mp4`);
      let fmt = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
      if (quality === '1080') fmt = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]';
      if (quality === '720')  fmt = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]';
      if (quality === '480')  fmt = 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]';
      if (quality === '360')  fmt = 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best[height<=360]';
      const ytArgs = '--extractor-args "youtube:player_client=tv_embedded,android,ios" --no-check-certificates';
      const cmd = `${YTDLP} -f "${fmt}" --merge-output-format mp4 --no-playlist --concurrent-fragments 4 --no-warnings --socket-timeout 30 ${ytArgs} -o "${tmpFile}" "${url}"`;
      exec(cmd, { timeout: 180000 }, (err) => {
        if (err) {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
          return res.status(500).json({ error: 'YouTube video download failed. The video may be restricted or unavailable.' });
        }
        const actual = fs.existsSync(tmpFile) ? tmpFile : null;
        if (!actual) return res.status(500).json({ error: 'File not found after download.' });
        const stat = fs.statSync(actual);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="videosnap.mp4"');
        res.setHeader('Content-Length', stat.size);
        const stream = fs.createReadStream(actual);
        stream.pipe(res);
        stream.on('finish', () => fs.unlink(actual, () => {}));
        stream.on('error', () => { if (fs.existsSync(actual)) fs.unlinkSync(actual); res.status(500).end(); });
      });
    }
    return;
  }

  // Other platforms: yt-dlp
  const ext = isAudio ? 'mp3' : 'mp4';
  const tmpFile = path.join(os.tmpdir(), `vs_${Date.now()}.${ext}`);
  let cmd;
  if (isAudio) {
    cmd = `${YTDLP} -f bestaudio --extract-audio --audio-format mp3 --audio-quality 0 --no-warnings --socket-timeout 30 -o "${tmpFile}" "${url}"`;
  } else {
    const isCombined = platform === 'facebook' || platform === 'tiktok' || platform === 'instagram';
    let fmt;
    if (isCombined) {
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
    const actual = fs.existsSync(tmpFile) ? tmpFile : fs.existsSync(tmpFile + '.mp3') ? tmpFile + '.mp3' : null;
    if (!actual) return res.status(500).json({ error: 'File not found after download.' });
    const stat = fs.statSync(actual);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${isAudio ? 'videosnap.mp3' : 'videosnap.mp4'}"`);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(actual);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(actual, () => {}));
    stream.on('error', () => { if (fs.existsSync(actual)) fs.unlinkSync(actual); res.status(500).end(); });
  });
});

app.listen(PORT, () => console.log(`VideoSnap on port ${PORT} | yt-dlp: ${YTDLP} | static: ${publicDir}`));
