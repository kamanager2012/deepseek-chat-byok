/** 严格校验外部可点击/可渲染跳转 URL 必须为 http: 或 https: 协议，拦截 javascript: / data: / vbscript: 等危险伪协议 */
export const isSafeHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
