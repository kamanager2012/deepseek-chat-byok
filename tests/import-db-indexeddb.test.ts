import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { exportEmergencyBackup } from '../src/services/chat/backup.js'
import * as db from '../src/services/chat/db.js'
import { exportArchive } from '../src/services/chat/history/exportArchive.js'
import { importArchive, inspectArchiveIndex } from '../src/services/chat/history/importArchive.js'
import type { Session } from '../src/services/chat/types.js'

const deleteRawSessionRecordOnly = async (sessionId: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open('chat-demo')
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const idb = req.result
      const tx = idb.transaction(['sessions'], 'readwrite')
      tx.objectStore('sessions').delete(sessionId)
      tx.oncomplete = () => {
        idb.close()
        resolve()
      }
      tx.onerror = () => {
        idb.close()
        reject(tx.error)
      }
    }
  })

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

    // Mutate local s1 (extra user turn + pinned memoryPrompt) before merge import
    if (loadedS1) {
      await db.saveSession({
        ...loadedS1,
        memoryPrompt: 'Canon rule: Alice lives in Kyoto.',
        messages: [
          ...loadedS1.messages,
          {
            id: `${s1.id}-u2-local`,
            role: 'user',
            createdAt: 1_760_000_200_000,
            content: 'Newer local turn must survive default merge',
            files: [],
          },
        ],
      })
    }

    // Default merge ('keep-existing') preserves local s1 turns & memoryPrompt while adding s3
    await db.clearStaging()
    const countMerge = await importArchive(archiveBFile, {
      selectedIds: new Set([s1.id, s3.id]),
    })
    expect(countMerge).toBe(2)
    const defaultMergeStats = await db.commitStagingWithResult('merge')
    expect(defaultMergeStats.importedCount).toBe(1)
    expect(defaultMergeStats.keptExistingCount).toBe(1)
    expect(defaultMergeStats.summaries.map((s) => s.id).sort()).toEqual([s1.id, s3.id].sort())

    const preservedS1 = await db.loadSession(s1.id)
    expect(preservedS1?.memoryPrompt).toBe('Canon rule: Alice lives in Kyoto.')
    expect(preservedS1?.messages).toHaveLength(3)
    expect(preservedS1?.messages[2]?.role).toBe('user')
    expect(await db.loadSession(s3.id)).toBeDefined()

    // Explicit 'keep-both' imports conflicting s1 under a new ID without touching local s1
    await db.clearStaging()
    await importArchive(archiveBFile, { selectedIds: new Set([s1.id]) })
    const keepBothStats = await db.commitStagingWithResult('merge', 'keep-both', ' (Imported)')
    expect(keepBothStats.importedCount).toBe(1)
    expect(keepBothStats.copiedConflictCount).toBe(1)
    expect(keepBothStats.summaries).toHaveLength(3)
    const copiedSummary = keepBothStats.summaries.find(
      (s) => s.id !== s1.id && s.id !== s3.id && s.title.endsWith('(Imported)')
    )
    expect(copiedSummary).toBeDefined()
    expect((await db.loadSession(s1.id))?.messages).toHaveLength(3)

    // Explicit 'overwrite' replaces s1 turns while keeping existing memoryPrompt if missing
    await db.clearStaging()
    await importArchive(archiveBFile, { selectedIds: new Set([s1.id]) })
    const overwriteStats = await db.commitStagingWithResult('merge', 'overwrite')
    expect(overwriteStats.overwrittenCount).toBe(1)
    const overwrittenS1 = await db.loadSession(s1.id)
    expect(overwrittenS1?.memoryPrompt).toBe('Canon rule: Alice lives in Kyoto.')
    expect(overwrittenS1?.messages).toHaveLength(2)
  })

  it('verifies emergency backup counts honestly on partial corruption and total unreadability', async () => {
    const sKeep = makeSession('44444444-4444-4444-8444-444444444444', 'Healthy Chat', false)
    const sMissing = makeSession('55555555-5555-4555-8555-555555555555', 'Corrupted Chat', false)

    await db.clearStaging()
    await db.commitStaging('replace')
    await db.saveSession(sKeep)
    await db.saveSession(sMissing)

    const cleanBackup = await exportEmergencyBackup()
    expect(cleanBackup.totalCount).toBe(2)
    expect(cleanBackup.exportedCount).toBe(2)
    expect(cleanBackup.skippedIds).toEqual([])

    // Simulate missing session body while summary still exists in sessionSummaries
    await deleteRawSessionRecordOnly(sMissing.id)
    const partialBackup = await exportEmergencyBackup()
    expect(partialBackup.totalCount).toBe(2)
    expect(partialBackup.exportedCount).toBe(1)
    expect(partialBackup.skippedIds).toEqual([sMissing.id])

    const recoveredFile = new File([partialBackup.blob], partialBackup.name, {
      type: 'application/zip',
    })
    const recoveredIndex = await inspectArchiveIndex(recoveredFile)
    expect(recoveredIndex.map((item) => item.id)).toEqual([sKeep.id])

    // If all indexed sessions are unreadable, emergency backup must fail rather than emit empty ZIP
    await deleteRawSessionRecordOnly(sKeep.id)
    await expect(exportEmergencyBackup()).rejects.toThrow(/0 of 2/)
  })
})
