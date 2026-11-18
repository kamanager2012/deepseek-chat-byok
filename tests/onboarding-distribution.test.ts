import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = (name: string) => readFileSync(path.join(ROOT, name), 'utf8')

describe('Public BYOK onboarding and distribution disclosures', () => {
  it('explains browser CORS and provides a real official API Key entry point', () => {
    const guide = source('public/get-started.html')
    expect(guide).toContain('https://platform.deepseek.com/api_keys')
    expect(guide).toContain('浏览器跨域')
    expect(guide).toContain('正确的 Key')
    expect(guide).toContain('安卓正式版')
    expect(guide).toContain('Node.js 22+')
    expect(guide).toContain('iPhone / iPad')
    expect(guide).not.toContain('稳定畅聊')
  })

  it('keeps JSON-LD parseable and declares an independent product', () => {
    const guide = source('public/get-started.html')
    const structuredData = Array.from(
      guide.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
      (match) => JSON.parse(match[1]) as { '@type': string; mainEntity?: unknown[] }
    )
    expect(structuredData.map((item) => item['@type'])).toEqual([
      'SoftwareApplication',
      'FAQPage',
    ])
    expect(structuredData[1]?.mainEntity).toHaveLength(5)
    expect(guide).toContain('非官方出品')
  })

  it('aligns README and AI-facing metadata with actual browser limitations', () => {
    expect(source('README.zh-CN.md')).toContain('浏览器跨域')
    expect(source('README.md')).toContain('browser CORS')
    expect(source('public/llms.txt')).toContain('no native iOS/iPadOS package')
    expect(source('src/index.html')).not.toContain('稳定畅聊')
    expect(source('docs/xiaohongshu/xiaohongshu-launch-pack.md')).toContain(
      'iPhone / iPad 暂无独立安装包'
    )
  })
})
