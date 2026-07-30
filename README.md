<p align="center">
  <img src="assets/pocketrisu-banner-1024.png" alt="PocketRisu Kei" width="900" />
</p>

<h1 align="center">PocketRisu Kei</h1>

<p align="center">
  A self-hosted AI roleplay chat frontend based on PocketRisu, extended with additional features and usability improvements
</p>

<p align="center">
  <strong>English</strong> | <a href="i18n/README.ko.md">한국어</a> | <a href="i18n/README.de.md">Deutsch</a> | <a href="i18n/README.cn.md">简体中文</a> | <a href="i18n/README.es.md">Español</a> | <a href="i18n/README.vi.md">Tiếng Việt</a> | <a href="i18n/README.zh-Hant.md">繁體中文</a>
</p>

> [!CAUTION]
> **This project is a nightly build.** Features and data structures may change without notice, and some functionality may not work correctly. Always create a backup before updating.

PocketRisu Kei is a personal modification based on [PocketRisu](https://github.com/PocketRisu/PocketRisu) `v1.8.1` / `63832a13`. It is not intended to be a stable release or to provide official support.

Project links: [Repository](https://github.com/seto-sama/PocketRisu-Kei) · [Releases](https://github.com/seto-sama/PocketRisu-Kei/releases) · [Issues](https://github.com/seto-sama/PocketRisu-Kei/issues)

## Changes from the original PocketRisu

- Refactored the package, workspace, TypeScript, Vite, and Vitest toolchain.
- Consolidated shared UI controls and settings wrappers.
- Added preset folders and sortable pickers.
- Organized prompt roles and preset behavior.
- Extended the model preset runtime and adapters.
- Added a `models.dev`-based model catalog.
- Reworked model preset and credential management.
- Consolidated the plugin and module tabs.
- Added support for plugin-provided models in model presets.
- Added HypaMemory management, manual summarization, and search.
- Added translation cache management and translation cancellation.
- Improved chat streaming and rendering stability.
- Improved partial message editing.
- Improved chat navigation, shortcuts, and mobile back behavior.
- Improved themes, chat text display, and styling controls.
- Reorganized image, TTS, and inlay settings.
- Reworked the character list and sidebar UI.
- Improved regex and lorebook editing.
- Added chat and folder filtering for remote access and multi-device synchronization.
- Added snapshots, automatic backups, and asset recovery.
- Added persistent request logs.
- Added usage tracking and cost estimation.
- Moved part of chat generation to the server.
- Consolidated UI and settings structures and removed legacy code paths.

## Key features

- Multiple AI providers, including OpenAI, Claude, Gemini, OpenRouter, and Ollama
- A self-hosted server accessible from PCs, tablets, and smartphones
- Unified SQLite storage for characters, chats, settings, and assets
- Server backup and restore, snapshots, and automatic backups
- Lorebooks, HypaMemoryV3, translation, regex scripts, and plugins
- Request logs, token usage tracking, and estimated costs
- TTS and embedded images, audio, and video in chats
- For other features, see [PocketRisu](https://github.com/PocketRisu/PocketRisu).

## Documentation

- [Installation guide](docs/en/install.md)
- [RisuAI migration guide](docs/en/migration.md)
- [Remote access guide](docs/en/remote.md)
- [Android Termux installation guide](docs/en/termux.md)

## RisuAI compatibility

PocketRisu Kei maintains compatibility with the RisuAI ecosystem. Existing RisuAI data, character cards, modules, lorebooks, presets, and backup files can be imported or exported. See the [migration guide](docs/en/migration.md) for details.

## License

[GPL-3.0](LICENSE)
