#!/usr/bin/env bash
set -euo pipefail

REPO="seto-sama/PocketRisu-Kei"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; exit 1; }

normalize_version() {
    local version="$1"
    version="${version#kei-v}"
    version="${version#v}"
    printf '%s' "$version"
}

# ── Check current version ─────────────────────────────────────────────────────

CURRENT=""
if [ -f .installed-version ]; then
    CURRENT=$(normalize_version "$(cat .installed-version)")
fi

if [ -z "$CURRENT" ]; then
    # Fallback: read from package.json
    CURRENT=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
fi

info "Current version: v$CURRENT"

# ── Fetch latest release ───────────────────────────────────────────────────────

info "Checking for updates..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    || wget -qO- "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null) \
    || error "Failed to fetch release info."

RELEASE_TAG=$(echo "$RELEASE_JSON" | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$RELEASE_TAG" ] || error "Could not determine latest version."
LATEST=$(normalize_version "$RELEASE_TAG")

if [ "$CURRENT" = "$LATEST" ]; then
    info "Already up to date (v$CURRENT)."
    exit 0
fi

info "New version available: v$LATEST"

# ── Confirm ────────────────────────────────────────────────────────────────────

printf "Update from v%s to v%s? [Y/n]: " "$CURRENT" "$LATEST"
read -r answer
[ "$answer" = "n" ] || [ "$answer" = "N" ] && { info "Aborted."; exit 0; }

# ── Backup save/ ───────────────────────────────────────────────────────────────

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if [ -d save ]; then
    info "Backing up save/ ..."
    cp -r save "$TMP_DIR/_save_backup"
fi

# ── Download and extract ───────────────────────────────────────────────────────

TARBALL_URL="https://github.com/$REPO/archive/refs/tags/$RELEASE_TAG.tar.gz"

info "Downloading $RELEASE_TAG..."
if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/release.tar.gz"
else
    wget -qO "$TMP_DIR/release.tar.gz" "$TARBALL_URL"
fi

info "Extracting..."
tar -xzf "$TMP_DIR/release.tar.gz" -C "$TMP_DIR"
# Match both PocketRisu-* (current) and Risuai-NodeOnly-* (legacy repo name)
# in case an older script encounters a redirected source archive.
# Use find rather than ls: ls exits non-zero when one branch has no match,
# which `set -euo pipefail` would propagate and abort the script.
EXTRACTED_DIR=$(find "$TMP_DIR" -maxdepth 1 -type d \
    \( -name 'PocketRisu-*' -o -name 'Risuai-NodeOnly-*' \) \
    -print -quit)
[ -d "$EXTRACTED_DIR" ] || error "Extraction failed."

# ── Replace files (preserve save/) ─────────────────────────────────────────────

info "Updating files..."

# Remove old app files but keep save/ and backups/
find "$SCRIPT_DIR" -mindepth 1 -maxdepth 1 ! -name 'save' ! -name 'backups' ! -name '.installed-version' -exec rm -rf {} +

# Move new files in
mv "$EXTRACTED_DIR"/* "$EXTRACTED_DIR"/.[!.]* "$SCRIPT_DIR/" 2>/dev/null || true

# Restore save/
if [ -d "$TMP_DIR/_save_backup" ]; then
    rm -rf "$SCRIPT_DIR/save"
    mv "$TMP_DIR/_save_backup" "$SCRIPT_DIR/save"
fi

# ── Rebuild ────────────────────────────────────────────────────────────────────

info "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

info "Building..."
NODE_OPTIONS="--max-old-space-size=4096" pnpm build

info "Removing dev dependencies..."
pnpm prune --prod

echo "v$LATEST" > "$SCRIPT_DIR/.installed-version"

info "Update complete! v$CURRENT → v$LATEST"
echo ""
echo "  Restart the server to apply the update:"
echo "    pnpm runserver"
echo ""
