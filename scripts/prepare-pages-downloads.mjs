import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Only mirror an existing, immutable public Release. The bytes stay unchanged:
 * compare them with that Release's SHA256SUMS before publishing to GitHub Pages.
 */
export const preparePagesDownloads = async (sourceDir, siteDir, tag) => {
  if (!/^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error('Invalid release tag')
  }

  const expectedFiles = {
    android: `deepseek-chat-byok-${tag}-android-release.apk`,
    desktop: `deepseek-chat-byok-${tag}-portable.zip`,
  }
  const inventory = await readdir(sourceDir)
  const checksumFile = await readFile(path.join(sourceDir, 'SHA256SUMS.txt'), 'utf8')
  const sums = new Map()
  for (const line of checksumFile.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line)
    if (!match) continue
    if (sums.has(match[2])) throw new Error(`Duplicate checksum: ${match[2]}`)
    sums.set(match[2], match[1].toLowerCase())
  }

  const staged = {}
  for (const [platform, name] of Object.entries(expectedFiles)) {
    if (inventory.filter((item) => item === name).length !== 1) {
      throw new Error(`Required Release asset missing: ${name}`)
    }
    const file = path.join(sourceDir, name)
    const details = await stat(file)
    if (!details.isFile() || details.size < 1 || details.size > 64 * 1024 * 1024) {
      throw new Error(`Invalid Release asset size: ${name}`)
    }
    const expected = sums.get(name)
    if (!expected) throw new Error(`Missing published checksum for ${name}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    const actual = hash.digest('hex')
    if (actual !== expected) throw new Error(`Release checksum mismatch: ${name}`)
    staged[platform] = { filename: name, sha256: actual, bytes: details.size }
  }

  // No copy starts before both release files have passed the checksum gate.
  const outputDir = path.join(siteDir, 'downloads')
  await mkdir(outputDir, { recursive: true })
  for (const info of Object.values(staged)) {
    await copyFile(path.join(sourceDir, info.filename), path.join(outputDir, info.filename))
  }
  await writeFile(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, tag, ...staged }, null, 2) + '\n'
  )
  return { tag, ...staged }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [sourceDir, siteDir, tag] = process.argv.slice(2)
  if (!sourceDir || !siteDir || !tag) {
    console.error('Usage: node scripts/prepare-pages-downloads.mjs <assets-dir> <dist-dir> <release-tag>')
    process.exitCode = 2
  } else {
    preparePagesDownloads(sourceDir, siteDir, tag)
      .then((result) => console.log(`Pages mirrored ${result.tag}: ${result.android.filename}, ${result.desktop.filename}`))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      })
  }
}
