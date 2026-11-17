import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import {
  createDefaultProvider,
  isProviderConfigured,
  type ProviderConfig,
} from './api/providers.js'
import {
  getDefaultCorsProxyUrl,
  hasAndroidSecureStorage,
  readAndroidSecureSecrets,
  writeAndroidSecureSecrets,
} from './api/androidBridge.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

export const DEFAULT_SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

export const SYSTEM_PROMPT_PRESETS = [
  {
    id: 'default',
    labelZh: 'DeepSeek 原版通用',
    labelEn: 'DeepSeek Default',
    prompt: DEFAULT_SYSTEM_PROMPT,
  },
  {
    id: 'companion',
    labelZh: '长对话伴侣 / 人设记忆优先',
    labelEn: 'Companion / Long-Term Memory',
    prompt:
      '你是用户的长期对话伙伴，请保持自然、连贯且富有人情味的风格。请严格遵循前文已确立的人物设定、称呼、相处细节与约定，不要生硬重复模板客套。',
  },
  {
    id: 'writing',
    labelZh: '长篇创作 / 小说润色',
    labelEn: 'Creative Writing / Fiction',
    prompt:
      '你是一位擅长中文叙事与网文/剧本创作的写作搭档。请严格保持前文剧情走向、人物性格、文风节奏与细节一致，直接续写或修改，不要擅自总结或替用户完结剧情。',
  },
] as const

/** 本机设置，存 localStorage：API 配置列表、主题、语言、语音、上下文预算与本地转发 */
type Settings = {
  apiKey: string | null
  providers: ProviderConfig[]
  activeProviderId: string
  corsProxyUrl: string
  contextMaxRounds: number
  contextMaxTokens: number
  systemPrompt: string
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  providers: 'chat-demo:providers-v1',
  activeProviderId: 'chat-demo:active-provider-id',
  corsProxyUrl: 'chat-demo:cors-proxy-url',
  contextMaxRounds: 'chat-demo:context-max-rounds',
  contextMaxTokens: 'chat-demo:context-max-tokens',
  systemPrompt: 'chat-demo:system-prompt',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

const readNonNegInt = (key: string, fallback: number): number => {
  const raw = read(key)
  if (!raw) {
    return fallback
  }
  const num = Number(raw)
  return Number.isSafeInteger(num) && num >= 0 ? num : fallback
}

const isProviderRecord = (value: unknown): value is ProviderConfig => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    typeof item.preset === 'string' &&
    typeof item.name === 'string' &&
    typeof item.protocol === 'string' &&
    typeof item.baseUrl === 'string' &&
    typeof item.apiKey === 'string' &&
    typeof item.model === 'string'
  )
}

const buildSecretVaultMap = (providers: ProviderConfig[]): Record<string, string> => {
  const vault: Record<string, string> = {}
  for (const item of providers) {
    const key = item.apiKey.trim()
    if (key) {
      vault[item.id] = key
    }
  }
  return vault
}

const stripProviderSecrets = (providers: ProviderConfig[]): ProviderConfig[] =>
  providers.map((item) => (item.apiKey ? { ...item, apiKey: '' } : item))

/** Android 下把 localStorage 遗留明文密钥迁入 AndroidKeyStore 保险箱并清除明文 */
export const loadInitialProvidersWithVault = (): {
  providers: ProviderConfig[]
  activeProviderId: string
} => {
  const legacyKey = read(KEYS.apiKey) ?? ''
  let resolved: { providers: ProviderConfig[]; activeProviderId: string } | null = null
  try {
    const raw = JSON.parse(read(KEYS.providers) ?? 'null') as unknown
    if (Array.isArray(raw)) {
      const valid = raw.filter(isProviderRecord).map((item) => ({
        ...item,
        useCorsProxy: item.useCorsProxy === true,
      }))
      if (valid.length > 0) {
        const savedActive = read(KEYS.activeProviderId) ?? ''
        const activeId = valid.some((p) => p.id === savedActive) ? savedActive : valid[0].id
        resolved = { providers: valid, activeProviderId: activeId }
      }
    }
  } catch {
    // 解析失败回退默认配置
  }
  if (!resolved) {
    const fallback = createDefaultProvider(legacyKey)
    resolved = { providers: [fallback], activeProviderId: fallback.id }
  }
  if (!hasAndroidSecureStorage()) {
    return resolved
  }

  const vault = readAndroidSecureSecrets()
  let needsVaultWrite = false
  let hasLocalPlaintext = Boolean(legacyKey.trim())
  const hydrated = resolved.providers.map((item) => {
    const localKey = item.apiKey.trim()
    if (localKey) {
      hasLocalPlaintext = true
      if (!vault[item.id]) {
        vault[item.id] = localKey
        needsVaultWrite = true
      }
    }
    const vaultKey = vault[item.id] ?? ''
    return vaultKey ? { ...item, apiKey: vaultKey } : { ...item, apiKey: '' }
  })
  if (legacyKey.trim() && hydrated[0] && !hydrated[0].apiKey.trim()) {
    hydrated[0] = { ...hydrated[0], apiKey: legacyKey.trim() }
    vault[hydrated[0].id] = legacyKey.trim()
    needsVaultWrite = true
  }
  const vaultOk = !needsVaultWrite || writeAndroidSecureSecrets(vault)
  if (hasLocalPlaintext && vaultOk) {
    write(KEYS.providers, JSON.stringify(stripProviderSecrets(hydrated)))
    write(KEYS.apiKey, null)
  }
  return { providers: hydrated, activeProviderId: resolved.activeProviderId }
}

const initialProviders = (): { providers: ProviderConfig[]; activeProviderId: string } =>
  loadInitialProvidersWithVault()

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const initProviderState = initialProviders()

const resolveActive = (providers: ProviderConfig[], activeId: string): ProviderConfig =>
  providers.find((item) => item.id === activeId) ?? providers[0] ?? createDefaultProvider()

const initialActiveProvider = resolveActive(
  initProviderState.providers,
  initProviderState.activeProviderId
)

export const useSettings = create<Settings>(() => ({
  apiKey: initialActiveProvider.apiKey.trim() || null,
  providers: initProviderState.providers,
  activeProviderId: initProviderState.activeProviderId,
  corsProxyUrl: read(KEYS.corsProxyUrl) ?? getDefaultCorsProxyUrl(),
  contextMaxRounds: readNonNegInt(KEYS.contextMaxRounds, 20),
  contextMaxTokens: readNonNegInt(KEYS.contextMaxTokens, 24000),
  systemPrompt: read(KEYS.systemPrompt) ?? DEFAULT_SYSTEM_PROMPT,
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const getActiveProvider = (state: Pick<Settings, 'providers' | 'activeProviderId'>) =>
  resolveActive(state.providers, state.activeProviderId)

export const isActiveProviderReady = (state = useSettings.getState()): boolean =>
  isProviderConfigured(getActiveProvider(state))

const persistProviders = (providers: ProviderConfig[], activeId: string) => {
  const active = resolveActive(providers, activeId)
  const cleanKey = active.apiKey.trim() || null
  if (hasAndroidSecureStorage() && writeAndroidSecureSecrets(buildSecretVaultMap(providers))) {
    write(KEYS.providers, JSON.stringify(stripProviderSecrets(providers)))
    write(KEYS.apiKey, null)
  } else {
    write(KEYS.providers, JSON.stringify(providers))
    write(KEYS.apiKey, cleanKey)
  }
  write(KEYS.activeProviderId, active.id)
  useSettings.setState({
    providers,
    activeProviderId: active.id,
    apiKey: cleanKey,
  })
}

export const upsertProvider = (next: ProviderConfig, activate = true) => {
  const { providers, activeProviderId } = useSettings.getState()
  const exists = providers.some((item) => item.id === next.id)
  const updated = exists
    ? providers.map((item) => (item.id === next.id ? next : item))
    : [...providers, next]
  persistProviders(updated, activate ? next.id : activeProviderId)
}

export const selectActiveProvider = (providerId: string) => {
  const { providers } = useSettings.getState()
  if (providers.some((item) => item.id === providerId)) {
    persistProviders(providers, providerId)
  }
}

export const removeProvider = (providerId: string) => {
  const { providers, activeProviderId } = useSettings.getState()
  const remaining = providers.filter((item) => item.id !== providerId)
  if (remaining.length === 0) {
    const fallback = createDefaultProvider()
    persistProviders([fallback], fallback.id)
    return
  }
  const nextActive = activeProviderId === providerId ? remaining[0].id : activeProviderId
  persistProviders(remaining, nextActive)
}

export const setCorsProxyUrl = (corsProxyUrl: string) => {
  const clean = corsProxyUrl.trim()
  write(KEYS.corsProxyUrl, clean || null)
  useSettings.setState({ corsProxyUrl: clean })
}

export const setContextBudget = (contextMaxRounds: number, contextMaxTokens: number) => {
  const rounds = Math.max(0, Math.floor(contextMaxRounds))
  const tokens = Math.max(0, Math.floor(contextMaxTokens))
  write(KEYS.contextMaxRounds, String(rounds))
  write(KEYS.contextMaxTokens, String(tokens))
  useSettings.setState({ contextMaxRounds: rounds, contextMaxTokens: tokens })
}

export const setSystemPrompt = (systemPrompt: string) => {
  write(KEYS.systemPrompt, systemPrompt)
  useSettings.setState({ systemPrompt })
}

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  const current = getActiveProvider(useSettings.getState())
  upsertProvider({ ...current, apiKey: apiKey ?? '' }, true)
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
