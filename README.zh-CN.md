# DeepSeek Chat BYOK

[![Latest Release](https://img.shields.io/github/v/release/kamanager2012/deepseek-chat-byok?label=Release)](https://github.com/kamanager2012/deepseek-chat-byok/releases/latest)
[![Live Web / PWA](https://img.shields.io/badge/Web%20%2F%20PWA-在线体验-4d6bfe)](https://kamanager2012.github.io/deepseek-chat-byok/)
[![CI](https://github.com/kamanager2012/deepseek-chat-byok/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/deepseek-chat-byok/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | 简体中文

> **DeepSeek Chat BYOK 是一个独立、免费、开源的 DeepSeek 聊天客户端，支持导入官方导出的聊天记录、本地记忆卡和自带 API Key 对话。它不是 DeepSeek 官方产品，也不是 Harness 插件集合。**（基于 MIT 协议从 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo) 独立扩展，面向习惯直接使用 DeepSeek 网页或 App 的日常对话与写作用户。）

关键词：DeepSeek 聊天记录迁移 · DeepSeek 聊天记录导入 · DeepSeek 本地聊天客户端 · 免费开源 · 自带密钥（BYOK）

- **新手入口与本站校验下载（推荐，免翻 GitHub 仓库）**：https://kamanager2012.github.io/deepseek-chat-byok/get-started.html
- **在线网页 / PWA 版（零安装试用）**：https://kamanager2012.github.io/deepseek-chat-byok/
- **校验与源码发行源**：[GitHub Releases（含 APK / 便携包 / SHA256SUMS）](https://github.com/kamanager2012/deepseek-chat-byok/releases/latest) · [SECURITY.md](SECURITY.md)

## 定位与运行形态速览

| 使用方式                            | 推荐入口                                                                                                                                                                                                                                                      | 内置本地 `/_proxy`          | 适用场景                                                                 |
| :---------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------- | :----------------------------------------------------------------------- |
| **零安装网页 / PWA（小白首选）**    | [打开在线版](https://kamanager2012.github.io/deepseek-chat-byok/)                                                                                                                                                                                             | 无（浏览器直连）            | 零安装导入并查看旧聊天、支持跨域的官方或三方接口                         |
| **Android 独立 APK（手机首选）**    | 在 [新手引导与直达下载页](https://kamanager2012.github.io/deepseek-chat-byok/get-started.html) 直接下载 **`*-android-release.apk`**（GitHub Pages 校验镜像优先；[GitHub Releases](https://github.com/kamanager2012/deepseek-chat-byok/releases/latest) 备选） | 内置 `127.0.0.1:18787` 桥接 | 手机日常高频聊天/写作、系统「分享/打开方式」导 ZIP、SAF 导出             |
| **电脑便携版（进阶，需 Node 22+）** | 在 [新手页进阶下载区](https://kamanager2012.github.io/deepseek-chat-byok/get-started.html) 下载 **`*-portable.zip`**（需本机先装 Node.js 22+ LTS；解压双击 `Start-Windows.bat` / `Start-macOS.command`）                                                      | 内置 Node 22 `/_proxy`      | 需本地 CORS 转发、连接本地 Ollama 等进阶场景（普通用户推荐直接用网页版） |

1. **三步导入旧聊天（免 Key 启动）**：内置 DeepSeek 手机 App 与网页版分步导出教程，支持桌面端直接拖入 `.zip` 或 Android 文件管理器 **「分享 / 用其他应用打开」** 导入，默认安全合并保留本地已有会话与记忆卡。
2. **多服务商自带密钥（BYOK + Android Keystore）**：内置 DeepSeek 官方（含取 Key 引导）、DeepSeek OpenAI、OpenCode Go / Zen、Anthropic、硅基流动 SiliconFlow、OpenRouter、本地 Ollama 及自定义端点；Android 端使用 `AndroidKeyStore` 管理加密密钥（导出备份包永不携带）。
3. **保存重要内容与人民币费用参考**：支持钉住 **记忆卡**（长文背景/设定不丢失）、按轮数控制携带上下文，并提供人民币参考花费（`预计约 ¥... 元`）与缓存命中省流显示。

## 产品边界与同类定位对照（避免混淆）

| 项目 / 方案                                 | 类型与定位                                                                  | 典型体积 / 形态                                           | 与本项目的关系                                                                                                                                                            |
| :------------------------------------------ | :-------------------------------------------------------------------------- | :-------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`DeepSeek Chat BYOK`（AI 聊天搬家助手）** | **独立、免费、开源的轻量聊天与历史迁移客户端**                              | Web / PWA · `~2.25 MB` Android Release APK · 电脑便携 ZIP | **已集成发布的独立产品**，无需安装 Harness 环境即可三步导入旧聊天、保存重要设定并续聊，不捆绑重型 Agent 引擎                                                              |
| 官方 `deepseek-chat-import`                 | `deepseek-ai/deepseek-harness` 内的实验性插件                               | 依赖 Harness 环境的实验性插件（支持 CLI 与 Harness 界面） | 把 DeepSeek ZIP 转为 Harness 会话；而本项目是无需 Harness 环境、面向普通用户的独立轻量客户端                                                                              |
| **`DSH Community`**（兄弟项目）             | 基于 `@deepseek-ai/dsh` 的**重型多 Agent Harness 工作台与 E2EE 远程控制端** | Linux 终端 TUI / AppImage / Web PWA / Android APK         | 与本团队独立维护：[github.com/kamanager2012/dsh-community](https://github.com/kamanager2012/dsh-community)；与 `DSH Go` 同属重型 Agent 工作台赛道，使本客户端保持简单轻快 |

> **这不是什么**：本项目不是 DeepSeek 官方客户端，也不是几个零散开源插件的组合脚本；不出售共享账号，不提供无限免费模型额度；软件免费开源，但在线生成新回复需填写你自己的 API Key 并由所选服务商按用量计费。

## 界面实机截图

![桌面端多配置 BYOK、固定记忆卡与思维链排版](docs/images/desktop-byok-workspace.png)

|                  官方导出包目录预览与选择性合并                   |                   移动端（390px）BYOK 接口配置                    |
| :---------------------------------------------------------------: | :---------------------------------------------------------------: |
| ![选择性合并导入预览弹窗](docs/images/import-selective-merge.png) | ![移动端多服务商 BYOK 配置](docs/images/mobile-byok-settings.png) |

## 三步快速上手（先免 Key 导入，再按需配密钥）

> **普通用户建议先打开 [独立产品证据与下载引导页](https://kamanager2012.github.io/deepseek-chat-byok/get-started.html)**：导入和查看本地历史对话**完全免费且不需要 API Key**；让在线 AI 生成新回复才需要自备 Key（按服务商实际价格计费）。

1. **导出官方历史包（可选）**：在 DeepSeek 官网或 App（「设置 → 个人资料 / 数据导出」获取 `deepseek_data-YYYY-MM-DD.zip`）。
2. **免 API Key 直接导入并阅读**：
   - 在线网页版 / 桌面端可直接把 `.zip` 拖入窗口，或打开 **设置 → 数据管理** 选取文件；
   - Android 版可在系统文件管理器直接选 `.zip` 点击 **「分享 / 用其他应用打开 → DeepSeek Chat BYOK」**；
   - 勾选需要的会话执行「合并导入」——默认严格保留本机已有会话与记忆卡，不强制覆盖。
3. **需要 AI 续写时再填 API Key**：打开 **设置 → 模型与 API**，选择服务商预设（或自定义端点），填入自己的密钥并点击 **「测试并保存」**（若网关未开放 `GET /models`，可直接点 **「直接保存」**）；再按需钉住 **「记忆卡」**、调节携带轮数即可低开销续聊。
   - 静态网页版受浏览器同源 CORS 策略限制，请求未开放 CORS 头的第三方接口时请改用 **Android Release APK** 或 **电脑便携版**。

> **Android 安装与升级说明**：自 `v0.2.2+` 起，公开 `Releases` 与 GitHub Pages 镜像均提供固定长期证书签名的 **`*-android-release.apk`**（SHA-256 指纹 `86d829e21571afedfcae690f240ada7f338e4c10fd9997ddc7a18ae9da91ada7`），后续版本可直接覆盖安装并保留本地对话、记忆卡与 API Key（`v0.4.0+` 起使用 `AndroidKeyStore` 管理加密密钥）；仅此前安装过早期临时 Debug 版（`v0.2.0`、`v0.2.1` 或 `*-android-debug.apk`）的用户，需先 **设置 → 数据管理 → 导出所有历史对话** 并卸载旧 Debug 包一次。验签指纹与说明见 [SECURITY.md](SECURITY.md)。

## 从源码构建与校验

需准备 Node.js 22+、`pnpm`，构建与验证 Android 桥接需 JDK 17 与 Android SDK：

```sh
pnpm install
pnpm format:check
pnpm type
pnpm lint && pnpm lint:extra
pnpm test
pnpm build
pnpm test:e2e
pnpm start
```

- 桌面独立窗口：`./scripts/start-desktop.sh`（macOS / Linux）或 `./scripts/start-desktop.ps1`（Windows PowerShell）
- 编译 Android Debug APK：`pnpm android:apk`（输出 `android/app/build/outputs/apk/debug/app-debug.apk`）
- 容器化部署：`docker build -t deepseek-chat-byok . && docker run -p 8787:8787 deepseek-chat-byok`

> 局域网 / Web 同源隔离提示：非本机 `127.0.0.1` 的明文 `http://` 访问会被现代浏览器限制 PWA 安装、剪贴板与 Service Worker，远程访问建议通过 Caddy、Nginx 或 Tailscale Serve 前置 HTTPS。另请注意：`https://kamanager2012.github.io/deepseek-chat-byok/` 与同账号下其他 GitHub Pages 仓库共用 `kamanager2012.github.io` 域名同源边界（`localStorage` / IndexedDB 同源可见）；如需严格的浏览器存储隔离，请使用 **Android Release APK**（固定本机 Origin `127.0.0.1:18787`）、**电脑便携版**，或将 `dist/` 部署到独立子域名（`CNAME` / Cloudflare Pages）。

## 问题反馈与使用交流

使用过程中遇到问题或有体验建议，欢迎通过 [脱敏反馈表单](https://github.com/kamanager2012/deepseek-chat-byok/issues/new?template=pilot-feedback.yml)（或 [GitHub Issues](https://github.com/kamanager2012/deepseek-chat-byok/issues)）提交，建议附带：

1. 使用端与版本（在线 GitHub Pages / 电脑便携版 / Android Release APK `v0.4.2`）
2. 所选接口预设与协议（DeepSeek 官方 / OpenCode Go / SiliconFlow / Ollama / 自定义等）
3. `deepseek_data-*.zip` 导入体积、会话数量与选择性合并情况
4. 复现步骤或脱敏后的报错信息（**严禁上传 API Key 或个人原始聊天导出包**）

> 如需面向开发者的多 Agent 终端 Harness 与端到端加密远程控制台，请参阅独立维护的兄弟项目 [DSH Community](https://github.com/kamanager2012/dsh-community)。

## 许可证

沿用上游 [MIT](LICENSE) 许可证。
