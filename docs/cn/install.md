<p align="center">
  <a href="../en/install.md">English</a> | <a href="../ko/install.md">한국어</a> | <a href="../de/install.md">Deutsch</a> | <strong>简体中文</strong> | <a href="../es/install.md">Español</a> | <a href="../vi/install.md">Tiếng Việt</a> | <a href="../zh-Hant/install.md">繁體中文</a>
</p>

# 安装指南

> 🌐 此指南由机器翻译生成。如需获取最准确的信息,请参阅 [English](../en/install.md) 或 [한국어](../ko/install.md) 版本。

PocketRisu 有四种安装方式。

- [1. 便携版](#1-便携版) — 预编译的二进制文件。无需 Node.js。
- [2. Docker](#2-docker) — 容器环境。
- [3. 安装脚本](#3-安装脚本) — 从源码自动构建。适用于 Linux/macOS 服务器。
- [4. Git Clone](#4-git-clone) — 手动源码构建。适用于开发者/高级用户。


## 系统要求

| 项目         | 最低                | 推荐                                |
| ------------ | ------------------- | ----------------------------------- |
| **CPU**      | 1 核                | 2 核及以上                          |
| **内存**     | 1 GB(仅运行)      | 4 GB 及以上(包含构建)             |
| **磁盘**     | 1 GB                | 2 GB 及以上                         |
| **Node.js**  | 22.12 及以上        | (便携版/Docker 不需要)             |

便携版和 Docker 无需构建步骤,可在 1 GB 内存下运行。直接构建(Git Clone、安装脚本)在构建时消耗大量内存,建议 4 GB 或更多。


---

## 1. 便携版

下载并运行预编译的二进制文件。无需 Node.js、Docker 或其他工具。支持 Windows、macOS(Apple Silicon)和 Linux(x64/ARM)。

### 下载

从 [Releases 页面](https://github.com/seto-sama/PocketRisu-Kei/releases)获取对应您 OS 的文件。

| OS                       | 文件                                      |
| ------------------------ | ----------------------------------------- |
| Windows (x64)            | `PocketRisu-vX.X.X-win-x64.zip`           |
| macOS (Apple Silicon)    | `PocketRisu-vX.X.X-macos-arm64.tar.gz`    |
| Linux (x64)              | `PocketRisu-vX.X.X-linux-x64.tar.gz`      |
| Linux (ARM)              | `PocketRisu-vX.X.X-linux-arm64.tar.gz`    |

### 运行

**Windows**

解压 zip 文件,双击文件夹中的 `PocketRisu.exe`。浏览器自动打开 `http://localhost:6001`。

**macOS**

```bash
tar -xzf PocketRisu-vX.X.X-macos-arm64.tar.gz
xattr -cr PocketRisu-vX.X.X-macos-arm64
open PocketRisu-vX.X.X-macos-arm64/PocketRisu.app
```

`xattr` 命令是绕过"无法验证 Apple"警告的一次性操作。

**Linux**

```bash
tar -xzf PocketRisu-vX.X.X-linux-*.tar.gz
cd PocketRisu-vX.X.X-linux-*
./start.sh
```

在浏览器中打开 `http://localhost:6001`。

### 无界面服务器(一行下载)

对于无 GUI 的 Linux/macOS 服务器,用一行命令获取并运行最新版本。

**Linux (x64):**

```bash
RELEASE_TAG=$(curl -s https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest | grep -o '"tag_name":[[:space:]]*"[^"]*"' | cut -d'"' -f4)
VERSION=${RELEASE_TAG#*v}
curl -fsSL "https://github.com/seto-sama/PocketRisu-Kei/releases/download/${RELEASE_TAG}/PocketRisu-v${VERSION}-linux-x64.tar.gz" -o pocketrisu.tar.gz
tar -xzf pocketrisu.tar.gz && rm pocketrisu.tar.gz
cd PocketRisu-v${VERSION}-linux-x64
./start.sh
```

**Linux (ARM):** 将上述命令中的 `linux-x64` 替换为 `linux-arm64`。

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

### 更新

在 Web UI 主屏幕的更新弹窗中点击"立即更新",或在安装文件夹中运行更新脚本。

- **Windows**: 双击 `update.bat`
- **macOS / Linux**: `./update.sh`

`save/` 文件夹中的数据会保留。


---

## 2. Docker

在已安装 Docker 或 Docker Desktop 的系统上运行。

### 安装 Docker

- **Windows / macOS**: 安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。
- **Linux**:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```

### 运行

```bash
curl -L https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

在浏览器中打开 `http://localhost:6001`。

### 更新

```bash
docker compose pull && docker compose up -d
```

### 数据位置

所有数据(聊天、角色等)存储在 Docker 卷 `risuai-save` 中。更新时数据保留。


---

## 3. 安装脚本

获取源码并通过 Node.js 自动构建。适用于 Linux/macOS 服务器。如需通过 `git pull` 管理更新,使用此方法。

### 前置条件

需要 Node.js 22.12 或更高版本:

```bash
node --version
# v22.12.0 或更高
```

如未安装,请从 [Node.js 官方网站](https://nodejs.org/)安装。

### 安装

```bash
curl -fsSL https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/install.sh | bash
```

安装完成后会显示状态消息。

### 启动服务器

```bash
cd ~/pocketrisu
pnpm runserver
```

在浏览器中打开 `http://localhost:6001`。

### 更新

```bash
cd ~/pocketrisu
./update.sh
```

> **v1.5.x → v1.6.0 一次性提示**: 如果您在 Risuai-NodeOnly 时代(v1.5.x 或更早)通过 `install.sh` 安装,请在首次 v1.6.0 更新前一次性将 `update.sh` 替换为新版本。(仓库已重命名为 PocketRisu,旧 `update.sh` 无法找到新的源目录。)
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/update.sh -o update.sh && chmod +x update.sh
> ./update.sh
> ```
>
> 此后更新照常使用 `./update.sh`。


---

## 4. Git Clone

手动克隆并构建源码。适用于需要修改或调试代码的开发者。

```bash
git clone https://github.com/seto-sama/PocketRisu-Kei.git
cd PocketRisu-Kei
pnpm install
pnpm build
pnpm runserver
```

在浏览器中打开 `http://localhost:6001`。

### 更新

```bash
git pull
pnpm install
pnpm build
# 重启服务器
pnpm runserver
```


---

← [返回 README](../../i18n/README.cn.md)
