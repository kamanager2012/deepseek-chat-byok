# DeepSeek Chat BYOK

English | [简体中文](README.zh-CN.md)

- **Live Web / PWA**: https://kamanager2012.github.io/deepseek-chat-byok/
- **Downloads (Android APK & Portable Server ZIP)**: https://github.com/kamanager2012/deepseek-chat-byok/releases
- **Security & Release Signing Guide**: [SECURITY.md](SECURITY.md)

A local-first, MIT-licensed **Bring-Your-Own-Key (BYOK)** chat client, creative writing workspace, and DeepSeek official export migration tool extended from [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo). Zero hosted billing backend and zero shared API keys.

## Why DeepSeek Chat BYOK (30-Second Overview)

| How you want to use it                | Recommended Entry                                                                                 | Local CORS `/_proxy`              | Best For                                                      |
| :------------------------------------ | :------------------------------------------------------------------------------------------------ | :-------------------------------- | :------------------------------------------------------------ |
| **Zero-Install Browser / Mobile PWA** | [Open Live Web App](https://kamanager2012.github.io/deepseek-chat-byok/)                          | None (direct browser fetch)       | CORS-enabled APIs & local archive inspection                  |
| **Android Native App**                | `android-debug.apk` from [Releases](https://github.com/kamanager2012/deepseek-chat-byok/releases) | Built-in `127.0.0.1:18787` bridge | Phone daily driver, any BYOK endpoint, SAF file export        |
| **Portable Desktop / Local Server**   | `portable.zip` or `./scripts/start-desktop.*`                                                     | Built-in Node 22 `/_proxy`        | Desktop windowed mode, strict third-party APIs & local Ollama |

1. **Migrate Locked/Older Chats in Seconds**: Export `deepseek_data-*.zip` from DeepSeek Settings -> Data Export, drop it into **Settings -> Data -> Import Chat History**, preview the archive index immediately, and **merge** selected conversations without wiping your existing sessions or Memory Cards.
2. **Switch Providers Freely (BYOK)**: Keep multiple profiles in `localStorage` across DeepSeek Official (Anthropic + native search/files/TTS), DeepSeek OpenAI, OpenCode Go / Zen, Anthropic Messages, SiliconFlow, OpenRouter, Local Ollama, or custom endpoints.
3. **Cut Token Waste on Long Chats & Fiction**: Cap history by round count / token budget, pin a persistent **Memory Card** (editable or summarized from trimmed turns), and inspect per-reply cache hits (`in (hit X) · out`).

## Screenshots

![Desktop BYOK Workspace with Pinned Memory Card and Context Budget](docs/images/desktop-byok-workspace.png)

|                          Selective ZIP Archive Merge                           |                             Mobile BYOK Settings                             |
| :----------------------------------------------------------------------------: | :--------------------------------------------------------------------------: |
| ![Selective ZIP Archive Merge Preview](docs/images/import-selective-merge.png) | ![Mobile BYOK Multi-Provider Settings](docs/images/mobile-byok-settings.png) |

## Quick Start (3 Steps)

1. **Get your official export (optional)**: In the DeepSeek app or web UI, export your data (`deepseek_data-YYYY-MM-DD.zip`).
2. **Add your own API key**: Open **Settings -> Models & API**, pick a preset (or custom URL), enter your key, and tap **Test & Save** (or **Save Direct**).
   - Static GitHub Pages only calls APIs directly from your browser; endpoints that block browser CORS require the Android APK or Portable Desktop (`server.mjs`).
3. **Import & Continue**: In **Settings -> Data**, pick your ZIP, select sessions to merge, optionally pin a **Memory Card**, and keep writing.

> Android Upgrade Note: Current public releases ship a CI debug-signed APK (`android-debug.apk`). Because ephemeral debug signatures differ across CI builds, **export your chats first** (`Settings -> Data -> Export all chats`), uninstall the prior debug build, install the new APK, re-import your backup ZIP, and re-enter your API key(s). See [SECURITY.md](SECURITY.md) for permanent release keystore setup.

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

> Mobile LAN / VPS note: Browsers restrict PWA installation, clipboard, and Service Workers on plain HTTP outside `127.0.0.1` / `localhost`. Terminate HTTPS via Caddy, Nginx, or Tailscale Serve if hosting remotely.

## Trial Feedback Checklist

Trying out `v0.2.2`? Share reproducible feedback in [GitHub Issues](https://github.com/kamanager2012/deepseek-chat-byok/issues) with:

1. Platform & version (`GitHub Pages`, `Portable Desktop`, or `Android APK v0.2.2`)
2. Provider preset / protocol (`deepseek-anthropic`, `openai`, `anthropic`, or `ollama`)
3. Whether archive merge (`deepseek_data-*.zip`) succeeded and approximate session count / ZIP size
4. Any friction in first-run key setup, streaming, Memory Card distillation, or CORS errors

## License

[MIT](LICENSE)
