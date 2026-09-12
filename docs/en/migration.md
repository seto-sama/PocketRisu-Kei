<p align="center">
  <strong>English</strong> | <a href="../ko/migration.md">한국어</a> | <a href="../de/migration.md">Deutsch</a> | <a href="../cn/migration.md">简体中文</a> | <a href="../es/migration.md">Español</a> | <a href="../vi/migration.md">Tiếng Việt</a> | <a href="../zh-Hant/migration.md">繁體中文</a>
</p>

# RisuAI Migration Guide

There are two ways to migrate data from an existing RisuAI installation (Web RisuAI, Local RisuAI) to PocketRisu. Choose based on your source environment and data size.

- [1. Local Backup File (.bin)](#1-local-backup-file-bin) — Works in all environments. The most common method.
- [2. Save Folder Direct Copy](#2-save-folder-direct-copy) — Local RisuAI, large datasets.


## Before You Start

> ⚠️ **Back up your existing data** before migrating. You can export a `.bin` file from RisuAI's Settings > Backup.


---

## 1. Local Backup File (.bin)

Export a `.bin` backup file from existing RisuAI, then import it into PocketRisu. Works regardless of the source environment (web / Capacitor / local).

1. **In existing RisuAI**: Settings > Backup > "Save Local Backup" to export a `.bin` file.
2. **In PocketRisu**: Settings > Data Migration > "Import Original Risu Local Backup" to import the `.bin` file.


---

## 2. Save Folder Direct Copy

Suitable for large datasets (several GB or more). Requires direct filesystem access to the server.

1. Stop the PocketRisu server.
2. Overwrite PocketRisu's `save` folder with the existing RisuAI's `save` folder.
3. Restart the PocketRisu server — automatic migration begins.
    - Monitor progress in the terminal or PM2 logs.
4. After verifying the migration, archive or delete the original hex-named files manually if desired.


---

## Which Method Should I Choose?

| Situation                                            | Recommended Method                |
| ---------------------------------------------------- | --------------------------------- |
| Migrating from Web RisuAI                            | 1. `.bin` backup                  |
| Migrating from Local RisuAI, large data (10GB+)      | 2. Save folder direct copy        |
| Not sure                                             | 1. `.bin` backup                  |


---

← [Back to README](../../README.md)
