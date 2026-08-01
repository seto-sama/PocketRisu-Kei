<p align="center">
  <a href="../en/install.md">English</a> | <strong>한국어</strong> | <a href="../de/install.md">Deutsch</a> | <a href="../cn/install.md">简体中文</a> | <a href="../es/install.md">Español</a> | <a href="../vi/install.md">Tiếng Việt</a> | <a href="../zh-Hant/install.md">繁體中文</a>
</p>

# 설치 가이드

PocketRisu를 설치하는 방법은 네 가지가 있습니다.

- [1. 포터블 패키지](#1-포터블-패키지) — 미리 컴파일된 바이너리. Node.js 불필요.
- [2. Docker](#2-docker) — 컨테이너 환경.
- [3. 설치 스크립트](#3-설치-스크립트) — 소스에서 자동 빌드. Linux/macOS 서버용.
- [4. Git Clone](#4-git-clone) — 소스 직접 빌드. 개발자/고급 사용자용.


## 시스템 요구사항

| 항목        | 최소         | 권장                  |
| ----------- | ------------ | --------------------- |
| **CPU**     | 1코어        | 2코어 이상            |
| **RAM**     | 1GB (실행만) | 4GB 이상 (빌드 포함)  |
| **디스크**  | 1GB          | 2GB 이상              |
| **Node.js** | 22.12 이상   | (포터블/Docker는 불필요) |

포터블 패키지와 Docker는 빌드 과정이 없어 RAM 1GB로 동작합니다. 직접 빌드(Git Clone, 설치 스크립트)할 경우 빌드 중 메모리 사용량이 높아 4GB 이상을 권장합니다.


---

## 1. 포터블 패키지

미리 컴파일된 바이너리를 다운로드해 실행합니다. Node.js, Docker 등 추가 도구가 필요 없습니다. Windows, macOS(Apple Silicon), Linux(x64/ARM)를 지원합니다.

### 다운로드

[Releases 페이지](https://github.com/seto-sama/PocketRisu-Kei/releases)에서 OS에 맞는 파일을 받습니다.

| OS                      | 파일명                                    |
| ----------------------- | ----------------------------------------- |
| Windows (x64)           | `PocketRisu-vX.X.X-win-x64.zip`           |
| macOS (Apple Silicon)   | `PocketRisu-vX.X.X-macos-arm64.tar.gz`    |
| Linux (x64)             | `PocketRisu-vX.X.X-linux-x64.tar.gz`      |
| Linux (ARM)             | `PocketRisu-vX.X.X-linux-arm64.tar.gz`    |

### 실행

**Windows**

zip 파일의 압축을 풀고 폴더 안의 `PocketRisu.exe`를 더블클릭합니다. 브라우저가 자동으로 열리며 `http://localhost:6001`로 접속됩니다.

**macOS**

```bash
tar -xzf PocketRisu-vX.X.X-macos-arm64.tar.gz
xattr -cr PocketRisu-vX.X.X-macos-arm64
open PocketRisu-vX.X.X-macos-arm64/PocketRisu.app
```

`xattr` 명령은 "Apple에서 확인할 수 없습니다" 경고를 우회하기 위한 1회성 작업입니다.

**Linux**

```bash
tar -xzf PocketRisu-vX.X.X-linux-*.tar.gz
cd PocketRisu-vX.X.X-linux-*
./start.sh
```

브라우저에서 `http://localhost:6001`로 접속됩니다.

### 헤드리스 서버 (한 줄 다운로드)

GUI 없는 Linux/macOS 서버에서 최신 버전을 한 번에 받아 실행합니다.

**Linux (x64):**

```bash
RELEASE_TAG=$(curl -s https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest | grep -o '"tag_name":[[:space:]]*"[^"]*"' | cut -d'"' -f4)
VERSION=${RELEASE_TAG#*v}
curl -fsSL "https://github.com/seto-sama/PocketRisu-Kei/releases/download/${RELEASE_TAG}/PocketRisu-v${VERSION}-linux-x64.tar.gz" -o pocketrisu.tar.gz
tar -xzf pocketrisu.tar.gz && rm pocketrisu.tar.gz
cd PocketRisu-v${VERSION}-linux-x64
./start.sh
```

**Linux (ARM):** 위 명령에서 `linux-x64`를 `linux-arm64`로 교체.

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

### 업데이트

웹 UI 홈 화면의 업데이트 팝업에서 "지금 업데이트"를 클릭하거나, 설치 폴더에서 아래 스크립트를 실행합니다.

- **Windows**: `update.bat` 더블클릭
- **macOS / Linux**: `./update.sh`

`save/` 폴더의 데이터는 그대로 보존됩니다.


---

## 2. Docker

Docker / Docker Desktop이 설치된 환경에서 동작합니다.

### Docker 설치

- **Windows / macOS**: [Docker Desktop](https://www.docker.com/products/docker-desktop/) 다운로드 후 설치
- **Linux**:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```

### 실행

```bash
curl -L https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

브라우저에서 `http://localhost:6001`로 접속됩니다.

### 업데이트

```bash
docker compose pull && docker compose up -d
```

### 데이터 위치

채팅·캐릭터 등 모든 데이터는 Docker 볼륨(`risuai-save`)에 저장됩니다. 업데이트해도 데이터는 유지됩니다.


---

## 3. 설치 스크립트

소스 코드를 받아 Node.js로 자동 빌드하는 스크립트 방식입니다. Linux/macOS 서버에서 동작합니다. `git pull` 흐름으로 직접 관리하고 싶을 때 사용합니다.

### 사전 준비

Node.js 22.12 이상이 필요합니다:

```bash
node --version
# v22.12.0 이상
```

Node.js가 없다면 [Node.js 공식 사이트](https://nodejs.org/)에서 설치합니다.

### 설치

```bash
curl -fsSL https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/install.sh | bash
```

설치가 완료되면 안내 메시지가 표시됩니다.

### 서버 시작

```bash
cd ~/pocketrisu
pnpm runserver
```

브라우저에서 `http://localhost:6001`로 접속.

### 업데이트

```bash
cd ~/pocketrisu
./update.sh
```

> **v1.5.x → v1.6.0 1회성 안내**: Risuai-NodeOnly 시절(v1.5.x 이하)에 `install.sh`로 설치하셨다면, v1.6.0으로 첫 업데이트 전에 `update.sh`를 새 버전으로 한 번만 교체해주세요. (repo 이름이 PocketRisu로 바뀌어 옛 `update.sh`가 새 소스 디렉토리를 찾지 못합니다.)
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/update.sh -o update.sh && chmod +x update.sh
> ./update.sh
> ```
>
> 이후 업데이트부터는 평소대로 `./update.sh`만 실행하면 됩니다.


---

## 4. Git Clone

소스 코드를 직접 받아 단계별로 빌드합니다. 코드 수정·디버깅이 필요한 개발자용입니다.

```bash
git clone https://github.com/seto-sama/PocketRisu-Kei.git
cd PocketRisu-Kei
pnpm install
pnpm build
pnpm runserver
```

브라우저에서 `http://localhost:6001`로 접속.

### 업데이트

```bash
git pull
pnpm install
pnpm build
# 서버 재시작
pnpm runserver
```


---

← [README로 돌아가기](../../i18n/README.ko.md)
