import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import * as db from '../src/services/chat/db.js'
import { exportArchive } from '../src/services/chat/history/exportArchive.js'
import { importArchive, inspectArchiveIndex } from '../src/services/chat/history/importArchive.js'
import type { Session } from '../src/services/chat/types.js'

const makeSession = (id: string, title: string, withMediaAndSearch = false): Session => ({
  id,
  title,
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_100_000,
  messages: [
    {
      id: `${id}-u1`,
      role: 'user',
      createdAt: 1_760_000_000_000,
      content: `Hello from ${id}`,
      files: withMediaAndSearch
        ? [
            {
              id: 'file-png-1',
              serverId: null,
              name: 'cover.png',
              size: 16,
              isImage: true,
              mimeType: 'image/png',
            },
          ]
        : [],
    },
    {
      id: `${id}-a1`,
      role: 'assistant',
      createdAt: 1_760_000_010_000,
      model: 'deepseek-chat',
      thinking: false,
      search: withMediaAndSearch,
      prefix: false,
      status: 'done',
      stopReason: 'end_turn',
      blocks: withMediaAndSearch
        ? [
            {
              type: 'server_tool_use',
              id: 'srvtoolu_s_1_0123456789abcdef0123456789abcdef',
              name: 'deepseek_web_search',
              input: { action: 'search', queries: ['test'] },
              caller: { type: 'direct' },
              kind: 'search',
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_s_1_0123456789abcdef0123456789abcdef',
              kind: 'search',
              content: [],
            },
            { type: 'text', text: `Reply for ${id}` },
          ]
        : [{ type: 'text', text: `Reply for ${id}` }],
    },
  ],
})

describe('IndexedDB selective import, strip search, and non-destructive merge', () => {
  it('selectively imports sessions, strips bulky search blocks, detects PNG MIME, and preserves memoryPrompt on merge', async () => {
    const pngHeader = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ])
    await db.saveFiles([{ id: 'file-png-1', blob: new Blob([pngHeader], { type: 'image/png' }) }])

    const s1 = makeSession('11111111-1111-4111-8111-111111111111', 'Story Arc One', true)
    const s2 = makeSession('22222222-2222-4222-8222-222222222222', 'Skipped Session', false)
    const s3 = makeSession('33333333-3333-4333-8333-333333333333', 'Merged Chapter Two', false)

    const archiveABlob = await exportArchive([s1, s2])
    const archiveAFile = new File([archiveABlob], 'deepseek_data-a.zip', {
      type: 'application/zip',
    })
    const archiveBBlob = await exportArchive([s1, s3])
    const archiveBFile = new File([archiveBBlob], 'deepseek_data-b.zip', {
      type: 'application/zip',
    })

    // Clear DB cleanly via staging replace
    await db.clearStaging()
    expect(await db.commitStaging('replace')).toEqual([])

    const index = await inspectArchiveIndex(archiveAFile)
    expect(index.map((entry) => entry.id).sort()).toEqual([s1.id, s2.id].sort())

    // Selective import of s1 with search-block stripping
    await db.clearStaging()
    const count1 = await importArchive(archiveAFile, {
      selectedIds: new Set([s1.id]),
      stripSearchBlocks: true,
    })
    expect(count1).toBe(1)
    const afterFirst = await db.commitStaging('replace')
    expect(afterFirst.map((s) => s.id)).toEqual([s1.id])

    const loadedS1 = await db.loadSession(s1.id)
    expect(loadedS1).toBeDefined()
    const assistantMsg = loadedS1?.messages[1]
    expect(assistantMsg?.role).toBe('assistant')
    if (assistantMsg?.role === 'assistant') {
      expect(assistantMsg.blocks).toEqual([{ type: 'text', text: `Reply for ${s1.id}` }])
    }

    const loadedPng = await db.loadFile('file-png-1')
    expect(loadedPng?.type).toBe('image/png')

    // Pin custom memoryPrompt onto s1 before merge import
    if (loadedS1) {
      await db.saveSession({ ...loadedS1, memoryPrompt: 'Canon rule: Alice lives in Kyoto.' })
    }

    // Merge import s1 (without memoryPrompt in archive) + new session s3
    await db.clearStaging()
    const countMerge = await importArchive(archiveBFile, {
      selectedIds: new Set([s1.id, s3.id]),
    })
    expect(countMerge).toBe(2)
    const afterMerge = await db.commitStaging('merge')
    expect(afterMerge.map((s) => s.id).sort()).toEqual([s1.id, s3.id].sort())

    const reloadedS1 = await db.loadSession(s1.id)
    expect(reloadedS1?.memoryPrompt).toBe('Canon rule: Alice lives in Kyoto.')
    expect(await db.loadSession(s3.id)).toBeDefined()
  })
})
