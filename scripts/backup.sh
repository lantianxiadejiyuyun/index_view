#!/usr/bin/env bash
# 备份包装脚本（Linux / macOS）
#
#   ./scripts/backup.sh                      备份到 ./backups，保留最近 10 份
#   ./scripts/backup.sh --with-notes         连笔记一起备份（笔记在数据目录外时用）
#   ./scripts/backup.sh --out=/mnt/nas/bak   备份到别的地方
#   ./scripts/backup.sh --keep=30            保留最近 30 份
#
# 加到 crontab 里每天自动备份：
#   0 3 * * *  cd /opt/home-dashboard && ./scripts/backup.sh >> backups/cron.log 2>&1

set -euo pipefail
cd "$(dirname "$0")/.."
exec node --disable-warning=ExperimentalWarning scripts/backup.mjs "$@"
