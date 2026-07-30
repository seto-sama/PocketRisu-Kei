<p align="center">
  <a href="../en/install.md">English</a> | <a href="../ko/install.md">한국어</a> | <a href="../de/install.md">Deutsch</a> | <a href="../cn/install.md">简体中文</a> | <a href="../es/install.md">Español</a> | <a href="../vi/install.md">Tiếng Việt</a> | <strong>繁體中文</strong>
</p>

# 安裝指南

> 🌐 此指南由機器翻譯生成。如需獲取最準確的資訊,請參閱 [English](../en/install.md) 或 [한국어](../ko/install.md) 版本。

PocketRisu 有四種安裝方式。

- [1. 可攜版](#1-可攜版) — 預先編譯的二進位檔案。無需 Node.js。
- [2. Docker](#2-docker) — 容器環境。
- [3. 安裝指令碼](#3-安裝指令碼) — 從原始碼自動建構。適用於 Linux/macOS 伺服器。
- [4. Git Clone](#4-git-clone) — 手動原始碼建構。適用於開發者/進階使用者。


## 系統需求

| 項目         | 最低                   | 建議                              |
| ------------ | ---------------------- | --------------------------------- |
| **CPU**      | 1 核                   | 2 核以上                          |
| **記憶體**   | 1 GB(僅執行)         | 4 GB 以上(含建構)               |
| **磁碟**     | 1 GB                   | 2 GB 以上                         |
| **Node.js**  | 22.12 以上             | (可攜版/Docker 不需要)            |

可攜版和 Docker 不需建構步驟,可在 1 GB 記憶體下執行。直接建構(Git Clone、安裝指令碼)建構時記憶體用量高,建議 4 GB 或以上。


---

## 1. 可攜版

下載並執行預先編譯的二進位檔案。無需 Node.js、Docker 或其他工具。支援 Windows、macOS(Apple Silicon)和 Linux(x64/ARM)。

### 下載

從 [Releases 頁面](https://github.com/seto-sama/PocketRisu-Kei/releases)取得對應您 OS 的檔案。

| OS                       | 檔案                                      |
| ------------------------ | ----------------------------------------- |
| Windows (x64)            | `PocketRisu-vX.X.X-win-x64.zip`           |
| macOS (Apple Silicon)    | `PocketRisu-vX.X.X-macos-arm64.tar.gz`    |
| Linux (x64)              | `PocketRisu-vX.X.X-linux-x64.tar.gz`      |
| Linux (ARM)              | `PocketRisu-vX.X.X-linux-arm64.tar.gz`    |

### 執行

**Windows**

解壓縮 zip,雙擊資料夾中的 `PocketRisu.exe`。瀏覽器自動開啟 `http://localhost:6001`。

**macOS**

```bash
tar -xzf PocketRisu-vX.X.X-macos-arm64.tar.gz
xattr -cr PocketRisu-vX.X.X-macos-arm64
open PocketRisu-vX.X.X-macos-arm64/PocketRisu.app
```

`xattr` 命令是繞過「Apple 無法驗證」警告的一次性操作。

**Linux**

```bash
tar -xzf PocketRisu-vX.X.X-linux-*.tar.gz
cd PocketRisu-vX.X.X-linux-*
./start.sh
```

在瀏覽器中開啟 `http://localhost:6001`。

### 無介面伺服器(一行下載)

對於無 GUI 的 Linux/macOS 伺服器,用一行命令取得並執行最新版本。

**Linux (x64):**

```bash
VERSION=$(curl -s https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest | grep -o '"tag_name":"[^"]*"' | cut -d'"' -f4)
curl -fsSL "https://github.com/seto-sama/PocketRisu-Kei/releases/download/${VERSION}/PocketRisu-${VERSION}-linux-x64.tar.gz" -o pocketrisu.tar.gz
tar -xzf pocketrisu.tar.gz && rm pocketrisu.tar.gz
cd PocketRisu-${VERSION}-linux-x64
./start.sh
```

**Linux (ARM):** 將上述命令中的 `linux-x64` 替換為 `linux-arm64`。

**macOS (Apple Silicon):**

```bash
VERSION=$(curl -s https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest | grep -o '"tag_name":"[^"]*"' | cut -d'"' -f4)
curl -fsSL "https://github.com/seto-sama/PocketRisu-Kei/releases/download/${VERSION}/PocketRisu-${VERSION}-macos-arm64.tar.gz" -o pocketrisu.tar.gz
tar -xzf pocketrisu.tar.gz && rm pocketrisu.tar.gz
xattr -cr PocketRisu-${VERSION}-macos-arm64
cd PocketRisu-${VERSION}-macos-arm64
./start.sh
```

### 更新

在 Web UI 主畫面的更新彈窗點選「立即更新」,或在安裝資料夾執行更新指令碼。

- **Windows**: 雙擊 `update.bat`
- **macOS / Linux**: `./update.sh`

`save/` 資料夾中的資料會保留。


---

## 2. Docker

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

## 3. 安裝指令碼

取得原始碼並透過 Node.js 自動建構。執行於 Linux/macOS 伺服器。若要透過 `git pull` 管理更新時使用。

### 前置需求

需要 Node.js 22.12 或以上:

```bash
node --version
# v22.12.0 或以上
```

若未安裝,請從 [Node.js 官方網站](https://nodejs.org/)安裝。

### 安裝

```bash
curl -fsSL https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/install.sh | bash
```

安裝完成後會顯示狀態訊息。

### 啟動伺服器

```bash
cd ~/pocketrisu
pnpm runserver
```

在瀏覽器中開啟 `http://localhost:6001`。

### 更新

```bash
cd ~/pocketrisu
./update.sh
```

> **v1.5.x → v1.6.0 一次性提示**: 若您在 Risuai-NodeOnly 時代(v1.5.x 或更早)透過 `install.sh` 安裝,請在首次 v1.6.0 更新前一次性將 `update.sh` 替換為新版本。(儲存庫已重新命名為 PocketRisu,舊 `update.sh` 無法找到新的原始目錄。)
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/update.sh -o update.sh && chmod +x update.sh
> ./update.sh
> ```
>
> 此後更新照常使用 `./update.sh`。


---

## 4. Git Clone

手動 clone 並建構原始碼。適用於需要修改或除錯程式碼的開發者。

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
