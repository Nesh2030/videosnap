# VideoSnap 🎬
**Download TikTok, YouTube & Facebook videos — no watermarks**

---

## Requirements
- **Node.js** v18+
- **yt-dlp** installed on your system (see below)
- **ffmpeg** (required by yt-dlp for merging audio+video)

---

## 1. Install yt-dlp & ffmpeg

### On Ubuntu/Debian (VPS or local Linux):
```bash
sudo apt update
sudo apt install ffmpeg -y
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

### On macOS:
```bash
brew install yt-dlp ffmpeg
```

### On Windows:
- Download yt-dlp.exe from: https://github.com/yt-dlp/yt-dlp/releases
- Download ffmpeg from: https://ffmpeg.org/download.html
- Add both to your PATH

---

## 2. Install & Run

```bash
# Install dependencies
npm install

# Start server
npm start
```

Then open your browser at: **http://localhost:3000**

---

## 3. Deploy to a VPS (e.g. DigitalOcean, Railway, Render)

### Using Railway:
1. Push this project to GitHub
2. Connect to Railway → New Project → Deploy from GitHub
3. Add start command: `npm start`
4. Add a build command to install yt-dlp in the Dockerfile (see below)

### Dockerfile (for VPS/Docker deployment):
```dockerfile
FROM node:20-slim

# Install yt-dlp and ffmpeg
RUN apt-get update && apt-get install -y ffmpeg curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
```

Build and run:
```bash
docker build -t videosnap .
docker run -p 3000:3000 videosnap
```

---

## Project Structure

```
videosnap/
├── server.js          ← Express backend + yt-dlp integration
├── package.json
├── public/
│   └── index.html     ← Full frontend (UI)
└── README.md
```

---

## Features
- ✅ Supports TikTok, YouTube, Facebook
- ✅ TikTok no-watermark download
- ✅ Quality selection (Best / 720p / 480p)
- ✅ Video preview with thumbnail before downloading
- ✅ Streams video directly to browser (no storage needed)
- ✅ Clean, modern dark UI

---

## ⚠️ Legal Note
This tool is for personal use only. Downloading videos may violate the Terms of Service of TikTok, YouTube, and Facebook. Only download content you own or have rights to. The developer is not responsible for misuse.
