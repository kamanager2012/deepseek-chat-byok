import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assertLandingDownloadFlow,
  REQUIRED_LANDING_MARKERS,
  verifyLiveDownloads,
} from '../scripts/verify-live-downloads.mjs'

const tag = 'v0.3.1'
const android = `deepseek-chat-byok-${tag}-android-release.apk`
const desktop = `deepseek-chat-byok-${tag}-portable.zip`
const androidData = new TextEncoder().encode('apk-binary-bytes')
const desktopData = new TextEncoder().encode('zip-binary-bytes')
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const manifest = {
  schemaVersion: 1,
  tag,
  android: { filename: android, bytes: androidData.length, sha256: sha(androidData) },
  desktop: { filename: desktop, bytes: desktopData.length, sha256: sha(desktopData) },
}
const release = {
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: [
    { name: android, digest: `sha256:${manifest.android.sha256}`, size: androidData.length },
    { name: desktop, digest: `sha256:${manifest.desktop.sha256}`, size: desktopData.length },
  ],
}
const root = 'https://example.org/deepseek-chat-byok/'
const liveGuideHtml = readFileSync(new URL('../public/get-started.html', import.meta.url), 'utf8')

const fakeFetch =
  (
    options: {
      corruptZip?: boolean
      corruptDigest?: boolean
      missingApk?: boolean
      missingGuide?: boolean
    } = {}
  ) =>
  async (input: URL | RequestInfo) => {
    const url = String(input)
    if (url.endsWith('/downloads/manifest.json')) {
      return Response.json(manifest)
    }
    if (url.includes('api.github.com/')) {
      return Response.json(
        options.corruptDigest
          ? {
              ...release,
              assets: release.assets.map((a) => ({ ...a, digest: 'sha256:' + '0'.repeat(64) })),
            }
          : release
      )
    }
    if (url.endsWith('/' + android)) {
      return options.missingApk ? new Response('404', { status: 404 }) : new Response(androidData)
    }
    if (url.endsWith('/' + desktop)) {
      return new Response(options.corruptZip ? 'modified zip' : desktopData)
    }
    if (url.endsWith('/get-started.html')) {
      return new Response(options.missingGuide ? '<html>guide unavailable</html>' : liveGuideHtml)
    }
    return new Response('404', { status: 404 })
  }

describe('Public Pages download post-deploy acceptance', () => {
  it('validates two actual downloaded binary payloads against official release digests', async () => {
    const result = await verifyLiveDownloads(root, 'kamanager2012/deepseek-chat-byok', fakeFetch())
    expect(result.tag).toBe('v0.3.1')
    expect(result.android.sha256).toBe(manifest.android.sha256)
    expect(result.desktop.bytes).toBe(desktopData.length)
  })

  it('rejects an APK URL returning 404 or a corrupted desktop ZIP', async () => {
    await expect(
      verifyLiveDownloads(root, 'kamanager2012/deepseek-chat-byok', fakeFetch({ missingApk: true }))
    ).rejects.toThrow('Live android HTTP 404')
    await expect(
      verifyLiveDownloads(root, 'kamanager2012/deepseek-chat-byok', fakeFetch({ corruptZip: true }))
    ).rejects.toThrow()
  })

  it('rejects an HTML landing page with missing actual download controls', async () => {
    await expect(
      verifyLiveDownloads(
        root,
        'kamanager2012/deepseek-chat-byok',
        fakeFetch({ missingGuide: true })
      )
    ).rejects.toThrow('Live landing page lacks the expected download flow')
  })

  it('enforces shared landing page contract including guide title and download controls', () => {
    expect(() => assertLandingDownloadFlow(liveGuideHtml)).not.toThrow()
    for (const marker of REQUIRED_LANDING_MARKERS) {
      expect(() => assertLandingDownloadFlow(liveGuideHtml.replaceAll(marker, 'removed'))).toThrow(
        'Live landing page lacks the expected download flow'
      )
    }
  })

  it('does not trust site-provided checksums without checking published Release metadata', async () => {
    await expect(
      verifyLiveDownloads(
        root,
        'kamanager2012/deepseek-chat-byok',
        fakeFetch({ corruptDigest: true })
      )
    ).rejects.toThrow('Published Release digest/size mismatch')
  })
})
