FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY config ./config

ENV NODE_ENV=production
ENV PERSIST_DIR=/data

VOLUME ["/data"]

EXPOSE 3000

CMD ["npx", "tsx", "src/index.ts"]
