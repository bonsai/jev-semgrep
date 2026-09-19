#!/bin/sh
# リリース: 版を上げて GitHub にタグを push し、npm に公開し、GitHub Release を作る。
#   sh scripts/release.sh patch|minor|major|<x.y.z>
# 前提: main ブランチ、作業ツリーがきれい、origin/main と一致、テストが通る。
# npm publish は 2 要素認証をブラウザで行うので、対話端末から実行すること (`!` 経由は不可)。
set -eu
cd "$(dirname "$0")/.."
bump=${1:?usage: release.sh patch|minor|major|x.y.z}

[ "$(git branch --show-current)" = main ] || { echo "release: main ブランチで実行してください" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "release: コミットされていない変更があります" >&2; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "release: origin/main と一致していません (pull または push してください)" >&2; exit 1; }
npm whoami >/dev/null 2>&1 || { echo "release: npm にログインしていません (npm login)" >&2; exit 1; }

sh tests/check.sh

npm version "$bump" -m "v%s" >/dev/null
ver=$(node -p "require('./package.json').version")
git push --follow-tags
npm publish --access public
gh release create "v$ver" --title "v$ver" --generate-notes

echo "released v$ver"
echo "verify: npm view @uehaj/semgrep version  /  npx @uehaj/semgrep@$ver --help"
