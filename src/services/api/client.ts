import { translate, type TranslationMessage } from '../../i18n/index.js'
import {
  getAndroidBridgeToken,
  getDefaultCorsProxyUrl,
  hasAndroidBridge,
  isLocalProxyRequestUrl,
} from './androidBridge.js'
import {
  OpenAIStreamError,
  buildOpenAIMessages,
  parseOpenAIStream,
  type OpenAIInlineAttachment,
} from './openai.js'
import { readMessageEvent } from './parseEvent.js'
import {
  createDefaultProvider,
  probeLocalProxy,
  resolveFetchTarget,
  resolveProviderEndpoints,
  type ProviderConfig,
} from './providers.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileBlockParam,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** 构建期默认 API 地址，用于初始化默认 DeepSeek 官方配置；支持运行时切换 */
export const API_ORIGIN = __API_ORIGIN__
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

/** 对错误文本做防御性脱敏，避免故障网关回显将 API Key 或 Bearer 凭据写入界面与历史库 */
export const redactApiSecrets = (raw: string, knownSecret?: string): string => {
  let out = raw
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+=/:]{6,}/giu, '$1[REDACTED]')
    .replace(/((?:x-api-key|api[_-]?key)\s*[:=]\s*["']?)[A-Za-z0-9._\-+=/:]{6,}/giu, '$1[REDACTED]')
    .replace(/\b((?:sk-|gsk_|hf_|AIza|pplx-)[A-Za-z0-9_-]{8,})\b/gu, '[REDACTED]')
  const trimmed = knownSecret?.trim()
  if (trimmed && trimmed.length >= 6) {
    out = out.split(trimmed).join('[REDACTED]')
  }
  return out
}

const extractHeaderSecret = (headers?: HeadersInit): string | undefined => {
  if (!headers) {
    return undefined
  }
  const h = new Headers(headers)
  const xKey = h.get('x-api-key')
  if (xKey && xKey.trim().length >= 6) {
    return xKey.trim()
  }
  const auth = h.get('authorization')
  if (auth) {
    const m = /^Bearer\s+(.+)$/iu.exec(auth.trim())
    if (m?.[1] && m[1].trim().length >= 6) {
      return m[1].trim()
    }
  }
  return undefined
}

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText,
  knownSecret?: string
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, redactApiSecrets(message, knownSecret), response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  const knownSecret = extractHeaderSecret(init.headers)
  const token = isLocalProxyRequestUrl(url) ? getAndroidBridgeToken() : null
  let finalInit = init
  if (token) {
    const headers = new Headers(init.headers)
    headers.set('X-DS-Bridge-Token', token)
    finalInit = { ...init, headers }
  }

  let response: Response
  try {
    response = await fetch(url, finalInit)
  } catch (error) {
    if (finalInit.signal?.aborted) {
      throw error
    }
    throw new ApiError(
      'network',
      redactApiSecrets(error instanceof Error ? error.message : String(error), knownSecret)
    )
  }
  if (!response.ok) {
    throw await readErrorResponse(response, 'http', response.statusText, knownSecret)
  }
  return response
}

const canFallbackToLocalProxy = async (provider: ProviderConfig): Promise<boolean> => {
  if (provider.useCorsProxy) {
    return false
  }
  return hasAndroidBridge() || (await probeLocalProxy())
}

/**
 * 若直连因浏览器 CORS/网络失败且本地内置 /_proxy 桥接可用，则自动降级到本地代理重试一次，
 * 避免用户在 Android APK 或桌面便携版未勾选代理时被浏览器同源策略拦断。
 */
const requestWithLocalProxyFallback = async (
  url: string,
  init: RequestInit,
  provider: ProviderConfig,
  corsProxyUrl: string
): Promise<Response> => {
  const primaryTarget = resolveFetchTarget(url, provider.useCorsProxy, corsProxyUrl)
  try {
    return await request(primaryTarget, init)
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.kind === 'network' &&
      !init.signal?.aborted &&
      (await canFallbackToLocalProxy(provider))
    ) {
      const proxyTarget = resolveFetchTarget(url, true, corsProxyUrl || getDefaultCorsProxyUrl())
      if (proxyTarget !== primaryTarget) {
        return request(proxyTarget, init)
      }
    }
    throw error
  }
}

const anthropicHeaders = (
  apiKey: string,
  beta: boolean,
  includeVersion: boolean
): Record<string, string> => ({
  ...(apiKey ? { 'x-api-key': apiKey } : {}),
  ...(includeVersion ? { 'anthropic-version': DEFAULT_ANTHROPIC_VERSION } : {}),
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some(
        (block) =>
          (block.type === 'image' || block.type === 'document') && block.source.type === 'file'
      )
  )

const parseModelList = (raw: unknown): string[] => {
  if (typeof raw !== 'object' || raw === null || !('data' in raw) || !Array.isArray(raw.data)) {
    return []
  }
  const models: string[] = []
  for (const item of raw.data) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'id' in item &&
      typeof item.id === 'string' &&
      item.id.trim()
    ) {
      models.push(item.id.trim())
    }
  }
  return models
}

/** 用 GET /models 校验 Provider 配置（不产生费用），返回可用模型 ID 列表 */
export const verifyProvider = async (
  provider: ProviderConfig,
  corsProxyUrl = '',
  signal?: AbortSignal
): Promise<string[]> => {
  const endpoints = resolveProviderEndpoints(provider)
  const key = provider.apiKey.trim()
  const headers: Record<string, string> =
    provider.protocol === 'anthropic'
      ? {
          ...(key ? { 'x-api-key': key } : {}),
          'anthropic-version': DEFAULT_ANTHROPIC_VERSION,
        }
      : key
        ? { Authorization: `Bearer ${key}` }
        : {}
  const response = await requestWithLocalProxyFallback(
    endpoints.modelsUrl,
    {
      method: 'GET',
      headers,
      signal,
    },
    provider,
    corsProxyUrl
  )
  const text = await response.text().catch(() => '')
  try {
    return parseModelList(JSON.parse(text))
  } catch {
    return []
  }
}

/** 向后兼容旧 API Key 校验入口 */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  const provider = { ...createDefaultProvider(apiKey), baseUrl: API_ORIGIN }
  await verifyProvider(provider, '', signal)
}

/**
 * POST /anthropic/v1/files 上传附件（仅 deepseek-anthropic 协议支持）。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal,
  provider?: ProviderConfig,
  corsProxyUrl = ''
): Promise<FileObject> => {
  const resolved = provider ?? { ...createDefaultProvider(apiKey), baseUrl: API_ORIGIN }
  const endpoints = resolveProviderEndpoints(resolved)
  if (!endpoints.filesUrl) {
    throw new ApiError('protocol', 'Current provider does not support DeepSeek Files API')
  }
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await requestWithLocalProxyFallback(
    endpoints.filesUrl,
    {
      method: 'POST',
      headers: anthropicHeaders(resolved.apiKey || apiKey, true, false),
      body: form,
      signal,
    },
    resolved,
    corsProxyUrl
  )
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (
  apiKey: string,
  fileId: string,
  provider?: ProviderConfig,
  corsProxyUrl = ''
): Promise<void> => {
  const resolved = provider ?? { ...createDefaultProvider(apiKey), baseUrl: API_ORIGIN }
  const endpoints = resolveProviderEndpoints(resolved)
  if (!endpoints.filesUrl) {
    return
  }
  await requestWithLocalProxyFallback(
    `${endpoints.filesUrl}/${encodeURIComponent(fileId)}`,
    {
      method: 'DELETE',
      headers: anthropicHeaders(resolved.apiKey || apiKey, true, false),
    },
    resolved,
    corsProxyUrl
  )
}

const stripDataUrl = (dataUrl: string): { mediaType: string; data: string } | null => {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(dataUrl)
  return match ? { mediaType: match[1], data: match[2] } : null
}

/** 适配通用 Anthropic 第三方端点：展开 base64 内联附件、去掉 DeepSeek 私有字段，并为 thinking 补全 budget_tokens。 */
export const sanitizeGenericAnthropicBody = (
  body: CreateMessageRequest,
  inlineFiles: ReadonlyMap<string, OpenAIInlineAttachment>
): Record<string, unknown> => {
  const notes: string[] = []
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = []

  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      if (message.content.trim()) {
        notes.push(message.content.trim())
      }
      continue
    }
    if (message.role === 'user') {
      const note = notes.length > 0 ? `[${notes.splice(0).join(' | ')}]\n` : ''
      if (typeof message.content === 'string') {
        if (note || message.content) {
          messages.push({ role: 'user', content: note + message.content })
        }
        continue
      }
      const nextBlocks: Array<FileBlockParam | { type: 'text'; text: string }> = []
      if (note) {
        nextBlocks.push({ type: 'text', text: note.trimEnd() })
      }
      for (const block of message.content) {
        if (block.type === 'text') {
          nextBlocks.push(block)
        } else if (block.source.type === 'file') {
          const inline = inlineFiles.get(block.source.file_id)
          if (inline?.isImage && inline.dataUrl) {
            const parsed = stripDataUrl(inline.dataUrl)
            if (parsed) {
              nextBlocks.push({
                type: 'image',
                source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
              })
            }
          } else if (inline?.textExcerpt) {
            nextBlocks.push({
              type: 'text',
              text: `\n[附件: ${inline.name}]\n${inline.textExcerpt}\n`,
            })
          }
        }
      }
      if (nextBlocks.length > 0) {
        messages.push({ role: 'user', content: nextBlocks })
      }
      continue
    }

    const assistantBlocks = message.content.flatMap(
      (
        block
      ): Array<
        { type: 'text'; text: string } | { type: 'thinking'; thinking: string; signature: string }
      > => {
        if (block.type === 'text' && block.text) {
          return [{ type: 'text', text: block.text }]
        }
        if (block.type === 'thinking' && block.thinking.trim() && block.signature.trim()) {
          return [{ type: 'thinking', thinking: block.thinking, signature: block.signature }]
        }
        return []
      }
    )
    if (assistantBlocks.length > 0) {
      messages.push({ role: 'assistant', content: assistantBlocks })
    }
  }

  const thinkingEnabled = body.thinking?.type === 'enabled'
  const baseMaxTokens = body.max_tokens ?? (thinkingEnabled ? 16_384 : 8192)
  const thinkingBudget = 4096
  const maxTokens = thinkingEnabled ? Math.max(baseMaxTokens, thinkingBudget + 4096) : baseMaxTokens

  return {
    model: body.model,
    max_tokens: maxTokens,
    ...(body.system ? { system: body.system } : {}),
    messages,
    ...(thinkingEnabled
      ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } }
      : body.thinking
        ? { thinking: { type: 'disabled' } }
        : {}),
    stream: true,
  }
}

export type StreamProviderOptions = {
  provider: ProviderConfig
  body: CreateMessageRequest
  signal: AbortSignal
  corsProxyUrl?: string
  inlineFiles?: ReadonlyMap<string, OpenAIInlineAttachment>
}

export async function* streamProviderMessage({
  provider,
  body,
  signal,
  corsProxyUrl = '',
  inlineFiles = new Map(),
}: StreamProviderOptions): AsyncGenerator<MessageStreamEvent> {
  const endpoints = resolveProviderEndpoints(provider)
  const apiKey = provider.apiKey.trim()

  if (provider.protocol === 'openai') {
    const openAiMessages = buildOpenAIMessages(body.system, body.messages, inlineFiles)
    const requestOpenAi = (includeUsage: boolean) =>
      requestWithLocalProxyFallback(
        endpoints.messagesUrl,
        {
          method: 'POST',
          headers: {
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model: provider.model.trim() || body.model,
            messages: openAiMessages,
            stream: true,
            ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
            ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
          }),
          signal,
        },
        provider,
        corsProxyUrl
      )

    let response: Response
    try {
      response = await requestOpenAi(true)
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 400 &&
        /stream_options/iu.test(error.message)
      ) {
        response = await requestOpenAi(false)
      } else {
        throw error
      }
    }
    const contentType = response.headers.get('Content-Type') ?? ''
    if (!response.body || !contentType.includes('text/event-stream')) {
      throw await readErrorResponse(response, 'protocol', '')
    }
    try {
      for await (const event of parseOpenAIStream(
        response.body,
        signal,
        provider.model.trim() || body.model
      )) {
        yield event
      }
      return
    } catch (error) {
      if (error instanceof OpenAIStreamError) {
        throw new ApiError(error.kind, redactApiSecrets(error.message))
      }
      throw error
    }
  }

  const isDeepSeek = provider.protocol === 'deepseek-anthropic'
  const payload = isDeepSeek
    ? { ...body, stream: true }
    : sanitizeGenericAnthropicBody(body, inlineFiles)

  const response = await requestWithLocalProxyFallback(
    endpoints.messagesUrl,
    {
      method: 'POST',
      headers: {
        ...anthropicHeaders(apiKey, isDeepSeek && hasFile(body), !isDeepSeek),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(payload),
      signal,
    },
    provider,
    corsProxyUrl
  )
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(parsed)) {
      throw new ApiError('stream', redactApiSecrets(parsed.error.message))
    }
    if (eventName === 'error') {
      throw new ApiError('stream', redactApiSecrets(data))
    }
    const event = readMessageEvent(parsed)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  throw new ApiError('interrupted', '')
}

/** 向后兼容旧 streamMessage 签名（默认 DeepSeek 官方 Anthropic） */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const provider = { ...createDefaultProvider(apiKey), baseUrl: API_ORIGIN }
  yield* streamProviderMessage({ provider, body, signal })
}
