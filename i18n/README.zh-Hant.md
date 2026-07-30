<p align="center">
  <img src="../assets/pocketrisu-banner-1024.png" alt="PocketRisu Kei" width="900" />
</p>

<h1 align="center">PocketRisu Kei</h1>

<p align="center">
  基於 PocketRisu，並擴充功能與易用性的自架 AI 角色扮演聊天前端
</p>

<p align="center">
  <a href="../README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.de.md">Deutsch</a> | <a href="README.cn.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.vi.md">Tiếng Việt</a> | <strong>繁體中文</strong>
</p>

> [!NOTE]
> 此 README 由機器翻譯產生。如需最準確的資訊，請參閱[英文](../README.md)或[韓文](README.ko.md)版本。

> [!CAUTION]
> **本專案為 nightly 建置。** 功能與資料結構可能在沒有預告的情況下變更，部分功能也可能無法正常運作。更新前請務必建立備份。

PocketRisu Kei 是基於 [PocketRisu](https://github.com/PocketRisu/PocketRisu) `v1.8.1` / `63832a13` 開始的個人修改版。本專案不以穩定版本或官方支援為目標。

專案連結：[程式碼儲存庫](https://github.com/seto-sama/PocketRisu-Kei) · [發行版本](https://github.com/seto-sama/PocketRisu-Kei/releases) · [問題回報](https://github.com/seto-sama/PocketRisu-Kei/issues)

## 相較於原版 PocketRisu 的變更

- 重構套件、工作區、TypeScript、Vite 與 Vitest 工具鏈。
- 整合共用 UI 控制項與設定包裝元件。
- 新增預設資料夾與可排序選擇器。
- 整理提示詞角色與預設行為。
- 擴充模型預設執行環境與轉接器。
- 新增以 `models.dev` 為基礎的模型目錄。
- 重新設計模型預設與驗證資訊管理。
- 整合外掛與模組分頁。
- 支援在模型預設中加入外掛提供的模型。
- 新增 HypaMemory 管理、手動摘要與搜尋。
- 新增翻譯快取管理與取消翻譯功能。
- 改善聊天串流與渲染穩定性。
- 改善訊息局部編輯方式。
- 改善聊天導覽、快速鍵與行動裝置返回行為。
- 改善主題、聊天文字顯示與樣式設定。
- 重新整理圖片、TTS 與嵌入內容設定。
- 重新設計角色列表與側邊欄 UI。
- 改善正規表示式與世界書編輯。
- 新增遠端存取時的聊天與資料夾篩選及多裝置同步。
- 新增快照、自動備份與資源復原。
- 新增持久化請求日誌。
- 新增用量記錄與費用估算。
- 將部分聊天生成流程移至伺服器端。
- 整合 UI 與設定結構，並清理舊版路徑。

## 主要功能

- 支援 OpenAI、Claude、Gemini、OpenRouter、Ollama 等多種 AI 提供者
- 可透過 PC、平板與智慧型手機使用的自架伺服器
- 使用 SQLite 統一儲存角色、聊天、設定與資源
- 伺服器備份與還原、快照及自動備份
- 世界書、HypaMemoryV3、翻譯、正規表示式腳本與外掛
- 請求日誌、Token 用量與預估費用
- TTS 及聊天內圖片、音訊與影片
- 其他功能請參閱 [PocketRisu](https://github.com/PocketRisu/PocketRisu)。

## 文件

- [安裝指南](../docs/zh-Hant/install.md)
- [RisuAI 遷移指南](../docs/zh-Hant/migration.md)
- [遠端存取指南](../docs/zh-Hant/remote.md)
- [Android Termux 安裝指南](../docs/zh-Hant/termux.md)

## RisuAI 相容性

PocketRisu Kei 維持與 RisuAI 生態系統的相容性。可以匯入或匯出既有的 RisuAI 資料、角色卡、模組、世界書、預設與備份檔案。詳情請參閱[遷移指南](../docs/zh-Hant/migration.md)。

## 授權條款

[GPL-3.0](../LICENSE)
