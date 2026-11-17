# DeepSeek Chat BYOK

[English](README.md) | 简体中文

- **在线网页 / PWA 版**：https://kamanager2012.github.io/deepseek-chat-byok/
- **版本下载（Android APK & 便携版压缩包）**：https://github.com/kamanager2012/deepseek-chat-byok/releases

基于 MIT 开源项目 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo) 扩展的**完全本地、纯工具型（零后端收费/零套餐代销）BYOK 聊天、写作与 DeepSeek 导出历史迁移工具**。

## 核心特性

1. **自带 API Key（BYOK）多服务商自由切换**
   - 在 **设置 → 模型与 API** 支持保存多套配置并随时切换，所有 Key 仅保存在本机 `localStorage`（导出对话包时不会携带），支持未保存修改提示。
   - 内置预设：
     - **DeepSeek 官方（Anthropic + 原生工具）**：`https://api.deepseek.com`，完整保留官方联网搜索、文档解析、网页阅读与语音能力。
     - **DeepSeek 官方（OpenAI 兼容）**：`https://api.deepseek.com/v1`。
     - **OpenCode Go / Zen（个人订阅/按量 Key）**：预置 `https://opencode.ai/zen/go/v1` 与 `https://opencode.ai/zen/v1`，适配 `deepseek-v4.1-flash` / `deepseek-v4-pro` 等模型的思考链与正文流式输出。
     - **硅基流动 SiliconFlow / OpenRouter / 本地 Ollama / 任意自定义端点**（兼容 OpenAI Chat Completions 与 Anthropic Messages）。
   - 支持 **「测试并保存」** 与 **「直接保存」**（兼容未开放 `GET /models` 的网关）。

2. **大包不卡死：DeepSeek 官方导出包（`export_format_version: 3`）选择性合并导入**
   - 一次性读取中央目录索引 `chat_session_index.json` 毫秒级展示全部会话，无需把 200 MB+ 归档全部解压进手机内存即可搜索、勾选需要迁移的会话。
   - 默认支持 **合并导入（保留当前已有新对话及已有记忆卡）**，也保留 **覆盖替换** 选项；导入时默认可选剔除体积极大的历史联网搜索结果碎片。

3. **对抗低缓存高费率：上下文预算裁剪 + 固定记忆卡 + 用量展示 + Markdown 导出**
   - **发送前预算控制**：可按「携带最近 N 轮（默认 20 轮）」与「历史 Token 上限（默认 ~24K tokens）」自动裁剪超长历史；每条回答底部展示 `in / cache hit / out` Token 统计。
   - **固定记忆卡（Memory Prefix）**：支持手工编辑人物设定/背景故事，或点击 **「用当前模型压缩早期对话」** 一键提炼（支持关闭弹窗/切换会话时自动取消请求），大幅降低无缓存输入费用。
   - **一键导出 Markdown**：将当前会话整理为清爽 Markdown，方便本地留档或配合外部工具使用。

4. **电脑版桌面窗口 + 手机 PWA + 安全加固本地转发服务**
   - `pnpm build` 生成离线可用的 PWA 静态站点（含 `manifest.webmanifest`、矢量/PNG 图标与 `sw.js` 应用壳缓存，且不拦截 `/_proxy`）。
   - 零依赖 Node 22 服务 `server.mjs` 提供 `/_proxy` 本地 CORS 转发，内置：同源 `Origin` / `Sec-Fetch-Site` 防跨站 CSRF 滥用、请求方法白名单、禁止 `3xx` 重定向 SSRF、DNS 解析防内网/云元数据 IP 回环绑定、`25 MB` 请求体上限保护。
   - 提供开箱即用桌面端应用窗口脚本（macOS/Linux `./scripts/start-desktop.sh`、Windows `./scripts/start-desktop.ps1`）与容器化部署 `Dockerfile`。

## 运行、验证与部署

需要 Node.js 22+ 与 pnpm：

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

- **电脑端桌面窗口一键启动**：
  - macOS / Linux：`./scripts/start-desktop.sh`
  - Windows PowerShell：`./scripts/start-desktop.ps1`
- **原生 Android APK（内置 `127.0.0.1:18787` 本地流式 `/_proxy`、文件选择与原生文档导出，无需自建服务器即可在手机端直连任意兼容 API）**：
  - `pnpm android:apk`（输出 `android/app/build/outputs/apk/debug/app-debug.apk`）
- **自托管 Docker 部署（供多端 / 手机浏览器访问）**：
  - `docker build -t deepseek-chat-byok . && docker run -p 8787:8787 deepseek-chat-byok`

> 手机端提示：浏览器对 PWA 安装与 Service Worker 要求 HTTPS（或本机 `127.0.0.1`）。若在局域网或云服务器部署后用手机浏览器安装 PWA 与走同源 `/_proxy`，建议前置 Caddy / Nginx / Tailscale Serve 提供 HTTPS。

## 许可证

沿用上游 [MIT](LICENSE) 许可证。
