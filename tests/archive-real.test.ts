import fs from 'node:fs'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { applyContextBudget } from '../src/services/chat/contextBudget.js'
import { EXPORT_FORMAT_VERSION } from '../src/services/chat/history/format.js'
import { stripHistoricalSearchBlocks } from '../src/services/chat/history/importArchive.js'
import { INDEX_PATH, MANIFEST_PATH, sessionPath } from '../src/services/chat/history/paths.js'
import {
  checkManifest,
  readSessionFile,
  readSessionIndex,
} from '../src/services/chat/history/schema.js'
import { toIndexEntry, toSessionFile } from '../src/services/chat/history/toArchive.js'
import { toLocalSession } from '../src/services/chat/history/toLocal.js'
import { readArchive, readEntry, readNamedEntry } from '../src/services/chat/history/zipReader.js'
import type { Session } from '../src/services/chat/types.js'

const REAL_ZIP = process.env.DEEPSEEK_REAL_ARCHIVE ?? ''
const hasRealZip = REAL_ZIP !== '' && fs.existsSync(REAL_ZIP)

const openLazyZipFile = async (filePath: string): Promise<File> => {
  const blob = await fs.openAsBlob(filePath, { type: 'application/zip' })
  return {
    name: 'deepseek_export.zip',
    size: blob.size,
    type: blob.type,
    slice: (start?: number, end?: number, contentType?: string) =>
      blob.slice(start, end, contentType),
    arrayBuffer: () => blob.arrayBuffer(),
    text: () => blob.text(),
    stream: () => blob.stream(),
  } as unknown as File
}

describe('DeepSeek official export v3 lazy central-directory selective reader', () => {
  it('reads archive index without scanning unrelated entries and trims oversized multi-round sessions', async () => {
    const longMessages: Session['messages'] = []
    for (let i = 1; i <= 40; i += 1) {
      longMessages.push(
        {
          id: `u-${i}`,
          role: 'user',
          createdAt: 1_760_000_000_000 + i * 2000,
          content: `Turn ${i}: ` + 'context-detail '.repeat(120),
          files: [],
        },
        {
          id: `a-${i}`,
          role: 'assistant',
          createdAt: 1_760_000_000_000 + i * 2000 + 1000,
          model: 'deepseek-chat',
          thinking: false,
          search: i === 1,
          prefix: false,
          status: 'done',
          stopReason: 'end_turn',
          blocks: [
            ...(i === 1
              ? [
                  {
                    type: 'server_tool_use' as const,
                    id: 'srvtoolu_s_1_0123456789abcdef0123456789abcdef',
                    name: 'deepseek_web_search' as const,
                    input: { action: 'search' as const, queries: ['noise'] },
                    caller: { type: 'direct' as const },
                    kind: 'search' as const,
                  },
                ]
              : []),
            { type: 'text', text: `Reply ${i}: ` + 'story-output '.repeat(150) },
          ],
        }
      )
    }

    const s1: Session = {
      id: '10101010-1010-4010-8010-101010101010',
      title: 'Long Session',
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_200_000,
      messages: longMessages,
    }
    const s2: Session = {
      id: '20202020-2020-4020-8020-202020202020',
      title: 'Ignored Session',
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_100_000,
      messages: [
        { id: 'u-x', role: 'user', createdAt: 1_760_000_000_000, content: 'hi', files: [] },
        {
          id: 'a-x',
          role: 'assistant',
          createdAt: 1_760_000_001_000,
          model: 'deepseek-chat',
          prefix: false,
          status: 'done',
          stopReason: 'end_turn',
          blocks: [{ type: 'text', text: 'ok' }],
        },
      ],
    }

    const sf1 = toSessionFile(s1, () => null)
    const sf2 = toSessionFile(s2, () => null)
    const zipBytes = zipSync({
      [MANIFEST_PATH]: strToU8(JSON.stringify({ export_format_version: EXPORT_FORMAT_VERSION })),
      [sessionPath(s1.id)]: strToU8(JSON.stringify(sf1)),
      [sessionPath(s2.id)]: strToU8(JSON.stringify(sf2)),
      [INDEX_PATH]: strToU8(JSON.stringify([toIndexEntry(sf1), toIndexEntry(sf2)])),
    })
    const file = new File([Buffer.from(zipBytes)], 'synthetic.zip', { type: 'application/zip' })

    const manifestBlob = await readNamedEntry(file, MANIFEST_PATH)
    expect(manifestBlob).not.toBeNull()
    if (!manifestBlob) {
      throw new Error('manifest missing')
    }
    checkManifest(JSON.parse(await manifestBlob.text()))

    const indexBlob = await readNamedEntry(file, INDEX_PATH)
    expect(indexBlob).not.toBeNull()
    if (!indexBlob) {
      throw new Error('index missing')
    }
    const index = readSessionIndex(JSON.parse(await indexBlob.text()))
    expect(index).toHaveLength(2)

    const loadedIds: string[] = []
    for await (const entry of readArchive(
      file,
      (entryPath) =>
        entryPath === MANIFEST_PATH || entryPath === sessionPath(s1.id) || entryPath === INDEX_PATH
    )) {
      const blob = await readEntry(entry)
      if (entry.path === sessionPath(s1.id)) {
        const local = toLocalSession(readSessionFile(JSON.parse(await blob.text())))
        const stripped = stripHistoricalSearchBlocks(local.session)
        loadedIds.push(stripped.id)
        const trimmed = applyContextBudget(stripped.messages, { maxRounds: 10, maxTokens: 24_000 })
        expect(trimmed.totalRounds).toBe(40)
        expect(trimmed.keptRounds).toBeLessThanOrEqual(10)
        expect(trimmed.estimatedHistoryTokens).toBeLessThanOrEqual(24_000)
        expect(trimmed.estimatedHistoryTokens).toBeLessThan(trimmed.fullHistoryTokens * 0.4)
      }
    }
    expect(loadedIds).toEqual([s1.id])
  })
})

describe.skipIf(!hasRealZip)('optional local DeepSeek real export archive verification', () => {
  it('validates all exported sessions and selective-imports largest session within budget', async () => {
    const file = await openLazyZipFile(REAL_ZIP)

    const manifestBlob = await readNamedEntry(file, MANIFEST_PATH)
    expect(manifestBlob).not.toBeNull()
    if (!manifestBlob) {
      throw new Error('manifest.json missing')
    }
    checkManifest(JSON.parse(await manifestBlob.text()))

    const indexBlob = await readNamedEntry(file, INDEX_PATH)
    expect(indexBlob).not.toBeNull()
    if (!indexBlob) {
      throw new Error('chat_session_index.json missing')
    }
    const index = readSessionIndex(JSON.parse(await indexBlob.text()))
    expect(index.length).toBeGreaterThan(0)

    const largest = [...index].sort((a, b) => b.message_count - a.message_count)[0]
    expect(largest).toBeDefined()
    if (!largest) {
      throw new Error('no sessions in index')
    }

    const largestBlob = await readNamedEntry(file, sessionPath(largest.id))
    expect(largestBlob).not.toBeNull()
    if (largestBlob) {
      const megaSession = toLocalSession(
        readSessionFile(JSON.parse(await largestBlob.text()))
      ).session
      const trimmed = applyContextBudget(megaSession.messages, { maxRounds: 12, maxTokens: 24_000 })
      expect(trimmed.keptRounds).toBeLessThanOrEqual(12)
      expect(trimmed.estimatedHistoryTokens).toBeLessThanOrEqual(24_000)
    }

    let sessionCount = 0
    for await (const entry of readArchive(file, (entryPath) => !entryPath.includes('_files/'))) {
      const blob = await readEntry(entry)
      if (entry.path.startsWith('chat_sessions/') && entry.path.endsWith('.json')) {
        const parsed = readSessionFile(JSON.parse(await blob.text()))
        const local = toLocalSession(parsed)
        const stripped = stripHistoricalSearchBlocks(local.session)
        expect(stripped.messages.length).toBe(local.session.messages.length)
        sessionCount += 1
      }
    }
    expect(sessionCount).toBe(index.length)
  }, 30_000)
})
