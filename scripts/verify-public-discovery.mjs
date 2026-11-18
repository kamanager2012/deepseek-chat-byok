import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertLandingDownloadFlow } from './verify-live-downloads.mjs'

const readDist = (name) => readFileSync(new URL(`../dist/${name}`, import.meta.url), 'utf8')
const home = readDist('index.html')
const guide = readDist('get-started.html')
const guideJs = readDist('get-started.js')
const llms = readDist('llms.txt')
const sitemap = readDist('sitemap.xml')

const origin = 'https://kamanager2012.github.io/deepseek-chat-byok/'
for (const url of [origin, `${origin}get-started.html`]) {
  assert.ok(sitemap.includes(`<loc>${url}</loc>`), `Missing sitemap URL: ${url}`)
}
assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/)
assert.match(home, /DeepSeek 聊天记录导入与自带 API Key/)
assert.match(home, /<meta property="og:image"/)
assert.match(home, /<meta name="twitter:card" content="summary_large_image"/)
assert.match(home, /"@type"\s*:\s*"SoftwareApplication"/)
assert.match(guide, /导入 DeepSeek 旧聊天，用自己的 API Key 继续聊/)
assert.match(guide, /"@type"\s*:\s*"FAQPage"/)
assert.match(guide, /同源存储边界/)
assertLandingDownloadFlow(guide)
assert.match(llms, /Not an official DeepSeek product/)
assert.match(llms, /releases\/latest/)
assert.ok(
  !/Release Target Version:\s*v\d+\.\d+\.\d+/.test(llms),
  'llms.txt must not pin a stale version'
)
assert.ok(!guideJs.includes('最新官方安卓正式版'), 'Non-official APK must not be named official')

const XHS_SLIDES = [
  'xhs-slide-1-cover.png',
  'xhs-slide-2-import.png',
  'xhs-slide-3-memory-byok.png',
  'xhs-slide-4-howto.png',
]
for (const slide of XHS_SLIDES) {
  const png = readFileSync(new URL(`../docs/xiaohongshu/${slide}`, import.meta.url))
  assert.equal(
    png.subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
    `Invalid PNG header: ${slide}`
  )
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assert.deepEqual(
    { slide, width, height },
    { slide, width: 1080, height: 1440 },
    `Xiaohongshu slide must be 1080x1440 (3:4): ${slide}`
  )
}

console.log(
  'Public discovery acceptance passed: sitemap, identity, social metadata, honest limits, 1080x1440 slides'
)
