# ─────────────────────────────────────────────────────────────
# 构建阶段：装依赖、构建前端、编译并打包后端
# ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

# 用 npm 装 pnpm 而不是 corepack：corepack 在新版 Node 里逐步移除，
# 这条路更稳定，也不依赖 corepack 是否随镜像分发。
RUN npm install -g pnpm@11.7.0

WORKDIR /repo

# 先只拷贝依赖清单。只要依赖没变，这一层就一直命中缓存，
# 改业务代码时不用重新装一遍依赖。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/server/package.json ./app/server/
COPY app/web/package.json ./app/web/

RUN pnpm install --frozen-lockfile

COPY . .

# 前端产物 + 后端单文件 bundle
RUN pnpm -F web build && pnpm build:bundle

# ─────────────────────────────────────────────────────────────
# 运行阶段：只带产物，不带 node_modules
#
# 后端被 esbuild 打成了单个 .mjs，运行时零依赖，
# 所以这个镜像里没有 pnpm、没有 node_modules，体积和攻击面都小很多。
# 附带好处：宿主机裸跑时也只需要这一个文件 + app/web/dist，不用 pnpm install。
# ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    PORT=9200 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /repo

COPY --from=builder /repo/app/server/dist/bundle.mjs ./app/server/dist/bundle.mjs
COPY --from=builder /repo/app/web/dist ./app/web/dist
COPY --from=builder /repo/agent ./agent

# 数据目录要可写；官方 node 镜像自带非 root 的 node 用户
RUN mkdir -p /data && chown -R node:node /data /repo

USER node

VOLUME ["/data"]
EXPOSE 9200

# busybox 自带 wget，不用为了健康检查再装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9200/api/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "app/server/dist/bundle.mjs"]
