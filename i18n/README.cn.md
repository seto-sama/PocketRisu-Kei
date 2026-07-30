<p align="center">
  <img src="../assets/pocketrisu-banner-1024.png" alt="PocketRisu Kei" width="900" />
</p>

<h1 align="center">PocketRisu Kei</h1>

<p align="center">
  基于 PocketRisu，并扩展了功能与易用性的自托管 AI 角色扮演聊天前端
</p>

<p align="center">
  <a href="../README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.de.md">Deutsch</a> | <strong>简体中文</strong> | <a href="README.es.md">Español</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-Hant.md">繁體中文</a>
</p>

> [!NOTE]
> 此 README 由机器翻译生成。如需最准确的信息，请参阅[英文](../README.md)或[韩文](README.ko.md)版本。

> [!CAUTION]
> **本项目为 nightly 构建。** 功能和数据结构可能会在没有预告的情况下发生变化，部分功能也可能无法正常工作。更新前请务必创建备份。

PocketRisu Kei 是基于 [PocketRisu](https://github.com/PocketRisu/PocketRisu) `v1.8.1` / `63832a13` 开始的个人修改版。本项目不以稳定版本或官方支持为目标。

项目链接：[代码仓库](https://github.com/seto-sama/PocketRisu-Kei) · [发布版本](https://github.com/seto-sama/PocketRisu-Kei/releases) · [问题反馈](https://github.com/seto-sama/PocketRisu-Kei/issues)

## 相比原版 PocketRisu 的变更

- 重构了包、工作区、TypeScript、Vite 和 Vitest 工具链。
- 合并了通用 UI 控件与设置包装组件。
- 添加了预设文件夹与可排序选择器。
- 整理了提示词角色与预设行为。
- 扩展了模型预设运行时与适配器。
- 添加了基于 `models.dev` 的模型目录。
- 重新设计了模型预设与认证信息管理。
- 合并了插件与模块标签页。
- 支持在模型预设中添加插件提供的模型。
- 添加了 HypaMemory 管理、手动摘要与搜索。
- 添加了翻译缓存管理与取消翻译功能。
- 改进了聊天流式传输与渲染稳定性。
- 改进了消息局部编辑方式。
- 改进了聊天导航、快捷键与移动端返回行为。
- 改进了主题、聊天文本显示与样式设置。
- 重新整理了图片、TTS 与嵌入内容设置。
- 重新设计了角色列表与侧边栏 UI。
- 改进了正则表达式与世界书编辑。
- 添加了远程访问时的聊天和文件夹过滤及多设备同步。
- 添加了快照、自动备份与资源恢复。
- 添加了持久化请求日志。
- 添加了用量记录与费用估算。
- 将部分聊天生成流程迁移到服务器端。
- 统一了 UI 与设置结构，并清理了旧版路径。

## 主要功能

- 支持 OpenAI、Claude、Gemini、OpenRouter、Ollama 等多种 AI 提供商
- 可通过 PC、平板和智能手机使用的自托管服务器
- 使用 SQLite 统一存储角色、聊天、设置与资源
- 服务器备份与恢复、快照及自动备份
- 世界书、HypaMemoryV3、翻译、正则脚本与插件
- 请求日志、Token 用量与预估费用
- TTS 及聊天内图片、音频与视频
- 其他功能请参阅 [PocketRisu](https://github.com/PocketRisu/PocketRisu)。

## 文档

- [安装指南](../docs/cn/install.md)
- [RisuAI 迁移指南](../docs/cn/migration.md)
- [远程访问指南](../docs/cn/remote.md)
- [Android Termux 安装指南](../docs/cn/termux.md)

## RisuAI 兼容性

PocketRisu Kei 保持与 RisuAI 生态系统的兼容性。可以导入或导出现有的 RisuAI 数据、角色卡、模块、世界书、预设和备份文件。详情请参阅[迁移指南](../docs/cn/migration.md)。

## 许可证

[GPL-3.0](../LICENSE)
