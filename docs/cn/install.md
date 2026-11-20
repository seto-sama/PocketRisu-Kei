<p align="center">
  <a href="../en/install.md">English</a> | <a href="../ko/install.md">한국어</a> | <a href="../de/install.md">Deutsch</a> | <strong>简体中文</strong> | <a href="../es/install.md">Español</a> | <a href="../vi/install.md">Tiếng Việt</a> | <a href="../zh-Hant/install.md">繁體中文</a>
</p>

# 安装指南

> 🌐 此指南由机器翻译生成。如需获取最准确的信息,请参阅 [English](../en/install.md) 或 [한국어](../ko/install.md) 版本。

PocketRisu 有两种安装方式。

- [1. Docker](#1-docker) — 容器环境。
- [2. Git Clone](#2-git-clone) — 克隆源码并自行构建。


## 系统要求

| 项目         | 最低                | 推荐                                |
| ------------ | ------------------- | ----------------------------------- |
| **CPU**      | 1 核                | 2 核及以上                          |
| **内存**     | 1 GB(仅运行)      | 4 GB 及以上(包含构建)             |
| **磁盘**     | 1 GB                | 2 GB 及以上                         |
| **Node.js**  | 24.22.1+ (24.x) / 26.12.1+ (26.x) | (Docker 不需要)             |

Docker 无需构建步骤,可在 1 GB 内存下运行。直接构建(Git Clone)在构建时消耗大量内存,建议 4 GB 或更多。


---

## 1. Docker

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

## 2. Git Clone

克隆源码并自行构建。

需要 Node.js 24.x（24.22.1 或更高版本）或 26.x（26.12.1 或更高版本）:

```bash
node --version
# v24.22.1 或更高版本（24.x），或 v26.12.1 或更高版本（26.x）
```

如未安装,请从 [Node.js 官方网站](https://nodejs.org/)安装。

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
