#!/usr/bin/env sh
# 裸机启动（Linux / macOS / 群晖 SSH）
#
#   ./scripts/start.sh
#
# 逻辑都在 scripts/start.mjs 里，这里只是个壳。
# 需要 Node >= 22.5。首次运行会自动构建；只想重启加 SKIP_BUILD=1。

set -e
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先装 Node.js 22.5 或更高版本：https://nodejs.org" >&2
  exit 1
fi

exec node scripts/start.mjs "$@"
