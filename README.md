# DeepSeek Chat BYOK

[![Latest Release](https://img.shields.io/github/v/release/kamanager2012/deepseek-chat-byok?label=Release)](https://github.com/kamanager2012/deepseek-chat-byok/releases/latest)
[![Live Web / PWA](https://img.shields.io/badge/Web%20%2F%20PWA-Live%20App-4d6bfe)](https://kamanager2012.github.io/deepseek-chat-byok/)
[![CI](https://github.com/kamanager2012/deepseek-chat-byok/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/deepseek-chat-byok/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

- **Beginner start page (no GitHub file navigation)**: https://kamanager2012.github.io/deepseek-chat-byok/get-started.html
- **Live Web / PWA**: https://kamanager2012.github.io/deepseek-chat-byok/
- **Beginner downloads (signed Android APK & portable desktop ZIP)**: https://kamanager2012.github.io/deepseek-chat-byok/get-started.html (site-hosted release snapshot, checksum checked during build; GitHub Release remains the origin)
- **Security & Release Signing Guide**: [SECURITY.md](SECURITY.md)

A local-first, MIT-licensed **Bring-Your-Own-Key (BYOK)** chat client, creative writing workspace, and DeepSeek official export migration tool extended from [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo). Zero hosted billing backend and zero shared API keys.

## Why DeepSeek Chat BYOK (30-Second Overview)

| How you want to use it                | Recommended Entry                                                                                                                                                                                                            | Local CORS `/_proxy`              | Best For                                                      |
| :------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------- | :------------------------------------------------------------ |
| **Zero-Install Browser / Mobile PWA** | [Open Live Web App](https://kamanager2012.github.io/deepseek-chat-byok/)                                                                                                                                                     | None (direct browser fetch)       | CORS-enabled APIs & local archive inspection                  |
| **Android Native App**                | **`*-android-release.apk`** from [Latest Release](https://github.com/kamanager2012/deepseek-chat-byok/releases/latest)                                                                                                       | Built-in `127.0.0.1:18787` bridge | Phone daily driver, any BYOK endpoint, SAF file export        |
| **Portable Desktop / Local Server**   | **`*-portable.zip`** ([Download & Setup Guide](https://kamanager2012.github.io/deepseek-chat-byok/get-started.html)): unzip and double-click `Start-Windows.bat` / `Start-macOS.command`, or run `./scripts/start-desktop.*` | Built-in Node 22 `/_proxy`        | Desktop windowed mode, strict third-party APIs & local Ollama |

1. **Migrate Locked/Older Chats in Seconds**: Export `deepseek_data-*.zip` from DeepSeek Settings -> Data Export, drop it into **Settings -> Data -> Import Chat History**, preview the archive index immediately, and **merge** selected conversations without wiping your existing sessions or Memory Cards.
2. **Switch Providers Freely (BYOK)**: Keep multiple profiles in `localStorage` across DeepSeek Official (Anthropic + native search/files/TTS), DeepSeek OpenAI, OpenCode Go / Zen, Anthropic Messages, SiliconFlow, OpenRouter, Local Ollama, or custom endpoints.
3. **Cut Token Waste on Long Chats & Fiction**: Cap history by round count / token budget, pin a persistent **Memory Card** (editable or summarized from trimmed turns), and inspect per-reply cache hits (`in (hit X) · out`).

## Screenshots

![Desktop BYOK Workspace with Pinned Memory Card and Context Budget](docs/images/desktop-byok-workspace.png)

|                          Selective ZIP Archive Merge                           |                             Mobile BYOK Settings                             |
| :----------------------------------------------------------------------------: | :--------------------------------------------------------------------------: |
| ![Selective ZIP Archive Merge Preview](docs/images/import-selective-merge.png) | ![Mobile BYOK Multi-Provider Settings](docs/images/mobile-byok-settings.png) |

## Quick Start (3 Steps)

> **Non-developers:** Start with the [download & migration guide](https://kamanager2012.github.io/deepseek-chat-byok/get-started.html). Importing and reading local archives needs no API key; live replies require your own key and provider charges. Downloads are still served by GitHub Releases, so restricted networks may not be able to download them. No hosted free model quota is included.

1. **Get your official export (optional)**: In the DeepSeek app or web UI, export your data (`deepseek_data-YYYY-MM-DD.zip`).
2. **Add your own API key**: Open **Settings -> Models & API**, pick a preset (or custom URL), enter your key, and tap **Test & Save** (or **Save Direct**).
   - Static GitHub Pages only calls APIs directly from your browser; endpoints that block browser CORS require the Android APK or Portable Desktop (`server.mjs`).
3. **Import & Continue**: In **Settings -> Data**, pick your ZIP, select sessions to merge, optionally pin a **Memory Card**, and keep writing.

> **Android Install & Upgrade Note**: Starting with `v0.2.2+`, public releases provide **`*-android-release.apk`** signed with a persistent Release certificate (SHA-256 `86d829e21571afedfcae690f240ada7f338e4c10fd9997ddc7a18ae9da91ada7`), supporting direct in-place updates while keeping local chats, Memory Cards, and API keys intact. Only users upgrading from older ephemeral debug builds (`v0.2.0`, `v0.2.1`, or `*-android-debug.apk`) should export their chats once (**Settings -> Data -> Export all chats**) and uninstall the debug build before installing `*-android-release.apk`. See [SECURITY.md](SECURITY.md) for verification fingerprints.

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

1. Platform & release version (`GitHub Pages`, `Portable Desktop`, or `Android Release APK v0.3.2`)
2. Provider preset / protocol (`deepseek-anthropic`, `openai`, `anthropic`, or `ollama`)
3. Whether archive merge (`deepseek_data-*.zip`) succeeded and approximate session count / ZIP size
4. Reproduction steps or sanitized console/UI error messages (**never attach API keys or personal chat ZIPs**)

> Looking for a developer terminal harness / multi-agent remote controller instead of a daily chat client? See the independent sister repository [DSH Community](https://github.com/kamanager2012/dsh-community) (maintained separately).

## License

[MIT](LICENSE)
