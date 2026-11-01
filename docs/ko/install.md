<p align="center">
  <a href="../en/install.md">English</a> | <strong>한국어</strong> | <a href="../de/install.md">Deutsch</a> | <a href="../cn/install.md">简体中文</a> | <a href="../es/install.md">Español</a> | <a href="../vi/install.md">Tiếng Việt</a> | <a href="../zh-Hant/install.md">繁體中文</a>
</p>

# 설치 가이드

PocketRisu를 설치하는 방법은 두 가지가 있습니다.

- [1. Docker](#1-docker) — 컨테이너 환경.
- [2. Git Clone](#2-git-clone) — 소스를 받아 직접 빌드.


## 시스템 요구사항

| 항목        | 최소         | 권장                  |
| ----------- | ------------ | --------------------- |
| **CPU**     | 1코어        | 2코어 이상            |
| **RAM**     | 1GB (실행만) | 4GB 이상 (빌드 포함)  |
| **디스크**  | 1GB          | 2GB 이상              |
| **Node.js** | 24.22.1+ (24.x) / 26.12.1+ (26.x) | (Docker는 불필요) |

Docker는 빌드 과정이 없어 RAM 1GB로 동작합니다. 직접 빌드(Git Clone)할 경우 빌드 중 메모리 사용량이 높아 4GB 이상을 권장합니다.


---

## 1. Docker

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

## 2. Git Clone

소스 코드를 받아 직접 빌드합니다.

Node.js 24.x(24.22.1 이상) 또는 26.x(26.12.1 이상)가 필요합니다:

```bash
node --version
# v24.22.1 이상(24.x) 또는 v26.12.1 이상(26.x)
```

Node.js가 없다면 [Node.js 공식 사이트](https://nodejs.org/)에서 설치합니다.

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

### 디버그 로그

`pnpm runserver` 대신 `pnpm debug`로 실행하면 서버 진단과 브라우저 디버그 로그, 채팅 저장 상세 진단이 함께 켜집니다. 서버를 재시작한 뒤 브라우저도 새로고침하세요. 브라우저 개발자 도구에서 **Verbose(상세)** 콘솔 수준을 켜면 로그를 볼 수 있습니다. 디버그 메시지는 시스템 로그 DB에 저장되지 않습니다.

개발 모드는 `pnpm dev`, 디버그 로그도 보려면 `pnpm debug dev`로 실행하세요. 개발 모드만으로는 디버그 로그가 켜지지 않습니다.

디버그 명령들은 Node의 `NODE_DEBUG=pocketrisu` 설정을 켭니다. 빌드된 앱도 재빌드 없이 `NODE_DEBUG=pocketrisu pnpm runserver`로 로그를 켤 수 있습니다.

개발 패널은 별도로 유지됩니다. 브라우저 콘솔에서 다음을 실행하면 켜집니다.

```js
localStorage.setItem('risu-dev-panel', '1')
location.reload()
```

### 로컬 폰트

폰트 파일은 저장소에 포함하지 않습니다. 사용 권한이 있는 폰트를 직접 포함하려면:

1. `.woff2`, `.woff`, `.ttf`, `.otf` 파일을 `public/assets/fonts/`에 넣습니다.
2. `pnpm build`를 다시 실행합니다.
3. 폰트 설정에서 **Custom**을 선택하고 입력 추천 목록에서 감지된 family를 선택합니다. Weight variable 폰트라면 `SUIT Variable 700`처럼 뒤에 숫자 weight를 붙입니다.

Weight variable 폰트는 원본 family 이름과 파일에 포함된 weight 범위를 그대로 사용하므로 `SUIT Variable 475` 같은 중간값도 사용할 수 있습니다. Static 폰트라면 `Regular`, `Thin` 등의 접미사를 포함한 원본 family 이름을 선택합니다. `public/assets/fonts/` 아래의 폰트 파일은 Git에서 무시되며 해당 빌드 환경에만 남습니다.


---

← [README로 돌아가기](../../i18n/README.ko.md)
