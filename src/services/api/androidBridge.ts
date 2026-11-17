export type AndroidExportBridgeLike = {
  getBridgeToken?: () => string
  getProxyUrl?: () => string
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
