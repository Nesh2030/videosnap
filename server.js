const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Detect supported platform
function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'facebook';
  return null;
}

// Get video info (title + thumbnail)
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported platform. Use TikTok, YouTube, or Facebook.' });

  // Use yt-dlp to get JSON metadata
  const cmd = `yt-dlp --dump-json --no-playlist "${url}"`;

  exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error(stderr);
      return res.status(500).json({ error: 'Could not fetch video info. The link may be private or unsupported.' });
    }
    try {
      const info = JSON.parse(stdout);
      res.json({
        title: info.title || 'Video',
        thumbnail: info.thumbnail || null,
        duration: info.duration || null,
        platform,
        uploader: info.uploader || info.channel || null,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse video info.' });
    }
  });
});

// Download endpoint — streams the video back to client
app.post('/api/download', (req, res) => {
  const { url, quality } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported platform.' });

  const tmpFile = path.join(os.tmpdir(), `videosnap_${Date.now()}.mp4`);

  // Build yt-dlp command
  // For TikTok: use format that avoids watermark
  // For YouTube/Facebook: best mp4 quality
  let formatArg = '-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"';
  if (platform === 'tiktok') {
    // TikTok: download without watermark using no_watermark format if available
    formatArg = '-f "no_watermark/bestvideo+bestaudio/best"';
  }
  if (quality === '720') {
    formatArg = '-f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]"';
  } else if (quality === '480') {
    formatArg = '-f "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]"';
  }

  const cmd = `yt-dlp ${formatArg} --merge-output-format mp4 -o "${tmpFile}" "${url}"`;

  exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      console.error(stderr);
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      return res.status(500).json({ error: 'Download failed. The video may be private, age-restricted, or unavailable.' });
    }

    if (!fs.existsSync(tmpFile)) {
      return res.status(500).json({ error: 'Downloaded file not found.' });
    }

    const stat = fs.statSync(tmpFile);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="videosnap_download.mp4"');
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('end', () => {
      fs.unlink(tmpFile, () => {});
    });
    stream.on('error', () => {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      res.status(500).end();
    });
  });
});

app.listen(PORT, () => {
  console.log(`VideoSnap server running on http://localhost:${PORT}`);
});
