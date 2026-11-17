# DeepSeek Chat BYOK

English | [简体中文](README.zh-CN.md)

- **Online Web / PWA**: https://kamanager2012.github.io/deepseek-chat-byok/
- **Releases (Android APK & Portable ZIP)**: https://github.com/kamanager2012/deepseek-chat-byok/releases

A local-first, MIT-licensed **Bring-Your-Own-Key (BYOK)** chat client and DeepSeek official export migration tool extended from [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo). No hosted billing backend or shared API pool.

## Features

- **Multi-Provider BYOK (OpenAI Chat Completions + Anthropic Messages)**: Presets for DeepSeek Official (Anthropic + native search/files/speech), DeepSeek OpenAI (`https://api.deepseek.com/v1`), OpenCode Go (`https://opencode.ai/zen/go/v1`), OpenCode Zen (`https://opencode.ai/zen/v1`), SiliconFlow, OpenRouter, local Ollama (`http://127.0.0.1:11434/v1`), or custom endpoints. Keys are stored only in local browser storage and excluded from exports.
- **Fast Index-First Selective ZIP Import (`export_format_version: 3`)**: Reads only the ZIP central directory and `chat_session_index.json` before decompressing, allowing searchable selective merge import (preserving existing chats and pinned Memory Cards) or full replace, plus optional stripping of bulky historical search blocks.
- **Context Budget, Pinned Memory Prefix & Per-Reply Usage**: Trim outgoing history by max rounds or estimated token budget, maintain a pinned per-session memory/persona card (editable or distilled from trimmed early turns with abortable requests), monitor per-reply cached vs uncached tokens, and export clean session Markdown.
- **Desktop App Mode, Mobile PWA & Hardened `/_proxy`**:
  - Generates an offline-capable PWA (`manifest.webmanifest`, vector/PNG icons, Network-First App Shell `sw.js`).
  - Zero-dependency Node 22 server (`server.mjs`) with an SSRF/CSRF-hardened `/_proxy` (same-origin check, method allowlist, blocked `3xx` redirects, DNS-resolved private/metadata IP block, `25 MB` payload cap).
  - Turnkey desktop app launchers (`./scripts/start-desktop.sh`, `scripts/start-desktop.ps1`) and container self-hosting (`Dockerfile`).

## Quick Start

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

Open `http://127.0.0.1:8787`, or launch directly as a standalone desktop window:

- macOS / Linux: `./scripts/start-desktop.sh`
- Windows PowerShell: `./scripts/start-desktop.ps1`
- Native Android APK (embedded `127.0.0.1:18787` streaming `/_proxy`, file picker & SAF document export): `pnpm android:apk` (outputs `android/app/build/outputs/apk/debug/app-debug.apk`)
- Self-hosted Docker (LAN / TLS reverse proxy): `docker build -t deepseek-chat-byok . && docker run -p 8787:8787 deepseek-chat-byok`

> Mobile note: Accessing a remote server over plain HTTP LAN is restricted by browser secure-context APIs (such as Service Workers and clipboard/mic). For mobile PWA installation over LAN or VPS, terminate HTTPS via a reverse proxy (e.g., Caddy, Nginx, or Tailscale Serve).

## License

[MIT](LICENSE)
