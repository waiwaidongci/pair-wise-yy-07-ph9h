#!/usr/bin/env bash
# 用 esbuild（vite 的传递依赖）打包并运行共编修订验证脚本，无需额外安装测试框架。
set -euo pipefail

ESBUILD="node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild"
if [[ ! -x "${ESBUILD}" ]]; then
  ESBUILD="$(find node_modules/.pnpm -maxdepth 4 -path '*/esbuild/bin/esbuild' | head -1)"
fi
if [[ -z "${ESBUILD}" || ! -x "${ESBUILD}" ]]; then
  echo "找不到 esbuild，请先执行 pnpm install" >&2
  exit 1
fi

OUT_DIR="node_modules/.cache/collab-tests"
mkdir -p "${OUT_DIR}"

"${ESBUILD}" scripts/test-collab.mts --bundle --platform=node --format=esm --outfile="${OUT_DIR}/engine.mjs"
"${ESBUILD}" scripts/test-session.mts --bundle --platform=node --format=esm --outfile="${OUT_DIR}/session.mjs"

node "${OUT_DIR}/engine.mjs"
node "${OUT_DIR}/session.mjs"
