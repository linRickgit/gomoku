#!/usr/bin/env bash
# 构建前端并把产物同步到后端静态资源目录
# 用法（Git Bash）：bash scripts/deploy-frontend.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATIC="$ROOT/gomoku-server/src/main/resources/static"

echo "==> 构建前端"
cd "$ROOT/gomoku-web"
npm run build

echo "==> 同步产物到 $STATIC"
rm -rf "$STATIC"
mkdir -p "$STATIC"
cp -r "$ROOT/gomoku-web/dist/." "$STATIC/"

echo "==> 完成"
ls -R "$STATIC"
