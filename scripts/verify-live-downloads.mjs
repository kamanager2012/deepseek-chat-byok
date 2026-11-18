import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const maxBytes = 64 * 1024 * 1024

export const REQUIRED_LANDING_MARKERS = [
  '客户端下载与使用指南',
  'id="android-download"',
  'id="desktop-download"',
  'id="download-status"',
  'id="release-tag"',
  'href="./downloads/manifest.json"',
  'src="./get-started.js"',
]

/** Verify that the guide page contains the canonical title anchor and live download controls. */
export const assertLandingDownloadFlow = (html) => {
  if (REQUIRED_LANDING_MARKERS.some((marker) => !html.includes(marker))) {
    throw new Error('Live landing page lacks the expected download flow')
  }
}

/** Validate the deployed bytes against original GitHub Release asset digests. */
export const verifyLiveDownloads = async (siteUrl, repo, fetcher = fetch, authToken = '') => {
  const root = new URL(siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`)
  if (root.protocol !== 'https:') throw new Error('Public site URL must use HTTPS')
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    throw new Error('Invalid GitHub repository')
  }

  const manifestUrl = new URL('downloads/manifest.json', root)
  const manifestResponse = await fetcher(manifestUrl, { cache: 'no-store' })
  if (!manifestResponse.ok) throw new Error(`Live manifest HTTP ${manifestResponse.status}`)
  const manifest = await manifestResponse.json()
  if (
    manifest.schemaVersion !== 1 ||
    !/^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(manifest.tag)
  ) {
    throw new Error('Unexpected live manifest format or release tag')
  }

  const releaseResponse = await fetcher(
    `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(manifest.tag)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'deepseek-chat-byok-pages-live-smoke',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    }
  )
  if (!releaseResponse.ok) throw new Error(`Release metadata HTTP ${releaseResponse.status}`)
  const release = await releaseResponse.json()
  if (release.draft || release.prerelease || release.tag_name !== manifest.tag) {
    throw new Error('Live mirror is not tied to a published stable Release')
  }

  const validated = {}
  for (const [platform, suffix] of [
    ['android', '-android-release.apk'],
    ['desktop', '-portable.zip'],
  ]) {
    const item = manifest[platform]
    const expectedName = `deepseek-chat-byok-${manifest.tag}${suffix}`
    if (
      !item ||
      item.filename !== expectedName ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1 ||
      item.bytes > maxBytes
    ) {
      throw new Error(`Invalid ${platform} manifest entry`)
    }
    const asset = release.assets?.find((value) => value.name === expectedName)
    if (!asset || asset.digest !== `sha256:${item.sha256}` || asset.size !== item.bytes) {
      throw new Error(`Published Release digest/size mismatch: ${platform}`)
    }
    const fileUrl = new URL(`downloads/${encodeURIComponent(expectedName)}`, root)
    const response = await fetcher(fileUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Live ${platform} HTTP ${response.status}`)
    if (response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
      throw new Error(`Live ${platform} returned HTML instead of installer`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength !== item.bytes) throw new Error(`Live ${platform} byte count mismatch`)
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    if (actualHash !== item.sha256) throw new Error(`Live ${platform} SHA-256 mismatch`)
    validated[platform] = { filename: expectedName, bytes: item.bytes, sha256: actualHash }
  }

  const landing = await fetcher(new URL('get-started.html', root), { cache: 'no-store' })
  if (!landing.ok) throw new Error(`Live landing HTTP ${landing.status}`)
  const html = await landing.text()
  assertLandingDownloadFlow(html)
  return { tag: manifest.tag, ...validated }
}

const runCli = async () => {
  const site = process.argv[2]
  const repo = process.env.GITHUB_REPOSITORY
  if (!site || !repo) throw new Error('SITE_URL and GITHUB_REPOSITORY are required')
  let lastError
  // GitHub Pages CDN may need a short propagation window after the deployment step.
  for (let i = 0; i < 10; i += 1) {
    try {
      const result = await verifyLiveDownloads(site, repo, fetch, process.env.GH_TOKEN ?? '')
      console.log(`Public download acceptance PASSED: ${JSON.stringify(result)}`)
      return
    } catch (error) {
      lastError = error
      console.warn(
        `Live acceptance attempt ${i + 1} failed: ${error instanceof Error ? error.message : String(error)}`
      )
      if (i < 9) await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }
  throw lastError
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
