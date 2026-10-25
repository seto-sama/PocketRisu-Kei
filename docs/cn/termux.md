<p align="center">
  <a href="../en/termux.md">English</a> | <a href="../ko/termux.md">한국어</a> | <a href="../de/termux.md">Deutsch</a> | <strong>简体中文</strong> | <a href="../es/termux.md">Español</a> | <a href="../vi/termux.md">Tiếng Việt</a> | <a href="../zh-Hant/termux.md">繁體中文</a>
</p>

# Termux 安装指南

> 🌐 此指南由机器翻译生成。如需获取最准确的信息,请参阅 [English](../en/termux.md) 或 [한국어](../ko/termux.md) 版本。

本指南介绍如何通过 Termux 在 Android 手机上直接构建并运行 PocketRisu。预期使用方式是在同一台手机的浏览器中打开 `http://localhost:6001`。

- [1. 准备工作](#1-准备工作) — F-Droid Termux 与系统要求
- [2. 安装与构建](#2-安装与构建) — 单条命令完成
- [3. 运行与连接](#3-运行与连接) — 从手机浏览器打开
- [4. 保持运行](#4-保持运行) — 屏幕关闭时也保持运行
- [5. 更新](#5-更新) — 获取最新版本
- [6. 限制](#6-限制) — 在 Termux 上无法使用的功能


## 系统要求

| 项目         | 最低         | 推荐                    |
| ------------ | ------------ | ----------------------- |
| **Android**  | 7.0 (API 24) | 10 或更新版本           |
| **CPU**      | ARM64        | ARM64                   |
| **内存**     | 2 GB         | 4 GB 或以上             |
| **可用存储** | 2 GB         | 4 GB 或以上(含构建产物) |

PocketRisu 会在手机上本地构建应用,因此构建时间取决于手机性能。


---

## 1. 准备工作

### 使用 F-Droid 或 GitHub Releases 版本的 Termux

> ⚠️ **Play Store 版本的 Termux 无法使用。**
> Termux 维护者已于 2020 年停止更新 Play Store 版本,无法再安装 PocketRisu 所需的最新软件包(Node.js 24.22.1+ (24.x) / 26.12.1+ (26.x))。

请从以下任一来源安装 Termux:

- **F-Droid(推荐)**: https://f-droid.org/packages/com.termux/
- **GitHub Releases**: https://github.com/termux/termux-app/releases

如果已经安装了 Play Store 版本,请先卸载,然后从上述任一来源重新安装。


---

## 2. 安装与构建

打开 Termux 并执行以下单条命令:

```bash
pkg install -y git && \
  git clone https://github.com/seto-sama/PocketRisu-Kei.git && \
  cd PocketRisu-Kei && \
  bash scripts/termux/build.sh
```

该命令将自动完成:

1. 安装 `git`
2. 克隆 PocketRisu 仓库
3. 安装构建依赖(`nodejs-lts`、`python`、`make`、`clang`、`pnpm` 等)
4. `pnpm install` — JavaScript 依赖和可选的原生加速模块
5. `pnpm build` — 前端打包

构建完成后会显示:

```
Build OK. Start the server with:
  node server/server.cjs

Then open this address in the phone's own browser:
  http://localhost:6001
```


---

## 3. 运行与连接

从同一目录启动服务器:

```bash
node server/server.cjs
```

服务器启动日志出现后,在手机浏览器(Chrome、Firefox 等)中访问:

```
http://localhost:6001
```

PocketRisu UI 应当正常加载。浏览器自动将 `localhost` 视为安全上下文(secure context),因此剪贴板、`crypto.subtle` 等需要安全上下文的 API 均可正常工作。

使用 `Ctrl + C` 停止服务器。


---

## 4. 保持运行

为了在屏幕关闭或切换到其他应用时保持服务器运行,请启用 Termux 的唤醒锁:

```bash
termux-wake-lock
```

Termux 通知栏会显示唤醒锁指示,即使屏幕关闭服务器也会继续运行。

释放命令: `termux-wake-unlock`

> 内存压力下 Android 仍可能终止 Termux。为了长时间运行,请在手机的电池优化设置中将 Termux 排除在外。


---

## 5. 更新

先使用 `Ctrl + C` 停止正在运行的服务器,然后执行:

```bash
cd ~/PocketRisu-Kei && \
  git pull --ff-only && \
  GYP_DEFINES="android_ndk_path=''" pnpm install --frozen-lockfile && \
  NODE_OPTIONS="--max-old-space-size=2048" pnpm build
```

每一步只有在前一步成功后才会执行。如果 `git pull` 失败,命令会在安装依赖或构建前停止,不会重新构建旧源码。`pnpm install` 需要明确执行,不会作为 `pnpm build` 的一部分自动运行。每次更新都要运行它。`GYP_DEFINES` 是构建脚本使用的 Termux 设置,编译 `msgpackr-extract` 等原生模块时需要它。构建完成后,使用 `node server/server.cjs` 重新启动服务器。

### 如果 `git pull` 失败

检查本地更改:

```bash
cd ~/PocketRisu-Kei
git status
git diff
git diff --cached
```

如果要保留未提交的更改,请先提交,或在运行上面的更新命令前使用 `git stash push` 暂存。使用 stash 时,更新完成后用 `git stash pop` 恢复,并检查是否有冲突。如果出现 `Not possible to fast-forward`,请先解决本地分支的分歧; stash 无法解决不同的提交历史。


---

## 6. 限制

**Quick Tunnel(Cloudflare 自动隧道)在 Termux 上无法使用。** `cloudflared` 二进制文件与 Termux 的 DNS 和 TLS 环境不兼容。

PocketRisu 会自动检测 Termux 环境,在远程访问菜单中显示警告并隐藏启动按钮。


---

← [返回 README](../../i18n/README.cn.md)
