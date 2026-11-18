import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import type { SessionIndexEntry } from './history/format.js'
import { commitHistoryChange, replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'
export type { MergeConflictPolicy } from './db.js'
export type { SessionIndexEntry }

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 毫秒级读取 ZIP 归档的会话目录清单（不解压正文和附件） */
export const inspectBackupArchive = async (file: File): Promise<SessionIndexEntry[]> => {
  const { inspectArchiveIndex } = await import('./history/importArchive.js')
  return inspectArchiveIndex(file)
}

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

export type EmergencyBackupResult = {
  name: string
  blob: Blob
  totalCount: number
  exportedCount: number
  skippedIds: string[]
}

/**
 * 故障降级时的紧急 ZIP 导出：直接遍历持久化 IndexedDB 摘要并逐条核对读写完整性。
 * 若部分会话损坏/丢失但仍有可读数据，保留可恢复 ZIP 并在结果中显式暴露 skippedIds；
 * 若有摘要记录但全部不可读，则显式抛出错误，避免输出空包并误报成功。
 */
export const exportEmergencyBackup = async (): Promise<EmergencyBackupResult> => {
  const summaries = await db.loadSessionSummaries()
  const skippedIds: string[] = []
  let yieldedCount = 0
  let serializeSkippedCount = 0

  async function* readSessions(): AsyncGenerator<Session> {
    for (const summary of summaries) {
      try {
        const loaded = await db.loadSession(summary.id)
        if (!loaded) {
          skippedIds.push(summary.id)
          continue
        }
        yieldedCount += 1
        yield { ...loaded, ...summary }
      } catch {
        skippedIds.push(summary.id)
      }
    }
  }

  const { exportArchive } = await import('./history/exportArchive.js')
  const now = new Date()
  const blob = await exportArchive(readSessions(), {
    onSessionError: (sessionId) => {
      serializeSkippedCount += 1
      skippedIds.push(sessionId)
    },
  })
  const exportedCount = Math.max(0, yieldedCount - serializeSkippedCount)
  if (summaries.length > 0 && exportedCount === 0) {
    const preview = skippedIds.slice(0, 5).join(', ')
    throw new Error(
      `Emergency backup failed: 0 of ${summaries.length} indexed chat(s) readable (${preview})`
    )
  }
  return {
    name: `deepseek_emergency-${formatDate(now)}.zip`,
    blob,
    totalCount: summaries.length,
    exportedCount,
    skippedIds,
  }
}

export type ImportBackupOptions = {
  selectedIds?: ReadonlySet<string>
  mode?: 'merge' | 'replace'
  conflictPolicy?: db.MergeConflictPolicy
  copyTitleSuffix?: string
  stripSearchBlocks?: boolean
}

export type ImportBackupResult = {
  importedCount: number
  keptExistingCount: number
  copiedConflictCount: number
  overwrittenCount: number
}

/**
 * 校验并导入历史对话归档；支持选择指定会话、增量合并（同 ID 冲突默认保留已有记录）或覆盖替换。
 * 返回实际写入/保留统计。
 */
export const importHistory = (
  file: File,
  options: ImportBackupOptions = {}
): Promise<ImportBackupResult> =>
  enqueueBackup(async () => {
    const {
      selectedIds,
      mode = 'replace',
      conflictPolicy = 'keep-existing',
      copyTitleSuffix,
      stripSearchBlocks = false,
    } = options
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    const result = await commitHistoryChange(
      mode,
      async () => {
        await importArchive(file, { selectedIds, stripSearchBlocks })
      },
      { conflictPolicy, copyTitleSuffix }
    )
    return {
      importedCount: result.importedCount,
      keptExistingCount: result.keptExistingCount,
      copiedConflictCount: result.copiedConflictCount,
      overwrittenCount: result.overwrittenCount,
    }
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
