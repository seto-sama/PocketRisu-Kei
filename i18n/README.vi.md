<p align="center">
  <img src="../assets/pocketrisu-banner-1024.png" alt="PocketRisu Kei" width="900" />
</p>

<h1 align="center">PocketRisu Kei</h1>

<p align="center">
  Giao diện trò chuyện nhập vai AI tự lưu trữ dựa trên PocketRisu, được mở rộng với nhiều tính năng và cải tiến khả năng sử dụng
</p>

<p align="center">
  <a href="../README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.de.md">Deutsch</a> | <a href="README.cn.md">简体中文</a> | <a href="README.es.md">Español</a> | <strong>Tiếng Việt</strong> | <a href="README.zh-Hant.md">繁體中文</a>
</p>

> [!NOTE]
> README này được dịch bằng máy. Để có thông tin chính xác nhất, vui lòng xem phiên bản [tiếng Anh](../README.md) hoặc [tiếng Hàn](README.ko.md).

> [!CAUTION]
> **Dự án này là bản dựng nightly.** Các tính năng và cấu trúc dữ liệu có thể thay đổi mà không báo trước, và một số chức năng có thể không hoạt động đúng. Hãy luôn tạo bản sao lưu trước khi cập nhật.

PocketRisu Kei là một bản sửa đổi cá nhân dựa trên [PocketRisu](https://github.com/PocketRisu/PocketRisu) `v1.8.1` / `63832a13`. Dự án không hướng tới một bản phát hành ổn định và không cung cấp hỗ trợ chính thức.

Liên kết dự án: [Kho mã nguồn](https://github.com/seto-sama/PocketRisu-Kei) · [Bản phát hành](https://github.com/seto-sama/PocketRisu-Kei/releases) · [Vấn đề](https://github.com/seto-sama/PocketRisu-Kei/issues)

## Thay đổi so với PocketRisu gốc

- Tái cấu trúc bộ công cụ package, workspace, TypeScript, Vite và Vitest.
- Hợp nhất các điều khiển UI dùng chung và lớp bao cài đặt.
- Thêm thư mục preset và bộ chọn có thể sắp xếp.
- Sắp xếp lại vai trò prompt và hành vi preset.
- Mở rộng runtime và adapter cho preset mô hình.
- Thêm danh mục mô hình dựa trên `models.dev`.
- Thiết kế lại phần quản lý preset mô hình và thông tin xác thực.
- Hợp nhất các tab plugin và module.
- Hỗ trợ mô hình do plugin cung cấp trong preset mô hình.
- Thêm quản lý HypaMemory, tóm tắt thủ công và tìm kiếm.
- Thêm quản lý bộ nhớ đệm dịch và hủy tác vụ dịch.
- Cải thiện độ ổn định khi stream và render trò chuyện.
- Cải thiện cách chỉnh sửa một phần tin nhắn.
- Cải thiện điều hướng trò chuyện, phím tắt và thao tác quay lại trên thiết bị di động.
- Cải thiện giao diện, hiển thị văn bản trò chuyện và tùy chọn kiểu.
- Sắp xếp lại cài đặt hình ảnh, TTS và inlay.
- Thiết kế lại danh sách nhân vật và UI thanh bên.
- Cải thiện chỉnh sửa biểu thức chính quy và lorebook.
- Thêm lọc trò chuyện, thư mục khi truy cập từ xa và đồng bộ nhiều thiết bị.
- Thêm snapshot, sao lưu tự động và khôi phục tài nguyên.
- Thêm nhật ký yêu cầu được lưu lâu dài.
- Thêm ghi nhận mức sử dụng và ước tính chi phí.
- Chuyển một phần quá trình tạo trò chuyện sang máy chủ.
- Hợp nhất cấu trúc UI và cài đặt, đồng thời dọn dẹp các đường dẫn cũ.

## Tính năng chính

- Nhiều nhà cung cấp AI, gồm OpenAI, Claude, Gemini, OpenRouter và Ollama
- Máy chủ tự lưu trữ có thể truy cập từ PC, máy tính bảng và điện thoại thông minh
- Lưu trữ SQLite thống nhất cho nhân vật, cuộc trò chuyện, cài đặt và tài nguyên
- Sao lưu và khôi phục phía máy chủ, snapshot và sao lưu tự động
- Lorebook, HypaMemoryV3, dịch thuật, script regex và plugin
- Nhật ký yêu cầu, mức sử dụng token và chi phí ước tính
- TTS cùng hình ảnh, âm thanh và video trong trò chuyện
- Với các tính năng khác, xem [PocketRisu](https://github.com/PocketRisu/PocketRisu).

## Tài liệu

- [Hướng dẫn cài đặt](../docs/vi/install.md)
- [Hướng dẫn di chuyển từ RisuAI](../docs/vi/migration.md)
- [Hướng dẫn truy cập từ xa](../docs/vi/remote.md)
- [Hướng dẫn cài đặt Termux trên Android](../docs/vi/termux.md)

## Tương thích với RisuAI

PocketRisu Kei duy trì khả năng tương thích với hệ sinh thái RisuAI. Có thể nhập hoặc xuất dữ liệu RisuAI hiện có, thẻ nhân vật, module, lorebook, preset và tệp sao lưu. Xem [hướng dẫn di chuyển](../docs/vi/migration.md) để biết chi tiết.

## Giấy phép

[GPL-3.0](../LICENSE)
