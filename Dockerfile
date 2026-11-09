# Image du bot InstaVA : Node 22 + Chromium système + Playwright.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium \
    DATA_DIR=/app/data \
    PORT=8080 \
    HOST=0.0.0.0

# Dépendances système de Chromium (paquet Debian, pas de téléchargement Playwright).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-dejavu-core \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY extension/bot-utils.js ./extension/bot-utils.js
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
