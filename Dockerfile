# Node 22 is required for the built-in `node:sqlite` module (added in 22.5).
FROM node:22-slim

WORKDIR /app

# No runtime dependencies to install — the app uses Node built-ins only.
# Copy package.json first so this layer is cached.
COPY package.json ./
COPY src ./src
COPY public ./public

# Persistent data lives here (mount a volume at /app/data to keep queues).
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
# Hosts set PORT; default to 3000 for local `docker run`.
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
