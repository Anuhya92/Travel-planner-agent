FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs index.html app.js style.css manifest.webmanifest sw.js icon.svg ./
ENV NODE_ENV=production PORT=8765 HOST=0.0.0.0
ENV APP_DATA_FILE=/data/app-data.json
VOLUME ["/data"]
EXPOSE 8765
CMD ["node", "server.mjs"]
