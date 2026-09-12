#!/usr/bin/env bash
# Build PocketRisu on Termux for smoke testing.
# Usage (from PocketRisu repo root): bash scripts/termux/build.sh
set -euo pipefail

if [ ! -f package.json ] || [ ! -d server/node ]; then
    echo "Run from the PocketRisu repo root."
    exit 1
fi

echo "[1/5] Installing Termux packages..."
pkg install -y nodejs-lts python make clang pkg-config tar curl

node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 24 || (major === 24 && minor < 15)) { console.error('Node.js 24.15.0+ is required. Update the Termux nodejs-lts package.'); process.exit(1); }"

echo "[2/5] Enabling pnpm via corepack..."
corepack enable
corepack install --global pnpm@12.4.0

echo "[3/5] Termux wake lock (best effort)..."
termux-wake-lock 2>/dev/null || true

# msgpackr-extract is an optional native accelerator and does not publish an
# Android build. Do not force its Linux ARM64 binary: Termux uses Bionic, not
# glibc. Let it compile locally while Android-native Vite dependencies use
# their published Android ARM64 packages.
export GYP_DEFINES="android_ndk_path=''"

echo "[4/5] Installing dependencies..."
pnpm install --frozen-lockfile

echo "[5/5] Building (may take a while)..."
NODE_OPTIONS="--max-old-space-size=2048" pnpm build

cat <<'EOF'

Build OK. Start the server with:
  node server/node/server.cjs

Then open this address in the phone's own browser:
  http://localhost:6001
EOF
