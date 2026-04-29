FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    python3 \
    python3-pip \
    python-is-python3 \
    git \
    && pip install -U yt-dlp bgutil-ytdlp-pot-provider --break-system-packages \
    && git clone --single-branch --branch 1.3.1 \
       https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
    && cd /opt/bgutil/server && npm ci && npx tsc \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts
COPY . .

EXPOSE 3000
CMD node /opt/bgutil/server/build/main.js & node server.js
