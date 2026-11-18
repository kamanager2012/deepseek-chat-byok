import * as db from '../db.js'
import type { Session } from '../types.js'
import { BackupError, fail } from './errors.js'
import { parseExternalConversationsJson } from './externalFormats.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import {
  ArchiveError,
  isZipFile,
  listArchivePaths,
  readArchive,
  readEntry,
  readNamedEntry,
  skipEntry,
  type ArchiveEntry,
} from './zipReader.js'

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJsonText = async (blob: Blob): Promise<unknown> => {
  const text = await blob.text()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> =>
  readJsonText(await readEntry(entry))

export const stripHistoricalSearchBlocks = (session: Session): Session => ({
  ...session,
  messages: session.messages.map((message) => {
    if (message.role !== 'assistant') {
      return message
    }
    return {
      ...message,
      blocks: message.blocks.filter(
        (block) =>
          block.type !== 'server_tool_use' &&
          block.type !== 'web_search_tool_result' &&
          block.type !== 'web_fetch_tool_result'
      ),
    }
  }),
})

const EXTERNAL_CONVERSATIONS_PATH = 'conversations.json'

const isOsMetadataPath = (entryPath: string): boolean =>
  entryPath.startsWith('__MACOSX/') ||
  entryPath === '.DS_Store' ||
  entryPath.endsWith('/.DS_Store') ||
  entryPath === 'Thumbs.db' ||
  entryPath.endsWith('/Thumbs.db')

const detectArchiveLayout = async (
  file: File
): Promise<{ prefix: string; kind: 'deepseek' | 'external' } | null> => {
  const paths = (await listArchivePaths(file)).filter((p) => !isOsMetadataPath(p))
  const pathSet = new Set(paths)
  if (pathSet.has(MANIFEST_PATH)) {
    return { prefix: '', kind: 'deepseek' }
  }
  if (pathSet.has(EXTERNAL_CONVERSATIONS_PATH)) {
    return { prefix: '', kind: 'external' }
  }
  for (const p of paths) {
    if (p.endsWith(`/${MANIFEST_PATH}`)) {
      const prefix = p.slice(0, -MANIFEST_PATH.length)
      if (/^[^/]+\/$/u.test(prefix)) {
        return { prefix, kind: 'deepseek' }
      }
    }
  }
  for (const p of paths) {
    if (p.endsWith(`/${EXTERNAL_CONVERSATIONS_PATH}`)) {
      const prefix = p.slice(0, -EXTERNAL_CONVERSATIONS_PATH.length)
      if (/^[^/]+\/$/u.test(prefix)) {
        return { prefix, kind: 'external' }
      }
    }
  }
  return null
}

const inspectExternalConversations = async (file: File, prefix = '') => {
  const blob = await readNamedEntry(file, `${prefix}${EXTERNAL_CONVERSATIONS_PATH}`)
  if (!blob) {
    return null
  }
  const parsed = parseExternalConversationsJson(await readJsonText(blob))
  if (!parsed) {
    return fail('backupUnrecognized')
  }
  return parsed
}

/**
 * 仅从中央目录定位并读取 manifest.json 与 chat_session_index.json，
 * 不解压会话正文和海量附件即可毫秒级预览备份里的全部会话列表（兼容系统自动解压后重打包的单层目录 ZIP）。
 */
export const inspectArchiveIndex = async (file: File): Promise<SessionIndexEntry[]> => {
  if (!(await isZipFile(file))) {
    return fail('backupUnrecognized')
  }
  try {
    const layout = await detectArchiveLayout(file)
    if (!layout) {
      return fail('backupUnrecognized')
    }
    if (layout.kind === 'external') {
      const external = await inspectExternalConversations(file, layout.prefix)
      if (!external) {
        return fail('backupUnrecognized')
      }
      return external.index
    }
    const manifestBlob = await readNamedEntry(file, `${layout.prefix}${MANIFEST_PATH}`)
    if (!manifestBlob) {
      return fail('backupUnrecognized')
    }
    checkManifest(await readJsonText(manifestBlob))
    const indexBlob = await readNamedEntry(file, `${layout.prefix}${INDEX_PATH}`)
    if (!indexBlob) {
      return fail('backupIncomplete')
    }
    const entries = readSessionIndex(await readJsonText(indexBlob))
    return [...entries].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
}

/**
 * 检查 ZIP 格式、manifest 及格式版本。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
export const checkArchiveFormat = async (file: File): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    const layout = await detectArchiveLayout(file)
    if (!layout) {
      return fail('backupUnrecognized')
    }
    if (layout.kind === 'external') {
      const external = await inspectExternalConversations(file, layout.prefix)
      if (external) {
        return
      }
      return fail('backupUnrecognized')
    }
    const manifestBlob = await readNamedEntry(file, `${layout.prefix}${MANIFEST_PATH}`)
    if (!manifestBlob) {
      return fail('backupUnrecognized')
    }
    checkManifest(await readJsonText(manifestBlob))
    const indexBlob = await readNamedEntry(file, `${layout.prefix}${INDEX_PATH}`)
    if (!indexBlob) {
      return fail('backupIncomplete')
    }
    readSessionIndex(await readJsonText(indexBlob))
    return
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
}

export type ImportArchiveOptions = {
  /** 仅导入指定 ID 的会话及关联附件；缺省表示全量导入 */
  selectedIds?: ReadonlySet<string>
  /** 导入时清理历史联网搜索/网页抓取结果，减小本地存储开销 */
  stripSearchBlocks?: boolean
}

/**
 * 流式导入归档到暂存区；支持按 selectedIds 只解压选中的会话与附件，跳过其余大附件。
 * 返回成功写入暂存区的会话数。
 */
export const importArchive = async (
  file: File,
  options: ImportArchiveOptions = {}
): Promise<number> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const { selectedIds, stripSearchBlocks = false } = options
  let layout: Awaited<ReturnType<typeof detectArchiveLayout>>
  try {
    layout = await detectArchiveLayout(file)
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (!layout) {
    return fail('backupUnrecognized')
  }
  if (layout.kind === 'external') {
    try {
      const external = await inspectExternalConversations(file, layout.prefix)
      if (!external) {
        return fail('backupUnrecognized')
      }
      let count = 0
      for (const [id, session] of external.sessions) {
        if (selectedIds && !selectedIds.has(id)) {
          continue
        }
        await db.addStagingSession(
          stripSearchBlocks ? stripHistoricalSearchBlocks(session) : session
        )
        count += 1
      }
      return count
    } catch (error) {
      throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
    }
  }

  const { prefix } = layout
  const stripPrefix = (rawPath: string): string | null => {
    if (!prefix) {
      return rawPath
    }
    return rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : null
  }

  let index: SessionIndexEntry[]
  try {
    const manifestBlob = await readNamedEntry(file, `${prefix}${MANIFEST_PATH}`)
    if (!manifestBlob) {
      return fail('backupUnrecognized')
    }
    checkManifest(await readJsonText(manifestBlob))
    const indexBlob = await readNamedEntry(file, `${prefix}${INDEX_PATH}`)
    if (!indexBlob) {
      return fail('backupIncomplete')
    }
    index = readSessionIndex(await readJsonText(indexBlob))
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }

  const listed = new Set(index.map((entry) => entry.id))
  if (listed.size !== index.length) {
    fail('backupIncomplete')
  }

  const imported = new Set<string>()
  const images = new Map<string, string>()
  /** 已保存的原件：文件 ID → MIME。同一图片出现在多个会话目录时只保存一次。 */
  const stored = new Map<string, string>()

  const shouldInclude = (rawPath: string) => {
    if (isOsMetadataPath(rawPath)) {
      return false
    }
    const rel = stripPrefix(rawPath)
    if (rel === null) {
      return true
    }
    if (rel === MANIFEST_PATH || rel === INDEX_PATH || rel === USER_PATH) {
      return false
    }
    if (!selectedIds) {
      return true
    }
    const sid = parseSessionPath(rel)
    if (sid !== null) {
      return selectedIds.has(sid)
    }
    const fileSessionId = /^chat_sessions\/([^/]+)_files\//.exec(rel)?.[1]
    if (fileSessionId) {
      return selectedIds.has(fileSessionId)
    }
    return true
  }

  const loadSessionById = async (sid: string) => {
    if (imported.has(sid)) {
      return
    }
    const blob = await readNamedEntry(file, `${prefix}chat_sessions/${sid}.json`)
    if (!blob) {
      return fail('backupIncomplete')
    }
    const local = toLocalSession(readSessionFile(await readJsonText(blob)))
    if (local.session.id !== sid) {
      fail('backupIncomplete')
    }
    imported.add(sid)
    for (const [imagePath, id] of local.images) {
      images.set(imagePath, id)
    }
    const sessionToStore = stripSearchBlocks
      ? stripHistoricalSearchBlocks(local.session)
      : local.session
    await db.addStagingSession(sessionToStore)
  }

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    const data = await readEntry(entry)
    const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
    await db.saveStagingFiles([{ id, blob: new Blob([data], { type }) }])
    stored.set(id, type)
  }

  try {
    for await (const entry of readArchive(file, shouldInclude)) {
      if (isOsMetadataPath(entry.path)) {
        await skipEntry(entry)
        continue
      }
      const rel = stripPrefix(entry.path)
      if (rel === null) {
        fail('backupIncomplete')
        return 0
      }
      const sessionId = parseSessionPath(rel)
      if (rel === MANIFEST_PATH || rel === INDEX_PATH || rel === USER_PATH) {
        await skipEntry(entry)
      } else if (sessionId !== null) {
        if (imported.has(sessionId)) {
          await skipEntry(entry)
          continue
        }
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        for (const [imagePath, id] of local.images) {
          images.set(imagePath, id)
        }
        const sessionToStore = stripSearchBlocks
          ? stripHistoricalSearchBlocks(local.session)
          : local.session
        await db.addStagingSession(sessionToStore)
      } else {
        const fileSessionId = /^chat_sessions\/([^/]+)_files\//.exec(rel)?.[1]
        if (!fileSessionId || !listed.has(fileSessionId)) {
          fail('backupIncomplete')
          return 0
        }
        if (!imported.has(fileSessionId)) {
          await loadSessionById(fileSessionId)
        }
        if (!rel.startsWith(sessionFilesDir(fileSessionId))) {
          fail('backupIncomplete')
        }
        // 没有被引用的条目不保存，引用了但缺失的图片只展示文件名。
        const id = images.get(rel)
        await (id === undefined ? skipEntry(entry) : saveImage(entry, id))
      }
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (selectedIds) {
    for (const id of selectedIds) {
      if (listed.has(id) && !imported.has(id)) {
        fail('backupIncomplete')
      }
    }
    for (const id of imported) {
      if (!listed.has(id) || !selectedIds.has(id)) {
        fail('backupIncomplete')
      }
    }
  } else if (listed.size !== imported.size || [...imported].some((id) => !listed.has(id))) {
    fail('backupIncomplete')
  }
  await db.updateStagingFileTypes(stored)
  return imported.size
}
