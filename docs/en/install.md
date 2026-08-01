<p align="center">
  <strong>English</strong> | <a href="../ko/install.md">한국어</a> | <a href="../de/install.md">Deutsch</a> | <a href="../cn/install.md">简体中文</a> | <a href="../es/install.md">Español</a> | <a href="../vi/install.md">Tiếng Việt</a> | <a href="../zh-Hant/install.md">繁體中文</a>
</p>

# Installation Guide

PocketRisu can be installed in four ways.

- [1. Portable Package](#1-portable-package) — Pre-compiled binary. No Node.js required.
- [2. Docker](#2-docker) — Container environment.
- [3. Install Script](#3-install-script) — Automatic build from source. For Linux/macOS servers.
- [4. Git Clone](#4-git-clone) — Manual source build. For developers / advanced users.


## System Requirements

| Item        | Minimum             | Recommended                  |
| ----------- | ------------------- | ---------------------------- |
| **CPU**     | 1 core              | 2+ cores                     |
| **RAM**     | 1 GB (run only)     | 4+ GB (build included)       |
| **Disk**    | 1 GB                | 2+ GB                        |
| **Node.js** | 22.12+              | (not required for portable/Docker) |

The portable package and Docker do not require a build step and can run on 1 GB of RAM. Direct builds (Git Clone, install script) consume significant memory during build, so 4 GB or more is recommended.


---

## 1. Portable Package

Download and run a pre-compiled binary. No Node.js, Docker, or other tools required. Supports Windows, macOS (Apple Silicon), and Linux (x64/ARM).

### Download

Get the file for your OS from the [Releases page](https://github.com/seto-sama/PocketRisu-Kei/releases).

| OS                      | File                                      |
| ----------------------- | ----------------------------------------- |
| Windows (x64)           | `PocketRisu-vX.X.X-win-x64.zip`           |
| macOS (Apple Silicon)   | `PocketRisu-vX.X.X-macos-arm64.tar.gz`    |
| Linux (x64)             | `PocketRisu-vX.X.X-linux-x64.tar.gz`      |
| Linux (ARM)             | `PocketRisu-vX.X.X-linux-arm64.tar.gz`    |

### Run

**Windows**

Extract the zip and double-click `PocketRisu.exe`. A browser opens automatically at `http://localhost:6001`.

**macOS**

```bash
tar -xzf PocketRisu-vX.X.X-macos-arm64.tar.gz
xattr -cr PocketRisu-vX.X.X-macos-arm64
open PocketRisu-vX.X.X-macos-arm64/PocketRisu.app
```

The `xattr` command is a one-time step to bypass the "Apple cannot verify" warning.

**Linux**

```bash
tar -xzf PocketRisu-vX.X.X-linux-*.tar.gz
cd PocketRisu-vX.X.X-linux-*
./start.sh
```

Open `http://localhost:6001` in your browser.

### Headless Server (One-line Download)

For Linux/macOS servers without a GUI, fetch and run the latest version in one command.

**Linux (x64):**

```bash
RELEASE_TAG=$(curl -s https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest | grep -o '"tag_name":[[:space:]]*"[^"]*"' | cut -d'"' -f4)
VERSION=${RELEASE_TAG#*v}
curl -fsSL "https://github.com/seto-sama/PocketRisu-Kei/releases/download/${RELEASE_TAG}/PocketRisu-v${VERSION}-linux-x64.tar.gz" -o pocketrisu.tar.gz
tar -xzf pocketrisu.tar.gz && rm pocketrisu.tar.gz
cd PocketRisu-v${VERSION}-linux-x64
./start.sh
```

**Linux (ARM):** Replace `linux-x64` with `linux-arm64` in the command above.

**macOS (Apple Silicon):**

```bash
RELEASE_TAG=$(curl -s https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest | grep -o '"tag_name":[[:space:]]*"[^"]*"' | cut -d'"' -f4)
VERSION=${RELEASE_TAG#*v}
curl -fsSL "https://github.com/seto-sama/PocketRisu-Kei/releases/download/${RELEASE_TAG}/PocketRisu-v${VERSION}-macos-arm64.tar.gz" -o pocketrisu.tar.gz
tar -xzf pocketrisu.tar.gz && rm pocketrisu.tar.gz
xattr -cr PocketRisu-v${VERSION}-macos-arm64
cd PocketRisu-v${VERSION}-macos-arm64
./start.sh
```

### Update

Click "Update now" in the update popup on the web UI home screen, or run the update script in the installation folder.

- **Windows**: Double-click `update.bat`
- **macOS / Linux**: `./update.sh`

Data in the `save/` folder is preserved.


---

## 2. Docker

Runs on a system with Docker or Docker Desktop installed.

### Install Docker

- **Windows / macOS**: Install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
- **Linux**:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```

### Run

```bash
curl -L https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

Open `http://localhost:6001` in your browser.

### Update

```bash
docker compose pull && docker compose up -d
```

### Data Location

All data (chats, characters, etc.) is stored in the Docker volume `risuai-save`. Data is preserved across updates.


---

## 3. Install Script

Fetches the source and builds automatically with Node.js. Runs on Linux/macOS servers. Use this if you want to manage updates via `git pull`.

### Prerequisites

Node.js 22.12 or later is required:

```bash
node --version
# v22.12.0 or later
```

Install from the [official Node.js site](https://nodejs.org/) if not present.

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/install.sh | bash
```

A status message is shown when installation finishes.

### Start Server

```bash
cd ~/pocketrisu
pnpm runserver
```

Open `http://localhost:6001` in your browser.

### Update

```bash
cd ~/pocketrisu
./update.sh
```

> **One-time note for v1.5.x → v1.6.0**: If you installed via `install.sh` during the Risuai-NodeOnly era (v1.5.x or earlier), replace `update.sh` with the new version once before your first v1.6.0 update. (The repository was renamed to PocketRisu, and the old `update.sh` cannot find the new source directory.)
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/update.sh -o update.sh && chmod +x update.sh
> ./update.sh
> ```
>
> Subsequent updates run with `./update.sh` as usual.


---

## 4. Git Clone

Manually clone and build the source. For developers who need to modify or debug code.

```bash
git clone https://github.com/seto-sama/PocketRisu-Kei.git
cd PocketRisu-Kei
pnpm install
pnpm build
pnpm runserver
```

Open `http://localhost:6001` in your browser.

### Update

```bash
git pull
pnpm install
pnpm build
# Restart server
pnpm runserver
```

### Local Fonts

Local font files are intentionally not included in the repository. To bundle fonts that you are licensed to use:

1. Put `.woff2`, `.woff`, `.ttf`, or `.otf` files in `public/assets/fonts/`.
2. Run `pnpm build` again.
3. Select **Custom** in the font setting and choose a detected family from the input suggestions. For a weight-variable font, append a numeric weight such as `SUIT Variable 700`.

Weight-variable fonts keep their original family name and use their embedded weight range, so intermediate values such as `SUIT Variable 475` are also supported. Static fonts also keep their original family name, including suffixes such as `Regular` or `Thin`, and do not use the numeric suffix syntax. Font files under `public/assets/fonts/` are ignored by Git and remain local to your build.


---

← [Back to README](../../README.md)
