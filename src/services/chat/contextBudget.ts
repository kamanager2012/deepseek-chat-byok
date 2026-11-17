import type { AssistantMessage, Message, Session, UserMessage } from './types.js'
import { getContextRounds, getReplyText } from './reply.js'

/**
 * 轻量估算 CJK/混合文本的 Token 数，用于发送前预算控制与 UI 提示。
 * - 中文/全角字符按 ~1.5 tokens 估算（实测略偏保守，避免超预算）；
 * - ASCII / 代码按 ~0.32 tokens 估算。
 */
export const estimateTextTokens = (text: string): number => {
  if (!text) {
    return 0
  }
  let cjk = 0
  let ascii = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjk += 1
    } else if (code <= 0x7f) {
      ascii += 1
    } else {
      cjk += 1
    }
  }
  return Math.max(1, Math.ceil(cjk * 1.5 + ascii * 0.32))
}

export const estimateRoundTokens = ([user, reply]: [UserMessage, AssistantMessage]): number =>
  estimateTextTokens(user.content) + estimateTextTokens(getReplyText(reply)) + 16

export type ContextBudgetOptions = {
  /** 最大保留历史问答轮数（不含当前新提问），0 表示不按轮数限制 */
  maxRounds: number
  /** 最大历史输入 Token 预算（不含系统提示与当前新提问），0 表示不按 Token 限制 */
  maxTokens: number
}

export type BudgetTrimResult = {
  keptHistory: Message[]
  droppedRounds: [UserMessage, AssistantMessage][]
  totalRounds: number
  keptRounds: number
  estimatedHistoryTokens: number
  fullHistoryTokens: number
}

/** 从最近轮次往前截取，满足 maxRounds 与 maxTokens 约束，并保证历史顺序不变。 */
export const applyContextBudget = (
  history: Message[],
  { maxRounds, maxTokens }: ContextBudgetOptions
): BudgetTrimResult => {
  const allRounds = getContextRounds(history)
  const roundTokens = allRounds.map(estimateRoundTokens)
  const fullHistoryTokens = roundTokens.reduce((sum, n) => sum + n, 0)

  if (allRounds.length === 0) {
    return {
      keptHistory: [],
      droppedRounds: [],
      totalRounds: 0,
      keptRounds: 0,
      estimatedHistoryTokens: 0,
      fullHistoryTokens: 0,
    }
  }

  const kept: [UserMessage, AssistantMessage][] = []
  let usedTokens = 0

  for (let i = allRounds.length - 1; i >= 0; i -= 1) {
    if (maxRounds > 0 && kept.length >= maxRounds) {
      break
    }
    const cost = roundTokens[i]
    if (maxTokens > 0 && kept.length > 0 && usedTokens + cost > maxTokens) {
      break
    }
    // 即使单轮超过预算且 maxRounds > 0，也允许至少保留最近 1 轮避免完全失忆
    if (maxTokens > 0 && kept.length === 0 && cost > maxTokens * 2 && allRounds.length > 1) {
      break
    }
    kept.push(allRounds[i])
    usedTokens += cost
  }

  kept.reverse()
  const dropCount = allRounds.length - kept.length
  return {
    keptHistory: kept.flatMap(([user, reply]) => [user, reply]),
    droppedRounds: allRounds.slice(0, dropCount),
    totalRounds: allRounds.length,
    keptRounds: kept.length,
    estimatedHistoryTokens: usedTokens,
    fullHistoryTokens,
  }
}

/** 把被预算裁掉的早期轮次整理成待压缩文本，供用户一键生成长期记忆前缀。 */
export const buildDigestSourceText = (
  rounds: [UserMessage, AssistantMessage][],
  existingMemory = '',
  maxSourceChars = 36000
): string => {
  const chunks: string[] = []
  if (existingMemory.trim()) {
    chunks.push(`[已有记忆前缀]\n${existingMemory.trim()}`)
  }
  let used = chunks.reduce((sum, part) => sum + part.length, 0)
  for (let i = 0; i < rounds.length; i += 1) {
    const [user, reply] = rounds[i]
    const q = user.content.trim()
    const a = getReplyText(reply).trim()
    if (!q && !a) {
      continue
    }
    const snippet = `【第 ${i + 1} 轮】\n用户：${q.slice(0, 1200)}\n助手：${a.slice(0, 1800)}`
    if (used + snippet.length > maxSourceChars && chunks.length > 0) {
      chunks.push(`...（另有 ${rounds.length - i} 轮中间对话已略去以控制摘要输入成本）`)
      break
    }
    chunks.push(snippet)
    used += snippet.length
  }
  return chunks.join('\n\n')
}

export const buildEffectiveSystemPrompt = (
  baseSystemPrompt: string,
  memoryPrompt?: string
): string => {
  const base = baseSystemPrompt.trim()
  const mem = memoryPrompt?.trim()
  if (!mem) {
    return base
  }
  if (!base) {
    return `[长期记忆与约定]\n${mem}`
  }
  return `${base}\n\n[长期记忆与约定]\n${mem}`
}

/** 导出当前可见分支为紧凑可读的 Markdown（便于存档或粘贴进 Harness / 笔记软件） */
export const sessionToMarkdown = (
  session: Pick<Session, 'id' | 'title' | 'memoryPrompt'>,
  visibleMessages: Message[],
  includeThinking = false
): string => {
  const lines: string[] = [`# ${session.title.trim() || '未命名对话'}`]
  if (session.memoryPrompt?.trim()) {
    lines.push('', '## 长期记忆 / 设定前缀', '', session.memoryPrompt.trim())
  }
  for (const message of visibleMessages) {
    if (message.role === 'user') {
      lines.push('', '---', '', '## 用户')
      if (message.files.length > 0) {
        lines.push(`> 附件：${message.files.map((file) => file.name).join('、')}`)
      }
      if (message.content.trim()) {
        lines.push('', message.content.trim())
      }
      continue
    }
    lines.push('', '## 助手')
    if (includeThinking) {
      const think = message.blocks
        .filter((block) => block.type === 'thinking' && block.thinking.trim())
        .map((block) => (block.type === 'thinking' ? block.thinking.trim() : ''))
        .join('\n\n')
      if (think) {
        lines.push('', '<details><summary>思考过程</summary>', '', think, '', '</details>')
      }
    }
    const text = getReplyText(message).trim()
    if (text) {
      lines.push('', text)
    }
  }
  lines.push('')
  return lines.join('\n')
}
