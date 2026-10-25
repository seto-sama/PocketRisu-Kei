#!/usr/bin/env bash
set -euo pipefail

REPO="seto-sama/PocketRisu-Kei"
RELEASE_TAG_PREFIX="kei-v"
SOURCE_ARCHIVE_PREFIX="PocketRisu-Kei-"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; exit 1; }

normalize_version() {
    local version="$1"
    version="${version#"$RELEASE_TAG_PREFIX"}"
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
case "$RELEASE_TAG" in
    "${RELEASE_TAG_PREFIX}"*) ;;
    *) error "Latest release tag is not a PocketRisu Kei release: $RELEASE_TAG" ;;
esac
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
# Use find rather than ls: ls exits non-zero when one branch has no match,
# which `set -euo pipefail` would propagate and abort the script.
EXTRACTED_DIR=$(find "$TMP_DIR" -maxdepth 1 -type d \
    -name "${SOURCE_ARCHIVE_PREFIX}*" \
    -print -quit)
[ -d "$EXTRACTED_DIR" ] || error "Extraction failed."

# ── Replace app files, preserving user entries ─────────────────────────────────

info "Updating files..."

MANIFEST_FILE="$SCRIPT_DIR/.installed-manifest"
is_managed() {
    [ -e "$EXTRACTED_DIR/$1" ] && return 0
    in_manifest "$1" && return 0
    return 1
}
in_manifest() {
    [ -f "$MANIFEST_FILE" ] && grep -Fxq "$1" "$MANIFEST_FILE"
}

# Track top-level entries before moving them out of the new package.
ls -A "$EXTRACTED_DIR" > "$TMP_DIR/new-manifest"
CONFLICT_DIR="$SCRIPT_DIR/backups/update-conflict-v$LATEST"

while IFS= read -r -d '' entry; do
    name=$(basename "$entry")
    case "$name" in
        save|backups|.installed-version|.installed-manifest) continue ;;
    esac
    if ! is_managed "$name"; then
        info "Preserving user file: $name"
        continue
    fi
    # Collision ownership is only known when a previous manifest exists.
    if [ -f "$MANIFEST_FILE" ] && ! in_manifest "$name" && [ -e "$EXTRACTED_DIR/$name" ]; then
        warn "User file \"$name\" collides with a new app file — moving it to backups/update-conflict-v$LATEST/"
        mkdir -p "$CONFLICT_DIR"
        dest="$CONFLICT_DIR/$name"
        i=1
        while [ -e "$dest" ]; do dest="$CONFLICT_DIR/$name.$i"; i=$((i+1)); done
        mv "$entry" "$dest"
        continue
    fi
    rm -rf "$entry"
done < <(find "$SCRIPT_DIR" -mindepth 1 -maxdepth 1 -print0)

# Move all files, including dotfiles, and stop if replacement fails.
shopt -s dotglob nullglob
mv "$EXTRACTED_DIR"/* "$SCRIPT_DIR/"
shopt -u dotglob nullglob

cp "$TMP_DIR/new-manifest" "$MANIFEST_FILE"

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
