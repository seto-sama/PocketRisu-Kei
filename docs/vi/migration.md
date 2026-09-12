<p align="center">
  <a href="../en/migration.md">English</a> | <a href="../ko/migration.md">한국어</a> | <a href="../de/migration.md">Deutsch</a> | <a href="../cn/migration.md">简体中文</a> | <a href="../es/migration.md">Español</a> | <strong>Tiếng Việt</strong> | <a href="../zh-Hant/migration.md">繁體中文</a>
</p>

# Hướng dẫn di chuyển từ RisuAI

> 🌐 Hướng dẫn này được dịch bằng máy. Để có thông tin chính xác nhất, vui lòng tham khảo phiên bản [tiếng Anh](../en/migration.md) hoặc [tiếng Hàn](../ko/migration.md).

Có hai cách để di chuyển dữ liệu từ cài đặt RisuAI hiện có (RisuAI Web, RisuAI Cục bộ) sang PocketRisu. Chọn dựa trên môi trường nguồn và kích thước dữ liệu của bạn.

- [1. Tệp sao lưu cục bộ (.bin)](#1-tệp-sao-lưu-cục-bộ-bin) — Hoạt động trong mọi môi trường. Phương pháp phổ biến nhất.
- [2. Sao chép trực tiếp thư mục save](#2-sao-chép-trực-tiếp-thư-mục-save) — RisuAI Cục bộ, dữ liệu lớn.


## Trước khi bắt đầu

> ⚠️ **Sao lưu dữ liệu hiện có** trước khi di chuyển. Bạn có thể xuất tệp `.bin` từ Cài đặt > Sao lưu của RisuAI.


---

## 1. Tệp sao lưu cục bộ (.bin)

Xuất tệp sao lưu `.bin` từ RisuAI hiện có, sau đó nhập vào PocketRisu. Hoạt động bất kể môi trường nguồn (web / Capacitor / cục bộ).

1. **Trong RisuAI hiện có**: Cài đặt > Sao lưu > "Lưu bản sao lưu cục bộ" để xuất tệp `.bin`.
2. **Trong PocketRisu**: Cài đặt > Di chuyển dữ liệu > "Nhập bản sao lưu cục bộ Risu gốc" để nhập tệp `.bin`.


---

## 2. Sao chép trực tiếp thư mục save

Phù hợp cho dữ liệu lớn (vài GB trở lên). Yêu cầu quyền truy cập trực tiếp hệ thống tệp của máy chủ.

1. Dừng máy chủ PocketRisu.
2. Ghi đè thư mục `save` của PocketRisu bằng thư mục `save` của RisuAI hiện có.
3. Khởi động lại máy chủ PocketRisu — quá trình di chuyển tự động bắt đầu.
    - Theo dõi tiến trình trong terminal hoặc nhật ký PM2.
4. Sau khi xác minh di chuyển thành công, hãy tự lưu trữ hoặc xóa các tệp hex gốc nếu cần.


---

## Tôi nên chọn phương pháp nào?

| Tình huống                                                | Phương pháp được đề xuất             |
| --------------------------------------------------------- | ------------------------------------ |
| Di chuyển từ RisuAI Web                                   | 1. Sao lưu `.bin`                    |
| Di chuyển từ RisuAI Cục bộ, dữ liệu lớn (10GB+)           | 2. Sao chép trực tiếp thư mục save   |
| Không chắc                                                | 1. Sao lưu `.bin`                    |


---

← [Quay lại README](../../i18n/README.vi.md)
