<p align="center">
  <a href="../en/install.md">English</a> | <a href="../ko/install.md">한국어</a> | <a href="../de/install.md">Deutsch</a> | <a href="../cn/install.md">简体中文</a> | <a href="../es/install.md">Español</a> | <strong>Tiếng Việt</strong> | <a href="../zh-Hant/install.md">繁體中文</a>
</p>

# Hướng dẫn cài đặt

> 🌐 Hướng dẫn này được dịch bằng máy. Để có thông tin chính xác nhất, vui lòng tham khảo phiên bản [tiếng Anh](../en/install.md) hoặc [tiếng Hàn](../ko/install.md).

PocketRisu có thể được cài đặt theo hai cách.

- [1. Docker](#1-docker) — Môi trường container.
- [2. Git Clone](#2-git-clone) — Clone và tự build mã nguồn.


## Yêu cầu hệ thống

| Mục          | Tối thiểu                | Khuyến nghị                              |
| ------------ | ------------------------ | ---------------------------------------- |
| **CPU**      | 1 nhân                   | 2+ nhân                                  |
| **RAM**      | 1 GB (chỉ chạy)          | 4+ GB (bao gồm build)                    |
| **Đĩa**      | 1 GB                     | 2+ GB                                    |
| **Node.js**  | 24.22.1+ (24.x) / 26.12.1+ (26.x) | (không cần cho Docker)          |

Docker không cần bước build và có thể chạy với 1 GB RAM. Build trực tiếp (Git Clone) tiêu tốn nhiều bộ nhớ khi build, vì vậy khuyến nghị 4 GB trở lên.


---

## 1. Docker

Chạy trên hệ thống có Docker hoặc Docker Desktop được cài đặt.

### Cài đặt Docker

- **Windows / macOS**: Cài đặt [Docker Desktop](https://www.docker.com/products/docker-desktop/).
- **Linux**:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```

### Chạy

```bash
curl -L https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

Mở `http://localhost:6001` trong trình duyệt.

### Cập nhật

```bash
docker compose pull && docker compose up -d
```

### Vị trí dữ liệu

Tất cả dữ liệu (cuộc trò chuyện, nhân vật, v.v.) được lưu trong Docker volume `risuai-save`. Dữ liệu được bảo toàn khi cập nhật.


---

## 2. Git Clone

Clone mã nguồn và tự build.

Cần Node.js 24.x (phiên bản 24.22.1 trở lên) hoặc 26.x (phiên bản 26.12.1 trở lên):

```bash
node --version
# v24.22.1+ (24.x) hoặc v26.12.1+ (26.x)
```

Cài đặt từ [trang chính thức của Node.js](https://nodejs.org/) nếu chưa có.

```bash
git clone https://github.com/seto-sama/PocketRisu-Kei.git
cd PocketRisu-Kei
pnpm install
pnpm build
pnpm runserver
```

Mở `http://localhost:6001` trong trình duyệt.

### Cập nhật

```bash
git pull
pnpm install
pnpm build
# Khởi động lại máy chủ
pnpm runserver
```


---

← [Quay lại README](../../i18n/README.vi.md)
