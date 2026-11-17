import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import type { SessionIndexEntry } from './history/format.js'
import { commitHistoryChange, replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'
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

export type ImportBackupOptions = {
  selectedIds?: ReadonlySet<string>
  mode?: 'merge' | 'replace'
  stripSearchBlocks?: boolean
}

/**
 * 校验并导入历史对话归档；支持选择指定会话、增量合并（默认保留已有记录）或覆盖替换。
 * 返回实际写入本次的会话数量。
 */
export const importHistory = (file: File, options: ImportBackupOptions = {}): Promise<number> =>
  enqueueBackup(async () => {
    const { selectedIds, mode = 'replace', stripSearchBlocks = false } = options
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    let importedCount = 0
    await commitHistoryChange(mode, async () => {
      importedCount = await importArchive(file, { selectedIds, stripSearchBlocks })
    })
    return importedCount
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
