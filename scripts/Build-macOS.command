#!/bin/bash
set -Eeuo pipefail
build_stage="開始"
trap 'result=$?; printf "\n[失敗] %s（終了コード %s）\nこの表示の少し上にあるエラーを確認してください。\n" "$build_stage" "$result"; exit "$result"' ERR
cd "$(dirname "$0")/.."
mkdir -p release .build-toolchains
build_log="$PWD/release/build-macOS.log"
exec > >(tee "$build_log") 2>&1
printf 'RelayDesk Macビルド\nログ: %s\n' "$build_log"
build_stage="Node.jsの準備"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 24' 2>/dev/null || true)" != "true" ]; then
  arch="$(uname -m)"
  if [ "$arch" = "arm64" ]; then node_arch="arm64"; else node_arch="x64"; fi
  node_version="24.16.0"
  tools="$PWD/.build-toolchains"
  mkdir -p "$tools"
  archive="node-v${node_version}-darwin-${node_arch}.tar.gz"
  curl --fail --location "https://nodejs.org/dist/v${node_version}/${archive}" --output "$tools/$archive"
  curl --fail --location "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" --output "$tools/SHASUMS256.txt"
  (cd "$tools" && grep "  ${archive}$" SHASUMS256.txt | shasum -a 256 --check)
  tar -xzf "$tools/$archive" -C "$tools"
  export PATH="$tools/node-v${node_version}-darwin-${node_arch}/bin:$PATH"
fi
build_stage="Goの準備"
node scripts/prepare-go.mjs
build_stage="依存パッケージの準備"
npm ci --no-fund --no-audit
build_stage="アプリとDMGのビルド"
touch .build-toolchains/mac-build-start
npm run package:mac
build_stage="今回作成したDMGの確認"
artifacts="$(find release -maxdepth 1 -type f -name '*.dmg' -newer .build-toolchains/mac-build-start -print)"
if [ -z "$artifacts" ]; then
  printf '\nDMGが見つかりません。ログを確認してください。\n'
  false
fi
printf '\n[成功] DMGを作成しました。\n%s\n\nこれは個人検証用の未署名ビルドです。\n' "$artifacts"
open "$PWD/release"
