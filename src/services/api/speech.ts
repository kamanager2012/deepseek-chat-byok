import { ApiError, API_ORIGIN, request } from './client.js'
import {
  createDefaultProvider,
  resolveFetchTarget,
  resolveProviderEndpoints,
  type ProviderConfig,
} from './providers.js'

export type TtsVoice = 'stella' | 'tide'

/** TTS 输出的裸 PCM 参数：24kHz、单声道、16-bit 小端 */
export const TTS_SAMPLE_RATE = 24000

const resolveToolsBase = (provider?: ProviderConfig, apiKey = ''): ProviderConfig =>
  provider ?? { ...createDefaultProvider(apiKey), baseUrl: API_ORIGIN }

const requireToolsUrl = (provider: ProviderConfig, corsProxyUrl: string, path: string): string => {
  const endpoints = resolveProviderEndpoints(provider)
  if (!endpoints.toolsUrl) {
    throw new ApiError('protocol', 'Speech endpoint requires DeepSeek Official Anthropic mode')
  }
  return resolveFetchTarget(`${endpoints.toolsUrl}${path}`, provider.useCorsProxy, corsProxyUrl)
}

/** 语音识别：audio 为 WAV（单声道 16-bit PCM）或 Ogg Opus，时长不超过 120 秒、大小不超过 8 MiB */
export const transcribe = async (
  apiKey: string,
  audio: Blob,
  signal?: AbortSignal,
  provider?: ProviderConfig,
  corsProxyUrl = ''
): Promise<string> => {
  const resolved = resolveToolsBase(provider, apiKey)
  const target = requireToolsUrl(resolved, corsProxyUrl, '/asr')
  const key = resolved.apiKey.trim() || apiKey
  const form = new FormData()
  form.append('file', audio, 'recording.wav')
  const response = await request(target, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal,
  })
  const raw = await response.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('protocol', raw)
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('text' in body) ||
    typeof body.text !== 'string'
  ) {
    throw new ApiError('protocol', raw)
  }
  return body.text
}

/** 语音合成：返回裸 PCM 字节流；服务端默认过滤代码块、表格、引用标记与长公式 */
export const synthesize = async (
  apiKey: string,
  text: string,
  voice: TtsVoice,
  signal: AbortSignal,
  provider?: ProviderConfig,
  corsProxyUrl = ''
): Promise<ReadableStream<Uint8Array>> => {
  const resolved = resolveToolsBase(provider, apiKey)
  const target = requireToolsUrl(resolved, corsProxyUrl, '/tts')
  const key = resolved.apiKey.trim() || apiKey
  const response = await request(target, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true }),
    signal,
  })
  if (!response.body) {
    throw new ApiError('protocol', await response.text())
  }
  return response.body
}
