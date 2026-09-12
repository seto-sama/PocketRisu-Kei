<p align="center">
  <a href="../en/migration.md">English</a> | <a href="../ko/migration.md">한국어</a> | <a href="../de/migration.md">Deutsch</a> | <a href="../cn/migration.md">简体中文</a> | <a href="../es/migration.md">Español</a> | <a href="../vi/migration.md">Tiếng Việt</a> | <strong>繁體中文</strong>
</p>

# RisuAI 遷移指南

> 🌐 此指南由機器翻譯生成。如需獲取最準確的資訊,請參閱 [English](../en/migration.md) 或 [한국어](../ko/migration.md) 版本。

從現有 RisuAI 安裝(Web RisuAI、本地 RisuAI)遷移資料到 PocketRisu 有兩種方式。根據您的來源環境和資料規模選擇。

- [1. 本地備份檔案(.bin)](#1-本地備份檔案bin) — 在所有環境中可用。最常見的方法。
- [2. Save 資料夾直接複製](#2-save-資料夾直接複製) — 本地 RisuAI,大規模資料。


## 開始之前

> ⚠️ 遷移前**請備份現有資料**。可從 RisuAI 的 設定 > 備份 匯出 `.bin` 檔案。


---

## 1. 本地備份檔案(.bin)

從現有 RisuAI 匯出 `.bin` 備份檔案,然後匯入 PocketRisu。無論來源環境(web / Capacitor / 本地)如何均可使用。

1. **在現有 RisuAI 中**: 設定 > 備份 > "儲存本地備份" 匯出 `.bin` 檔案。
2. **在 PocketRisu 中**: 設定 > 資料遷移 > "匯入原版 Risu 本地備份" 匯入 `.bin` 檔案。


---

## 2. Save 資料夾直接複製

適合大規模資料(數 GB 以上)。需要伺服器檔案系統的直接存取權限。

1. 停止 PocketRisu 伺服器。
2. 用現有 RisuAI 的 `save` 資料夾整體覆蓋 PocketRisu 的 `save` 資料夾。
3. 重啟 PocketRisu 伺服器 — 自動遷移開始。
    - 可在終端機或 PM2 日誌中檢視進度。
4. 確認遷移成功後，可視需要手動封存或刪除原始 hex 檔案。


---

## 我該選擇哪種方式?

| 情況                                              | 推薦方式                          |
| ------------------------------------------------- | --------------------------------- |
| 從 Web RisuAI 遷移                                | 1. `.bin` 備份                    |
| 從本地 RisuAI 遷移,資料大規模(10GB+)            | 2. Save 資料夾直接複製            |
| 不確定                                            | 1. `.bin` 備份                    |


---

← [返回 README](../../i18n/README.zh-Hant.md)
