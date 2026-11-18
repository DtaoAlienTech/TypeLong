# TypeClash: one small Node container. Player data lives in the mounted /app/data volume.
FROM node:24-slim

ENV NODE_ENV=production \
    UV_THREADPOOL_SIZE=8 \
    PORT=3001 \
    DB_PATH=/app/data/typeclash.db

WORKDIR /app

# dependencies first so rebuilds are fast when only the code changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# run as the unprivileged "node" user (uid 1000), data folder writable by it
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
