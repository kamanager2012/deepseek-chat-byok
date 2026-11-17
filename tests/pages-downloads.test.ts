import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { preparePagesDownloads } from '../scripts/prepare-pages-downloads.mjs'

const tag = 'v0.3.1'
const apk = `deepseek-chat-byok-${tag}-android-release.apk`
const zip = `deepseek-chat-byok-${tag}-portable.zip`
const directories: string[] = []
const digest = (data: string) => createHash('sha256').update(data).digest('hex')

const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byok-pages-'))
  directories.push(root)
  const source = path.join(root, 'release')
  const site = path.join(root, 'dist')
  await mkdir(source)
  await mkdir(site)
  await writeFile(path.join(source, apk), 'signed APK sample')
  await writeFile(path.join(source, zip), 'portable ZIP sample')
  const checksums = `${digest('signed APK sample')}  ${apk}\n${digest('portable ZIP sample')}  ${zip}\n`
  await writeFile(path.join(source, 'SHA256SUMS.txt'), checksums)
  return { source, site }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Pages release download mirror', () => {
  it('copies only verified original release files and generates a versioned manifest', async () => {
    const { source, site } = await fixture()
    const result = await preparePagesDownloads(source, site, tag)
    expect(result.android.sha256).toBe(digest('signed APK sample'))
    expect(await readFile(path.join(site, 'downloads', apk), 'utf8')).toBe('signed APK sample')
    expect(await readFile(path.join(site, 'downloads', zip), 'utf8')).toBe('portable ZIP sample')
    const manifest = JSON.parse(await readFile(path.join(site, 'downloads/manifest.json'), 'utf8'))
    expect(manifest.tag).toBe(tag)
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.desktop.filename).toBe(zip)
  })

  it('fails closed if Release bytes do not match SHA256SUMS', async () => {
    const { source, site } = await fixture()
    await writeFile(path.join(source, apk), 'tampered')
    await expect(preparePagesDownloads(source, site, tag)).rejects.toThrow('checksum mismatch')
  })

  it('never accepts a debug APK in place of the signed Release APK', async () => {
    const { source, site } = await fixture()
    await rm(path.join(source, apk))
    await writeFile(path.join(source, `deepseek-chat-byok-${tag}-android-debug.apk`), 'debug')
    await expect(preparePagesDownloads(source, site, tag)).rejects.toThrow('Required Release asset missing')
  })

  it('rejects invalid release tags and wrong-identity checksums', async () => {
    const { source, site } = await fixture()
    await expect(preparePagesDownloads(source, site, '../../other')).rejects.toThrow('Invalid release tag')
    await writeFile(path.join(source, 'SHA256SUMS.txt'), `${digest('other')}  ${apk}\n`)
    await expect(preparePagesDownloads(source, site, tag)).rejects.toThrow('checksum mismatch')
  })
})
