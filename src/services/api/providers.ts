import { getAndroidBridgeToken, getDefaultCorsProxyUrl } from './androidBridge.js'

export type ProviderProtocol = 'deepseek-anthropic' | 'anthropic' | 'openai'

export type ProviderPresetId =
  | 'deepseek-official'
  | 'deepseek-openai'
  | 'opencode-go'
  | 'opencode-zen'
  | 'anthropic'
  | 'siliconflow'
  | 'openrouter'
  | 'ollama'
  | 'custom'

export type ProviderConfig = {
  id: string
  preset: ProviderPresetId
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  apiKey: string
  model: string
  useCorsProxy: boolean
  customSystemPrompt?: string
}

export type ProviderPreset = {
  id: ProviderPresetId
  nameZh: string
  nameEn: string
  protocol: ProviderProtocol
  defaultBaseUrl: string
  defaultModel: string
  modelSuggestions: string[]
  requiresApiKey: boolean
  hintZh: string
  hintEn: string
}

export const DEFAULT_CHAT_MODEL = 'deepseek-flash'

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek-official',
    nameZh: 'DeepSeek 官方（原版完整工具）',
    nameEn: 'DeepSeek Official (Anthropic + Tools)',
    protocol: 'deepseek-anthropic',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    modelSuggestions: ['deepseek-flash', 'deepseek-v4-pro'],
    requiresApiKey: true,
    hintZh: '直连官方 Anthropic 协议接口，支持联网搜索、文件解析与语音朗读。',
    hintEn: 'Official DeepSeek Anthropic endpoint with search, file upload, and ASR/TTS.',
  },
  {
    id: 'deepseek-openai',
    nameZh: 'DeepSeek 官方（OpenAI 兼容）',
    nameEn: 'DeepSeek Official (OpenAI)',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    modelSuggestions: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash', 'deepseek-v4-pro'],
    requiresApiKey: true,
    hintZh: '标准 OpenAI 协议，纯文本/思考与图片问答，便于对比或切换模型 ID。',
    hintEn: 'Standard OpenAI Chat Completions compatibility for DeepSeek models.',
  },
  {
    id: 'opencode-go',
    nameZh: 'OpenCode Go（个人订阅 Key）',
    nameEn: 'OpenCode Go (BYOK)',
    protocol: 'openai',
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'deepseek-v4.1-flash',
    modelSuggestions: ['deepseek-v4.1-flash', 'deepseek-v4-pro'],
    requiresApiKey: true,
    hintZh: '填入个人 OpenCode Go API Key；若浏览器提示跨域拦截请开启本地转发。',
    hintEn: 'Use your personal OpenCode Go API key. Enable local proxy if CORS blocks browser.',
  },
  {
    id: 'opencode-zen',
    nameZh: 'OpenCode Zen（按量 Key）',
    nameEn: 'OpenCode Zen (BYOK)',
    protocol: 'openai',
    defaultBaseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'deepseek-v4.1-flash',
    modelSuggestions: ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash-free'],
    requiresApiKey: true,
    hintZh: 'OpenCode Zen 按量端点，支持兼容 OpenAI 格式的 DeepSeek 模型。',
    hintEn: 'OpenCode Zen pay-as-you-go endpoint for DeepSeek models.',
  },
  {
    id: 'anthropic',
    nameZh: 'Anthropic 官方 / Claude 兼容',
    nameEn: 'Anthropic Messages (BYOK)',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    modelSuggestions: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    requiresApiKey: true,
    hintZh: '标准 Anthropic Messages 协议，自动处理思考预算（budget_tokens）与图片内联。',
    hintEn: 'Standard Anthropic Messages API with thinking budget_tokens and inline images.',
  },
  {
    id: 'siliconflow',
    nameZh: '硅基流动 SiliconFlow',
    nameEn: 'SiliconFlow',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    modelSuggestions: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1'],
    requiresApiKey: true,
    hintZh: '填入硅基流动 API Key 与对应 DeepSeek 托管模型 ID。',
    hintEn: 'Use your SiliconFlow API key with DeepSeek hosted model IDs.',
  },
  {
    id: 'openrouter',
    nameZh: 'OpenRouter',
    nameEn: 'OpenRouter',
    protocol: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat',
    modelSuggestions: ['deepseek/deepseek-chat', 'deepseek/deepseek-r1'],
    requiresApiKey: true,
    hintZh: '支持 OpenRouter Key，注意查看模型是否带 :free 或对应上下文上限。',
    hintEn: 'OpenRouter unified endpoint. Check model ID and context window.',
  },
  {
    id: 'ollama',
    nameZh: '本地 Ollama / 局域网模型',
    nameEn: 'Local Ollama',
    protocol: 'openai',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'deepseek-r1:latest',
    modelSuggestions: ['deepseek-r1:latest', 'deepseek-r1:8b'],
    requiresApiKey: false,
    hintZh: '纯本地免 API 费用运行，无需 Key（也可填 ollama）。',
    hintEn: 'Run local Ollama models at zero API cost. API key is optional.',
  },
  {
    id: 'custom',
    nameZh: '自定义端点（OpenAI / Anthropic）',
    nameEn: 'Custom Endpoint (OpenAI / Anthropic)',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.example.com/v1',
    defaultModel: 'deepseek-chat',
    modelSuggestions: [],
    requiresApiKey: true,
    hintZh: '自由配置任意 OpenAI Chat Completions 或 Anthropic Messages 兼容服务。',
    hintEn: 'Configure any custom OpenAI Chat Completions or Anthropic Messages provider.',
  },
]

export const findProviderPreset = (id: ProviderPresetId): ProviderPreset =>
  PROVIDER_PRESETS.find((preset) => preset.id === id) ?? PROVIDER_PRESETS[0]

export const createDefaultProvider = (
  apiKey = '',
  id = 'default-deepseek-official'
): ProviderConfig => {
  const preset = findProviderPreset('deepseek-official')
  return {
    id,
    preset: preset.id,
    name: preset.nameZh,
    protocol: preset.protocol,
    baseUrl: preset.defaultBaseUrl,
    apiKey,
    model: preset.defaultModel,
    useCorsProxy: false,
  }
}

export const normalizeBaseUrl = (raw: string): string => raw.trim().replace(/\/+$/u, '')

export const isValidHttpBaseUrl = (raw: string): boolean => {
  const trimmed = normalizeBaseUrl(raw)
  if (!trimmed) {
    return false
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

export const supportsNativeDeepseekTools = (provider: ProviderConfig): boolean =>
  provider.protocol === 'deepseek-anthropic'

export const isProviderConfigured = (provider: ProviderConfig | undefined): boolean => {
  if (!provider || !isValidHttpBaseUrl(provider.baseUrl) || !provider.model.trim()) {
    return false
  }
  const preset = findProviderPreset(provider.preset)
  if (!preset.requiresApiKey) {
    return true
  }
  return provider.apiKey.trim().length > 0
}

export type ResolvedEndpoints = {
  messagesUrl: string
  modelsUrl: string
  filesUrl?: string
  toolsUrl?: string
}

const trimTrailingSuffix = (url: string, suffix: string): string =>
  url.endsWith(suffix) ? url.slice(0, -suffix.length) : url

export const resolveProviderEndpoints = (provider: ProviderConfig): ResolvedEndpoints => {
  const base = normalizeBaseUrl(provider.baseUrl)
  if (provider.protocol === 'deepseek-anthropic') {
    const origin = trimTrailingSuffix(
      trimTrailingSuffix(base, '/anthropic/v1'),
      '/anthropic'
    ).replace(/\/v1$/u, '')
    const anthropicRoot = base.endsWith('/anthropic/v1') ? base : `${origin}/anthropic/v1`
    return {
      messagesUrl: `${anthropicRoot}/messages`,
      filesUrl: `${anthropicRoot}/files`,
      modelsUrl: `${origin}/models`,
      toolsUrl: `${origin}/v1/tools`,
    }
  }

  if (provider.protocol === 'anthropic') {
    const clean = trimTrailingSuffix(base, '/messages')
    const root = /\/v\d+(?:alpha|beta)?$/iu.test(clean) ? clean : `${clean}/v1`
    return {
      messagesUrl: `${root}/messages`,
      modelsUrl: `${root}/models`,
    }
  }

  // OpenAI 兼容协议：若末尾已经含 /chat/completions 或版本段（/v1、/zen/go/v1、/v4），直接拼接
  const clean = trimTrailingSuffix(base, '/chat/completions')
  let parsedPath = ''
  try {
    parsedPath = new URL(clean).pathname.replace(/\/+$/u, '')
  } catch {
    parsedPath = ''
  }
  const hasVersionSegment =
    /\/v\d+(?:alpha|beta)?$/iu.test(parsedPath) || /\/openai\/v\d+$/iu.test(parsedPath)
  const root = hasVersionSegment || parsedPath.includes('/v1/') ? clean : `${clean}/v1`
  return {
    messagesUrl: `${root}/chat/completions`,
    modelsUrl: `${root}/models`,
  }
}

export const resolveFetchTarget = (
  targetUrl: string,
  useCorsProxy: boolean,
  corsProxyUrl: string
): string => {
  const rawProxy = corsProxyUrl.trim()
  if (!useCorsProxy) {
    return targetUrl
  }
  const bridgeDefault = getDefaultCorsProxyUrl()
  const proxy =
    (!rawProxy || rawProxy === '/_proxy') && bridgeDefault !== '/_proxy' ? bridgeDefault : rawProxy
  if (!proxy) {
    return targetUrl
  }
  if (proxy.includes('{url}')) {
    return proxy.replace('{url}', encodeURIComponent(targetUrl))
  }
  const sep = proxy.includes('?') ? '&' : '?'
  return `${proxy}${sep}url=${encodeURIComponent(targetUrl)}`
}

const STATIC_PROXYLESS_HOST_SUFFIXES = ['.github.io', '.pages.dev', '.netlify.app', '.vercel.app']

/** 判断当前宿主是否可尝试探测同源 /_proxy（跳过纯静态托管域名以避免 404 控制台报错） */
export const shouldProbeLocalProxy = (protocol: string, hostname: string): boolean => {
  if (protocol !== 'http:' && protocol !== 'https:') {
    return false
  }
  const lower = hostname.toLowerCase()
  return !STATIC_PROXYLESS_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

let cachedLocalProxyProbe: Promise<boolean> | null = null

/** 探测当前宿主（server.mjs 或 Android LocalBridgeServer）是否内置 /_proxy 转发服务 */
export const probeLocalProxy = (): Promise<boolean> => {
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return Promise.resolve(false)
  }
  const { protocol, hostname } = window.location
  if (!shouldProbeLocalProxy(protocol, hostname)) {
    return Promise.resolve(false)
  }
  const proxyBase = getDefaultCorsProxyUrl()
  const probeUrl = proxyBase.includes('?') ? `${proxyBase}&probe=1` : `${proxyBase}?probe=1`
  const token = getAndroidBridgeToken()
  return (cachedLocalProxyProbe ??= fetch(probeUrl, {
    method: 'HEAD',
    ...(token ? { headers: { 'X-DS-Bridge-Token': token } } : {}),
  })
    .then((res) => res.status === 204 || res.status === 400)
    .catch(() => false))
}
