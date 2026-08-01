<p align="center">
  <a href="../en/install.md">English</a> | <a href="../ko/install.md">한국어</a> | <a href="../de/install.md">Deutsch</a> | <a href="../cn/install.md">简体中文</a> | <a href="../es/install.md">Español</a> | <strong>Tiếng Việt</strong> | <a href="../zh-Hant/install.md">繁體中文</a>
</p>

# Hướng dẫn cài đặt

> 🌐 Hướng dẫn này được dịch bằng máy. Để có thông tin chính xác nhất, vui lòng tham khảo phiên bản [tiếng Anh](../en/install.md) hoặc [tiếng Hàn](../ko/install.md).

PocketRisu có thể được cài đặt theo bốn cách.

- [1. Gói portable](#1-gói-portable) — Tệp nhị phân được biên dịch sẵn. Không cần Node.js.
- [2. Docker](#2-docker) — Môi trường container.
- [3. Script cài đặt](#3-script-cài-đặt) — Build tự động từ mã nguồn. Dành cho máy chủ Linux/macOS.
- [4. Git Clone](#4-git-clone) — Build mã nguồn thủ công. Dành cho nhà phát triển / người dùng nâng cao.


## Yêu cầu hệ thống

| Mục          | Tối thiểu                | Khuyến nghị                              |
| ------------ | ------------------------ | ---------------------------------------- |
| **CPU**      | 1 nhân                   | 2+ nhân                                  |
| **RAM**      | 1 GB (chỉ chạy)          | 4+ GB (bao gồm build)                    |
| **Đĩa**      | 1 GB                     | 2+ GB                                    |
| **Node.js**  | 22.12+                   | (không cần cho portable/Docker)          |

Gói portable và Docker không cần bước build và có thể chạy với 1 GB RAM. Build trực tiếp (Git Clone, script cài đặt) tiêu tốn nhiều bộ nhớ khi build, vì vậy khuyến nghị 4 GB trở lên.


---

## 1. Gói portable

Tải xuống và chạy tệp nhị phân được biên dịch sẵn. Không cần Node.js, Docker hay công cụ khác. Hỗ trợ Windows, macOS (Apple Silicon) và Linux (x64/ARM).

### Tải xuống

Lấy tệp cho OS của bạn từ [trang Releases](https://github.com/seto-sama/PocketRisu-Kei/releases).

| OS                       | Tệp                                       |
| ------------------------ | ----------------------------------------- |
| Windows (x64)            | `PocketRisu-vX.X.X-win-x64.zip`           |
| macOS (Apple Silicon)    | `PocketRisu-vX.X.X-macos-arm64.tar.gz`    |
| Linux (x64)              | `PocketRisu-vX.X.X-linux-x64.tar.gz`      |
| Linux (ARM)              | `PocketRisu-vX.X.X-linux-arm64.tar.gz`    |

### Chạy

**Windows**

Giải nén tệp zip và nhấp đúp vào `PocketRisu.exe`. Trình duyệt tự động mở tại `http://localhost:6001`.

**macOS**

```bash
tar -xzf PocketRisu-vX.X.X-macos-arm64.tar.gz
xattr -cr PocketRisu-vX.X.X-macos-arm64
open PocketRisu-vX.X.X-macos-arm64/PocketRisu.app
```

Lệnh `xattr` là thao tác một lần để bỏ qua cảnh báo "Apple không thể xác minh".

**Linux**

```bash
tar -xzf PocketRisu-vX.X.X-linux-*.tar.gz
cd PocketRisu-vX.X.X-linux-*
./start.sh
```

Mở `http://localhost:6001` trong trình duyệt.

### Máy chủ không GUI (tải xuống một dòng)

Đối với máy chủ Linux/macOS không có GUI, tải xuống và chạy phiên bản mới nhất bằng một lệnh.

**Linux (x64):**

```bash
RELEASE_TAG=$(curl -s https://api.github.com/repos/seto-sama/PocketRisu-Kei/releases/latest | grep -o '"tag_name":[[:space:]]*"[^"]*"' | cut -d'"' -f4)
VERSION=${RELEASE_TAG#*v}
curl -fsSL "https://github.com/seto-sama/PocketRisu-Kei/releases/download/${RELEASE_TAG}/PocketRisu-v${VERSION}-linux-x64.tar.gz" -o pocketrisu.tar.gz
tar -xzf pocketrisu.tar.gz && rm pocketrisu.tar.gz
cd PocketRisu-v${VERSION}-linux-x64
./start.sh
```

**Linux (ARM):** Thay `linux-x64` bằng `linux-arm64` trong lệnh trên.

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

### Cập nhật

Nhấp "Cập nhật ngay" trong popup cập nhật trên màn hình chính của giao diện web, hoặc chạy script cập nhật trong thư mục cài đặt.

- **Windows**: Nhấp đúp `update.bat`
- **macOS / Linux**: `./update.sh`

Dữ liệu trong thư mục `save/` được bảo toàn.


---

## 2. Docker

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

## 3. Script cài đặt

Lấy mã nguồn và build tự động với Node.js. Chạy trên máy chủ Linux/macOS. Sử dụng nếu bạn muốn quản lý cập nhật qua `git pull`.

### Điều kiện tiên quyết

Cần Node.js 22.12 trở lên:

```bash
node --version
# v22.12.0 trở lên
```

Cài đặt từ [trang chính thức của Node.js](https://nodejs.org/) nếu chưa có.

### Cài đặt

```bash
curl -fsSL https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/install.sh | bash
```

Thông báo trạng thái hiển thị khi cài đặt hoàn tất.

### Khởi động máy chủ

```bash
cd ~/pocketrisu
pnpm runserver
```

Mở `http://localhost:6001` trong trình duyệt.

### Cập nhật

```bash
cd ~/pocketrisu
./update.sh
```

> **Lưu ý một lần cho v1.5.x → v1.6.0**: Nếu bạn đã cài đặt qua `install.sh` trong thời kỳ Risuai-NodeOnly (v1.5.x trở về trước), hãy thay `update.sh` bằng phiên bản mới một lần trước lần cập nhật v1.6.0 đầu tiên. (Repository đã được đổi tên thành PocketRisu và `update.sh` cũ không thể tìm thấy thư mục mã nguồn mới.)
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/seto-sama/PocketRisu-Kei/main/update.sh -o update.sh && chmod +x update.sh
> ./update.sh
> ```
>
> Các cập nhật tiếp theo chạy bằng `./update.sh` như thường lệ.


---

## 4. Git Clone

Clone và build mã nguồn thủ công. Dành cho nhà phát triển cần sửa đổi hoặc gỡ lỗi mã.

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
