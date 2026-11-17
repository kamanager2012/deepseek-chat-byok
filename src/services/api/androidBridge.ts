export type AndroidExportBridgeLike = {
  getBridgeToken?: () => string
  getProxyUrl?: () => string
  readSecureSecrets?: (token: string) => string
  writeSecureSecrets?: (token: string, json: string) => boolean
  consumePendingSharedZip?: (token: string) => string
}

/** 读取 Android WebView 注入的原生桥接对象（仅在 Android APK 环境存在） */
export const getAndroidBridge = (): AndroidExportBridgeLike | null => {
  if (typeof window === 'undefined') {
    return null
  }
  const bridge = (window as Window & { AndroidExportBridge?: AndroidExportBridgeLike })
    .AndroidExportBridge
  return bridge ?? null
}

export const hasAndroidBridge = (): boolean => getAndroidBridge() !== null

/** 获取 Android 单次启动随机生成且不入库的本地代理令牌 */
export const getAndroidBridgeToken = (): string | null => {
  try {
    const token = getAndroidBridge()?.getBridgeToken?.()
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

/** 获取当前运行时默认的本地代理路径（在 Android 端口回退场景下指向实际桥接端口） */
export const getDefaultCorsProxyUrl = (): string => {
  try {
    const proxyUrl = getAndroidBridge()?.getProxyUrl?.()
    if (typeof proxyUrl === 'string' && proxyUrl.startsWith('http://127.0.0.1:')) {
      return proxyUrl
    }
  } catch {
    // 忽略异常回退同源相对路径
  }
  return '/_proxy'
}

const matchesUrlPrefix = (url: string, base: string): boolean =>
  url === base || url.startsWith(`${base}?`)

/** 严格限定仅向本机 /_proxy 请求附带 X-DS-Bridge-Token，杜绝泄漏给任意外部上游 */
export const isLocalProxyRequestUrl = (url: string): boolean => {
  if (matchesUrlPrefix(url, '/_proxy')) {
    return true
  }
  if (
    typeof window !== 'undefined' &&
    window.location.origin &&
    window.location.origin !== 'null' &&
    matchesUrlPrefix(url, `${window.location.origin}/_proxy`)
  ) {
    return true
  }
  const bridgeProxy = getDefaultCorsProxyUrl()
  return bridgeProxy !== '/_proxy' && matchesUrlPrefix(url, bridgeProxy)
}

/** 当前是否运行在注入了 AndroidKeyStore 加密存储接口的 Android 容器中 */
export const hasAndroidSecureStorage = (): boolean => {
  const bridge = getAndroidBridge()
  return (
    bridge !== null &&
    typeof bridge.readSecureSecrets === 'function' &&
    typeof bridge.writeSecureSecrets === 'function' &&
    getAndroidBridgeToken() !== null
  )
}

export const readAndroidSecureSecrets = (): Record<string, string> => {
  try {
    const bridge = getAndroidBridge()
    const token = getAndroidBridgeToken()
    if (!bridge?.readSecureSecrets || !token) {
      return {}
    }
    const raw = bridge.readSecureSecrets(token)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) {
        out[k] = v
      }
    }
    return out
  } catch {
    return {}
  }
}

export const writeAndroidSecureSecrets = (secrets: Record<string, string>): boolean => {
  try {
    const bridge = getAndroidBridge()
    const token = getAndroidBridgeToken()
    if (!bridge?.writeSecureSecrets || !token) {
      return false
    }
    return Boolean(bridge.writeSecureSecrets(token, JSON.stringify(secrets)))
  } catch {
    return false
  }
}

/** 读取 Android 系统「打开方式 / 分享到」传入的待导入 ZIP 文件 */
export const consumeAndroidSharedZip = async (): Promise<File | null> => {
  try {
    const bridge = getAndroidBridge()
    const token = getAndroidBridgeToken()
    if (!bridge?.consumePendingSharedZip || !token) {
      return null
    }
    const fileName = bridge.consumePendingSharedZip(token)
    if (!fileName) {
      return null
    }
    const res = await fetch(`/_shared_import.zip?token=${encodeURIComponent(token)}`, {
      cache: 'no-store',
    })
    if (!res.ok) {
      return null
    }
    const blob = await res.blob()
    return new File([blob], fileName, { type: 'application/zip' })
  } catch {
    return null
  }
}
