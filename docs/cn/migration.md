<p align="center">
  <a href="../en/migration.md">English</a> | <a href="../ko/migration.md">한국어</a> | <a href="../de/migration.md">Deutsch</a> | <strong>简体中文</strong> | <a href="../es/migration.md">Español</a> | <a href="../vi/migration.md">Tiếng Việt</a> | <a href="../zh-Hant/migration.md">繁體中文</a>
</p>

# RisuAI 迁移指南

> 🌐 此指南由机器翻译生成。如需获取最准确的信息,请参阅 [English](../en/migration.md) 或 [한국어](../ko/migration.md) 版本。

从现有 RisuAI 安装(Web RisuAI、本地 RisuAI)迁移数据到 PocketRisu 有两种方式。根据您的源环境和数据规模选择。

- [1. 本地备份文件(.bin)](#1-本地备份文件bin) — 在所有环境中工作。最常用的方法。
- [2. Save 文件夹直接复制](#2-save-文件夹直接复制) — 本地 RisuAI,大规模数据。


## 开始之前

> ⚠️ 迁移前**请备份现有数据**。可从 RisuAI 的 设置 > 备份 导出 `.bin` 文件。


---

## 1. 本地备份文件(.bin)

从现有 RisuAI 导出 `.bin` 备份文件,然后导入 PocketRisu。无论源环境(web / Capacitor / 本地)如何均可使用。

1. **在现有 RisuAI 中**: 设置 > 备份 > "保存本地备份" 导出 `.bin` 文件。
2. **在 PocketRisu 中**: 设置 > 数据迁移 > "导入原版 Risu 本地备份" 导入 `.bin` 文件。


---

## 2. Save 文件夹直接复制

适合大规模数据(数 GB 以上)。需要服务器文件系统的直接访问权限。

1. 停止 PocketRisu 服务器。
2. 用现有 RisuAI 的 `save` 文件夹整体覆盖 PocketRisu 的 `save` 文件夹。
3. 重启 PocketRisu 服务器 — 自动迁移开始。
    - 可在终端或 PM2 日志中查看进度。
4. 确认迁移成功后，可根据需要手动归档或删除原始 hex 文件。


---

## 该选择哪种方式?

| 情况                                              | 推荐方式                        |
| ------------------------------------------------- | ------------------------------- |
| 从 Web RisuAI 迁移                                | 1. `.bin` 备份                  |
| 从本地 RisuAI 迁移,数据大规模(10GB+)            | 2. Save 文件夹直接复制          |
| 不确定                                            | 1. `.bin` 备份                  |


---

← [返回 README](../../i18n/README.cn.md)
