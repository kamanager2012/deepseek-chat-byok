import type { Session } from '../chat/types.js'
import type { MessageUsage } from './types.js'

export type ModelPrice = {
  inputUsdPerM: number
  cacheHitUsdPerM: number
  outputUsdPerM: number
}

export type CostEstimate = {
  costUsd: number
  savedUsd: number
}

export type SessionCostSummary = {
  totalCostUsd: number
  totalSavedUsd: number
  pricedMessages: number
}

const PRICE_RULES: readonly [RegExp, ModelPrice][] = [
  [
    /^(?:deepseek\/)?deepseek-(?:chat|v3|flash|v4\.1-flash)(?:$|:|-)/i,
    { inputUsdPerM: 0.27, cacheHitUsdPerM: 0.07, outputUsdPerM: 1.1 },
  ],
  [
    /^(?:deepseek\/)?deepseek-(?:reasoner|r1|v4-pro)(?:$|:|-)/i,
    { inputUsdPerM: 0.55, cacheHitUsdPerM: 0.14, outputUsdPerM: 2.19 },
  ],
  [/^claude-sonnet-4-5/i, { inputUsdPerM: 3.0, cacheHitUsdPerM: 0.3, outputUsdPerM: 15.0 }],
  [/^claude-haiku-4-5/i, { inputUsdPerM: 0.8, cacheHitUsdPerM: 0.08, outputUsdPerM: 4.0 }],
  [/^claude-opus-4-1/i, { inputUsdPerM: 15.0, cacheHitUsdPerM: 1.5, outputUsdPerM: 75.0 }],
]

export const findModelPrice = (modelId: string | null | undefined): ModelPrice | null => {
  if (!modelId) {
    return null
  }
  const clean = modelId.trim()
  if (!clean) {
    return null
  }
  const tail = clean.includes('/') ? clean.slice(clean.lastIndexOf('/') + 1) : clean
  for (const [pattern, price] of PRICE_RULES) {
    if (pattern.test(clean) || pattern.test(tail)) {
      return price
    }
  }
  return null
}

/** 按公开标准费率估算单条回复花费及上下文缓存命中节省金额（USD） */
export const estimateMessageCost = (
  usage: MessageUsage | undefined,
  modelId: string | null | undefined
): CostEstimate | null => {
  if (!usage) {
    return null
  }
  const price = findModelPrice(modelId)
  if (!price) {
    return null
  }
  const uncachedInput = usage.input_tokens + usage.cache_creation_input_tokens
  const cachedInput = usage.cache_read_input_tokens
  const costUsd =
    (uncachedInput * price.inputUsdPerM +
      cachedInput * price.cacheHitUsdPerM +
      usage.output_tokens * price.outputUsdPerM) /
    1_000_000
  const savedUsd =
    (cachedInput * Math.max(0, price.inputUsdPerM - price.cacheHitUsdPerM)) / 1_000_000
  return { costUsd, savedUsd }
}

/** 汇总当前会话全部已计价回复的总预估花费与缓存省流 */
export const estimateSessionCost = (
  session: Session | null,
  fallbackModelId: string | null | undefined
): SessionCostSummary | null => {
  if (!session) {
    return null
  }
  let totalCostUsd = 0
  let totalSavedUsd = 0
  let pricedMessages = 0
  for (const msg of session.messages) {
    if (msg.role !== 'assistant' || !msg.usage) {
      continue
    }
    const est = estimateMessageCost(msg.usage, msg.model ?? fallbackModelId)
    if (est) {
      totalCostUsd += est.costUsd
      totalSavedUsd += est.savedUsd
      pricedMessages += 1
    }
  }
  return pricedMessages > 0 ? { totalCostUsd, totalSavedUsd, pricedMessages } : null
}

export const formatUsdCost = (usd: number): string => {
  if (!Number.isFinite(usd) || usd <= 0) {
    return '$0.00'
  }
  if (usd < 0.0001) {
    return '<$0.0001'
  }
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`
  }
  return `$${usd.toFixed(3)}`
}

const USD_TO_CNY = 7.25

/** 按参考汇率换算为通俗人民币（元），便于非技术用户理解大致花费 */
export const formatCnyCost = (usd: number): string => {
  if (!Number.isFinite(usd) || usd <= 0) {
    return '¥0.00 元'
  }
  const cny = usd * USD_TO_CNY
  if (cny < 0.01) {
    return '< ¥0.01 元'
  }
  return `¥${cny.toFixed(2)} 元`
}
