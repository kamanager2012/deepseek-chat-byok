import 'fake-indexeddb/auto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { checkProxyTargetAllowed, createAppServer, isPrivateOrMetadataIp } from '../server.mjs'
import {
  ANDROID_VAULT_ERR_SENTINEL,
  consumeAndroidSharedZip,
  isLocalProxyRequestUrl,
} from '../src/services/api/androidBridge.js'
import { redactApiSecrets } from '../src/services/api/client.js'
import { readMessageEvent } from '../src/services/api/parseEvent.js'
import { createDefaultProvider, resolveFetchTarget } from '../src/services/api/providers.js'
import { exportEmergencyBackup } from '../src/services/chat/backup.js'
import * as db from '../src/services/chat/db.js'
import { exportArchive } from '../src/services/chat/history/exportArchive.js'
import { EXPORT_FORMAT_VERSION } from '../src/services/chat/history/format.js'
import {
  checkArchiveFormat,
  importArchive,
  inspectArchiveIndex,
} from '../src/services/chat/history/importArchive.js'
import { INDEX_PATH, MANIFEST_PATH, sessionPath } from '../src/services/chat/history/paths.js'
import { toIndexEntry, toSessionFile } from '../src/services/chat/history/toArchive.js'
import type { Session } from '../src/services/chat/types.js'
import {
  loadInitialProvidersWithVault,
  selectActiveProvider,
  upsertProvider,
  useSettings,
} from '../src/services/settings.js'
import { isSafeHttpUrl } from '../src/utils/url.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('v0.4.3 production hardening regressions', () => {
  it('bans API-33 URLDecoder.decode(String, Charset) in Android Java sources for minSdk 26 safety', () => {
    const bridgeJava = readFileSync(
      path.join(ROOT, 'android/app/src/main/java/com/deepseekbyok/app/LocalBridgeServer.java'),
      'utf8'
    )
    const mainJava = readFileSync(
      path.join(ROOT, 'android/app/src/main/java/com/deepseekbyok/app/MainActivity.java'),
      'utf8'
    )
    expect(bridgeJava).not.toContain('URLDecoder.decode(')
    expect(mainJava).not.toContain('URLDecoder.decode(')
  })

  it('round-trips session Memory Cards (memoryPrompt) across ZIP export/replace and imports Safari re-zipped folders', async () => {
    await db.clearStaging()
    await db.commitStaging('replace')

    const sWithMemory: Session = {
      id: 'aaaa1111-1111-4111-8111-111111111111',
      title: 'Novel Worldbuilding',
      memoryPrompt: 'Protagonist: Lin Zhou, detective in Chongqing, hates rain.',
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_050_000,
      messages: [
        {
          id: 'u1',
          role: 'user',
          createdAt: 1_760_000_000_000,
          content: 'Start chapter 1',
          files: [],
        },
        {
          id: 'a1',
          role: 'assistant',
          createdAt: 1_760_000_005_000,
          model: 'deepseek-chat',
          prefix: false,
          status: 'done',
          stopReason: 'end_turn',
          blocks: [{ type: 'text', text: 'Rain drummed against the neon sign.' }],
        },
      ],
    }

    const exportedBlob = await exportArchive([sWithMemory])
    const exportedFile = new File([exportedBlob], 'backup.zip', { type: 'application/zip' })
    await checkArchiveFormat(exportedFile)
    await db.clearStaging()
    expect(await importArchive(exportedFile)).toBe(1)
    await db.commitStaging('replace')

    const restored = await db.loadSession(sWithMemory.id)
    expect(restored?.memoryPrompt).toBe(sWithMemory.memoryPrompt)

    // Simulate macOS Safari auto-unzip + Finder Compress (top-level folder + alphabetical order + .DS_Store)
    const sf = toSessionFile(sWithMemory, () => null)
    const rezippedBytes = zipSync({
      'deepseek_data-2026/.DS_Store': strToU8('junk'),
      '__MACOSX/deepseek_data-2026/._manifest.json': strToU8('junk'),
      [`deepseek_data-2026/${INDEX_PATH}`]: strToU8(JSON.stringify([toIndexEntry(sf)])),
      [`deepseek_data-2026/${sessionPath(sWithMemory.id)}`]: strToU8(JSON.stringify(sf)),
      [`deepseek_data-2026/${MANIFEST_PATH}`]: strToU8(
        JSON.stringify({ export_format_version: EXPORT_FORMAT_VERSION })
      ),
    })
    const rezippedFile = new File([Buffer.from(rezippedBytes)], 'deepseek_data-2026.zip', {
      type: 'application/zip',
    })
    const rezippedIdx = await inspectArchiveIndex(rezippedFile)
    expect(rezippedIdx.map((e) => e.id)).toEqual([sWithMemory.id])
    await checkArchiveFormat(rezippedFile)
    await db.clearStaging()
    expect(await importArchive(rezippedFile)).toBe(1)
    await db.commitStaging('replace')
    expect((await db.loadSession(sWithMemory.id))?.memoryPrompt).toBe(sWithMemory.memoryPrompt)
  })

  it('keeps exportEmergencyBackup resilient when one session has corrupted cyclic branches', async () => {
    await db.clearStaging()
    await db.commitStaging('replace')

    const goodSession: Session = {
      id: 'good-session-0001',
      title: 'Healthy Chat',
      memoryPrompt: 'Important study notes',
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_020_000,
      messages: [
        { id: 'u1', role: 'user', createdAt: 1_760_000_000_000, content: 'Hello', files: [] },
        {
          id: 'a1',
          role: 'assistant',
          parentId: 'u1',
          createdAt: 1_760_000_001_000,
          model: 'deepseek-chat',
          prefix: false,
          status: 'done',
          stopReason: 'end_turn',
          blocks: [{ type: 'text', text: 'World' }],
        },
      ],
    }
    const corruptedSession: Session = {
      id: 'bad-session-0002',
      title: 'Corrupted Timestamp Session',
      createdAt: Number.NaN,
      updatedAt: 1_760_000_030_000,
      messages: [
        {
          id: 'c1',
          role: 'user',
          createdAt: Number.NaN,
          content: 'Corrupted timestamp throws RangeError in toSessionFile',
          files: [],
        },
      ],
    }
    await db.saveSession(goodSession)
    await db.saveSession(corruptedSession)

    const emergency = await exportEmergencyBackup()
    expect(emergency.totalCount).toBe(2)
    expect(emergency.exportedCount).toBe(1)
    expect(emergency.skippedIds).toEqual(['bad-session-0002'])

    const emergencyFile = new File([emergency.blob], emergency.name, { type: 'application/zip' })
    await db.clearStaging()
    expect(await importArchive(emergencyFile)).toBe(1)
    await db.commitStaging('replace')
    expect((await db.loadSession('good-session-0001'))?.memoryPrompt).toBe('Important study notes')
  })

  it('prevents Android vault transient read/write errors from wiping keys or leaking plaintext to localStorage, and isolates fallback port tokens', async () => {
    const win = globalThis as unknown as {
      window?: Record<string, unknown>
      localStorage?: Storage
      fetch: typeof fetch
    }
    const prevWindow = win.window
    const prevStorage = win.localStorage
    const prevFetch = globalThis.fetch

    const store = new Map<string, string>()
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v)
      },
      removeItem: (k: string) => {
        store.delete(k)
      },
    } as unknown as Storage

    let vaultWrites = 0
    let allowWrite = false
    let readResponse = ANDROID_VAULT_ERR_SENTINEL

    try {
      win.localStorage = mockStorage
      const p1 = createDefaultProvider('', 'p1')
      const p2 = { ...createDefaultProvider('', 'p2'), name: 'Backup' }
      store.set('chat-demo:providers-v1', JSON.stringify([p1, p2]))
      store.set('chat-demo:active-provider-id', 'p1')

      win.window = {
        location: { origin: 'http://127.0.0.1:18787', protocol: 'http:', hostname: '127.0.0.1' },
        AndroidExportBridge: {
          getBridgeToken: () => 'tok-fallback-999',
          getProxyUrl: () => 'http://127.0.0.1:18788/_proxy',
          readSecureSecrets: () => readResponse,
          writeSecureSecrets: () => {
            vaultWrites += 1
            return allowWrite
          },
          consumePendingSharedZip: () =>
            JSON.stringify({ fileName: 'shared-ds.zip', nonce: 'one-time-nonce-777' }),
        },
      }

      // 1. Canonical port occupied (fallback 18788): never send token to 18787 or /_proxy
      expect(isLocalProxyRequestUrl('/_proxy?url=https%3A%2F%2Fapi.deepseek.com')).toBe(false)
      expect(
        isLocalProxyRequestUrl('http://127.0.0.1:18787/_proxy?url=https%3A%2F%2Fapi.deepseek.com')
      ).toBe(false)
      expect(
        isLocalProxyRequestUrl('http://127.0.0.1:18788/_proxy?url=https%3A%2F%2Fapi.deepseek.com')
      ).toBe(true)
      expect(
        resolveFetchTarget(
          'https://api.deepseek.com/v1/models',
          true,
          'http://127.0.0.1:18787/_proxy'
        )
      ).toBe('http://127.0.0.1:18788/_proxy?url=https%3A%2F%2Fapi.deepseek.com%2Fv1%2Fmodels')

      // 2. Transient vault read error (__DS_VAULT_ERR__) must not overwrite vault on passive switch
      const loaded = loadInitialProvidersWithVault()
      useSettings.setState({
        providers: loaded.providers,
        activeProviderId: loaded.activeProviderId,
      })
      expect(vaultWrites).toBe(0)
      selectActiveProvider('p2')
      expect(vaultWrites).toBe(0)

      // 3. Transient vault write failure (returns false) must NEVER write plaintext apiKey to localStorage
      allowWrite = false
      upsertProvider({ ...p1, apiKey: 'sk-super-secret-android-key-123456' }, true)
      expect(vaultWrites).toBe(1)
      expect(store.get('chat-demo:providers-v1') ?? '').not.toContain(
        'sk-super-secret-android-key-123456'
      )
      expect(store.get('chat-demo:api-key') ?? null).toBeNull()

      // 4. One-time share nonce query parameter used for /_shared_import.zip
      let requestedUrl = ''
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requestedUrl = String(input)
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 })
      }) as typeof fetch
      const shared = await consumeAndroidSharedZip()
      expect(shared?.name).toBe('shared-ds.zip')
      expect(requestedUrl).toBe('/_shared_import.zip?nonce=one-time-nonce-777')
    } finally {
      readResponse = '{}'
      win.window = prevWindow
      win.localStorage = prevStorage
      globalThis.fetch = prevFetch
    }
  })

  it('blocks javascript:/data: SSE URLs, redacts custom API keys, and blocks symlink escape & IPv6/self-proxy SSRF in server.mjs', async () => {
    expect(isSafeHttpUrl('https://chat.deepseek.com/a')).toBe(true)
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false)

    const evilSearch = readMessageEvent({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        kind: 'search',
        content: [
          {
            type: 'web_search_result',
            url: 'javascript:alert(document.domain)',
            title: 'XSS',
            snippet: 'bad',
            site_name: 'evil',
            site_icon: null,
            page_age: null,
          },
          {
            type: 'web_search_result',
            url: 'https://deepseek.com/news',
            title: 'Safe',
            snippet: 'ok',
            site_name: 'DeepSeek',
            site_icon: null,
            page_age: null,
          },
        ],
      },
    })
    expect(evilSearch?.type).toBe('content_block_start')
    if (
      evilSearch?.type === 'content_block_start' &&
      evilSearch.content_block.type === 'web_search_tool_result'
    ) {
      expect(evilSearch.content_block.content).toHaveLength(1)
    }

    expect(
      redactApiSecrets(
        'Gateway error x-api-key: custom_tok_987654321 and gsk_abcdefghijklmnop',
        'my-custom-secret-token'
      )
    ).toBe('Gateway error x-api-key: [REDACTED] and [REDACTED]')
    expect(
      redactApiSecrets(' Upstream echoed my-custom-secret-token ', 'my-custom-secret-token')
    ).toBe(' Upstream echoed [REDACTED] ')

    // Expanded 128-bit IPv6 private/tunnel checks & self-proxy recursion block
    expect(isPrivateOrMetadataIp('0:0:0:0:0:0:0:1')).toBe(true)
    expect(isPrivateOrMetadataIp('0:0:0:0:0:ffff:127.0.0.1')).toBe(true)
    expect(isPrivateOrMetadataIp('::7f00:1')).toBe(true)
    expect(isPrivateOrMetadataIp('2002:7f00:1::1')).toBe(true)
    expect(isPrivateOrMetadataIp('2001::1')).toBe(true)
    expect(isPrivateOrMetadataIp('100:0:0:0:1::1')).toBe(true)
    expect(isPrivateOrMetadataIp('2606:4700:4700::1111')).toBe(false)

    expect(
      await checkProxyTargetAllowed(new URL('http://127.0.0.1:8787/v1/models'), true, 8787)
    ).toContain('Self-proxy')
    expect(
      await checkProxyTargetAllowed(
        new URL('http://127.0.0.1:9999/_proxy?url=https://example.com'),
        true,
        8787
      )
    ).toContain('Self-proxy')

    // Symlink escape inside distDir must return 403 Forbidden
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ds-byok-symlink-'))
    const outsideSecret = path.join(os.tmpdir(), `ds-outside-${Date.now()}.txt`)
    writeFileSync(outsideSecret, 'TOP_SECRET_OUTSIDE_DIST', 'utf8')
    writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>ok</title>', 'utf8')
    symlinkSync(outsideSecret, path.join(tmp, 'leak.txt'))

    const app = createAppServer({ distDir: tmp, restrictLoopbackHost: true })
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()))
    const addr = app.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      const leakRes = await fetch(`http://127.0.0.1:${port}/leak.txt`)
      expect(leakRes.status).toBe(403)
      expect(await leakRes.text()).not.toContain('TOP_SECRET_OUTSIDE_DIST')

      const htmlRes = await fetch(`http://127.0.0.1:${port}/`)
      expect(htmlRes.status).toBe(200)
      expect(htmlRes.headers.get('content-security-policy')).toContain("script-src 'self'")

      const missingImg = await fetch(`http://127.0.0.1:${port}/docs/images/missing.png`)
      expect(missingImg.status).toBe(404)
    } finally {
      await new Promise<void>((resolve) =>
        (app as http.Server).close(() => {
          resolve()
        })
      )
      rmSync(tmp, { recursive: true, force: true })
      rmSync(outsideSecret, { force: true })
    }
  })
})
