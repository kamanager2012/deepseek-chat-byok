import { readServerSentEvents } from './sse.js'
import type { FileBlockParam, MessageParam, MessageStreamEvent, MessageUsage } from './types.js'

export type OpenAIInlineAttachment = {
  fileId: string
  dataUrl?: string
  textExcerpt?: string
  name: string
  isImage: boolean
}

type OpenAIMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | OpenAIMessagePart[]
}

const toAssistantPlainText = (
  content: Extract<MessageParam, { role: 'assistant' }>['content']
): string => {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n')
}

const toUserOpenAIContent = (
  content: Extract<MessageParam, { role: 'user' }>['content'],
  inlineFiles: ReadonlyMap<string, OpenAIInlineAttachment>,
  pendingContextNotes: string[]
): string | OpenAIMessagePart[] => {
  const prefixNote = pendingContextNotes.length > 0 ? `[${pendingContextNotes.join(' | ')}]\n` : ''
  if (typeof content === 'string') {
    return prefixNote + content
  }
  const parts: OpenAIMessagePart[] = []
  if (prefixNote) {
    parts.push({ type: 'text', text: prefixNote.trimEnd() })
  }
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' || block.type === 'document') {
      const file = resolveInlineBlock(block, inlineFiles)
      if (file?.isImage && file.dataUrl) {
        parts.push({ type: 'image_url', image_url: { url: file.dataUrl } })
      } else if (file?.textExcerpt) {
        parts.push({
          type: 'text',
          text: `\n[附件: ${file.name}]\n${file.textExcerpt}\n`,
        })
      }
    }
  }
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text
  }
  return parts.length > 0 ? parts : ''
}

const resolveInlineBlock = (
  block: FileBlockParam,
  inlineFiles: ReadonlyMap<string, OpenAIInlineAttachment>
): OpenAIInlineAttachment | undefined =>
  block.source.type === 'file' ? inlineFiles.get(block.source.file_id) : undefined

export const buildOpenAIMessages = (
  system: string,
  messages: MessageParam[],
  inlineFiles: ReadonlyMap<string, OpenAIInlineAttachment> = new Map()
): OpenAIMessage[] => {
  const output: OpenAIMessage[] = []
  if (system.trim()) {
    output.push({ role: 'system', content: system.trim() })
  }
  const notes: string[] = []
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      if (message.content.trim()) {
        notes.push(message.content.trim())
      }
      continue
    }
    if (message.role === 'user') {
      const content = toUserOpenAIContent(message.content, inlineFiles, notes.splice(0))
      if ((typeof content === 'string' && content !== '') || Array.isArray(content)) {
        output.push({ role: 'user', content })
      }
      continue
    }
    const text = toAssistantPlainText(message.content)
    if (text) {
      output.push({ role: 'assistant', content: text })
    }
  }
  if (output.at(-1)?.role === 'assistant') {
    output.push({
      role: 'user',
      content:
        'Please continue directly from where your previous unfinished message stopped, without repeating existing text or adding any preamble.',
    })
  }
  return output
}

type OpenAIChoiceDelta = {
  content?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
}

type OpenAIChunk = {
  id?: unknown
  model?: unknown
  error?: { message?: unknown }
  choices?: Array<{
    delta?: OpenAIChoiceDelta
    finish_reason?: unknown
  }>
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    prompt_tokens_details?: {
      cached_tokens?: unknown
    }
  }
}

const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

const mapUsage = (raw: OpenAIChunk['usage']): MessageUsage | undefined => {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  const prompt = asNumber(raw.prompt_tokens)
  const cached = asNumber(raw.prompt_tokens_details?.cached_tokens)
  const completion = asNumber(raw.completion_tokens)
  return {
    input_tokens: Math.max(0, prompt - cached),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: completion,
  }
}

const mapFinishReason = (reason: unknown): 'end_turn' | 'max_tokens' | 'refusal' | null => {
  if (reason === 'length') {
    return 'max_tokens'
  }
  if (reason === 'content_filter') {
    return 'refusal'
  }
  if (reason === 'stop' || reason === 'tool_calls') {
    return 'end_turn'
  }
  return null
}

export class OpenAIStreamError extends Error {
  constructor(
    readonly kind: 'stream' | 'interrupted',
    message: string
  ) {
    super(message)
    this.name = 'OpenAIStreamError'
  }
}

const OPEN_THINK_TAG = '<think>'
const CLOSE_THINK_TAG = '</think>'

const trailingPartialTagLength = (text: string, tag: string): number => {
  const maxCheck = Math.min(text.length, tag.length - 1)
  for (let len = maxCheck; len >= 1; len -= 1) {
    if (text.endsWith(tag.slice(0, len))) {
      return len
    }
  }
  return 0
}

type InlineThinkSplitter = {
  push: (chunk: string, allowOpenTag: boolean) => Array<{ kind: 'thinking' | 'text'; text: string }>
  flush: () => Array<{ kind: 'thinking' | 'text'; text: string }>
}

const createInlineThinkSplitter = (): InlineThinkSplitter => {
  let pending = ''
  let insideThink = false

  return {
    push(chunk, allowOpenTag) {
      const out: Array<{ kind: 'thinking' | 'text'; text: string }> = []
      pending += chunk

      while (pending.length > 0) {
        if (insideThink) {
          const closeIdx = pending.indexOf(CLOSE_THINK_TAG)
          if (closeIdx >= 0) {
            const thought = pending.slice(0, closeIdx)
            if (thought) {
              out.push({ kind: 'thinking', text: thought })
            }
            pending = pending.slice(closeIdx + CLOSE_THINK_TAG.length)
            insideThink = false
            continue
          }
          const hold = trailingPartialTagLength(pending, CLOSE_THINK_TAG)
          const safe = pending.slice(0, pending.length - hold)
          if (safe) {
            out.push({ kind: 'thinking', text: safe })
          }
          pending = pending.slice(pending.length - hold)
          break
        }

        if (!allowOpenTag) {
          out.push({ kind: 'text', text: pending })
          pending = ''
          break
        }

        const trimmedStart = pending.trimStart()
        if (!trimmedStart) {
          break
        }

        const openIdx = pending.indexOf(OPEN_THINK_TAG)
        if (openIdx >= 0 && pending.slice(0, openIdx).trim() === '') {
          pending = pending.slice(openIdx + OPEN_THINK_TAG.length)
          insideThink = true
          continue
        }

        if (trimmedStart.startsWith('<') && trimmedStart.length < OPEN_THINK_TAG.length) {
          const partialLen = trailingPartialTagLength(pending, OPEN_THINK_TAG)
          if (partialLen === trimmedStart.length) {
            break
          }
        }

        out.push({ kind: 'text', text: pending })
        pending = ''
      }

      return out
    },
    flush() {
      if (!pending) {
        return []
      }
      const rest = pending
      pending = ''
      return [{ kind: insideThink ? 'thinking' : 'text', text: rest }]
    },
  }
}

/** 将 OpenAI Chat Completions 流式 SSE 块翻译为应用统一的 MessageStreamEvent。 */
export async function* parseOpenAIStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  fallbackModel: string
): AsyncGenerator<MessageStreamEvent> {
  let started = false
  let blockIndex = -1
  let activeBlock: 'thinking' | 'text' | null = null
  let stopReason: 'end_turn' | 'max_tokens' | 'refusal' = 'end_turn'
  let sawFinishReason = false
  let latestUsage: MessageUsage | undefined
  let doneReceived = false
  let emittedAnswerText = false
  let sawExplicitReasoning = false
  const thinkSplitter = createInlineThinkSplitter()

  const closeActiveBlock = (): MessageStreamEvent | null => {
    if (activeBlock === null || blockIndex < 0) {
      return null
    }
    const closingIndex = blockIndex
    activeBlock = null
    return { type: 'content_block_stop', index: closingIndex }
  }

  function* emitSegment(kind: 'thinking' | 'text', text: string): Generator<MessageStreamEvent> {
    if (!text) {
      return
    }
    if (kind === 'text') {
      if (text.trim()) {
        emittedAnswerText = true
      } else if (!emittedAnswerText) {
        return
      }
    }
    if (activeBlock !== kind) {
      const stopEvent = closeActiveBlock()
      if (stopEvent) {
        yield stopEvent
      }
      blockIndex += 1
      activeBlock = kind
      yield {
        type: 'content_block_start',
        index: blockIndex,
        content_block:
          kind === 'thinking'
            ? { type: 'thinking', thinking: '', signature: '' }
            : { type: 'text', text: '' },
      }
    }
    yield {
      type: 'content_block_delta',
      index: blockIndex,
      delta:
        kind === 'thinking'
          ? { type: 'thinking_delta', thinking: text }
          : { type: 'text_delta', text },
    }
  }

  for await (const { data } of readServerSentEvents(body, signal)) {
    const trimmed = data.trim()
    if (!trimmed) {
      continue
    }
    if (trimmed === '[DONE]') {
      doneReceived = true
      break
    }
    let chunk: OpenAIChunk
    try {
      chunk = JSON.parse(trimmed) as OpenAIChunk
    } catch {
      continue
    }
    if (chunk.error && typeof chunk.error.message === 'string') {
      throw new OpenAIStreamError('stream', chunk.error.message)
    }
    if (!started) {
      started = true
      yield {
        type: 'message_start',
        message: {
          id: typeof chunk.id === 'string' && chunk.id ? chunk.id : `openai-${Date.now()}`,
          model: typeof chunk.model === 'string' && chunk.model ? chunk.model : fallbackModel,
        },
      }
    }
    if (chunk.usage) {
      latestUsage = mapUsage(chunk.usage) ?? latestUsage
    }
    const choice = chunk.choices?.[0]
    if (!choice) {
      continue
    }
    const mappedReason = mapFinishReason(choice.finish_reason)
    if (mappedReason) {
      stopReason = mappedReason
      sawFinishReason = true
    }
    const delta = choice.delta
    if (!delta || typeof delta !== 'object') {
      continue
    }
    const reasoningChunk =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : ''
    if (reasoningChunk) {
      sawExplicitReasoning = true
      yield* emitSegment('thinking', reasoningChunk)
    }
    const textChunk = typeof delta.content === 'string' ? delta.content : ''
    if (textChunk) {
      for (const seg of thinkSplitter.push(
        textChunk,
        !sawExplicitReasoning && !emittedAnswerText
      )) {
        yield* emitSegment(seg.kind, seg.text)
      }
    }
  }

  for (const seg of thinkSplitter.flush()) {
    yield* emitSegment(seg.kind, seg.text)
  }

  if (!started) {
    throw new OpenAIStreamError('interrupted', '')
  }
  const finalStop = closeActiveBlock()
  if (finalStop) {
    yield finalStop
  }
  yield {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    ...(latestUsage ? { usage: latestUsage } : {}),
  }
  if (!doneReceived && !sawFinishReason) {
    throw new OpenAIStreamError('interrupted', '')
  }
  yield { type: 'message_stop' }
}
