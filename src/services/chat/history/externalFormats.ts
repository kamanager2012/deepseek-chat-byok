import type { AssistantMessage, Message, ReplyBlock, Session, UserMessage } from '../types.js'
import type { SessionIndexEntry } from './format.js'

export type ExternalArchiveData = {
  index: SessionIndexEntry[]
  sessions: Map<string, Session>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const toEpochMs = (raw: unknown, fallback: number): number => {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw)
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return fallback
}

const toIso = (ms: number): string => new Date(ms).toISOString()

type ChatGptNode = {
  id: string
  parent?: string | null
  children?: unknown[]
  message?: unknown
}

const extractChatGptBlocks = (
  content: Record<string, unknown> | null
): { text: string; thinking: string } => {
  if (!content) {
    return { text: '', thinking: '' }
  }
  const textParts: string[] = []
  const thinkingParts: string[] = []
  const ctype = typeof content.content_type === 'string' ? content.content_type : ''

  if (ctype === 'thoughts' && Array.isArray(content.thoughts)) {
    for (const item of content.thoughts) {
      if (isRecord(item) && typeof item.content === 'string' && item.content.trim()) {
        thinkingParts.push(item.content.trim())
      }
    }
  }
  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (typeof part === 'string' && part.length > 0) {
        textParts.push(part)
      } else if (isRecord(part) && typeof part.text === 'string' && part.text.length > 0) {
        textParts.push(part.text)
      }
    }
  }
  if (typeof content.text === 'string' && content.text.length > 0) {
    textParts.push(content.text)
  }
  return {
    text: textParts.join('\n').trim(),
    thinking: thinkingParts.join('\n').trim(),
  }
}

const finalizeLinearOrBranchedTree = (
  id: string,
  title: string,
  createdAt: number,
  updatedAt: number,
  messages: Message[],
  preferredLeafId?: string
): Session | null => {
  if (messages.length === 0) {
    return null
  }
  // Ensure alternating User->Assistant invariants and find root
  const byId = new Map(messages.map((m) => [m.id, m]))
  const roots = messages.filter((m) => m.parentId === null || m.parentId === undefined)
  const root = roots[0] ?? messages[0]
  root.parentId = null

  // Walk from preferred leaf back to root to wire selectedChildId along the active branch
  let cursor: Message | undefined =
    (preferredLeafId ? byId.get(preferredLeafId) : undefined) ?? messages[messages.length - 1]
  const visited = new Set<string>()
  if (cursor) {
    cursor.selectedChildId = undefined
    while (cursor?.parentId && !visited.has(cursor.id)) {
      visited.add(cursor.id)
      const parent = byId.get(cursor.parentId)
      if (!parent) {
        break
      }
      parent.selectedChildId = cursor.id
      cursor = parent
    }
  }

  // Ensure every non-active branch parent at least links a child cleanly if needed
  return {
    id,
    title,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    messages,
    rootMessageId: root.id,
  }
}

const parseChatGptConversation = (raw: Record<string, unknown>, idx: number): Session | null => {
  if (!isRecord(raw.mapping)) {
    return null
  }
  const nowFallback = 1_760_000_000_000 + idx * 1000
  const convId =
    typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim()
      : typeof raw.conversation_id === 'string' && raw.conversation_id.trim()
        ? raw.conversation_id.trim()
        : `chatgpt-${idx + 1}`
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const createdAt = toEpochMs(raw.create_time, nowFallback)
  const updatedAt = toEpochMs(raw.update_time, createdAt)

  const mapping = raw.mapping as Record<string, ChatGptNode>
  const roots = Object.entries(mapping)
    .filter(
      ([, node]) => isRecord(node) && (typeof node.parent !== 'string' || !mapping[node.parent])
    )
    .map(([k]) => k)
  if (roots.length === 0) {
    for (const k of Object.keys(mapping)) {
      roots.push(k)
      break
    }
  }

  // Traverse top-down in parent-before-child order
  const order: string[] = []
  const seen = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const nid = queue.shift()
    if (!nid || seen.has(nid)) {
      continue
    }
    seen.add(nid)
    order.push(nid)
    const node = mapping[nid]
    if (isRecord(node) && Array.isArray(node.children)) {
      for (const childId of node.children) {
        if (typeof childId === 'string' && mapping[childId]) {
          queue.push(childId)
        }
      }
    }
  }

  const aliasToMessageId = new Map<string, string | null>()
  const messageById = new Map<string, Message>()
  const messages: Message[] = []

  const resolveParentMsgId = (nodeParentId: unknown): string | null => {
    if (typeof nodeParentId !== 'string') {
      return null
    }
    return aliasToMessageId.get(nodeParentId) ?? null
  }

  for (const nid of order) {
    const node = mapping[nid]
    if (!isRecord(node)) {
      continue
    }
    const parentMsgId = resolveParentMsgId(node.parent)
    const msgObj = isRecord(node.message) ? node.message : null
    if (!msgObj) {
      aliasToMessageId.set(nid, parentMsgId)
      continue
    }
    const metadata = isRecord(msgObj.metadata) ? msgObj.metadata : null
    if (metadata?.is_visually_hidden_from_conversation === true) {
      aliasToMessageId.set(nid, parentMsgId)
      continue
    }
    const author = isRecord(msgObj.author) ? msgObj.author : null
    const roleRaw = typeof author?.role === 'string' ? author.role : ''
    if (roleRaw !== 'user' && roleRaw !== 'assistant') {
      aliasToMessageId.set(nid, parentMsgId)
      continue
    }
    const content = isRecord(msgObj.content) ? msgObj.content : null
    const { text, thinking } = extractChatGptBlocks(content)
    if (!text && !thinking) {
      aliasToMessageId.set(nid, parentMsgId)
      continue
    }
    const msgTime = toEpochMs(msgObj.create_time, createdAt)
    const parentMsg = parentMsgId ? messageById.get(parentMsgId) : undefined

    // Collapse consecutive same-role messages cleanly into parent so branch invariants hold
    if (parentMsg && parentMsg.role === roleRaw) {
      if (parentMsg.role === 'user') {
        parentMsg.content = [parentMsg.content, text].filter(Boolean).join('\n\n')
      } else {
        if (thinking) {
          parentMsg.blocks.push({ type: 'thinking', thinking })
          parentMsg.thinking = true
        }
        if (text) {
          parentMsg.blocks.push({ type: 'text', text })
        }
      }
      aliasToMessageId.set(nid, parentMsg.id)
      continue
    }

    // Drop orphan assistant intro with no prior user turn by forwarding cleanly
    if (!parentMsg && roleRaw === 'assistant') {
      aliasToMessageId.set(nid, null)
      continue
    }

    const msgId = typeof msgObj.id === 'string' && msgObj.id.trim() ? msgObj.id.trim() : nid
    if (roleRaw === 'user') {
      const userMsg: UserMessage = {
        id: msgId,
        role: 'user',
        content: text,
        files: [],
        createdAt: msgTime,
        parentId: parentMsgId,
      }
      messageById.set(msgId, userMsg)
      messages.push(userMsg)
      aliasToMessageId.set(nid, msgId)
    } else {
      const blocks: ReplyBlock[] = []
      if (thinking) {
        blocks.push({ type: 'thinking', thinking })
      }
      if (text) {
        blocks.push({ type: 'text', text })
      }
      const modelSlug =
        typeof metadata?.model_slug === 'string'
          ? metadata.model_slug
          : typeof metadata?.default_model_slug === 'string'
            ? metadata.default_model_slug
            : null
      const assistantMsg: AssistantMessage = {
        id: msgId,
        role: 'assistant',
        createdAt: msgTime,
        model: modelSlug,
        thinking: Boolean(thinking),
        prefix: false,
        status: 'done',
        blocks,
        parentId: parentMsgId,
      }
      messageById.set(msgId, assistantMsg)
      messages.push(assistantMsg)
      aliasToMessageId.set(nid, msgId)
    }
  }

  const preferredLeaf =
    typeof raw.current_node === 'string'
      ? (aliasToMessageId.get(raw.current_node) ?? undefined)
      : undefined
  return finalizeLinearOrBranchedTree(convId, title, createdAt, updatedAt, messages, preferredLeaf)
}

const extractClaudeBlocks = (msg: Record<string, unknown>): { text: string; thinking: string } => {
  const textParts: string[] = []
  const thinkingParts: string[] = []
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!isRecord(part)) {
        continue
      }
      if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
        thinkingParts.push(part.thinking.trim())
      } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        textParts.push(part.text)
      }
    }
  }
  if (textParts.length === 0 && typeof msg.text === 'string' && msg.text.trim()) {
    textParts.push(msg.text)
  }
  return {
    text: textParts.join('\n').trim(),
    thinking: thinkingParts.join('\n').trim(),
  }
}

const parseClaudeConversation = (raw: Record<string, unknown>, idx: number): Session | null => {
  if (!Array.isArray(raw.chat_messages)) {
    return null
  }
  const nowFallback = 1_760_000_000_000 + idx * 1000
  const convId =
    typeof raw.uuid === 'string' && raw.uuid.trim() ? raw.uuid.trim() : `claude-${idx + 1}`
  const title = typeof raw.name === 'string' ? raw.name.trim() : ''
  const createdAt = toEpochMs(raw.created_at, nowFallback)
  const updatedAt = toEpochMs(raw.updated_at, createdAt)

  const messages: Message[] = []
  let prev: Message | null = null

  for (let i = 0; i < raw.chat_messages.length; i += 1) {
    const item = raw.chat_messages[i]
    if (!isRecord(item)) {
      continue
    }
    const sender = item.sender
    const role = sender === 'human' ? 'user' : sender === 'assistant' ? 'assistant' : null
    if (!role) {
      continue
    }
    const { text, thinking } = extractClaudeBlocks(item)
    if (!text && !thinking) {
      continue
    }
    const msgTime = toEpochMs(item.created_at, createdAt + i)
    if (prev && prev.role === role) {
      if (prev.role === 'user') {
        prev.content = [prev.content, text].filter(Boolean).join('\n\n')
      } else {
        if (thinking) {
          prev.blocks.push({ type: 'thinking', thinking })
          prev.thinking = true
        }
        if (text) {
          prev.blocks.push({ type: 'text', text })
        }
      }
      continue
    }
    if (!prev && role === 'assistant') {
      continue
    }
    const msgId =
      typeof item.uuid === 'string' && item.uuid.trim() ? item.uuid.trim() : `${convId}-m-${i}`
    if (role === 'user') {
      const userMsg: UserMessage = {
        id: msgId,
        role: 'user',
        content: text,
        files: [],
        createdAt: msgTime,
        parentId: prev ? prev.id : null,
      }
      messages.push(userMsg)
      prev = userMsg
    } else {
      const blocks: ReplyBlock[] = []
      if (thinking) {
        blocks.push({ type: 'thinking', thinking })
      }
      if (text) {
        blocks.push({ type: 'text', text })
      }
      const assistantMsg: AssistantMessage = {
        id: msgId,
        role: 'assistant',
        createdAt: msgTime,
        model: typeof raw.model === 'string' ? raw.model : null,
        thinking: Boolean(thinking),
        prefix: false,
        status: 'done',
        blocks,
        parentId: prev ? prev.id : null,
      }
      messages.push(assistantMsg)
      prev = assistantMsg
    }
  }

  return finalizeLinearOrBranchedTree(convId, title, createdAt, updatedAt, messages)
}

/**
 * 解析外部导出包中的 conversations.json（支持 ChatGPT 官方导出 mapping 树 & Claude 官方导出 chat_messages）。
 * 保留可见分支路径与思维链片段，拒绝不识别的结构并返回 null。
 */
export const parseExternalConversationsJson = (raw: unknown): ExternalArchiveData | null => {
  if (!Array.isArray(raw)) {
    return null
  }
  let recognizedShape = raw.length === 0
  const sessions = new Map<string, Session>()
  const index: SessionIndexEntry[] = []

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (!isRecord(item)) {
      continue
    }
    let session: Session | null = null
    if (isRecord(item.mapping)) {
      recognizedShape = true
      session = parseChatGptConversation(item, i)
    } else if (Array.isArray(item.chat_messages)) {
      recognizedShape = true
      session = parseClaudeConversation(item, i)
    }
    if (!session || sessions.has(session.id)) {
      continue
    }
    sessions.set(session.id, session)
    index.push({
      id: session.id,
      title: session.title || null,
      pinned: false,
      message_count: session.messages.length,
      inserted_at: toIso(session.createdAt),
      updated_at: toIso(session.updatedAt),
    })
  }

  if (!recognizedShape) {
    return null
  }
  index.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  return { index, sessions }
}
