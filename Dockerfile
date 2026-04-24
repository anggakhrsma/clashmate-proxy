FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json biome.json .env.example ./
COPY src ./src

RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY .env.example ./
RUN mkdir -p /app/data /home/container/data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD sh -c 'wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1'

CMD ["node", "/app/dist/index.js"]
