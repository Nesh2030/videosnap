const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

function getYtDlpPath() {
  const candidates = ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', 'yt-dlp'];
  for (const p of candidates) {
    try { execSync(`${p} --version`, { stdio: 'ignore' }); return p; } catch {}
  }
  return 'yt-dlp';
}
const YTDLP = getYtDlpPath();
console.log(`yt-dlp: ${YTDLP}`);

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

function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'facebook';
  return null;
}

app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });
  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported platform. Use TikTok, YouTube, or Facebook.' });

  const cmd = `${YTDLP} --dump-json --no-playlist --no-warnings --socket-timeout 15 "${url}"`;
  console.log('Info:', cmd);

  exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('Info error:', stderr);
      return res.status(500).json({ error: 'Could not fetch video info. The link may be private or invalid.' });
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
    } catch (e) {
      res.status(500).json({ error: 'Failed to read video info.' });
    }
  });
});

app.post('/api/download', (req, res) => {
  const { url, quality } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });
  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported platform.' });

  const tmpFile = path.join(os.tmpdir(), `vs_${Date.now()}.mp4`);

  let fmt = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
  if (platform === 'tiktok') fmt = 'bestvideo+bestaudio/best';
  if (quality === '1080') fmt = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]';
  if (quality === '720')  fmt = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]';
  if (quality === '480')  fmt = 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]';
  if (quality === '360')  fmt = 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]';
  if (quality === '240')  fmt = 'bestvideo[height<=240][ext=mp4]+bestaudio[ext=m4a]/best[height<=240]';

  const cmd = `${YTDLP} -f "${fmt}" --merge-output-format mp4 --no-warnings --socket-timeout 30 -o "${tmpFile}" "${url}"`;
  console.log('Download:', cmd);

  exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('Download error:', stderr);
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      return res.status(500).json({ error: 'Download failed. The video may be private or unavailable.' });
    }
    if (!fs.existsSync(tmpFile)) return res.status(500).json({ error: 'File not found after download.' });

    const stat = fs.statSync(tmpFile);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="videosnap.mp4"');
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(tmpFile, () => {}));
    stream.on('error', () => { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); res.status(500).end(); });
  });
});

app.listen(PORT, () => console.log(`VideoSnap on port ${PORT} | yt-dlp: ${YTDLP} | static: ${publicDir}`));
