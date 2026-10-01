# ────────────────────────────────────────────────────────────────
# 内网探针（agent）的容器镜像
#
# 为什么值得打成镜像：探针要求 Node ≥ 22，而 NAS / 路由器 / 电视盒子这类设备
# 常常没有 Node，装起来也麻烦。镜像里自带运行时，宿主机只要有 Docker 就能跑。
#
# 构建上下文是 agent/ 目录（探针是零依赖单文件，不需要 npm install）：
#   docker build -t home-dashboard-agent:latest agent/
#
# 或者直接用 agent/docker-compose.yml：docker compose up -d --build
# ────────────────────────────────────────────────────────────────
FROM node:24-alpine

LABEL org.opencontainers.image.title="home-dashboard agent" \
      org.opencontainers.image.description="内网探针：上报本机监听端口与运行指标"

# ss 用来扫监听端口，能顺带带上进程名。
# 没有它探针也能跑 —— 会退回读 /proc/net/tcp，只是 process 字段为空；
# 装上它才能和裸机跑出来的结果一致。alpine 默认不带 iproute2。
RUN apk add --no-cache iproute2

WORKDIR /app
# 只拷这一个文件：探针是刻意的零依赖单文件，多拷的都会变成镜像里的噪音
COPY node/index.mjs /app/index.mjs

# 专属密钥必须落在卷里。它是「这台机器的身份证」：
# 丢了就要重新 enroll，然后在面板上重新批准一次。
ENV AGENT_KEY_FILE=/data/agent-key \
    PORT=9201
VOLUME ["/data"]
EXPOSE 9201

# /healthz 不鉴权（见 agent/README.md 的接口表），正好拿来当健康检查。
#
# ⚠️ 地址必须用 ${HOST}，不能用 127.0.0.1：探针默认绑的是**内网网卡**，
# 不是回环 —— 写死 127.0.0.1 会永远 unhealthy。HOST 在 compose 里显式给了；
# 万一没给，就退化成 127.0.0.1（那种情况下健康检查会连不上，
# 用 docker compose logs 和 curl 手动看即可，不影响上报）。
# 用 shell 形式是为了让 ${HOST} / ${PORT} 跟着环境变量走，换端口不用改镜像。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://${HOST:-127.0.0.1}:${PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["node", "/app/index.mjs"]
