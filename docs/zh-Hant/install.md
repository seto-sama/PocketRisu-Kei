<p align="center">
  <a href="../en/install.md">English</a> | <a href="../ko/install.md">한국어</a> | <a href="../de/install.md">Deutsch</a> | <a href="../cn/install.md">简体中文</a> | <a href="../es/install.md">Español</a> | <a href="../vi/install.md">Tiếng Việt</a> | <strong>繁體中文</strong>
</p>

# 安裝指南

> 🌐 此指南由機器翻譯生成。如需獲取最準確的資訊,請參閱 [English](../en/install.md) 或 [한국어](../ko/install.md) 版本。

PocketRisu 有兩種安裝方式。

- [1. Docker](#1-docker) — 容器環境。
- [2. Git Clone](#2-git-clone) — clone 原始碼並自行建構。


## 系統需求

| 項目         | 最低                   | 建議                              |
| ------------ | ---------------------- | --------------------------------- |
| **CPU**      | 1 核                   | 2 核以上                          |
| **記憶體**   | 1 GB(僅執行)         | 4 GB 以上(含建構)               |
| **磁碟**     | 1 GB                   | 2 GB 以上                         |
| **Node.js**  | 24.22.1+ (24.x) / 26.12.1+ (26.x) | (Docker 不需要)            |

Docker 不需建構步驟,可在 1 GB 記憶體下執行。直接建構(Git Clone)建構時記憶體用量高,建議 4 GB 或以上。


---

## 1. Docker

在已安裝 Docker 或 Docker Desktop 的系統上執行。

### 安裝 Docker

- **Windows / macOS**: 安裝 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。
- **Linux**:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```

### 執行

```bash
curl -L https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

在瀏覽器中開啟 `http://localhost:6001`。

### 更新

```bash
docker compose pull && docker compose up -d
```

### 資料位置

所有資料(對話、角色等)儲存在 Docker 卷 `risuai-save`。更新時資料保留。


---

## 2. Git Clone

clone 原始碼並自行建構。

需要 Node.js 24.x（24.22.1 或以上）或 26.x（26.12.1 或以上）:

```bash
node --version
# v24.22.1+（24.x）或 v26.12.1+（26.x）
```

若未安裝,請從 [Node.js 官方網站](https://nodejs.org/)安裝。

```bash
git clone https://github.com/seto-sama/PocketRisu-Kei.git
cd PocketRisu-Kei
pnpm install
pnpm build
pnpm runserver
```

在瀏覽器中開啟 `http://localhost:6001`。

### 更新

```bash
git pull
pnpm install
pnpm build
# 重啟伺服器
pnpm runserver
```


---

← [返回 README](../../i18n/README.zh-Hant.md)
