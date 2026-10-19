#!/usr/bin/env bash
# Deploy video/ to the production renderer (Paris VPS, pm2 app video-renderer).
#
#   bash video/deploy/deploy-renderer.sh [git-ref]      # default origin/dev
#
# What it does, in order, and why:
#   1. git archive of video/ at the ref: what ships is what is committed,
#      never a working tree (the renderer drifted from its repo for four
#      months when it was edited in place).
#   2. timestamped backup of poc/src, poc/public, the bundle and server.mjs.
#   3. unpack src/, scripts/, public/ (the soundtrack .mp3 stays: it is not
#      in git) and server/server.mjs.
#   4. npm ci only when package-lock.json changed.
#   5. bundle into remotion-bundle.new, then swap, so a render in flight
#      never reads a half-written bundle.
#   6. pm2 restart and /health; on failure the backup goes back and the
#      service restarts on it.
#
# Bump COMP_VERSION in server/server.mjs whenever a composition changes:
# the cache key includes it, and without a bump the renderer keeps serving
# videos rendered by the old code.
set -euo pipefail

REF="${1:-origin/dev}"
HOST="rescue@57.130.19.92"
PORT=8822
ROOT=/mnt/video-renderer
REPO="$(git rev-parse --show-toplevel)"

git -C "$REPO" fetch -q origin
SHA="$(git -C "$REPO" rev-parse --short "$REF")"
VERSION="$(git -C "$REPO" show "$REF:video/server/server.mjs" | sed -n 's/^const COMP_VERSION = "\(.*\)";/\1/p')"
echo "deploying video/ at $REF ($SHA), COMP_VERSION=$VERSION"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git -C "$REPO" archive --format=tar "$REF" video | tar -x -C "$TMP"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$TMP/video" -cf "$TMP/payload.tar" src scripts public server package.json package-lock.json remotion.config.ts tsconfig.json

ssh -o ConnectTimeout=30 -p "$PORT" "$HOST" 'mkdir -p /tmp/video-deploy && cat > /tmp/video-deploy/payload.tar' < "$TMP/payload.tar"
ssh -o ConnectTimeout=30 -p "$PORT" "$HOST" "bash -s -- '$SHA' '$VERSION'" <<'REMOTE'
set -euo pipefail
SHA="$1"; VERSION="$2"
ROOT=/mnt/video-renderer; POC=$ROOT/poc
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$SHA"
BK=$ROOT/backups/$STAMP
mkdir -p "$BK" /tmp/video-deploy
cp -a "$POC/src" "$POC/public" "$POC/package-lock.json" "$BK/"
cp -a "$ROOT/server.mjs" "$BK/server.mjs"
[ -d "$POC/remotion-bundle" ] && cp -a "$POC/remotion-bundle" "$BK/remotion-bundle"

rollback() {
  echo "rollback to $BK"
  rm -rf "$POC/src" && cp -a "$BK/src" "$POC/src"
  cp -a "$BK/server.mjs" "$ROOT/server.mjs"
  [ -d "$BK/remotion-bundle" ] && rm -rf "$POC/remotion-bundle" && cp -a "$BK/remotion-bundle" "$POC/remotion-bundle"
  pm2 restart video-renderer >/dev/null
}

rm -rf /tmp/video-deploy/x && mkdir -p /tmp/video-deploy/x
tar -xf /tmp/video-deploy/payload.tar -C /tmp/video-deploy/x 2>/dev/null
find /tmp/video-deploy/x -name "._*" -delete
X=/tmp/video-deploy/x
LOCK_CHANGED=0
cmp -s "$X/package-lock.json" "$POC/package-lock.json" || LOCK_CHANGED=1

rm -rf "$POC/src" && cp -a "$X/src" "$POC/src"
cp -a "$X/scripts/." "$POC/scripts/"
cp -a "$X/public/." "$POC/public/"
cp -a "$X/package.json" "$X/package-lock.json" "$X/remotion.config.ts" "$X/tsconfig.json" "$POC/"
cp -a "$X/server/server.mjs" "$ROOT/server.mjs"

cd "$POC"
if [ "$LOCK_CHANGED" = 1 ]; then echo "package-lock changed: npm ci"; npm ci --no-audit --no-fund --loglevel=error || { rollback; exit 1; }; fi

node --input-type=module -e '
import { bundle } from "@remotion/bundler"; import path from "node:path"; import { rm, cp } from "node:fs/promises";
const OUT = path.resolve("remotion-bundle.new"); await rm(OUT, { recursive: true, force: true });
const tmp = await bundle({ entryPoint: path.resolve("src/index.ts") }); await cp(tmp, OUT, { recursive: true });
' || { rollback; exit 1; }
rm -rf remotion-bundle.prev && [ -d remotion-bundle ] && mv remotion-bundle remotion-bundle.prev
mv remotion-bundle.new remotion-bundle

pm2 restart video-renderer >/dev/null
for i in $(seq 1 20); do
  H="$(curl -s -m 5 localhost:4200/health || true)"
  case "$H" in *"\"comp_version\":\"$VERSION\""*) echo "healthy: $H"; ls -1dt $ROOT/backups/* | tail -n +6 | xargs -r rm -rf; exit 0;; esac
  sleep 1
done
echo "health check failed: ${H:-no answer}"; rollback; exit 1
REMOTE
