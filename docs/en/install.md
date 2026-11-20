<p align="center">
  <strong>English</strong> | <a href="../ko/install.md">한국어</a> | <a href="../de/install.md">Deutsch</a> | <a href="../cn/install.md">简体中文</a> | <a href="../es/install.md">Español</a> | <a href="../vi/install.md">Tiếng Việt</a> | <a href="../zh-Hant/install.md">繁體中文</a>
</p>

# Installation Guide

PocketRisu can be installed in two ways.

- [1. Docker](#1-docker) — Container environment.
- [2. Git Clone](#2-git-clone) — Clone and build from source.


## System Requirements

| Item        | Minimum             | Recommended                  |
| ----------- | ------------------- | ---------------------------- |
| **CPU**     | 1 core              | 2+ cores                     |
| **RAM**     | 1 GB (run only)     | 4+ GB (build included)       |
| **Disk**    | 1 GB                | 2+ GB                        |
| **Node.js** | 24.22.1+ (24.x) / 26.12.1+ (26.x) | (not required for Docker) |

Docker does not require a build step and can run on 1 GB of RAM. Building from source (Git Clone) consumes significant memory during build, so 4 GB or more is recommended.


---

## 1. Docker

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

## 2. Git Clone

Clone the source and build it yourself.

Node.js 24.x (24.22.1 or later) or 26.x (26.12.1 or later) is required:

```bash
node --version
# v24.22.1+ (24.x) or v26.12.1+ (26.x)
```

Install from the [official Node.js site](https://nodejs.org/) if not present.

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

### Debug logs

Run `pnpm debug` instead of `pnpm runserver` to enable server diagnostics and browser debug logs, including chat-save diagnostics. Reload the browser after restarting the server. In browser developer tools, enable the **Verbose** console level to see these messages. Debug messages are not stored in the system log database.

For development, run `pnpm dev`, or `pnpm debug dev` with debug logs. Development mode alone does not enable debug logs.

The debug commands enable Node's `NODE_DEBUG=pocketrisu` setting; an existing build can also use `NODE_DEBUG=pocketrisu pnpm runserver` without rebuilding.

The developer panel remains separate. Enable it in the browser console, then reload:

```js
localStorage.setItem('risu-dev-panel', '1')
location.reload()
```

### Local Fonts

Local font files are intentionally not included in the repository. To bundle fonts that you are licensed to use:

1. Put `.woff2`, `.woff`, `.ttf`, or `.otf` files in `public/assets/fonts/`.
2. Run `pnpm build` again.
3. Select **Custom** in the font setting and choose a detected family from the input suggestions. For a weight-variable font, append a numeric weight such as `SUIT Variable 700`.

Weight-variable fonts keep their original family name and use their embedded weight range, so intermediate values such as `SUIT Variable 475` are also supported. Static fonts also keep their original family name, including suffixes such as `Regular` or `Thin`, and do not use the numeric suffix syntax. Font files under `public/assets/fonts/` are ignored by Git and remain local to your build.


---

← [Back to README](../../README.md)
