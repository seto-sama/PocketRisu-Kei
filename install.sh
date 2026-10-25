#!/usr/bin/env bash
set -euo pipefail

REPO="seto-sama/PocketRisu-Kei"
RELEASE_TAG_PREFIX="kei-v"
SOURCE_ARCHIVE_PREFIX="PocketRisu-Kei-"
INSTALL_DIR="${RISU_INSTALL_DIR:-$HOME/pocketrisu-kei}"
PORT="${PORT:-6001}"

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; exit 1; }

# ── Prerequisites ──────────────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || error "Node.js is not installed. Please install a supported Node.js version first: https://nodejs.org/"

if ! command -v pnpm >/dev/null 2>&1; then
    info "Installing pnpm..."
    npm install -g pnpm
fi

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || error "curl or wget is required."

# ── Fetch latest release ───────────────────────────────────────────────────────

info "Fetching latest release from GitHub..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    || wget -qO- "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null) \
    || error "Failed to fetch release info. Check your internet connection."

TAG=$(echo "$RELEASE_JSON" | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$TAG" ] || error "Could not determine latest version."
case "$TAG" in
    "${RELEASE_TAG_PREFIX}"*) ;;
    *) error "Latest release tag is not a PocketRisu Kei release: $TAG" ;;
esac
info "Latest version: $TAG"

# ── Download source archive ────────────────────────────────────────────────────

TARBALL_URL="https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

info "Downloading $TAG..."
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

# ── Install ────────────────────────────────────────────────────────────────────

if [ -d "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR already exists."
    printf "Overwrite? (existing save/ and backups/ data will be preserved) [y/N]: "
    read -r answer
    [ "$answer" = "y" ] || [ "$answer" = "Y" ] || error "Aborted."

    # Preserve user data
    if [ -d "$INSTALL_DIR/save" ]; then
        mv "$INSTALL_DIR/save" "$TMP_DIR/_save_backup"
    fi
    if [ -d "$INSTALL_DIR/backups" ]; then
        mv "$INSTALL_DIR/backups" "$TMP_DIR/_backups_backup"
    fi
    rm -rf "$INSTALL_DIR"
fi

mv "$EXTRACTED_DIR" "$INSTALL_DIR"

# Restore user data
if [ -d "$TMP_DIR/_save_backup" ]; then
    mv "$TMP_DIR/_save_backup" "$INSTALL_DIR/save"
    info "Restored existing save/ data."
fi
if [ -d "$TMP_DIR/_backups_backup" ]; then
    mv "$TMP_DIR/_backups_backup" "$INSTALL_DIR/backups"
    info "Restored existing backups/ data."
fi

cd "$INSTALL_DIR"

info "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

info "Building..."
NODE_OPTIONS="--max-old-space-size=4096" pnpm build

info "Removing dev dependencies..."
pnpm prune --prod

# Write version marker for update script
echo "$TAG" > "$INSTALL_DIR/.installed-version"

# ── Optional: install cloudflared for remote access ──────────────────────────
if ! command -v cloudflared >/dev/null 2>&1; then
    printf "Install cloudflared for remote access? [y/N]: "
    read -r cfanswer
    if [ "$cfanswer" = "y" ] || [ "$cfanswer" = "Y" ]; then
        CF_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
        CF_ARCH_RAW=$(uname -m)
        case "$CF_ARCH_RAW" in
            x86_64)  CF_ARCH="amd64" ;;
            aarch64|arm64) CF_ARCH="arm64" ;;
            *) warn "Unsupported architecture $CF_ARCH_RAW for cloudflared. Skipping."; CF_ARCH="" ;;
        esac
        if [ -n "$CF_ARCH" ]; then
            CF_DEST="$INSTALL_DIR/bin/cloudflared"
            mkdir -p "$INSTALL_DIR/bin"
            if [ "$CF_OS" = "darwin" ]; then
                CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CF_ARCH}.tgz"
                info "Installing cloudflared..."
                if curl -fsSL "$CF_URL" -o /tmp/cloudflared.tgz 2>/dev/null; then
                    tar -xzf /tmp/cloudflared.tgz -C "$INSTALL_DIR/bin/"
                    chmod +x "$CF_DEST"
                    rm -f /tmp/cloudflared.tgz
                    info "cloudflared installed successfully."
                else
                    warn "Failed to install cloudflared. Remote access feature will be unavailable."
                fi
            else
                CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
                info "Installing cloudflared..."
                if curl -fsSL "$CF_URL" -o "$CF_DEST" 2>/dev/null; then
                    chmod +x "$CF_DEST"
                    info "cloudflared installed successfully."
                else
                    warn "Failed to install cloudflared. Remote access feature will be unavailable."
                fi
            fi
        fi
    fi
fi

# ── Done ───────────────────────────────────────────────────────────────────────

info "Installation complete!"
echo ""
echo "  Start the server:"
echo "    cd $INSTALL_DIR && pnpm runserver"
echo ""
echo "  Then open http://localhost:$PORT in your browser."
echo ""
echo "  To update later:"
echo "    cd $INSTALL_DIR && ./update.sh"
echo ""
