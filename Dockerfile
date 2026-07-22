FROM node:22-bookworm

WORKDIR /app

# 避免把本机 Windows 的 node_modules 带进来；sharp 在 Linux 容器内安装
COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY config ./config

ENV NODE_ENV=production
ENV PERSIST_DIR=/data

EXPOSE 3000

CMD ["npx", "tsx", "src/index.ts"]
