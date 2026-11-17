# DeepSeek Chat BYOK

[![Latest Release](https://img.shields.io/github/v/release/kamanager2012/deepseek-chat-byok?label=Release)](https://github.com/kamanager2012/deepseek-chat-byok/releases/latest)
[![Live Web / PWA](https://img.shields.io/badge/Web%20%2F%20PWA-Live%20App-4d6bfe)](https://kamanager2012.github.io/deepseek-chat-byok/)
[![CI](https://github.com/kamanager2012/deepseek-chat-byok/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/deepseek-chat-byok/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

> **DeepSeek Chat BYOK is an independent, free, open-source DeepSeek chat client with official chat history import, local memory cards, and Bring-Your-Own-Key (BYOK) chat. It is not an official DeepSeek product and not a Harness plugin bundle.** (MIT-licensed standalone client extended from [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo), supporting DeepSeek, ChatGPT, and Claude export ZIPs.)

Keywords: DeepSeek chat export importer · local-first BYOK client · DeepSeek 聊天记录迁移 · DeepSeek 聊天记录导入 · free open-source chat workspace

- **Verified Downloads & Setup Guide (no GitHub browsing needed)**: https://kamanager2012.github.io/deepseek-chat-byok/get-started.html
- **Live Web / PWA (Zero Install)**: https://kamanager2012.github.io/deepseek-chat-byok/
- **Release Origin & Checksums**: [GitHub Releases](https://github.com/kamanager2012/deepseek-chat-byok/releases/latest) · [SECURITY.md](SECURITY.md)

## Why DeepSeek Chat BYOK (30-Second Overview)

| How you want to use it                | Recommended Entry                                                                                                                                                                                                                                                                            | Local CORS `/_proxy`              | Best For                                                      |
| :------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------- | :------------------------------------------------------------ |
| **Zero-Install Browser / Mobile PWA** | [Open Live Web App](https://kamanager2012.github.io/deepseek-chat-byok/)                                                                                                                                                                                                                     | None (direct browser fetch)       | Keyless archive preview/import & CORS-enabled APIs            |
| **Android Native App**                | Direct download from [Verified Start Page](https://kamanager2012.github.io/deepseek-chat-byok/get-started.html) (**`*-android-release.apk`**, Pages mirror checked against Release SHA-256; [GitHub Releases](https://github.com/kamanager2012/deepseek-chat-byok/releases/latest) fallback) | Built-in `127.0.0.1:18787` bridge | Phone daily driver, OS Share/Open-With ZIP import, SAF export |
| **Portable Desktop / Local Server**   | Direct download from [Verified Start Page](https://kamanager2012.github.io/deepseek-chat-byok/get-started.html) (**`*-portable.zip`**, requires Node.js 22+ LTS; double-click `Start-Windows.bat` / `Start-macOS.command`)                                                                   | Built-in Node 22 `/_proxy`        | Desktop windowed mode, strict third-party APIs & local Ollama |

1. **Cross-Platform Chat Asset Migration in Seconds**: Open **DeepSeek** (`deepseek_data-*.zip`), **ChatGPT**, or **Claude** (`conversations.json`) export ZIPs directly via drag-and-drop, file picker, or Android **Share / Open with**; preview indexes immediately, preserve branched regenerations, and merge non-destructively without overwriting existing sessions or Memory Cards.
2. **Switch Providers Freely (BYOK + Android Keystore)**: Keep multiple profiles across DeepSeek Official (Anthropic + native search/files/TTS), DeepSeek OpenAI, OpenCode Go / Zen, Anthropic Messages, SiliconFlow, OpenRouter, Local Ollama, or custom endpoints. Android `v0.4.0+` encrypts saved keys with AES-256-GCM in `AndroidKeyStore`.
3. **Cut Token Waste & Estimate Cache Savings**: Cap history by round count / token budget, pin a persistent **Memory Card** (editable or summarized from trimmed turns), and track per-reply token usage, cache hits (`in (hit X) · out`), and estimated USD cost.

## Product Identity & Ecosystem Comparison

| Project / Tool                       | Category                                                         | Footprint / Packaging                                                    | How It Compares                                                                                                                                                                    |
| :----------------------------------- | :--------------------------------------------------------------- | :----------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`DeepSeek Chat BYOK`** (this repo) | **Standalone, free, open-source chat & archive client**          | Web / PWA · `~2.24 MB` Android Release APK · Portable Desktop ZIP        | Integrated end-user app focused on keyless archive migration, memory cards, cache/cost visibility, and local BYOK chat without Agent runtime bloat                                 |
| Official `deepseek-chat-import`      | Experimental CLI plugin inside `deepseek-ai/deepseek-harness`    | CLI / Harness package                                                    | Converts official ZIP exports into Harness sessions; unlike a standalone mobile/web/desktop chat UI, it requires a Harness setup                                                   |
| **`DSH Community`** (sister repo)    | **Heavy multi-agent Harness workbench & E2EE remote controller** | CLI / TUI / Linux AppImage / Web PWA / Android APK on `@deepseek-ai/dsh` | Independently maintained at [github.com/kamanager2012/dsh-community](https://github.com/kamanager2012/dsh-community); competes directly with heavy Agent workbenches like `DSH Go` |

> **What this is NOT**: It is not an official DeepSeek app, and not a DIY collection of disconnected plugins; it does not sell shared accounts or include free API quota. Live AI replies require your own API key billed directly by your chosen provider.

## Screenshots

![Desktop BYOK Workspace with Pinned Memory Card and Context Budget](docs/images/desktop-byok-workspace.png)

|                          Selective ZIP Archive Merge                           |                             Mobile BYOK Settings                             |
| :----------------------------------------------------------------------------: | :--------------------------------------------------------------------------: |
| ![Selective ZIP Archive Merge Preview](docs/images/import-selective-merge.png) | ![Mobile BYOK Multi-Provider Settings](docs/images/mobile-byok-settings.png) |

## Quick Start (3 Steps: Import Keylessly First, Add API Key Only When Ready)

> **Non-developers:** Start with the [Verified Product & Download Guide](https://kamanager2012.github.io/deepseek-chat-byok/get-started.html). Importing and reading local archives **is free and requires no API key**; live AI replies require your own API key billed by your provider.

1. **Export your official archive (optional)**: Download `deepseek_data-YYYY-MM-DD.zip` from DeepSeek, or export your `conversations.json` ZIP from ChatGPT / Claude.
2. **Import & read without an API Key**:
   - Drag and drop the `.zip` into the Web / Desktop window (or open **Settings -> Data**), or use Android system **Share / Open with -> DeepSeek Chat BYOK**;
   - Preview session counts & titles immediately and selectively merge without overwriting existing local chats.
3. **Add your own API key only to continue chatting**: Open **Settings -> Models & API**, pick a preset (or custom URL), enter your key, and tap **Test & Save** (or **Save Direct**), then pin a **Memory Card** or tune history round budgets to cut token cost.
   - Static GitHub Pages only calls APIs directly from your browser; endpoints that block browser CORS require the Android APK or Portable Desktop (`server.mjs`).

> **Android Install & Upgrade Note**: Starting with `v0.2.2+`, public releases provide **`*-android-release.apk`** signed with a persistent Release certificate (SHA-256 `86d829e21571afedfcae690f240ada7f338e4c10fd9997ddc7a18ae9da91ada7`), supporting direct in-place updates while keeping local chats, Memory Cards, and API keys intact (`v0.4.0+` automatically migrates existing keys into `AndroidKeyStore` AES-256-GCM storage). Only users upgrading from older ephemeral debug builds (`v0.2.0`, `v0.2.1`, or `*-android-debug.apk`) should export their chats once (**Settings -> Data -> Export all chats**) and uninstall the debug build before installing `*-android-release.apk`. See [SECURITY.md](SECURITY.md) for verification fingerprints.

## Build & Verify From Source

Requires Node.js 22+, `pnpm`, and (for Android builds/tests) JDK 17 + Android SDK:

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

- Desktop app mode: `./scripts/start-desktop.sh` (macOS/Linux) or `./scripts/start-desktop.ps1` (Windows PowerShell)
- Android Debug APK: `pnpm android:apk` (`android/app/build/outputs/apk/debug/app-debug.apk`)
- Self-hosted Docker: `docker build -t deepseek-chat-byok . && docker run -p 8787:8787 deepseek-chat-byok`

> Mobile LAN / Origin Isolation note: Browsers restrict PWA installation, clipboard, and Service Workers on plain HTTP outside `127.0.0.1` / `localhost`. Terminate HTTPS via Caddy, Nginx, or Tailscale Serve if hosting remotely. Note also that the shared `https://kamanager2012.github.io/deepseek-chat-byok/` subpath shares its `localStorage`/IndexedDB Web Origin with other GitHub Pages repositories under the same account; for isolated browser origin storage in production, deploy `dist/` to a dedicated custom domain / subdomain (`CNAME` or `*.pages.dev`), or use the signed Android APK / Portable Desktop bundle.

## Feedback & Bug Reports

Found a bug or UX bottleneck? Use the [De-identified Feedback Form](https://github.com/kamanager2012/deepseek-chat-byok/issues/new?template=pilot-feedback.yml) (or open a [GitHub Issue](https://github.com/kamanager2012/deepseek-chat-byok/issues)) with:

1. Platform & release version (`GitHub Pages`, `Portable Desktop`, or `Android Release APK v0.4.0`)
2. Provider preset / protocol (`deepseek-anthropic`, `openai`, `anthropic`, or `ollama`)
3. Whether archive merge (`deepseek_data-*.zip`) succeeded and approximate session count / ZIP size
4. Reproduction steps or sanitized console/UI error messages (**never attach API keys or personal chat ZIPs**)

> Looking for a developer terminal harness / multi-agent remote controller instead of a daily chat client? See the independent sister repository [DSH Community](https://github.com/kamanager2012/dsh-community) (maintained separately).

## License

[MIT](LICENSE)
