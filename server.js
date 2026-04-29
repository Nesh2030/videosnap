const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Auto-update yt-dlp on startup ───────────────────────────────────────────
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
  console.log('Updating yt-dlp...');
  execSync(`${YTDLP} -U`, { stdio: 'ignore', timeout: 30000 });
  console.log('yt-dlp updated.');
} catch {
  console.log('yt-dlp update skipped.');
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
const infoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please wait a moment.' },
});

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many downloads. Please wait a minute.' },
});

app.use(cors());
app.use(express.json());

const publicDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(__dirname, 'Public');
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
  } catch (e) {
    res.json({ status: 'error', error: e.message });
  }
});

// ─── URL validation & platform detection ─────────────────────────────────────
function validateUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return true;
  } catch {
    return false;
  }
}

function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'facebook';
  if (/instagram\.com/i.test(url)) return 'instagram';
  return null;
}

// ─── /api/info ────────────────────────────────────────────────────────────────
app.post('/api/info', infoLimiter, (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });
  if (!validateUrl(url)) return res.status(400).json({ error: 'Invalid URL format.' });

  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported platform. Supported: TikTok, YouTube, Facebook, Instagram.' });

  const ytArgs = platform === 'youtube' ? '--extractor-args "youtube:player_client=tv_embedded,android,ios" --no-check-certificates' : '';
  const cmd = `${YTDLP} --dump-json --no-playlist --no-warnings --socket-timeout 15 ${ytArgs} "${url}"`;
  console.log('Info:', cmd);

  exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('Info error:', stderr);
      if (/private/i.test(stderr)) return res.status(500).json({ error: 'This video is private.' });
      if (/unavailable|removed/i.test(stderr)) return res.status(500).json({ error: 'This video has been removed or is unavailable.' });
      if (/login|sign in/i.test(stderr)) return res.status(500).json({ error: 'This video requires login to access.' });
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
    } catch (e) {
      res.status(500).json({ error: 'Failed to read video info.' });
    }
  });
});

// ─── /api/download ────────────────────────────────────────────────────────────
app.post('/api/download', downloadLimiter, (req, res) => {
  const { url, quality, format } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });
  if (!validateUrl(url)) return res.status(400).json({ error: 'Invalid URL format.' });

  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported platform.' });

  const isAudio = format === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';
  const tmpFile = path.join(os.tmpdir(), `vs_${Date.now()}.${ext}`);
  const ytArgs = platform === 'youtube' ? '--extractor-args "youtube:player_client=tv_embedded,android,ios" --no-check-certificates' : '';

  let cmd;
  if (isAudio) {
    cmd = `${YTDLP} -f bestaudio --extract-audio --audio-format mp3 --audio-quality 0 --no-warnings --socket-timeout 30 ${ytArgs} -o "${tmpFile}" "${url}"`;
  } else {
    const isCombinedOnly = platform === 'facebook' || platform === 'tiktok' || platform === 'instagram';
    let fmt;
    if (isCombinedOnly) {
      const h = ['1080','720','480','360','240'].includes(quality) ? quality : null;
      fmt = h
        ? `best[height<=${h}][ext=mp4]/best[height<=${h}]/best[ext=mp4]/best`
        : `best[ext=mp4]/best`;
    } else {
      fmt = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
      if (quality === '1080') fmt = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]';
      if (quality === '720')  fmt = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]';
      if (quality === '480')  fmt = 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]';
      if (quality === '360')  fmt = 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best[height<=360]';
      if (quality === '240')  fmt = 'bestvideo[height<=240][ext=mp4]+bestaudio[ext=m4a]/best[height<=240][ext=mp4]/best[height<=240]';
    }
    cmd = `${YTDLP} -f "${fmt}" --merge-output-format mp4 --no-warnings --socket-timeout 30 ${ytArgs} -o "${tmpFile}" "${url}"`;
  }

  console.log('Download:', cmd);

  exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('Download error:', stderr);
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      if (/private/i.test(stderr)) return res.status(500).json({ error: 'This video is private.' });
      if (/unavailable|removed/i.test(stderr)) return res.status(500).json({ error: 'This video has been removed or is unavailable.' });
      if (/login|sign in/i.test(stderr)) return res.status(500).json({ error: 'This video requires login to access.' });
      return res.status(500).json({ error: 'Download failed. The video may be private or unavailable.' });
    }

    const actualFile = fs.existsSync(tmpFile) ? tmpFile
      : fs.existsSync(tmpFile + '.mp3') ? tmpFile + '.mp3'
      : null;

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
