import { describe, expect, it } from 'vitest'
import {
  estimateMessageCost,
  estimateSessionCost,
  formatUsdCost,
} from '../src/services/api/pricing.js'
import {
  applyContextBudget,
  buildDigestSourceText,
  buildEffectiveSystemPrompt,
  estimateTextTokens,
  sessionToMarkdown,
} from '../src/services/chat/contextBudget.js'
import type { AssistantMessage, Message, Session, UserMessage } from '../src/services/chat/types.js'

const makeRound = (i: number, qText: string, aText: string): [UserMessage, AssistantMessage] => [
  {
    id: `u-${i}`,
    role: 'user',
    content: qText,
    files: [],
    createdAt: i * 1000,
  },
  {
    id: `a-${i}`,
    role: 'assistant',
    createdAt: i * 1000 + 100,
    model: 'deepseek-flash',
    prefix: false,
    status: 'done',
    blocks: [
      { type: 'thinking', thinking: 'internal chain omitted on send' },
      { type: 'text', text: aText },
    ],
  },
]

describe('context budget & memory distillation', () => {
  it('trims oldest rounds to enforce maxRounds and maxTokens while keeping recent context intact', () => {
    const rounds = Array.from({ length: 10 }, (_, idx) =>
      makeRound(idx + 1, `第${idx + 1}轮提问`.repeat(30), `第${idx + 1}轮详细回答`.repeat(50))
    )
    const history: Message[] = rounds.flat()

    const byRounds = applyContextBudget(history, { maxRounds: 3, maxTokens: 0 })
    expect(byRounds.totalRounds).toBe(10)
    expect(byRounds.keptRounds).toBe(3)
    expect(byRounds.droppedRounds).toHaveLength(7)
    expect(byRounds.keptHistory[0]?.id).toBe('u-8')

    const singleRoundCost = Math.ceil(byRounds.estimatedHistoryTokens / 3)
    const byTokens = applyContextBudget(history, {
      maxRounds: 0,
      maxTokens: Math.floor(singleRoundCost * 2.2),
    })
    expect(byTokens.keptRounds).toBe(2)
    expect(byTokens.keptHistory[0]?.id).toBe('u-9')
    expect(byTokens.estimatedHistoryTokens).toBeLessThan(byTokens.fullHistoryTokens)
  })

  it('builds compact digest source text, effective system prompt, and clean Markdown export', () => {
    const rounds = [makeRound(1, '角色设定：叫我阿明', '好的阿明，记住设定了')]
    const digest = buildDigestSourceText(rounds, '已有背景')
    expect(digest).toContain('[已有记忆前缀]\n已有背景')
    expect(digest).toContain('叫我阿明')

    const sys = buildEffectiveSystemPrompt('基础提示词', '角色叫阿明')
    expect(sys).toContain('基础提示词')
    expect(sys).toContain('[长期记忆与约定]\n角色叫阿明')

    const md = sessionToMarkdown(
      { id: 's1', title: '测试会话', memoryPrompt: '记忆内容' },
      rounds.flat(),
      false
    )
    expect(md).toContain('# 测试会话')
    expect(md).toContain('## 长期记忆 / 设定前缀')
    expect(md).not.toContain('internal chain omitted on send')
    expect(md).toContain('好的阿明，记住设定了')

    expect(estimateTextTokens('你好世界abc')).toBeGreaterThan(0)
  })

  it('estimates DeepSeek/Claude message and session USD costs with cache-hit savings', () => {
    const est = estimateMessageCost(
      {
        input_tokens: 1_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100_000,
        output_tokens: 1_000,
      },
      'deepseek-chat'
    )
    expect(est).not.toBeNull()
    expect(est?.costUsd).toBeCloseTo(0.00837, 6)
    expect(est?.savedUsd).toBeCloseTo(0.02, 6)
    expect(formatUsdCost(est?.costUsd ?? 0)).toBe('$0.0084')

    const session: Session = {
      id: 'cost-s1',
      title: 'Cost check',
      createdAt: 1000,
      updatedAt: 2000,
      messages: [
        makeRound(1, 'hi', 'hello')[0],
        {
          ...makeRound(1, 'hi', 'hello')[1],
          usage: {
            input_tokens: 1_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 100_000,
            output_tokens: 1_000,
          },
        },
      ],
    }
    const summary = estimateSessionCost(session, 'deepseek-chat')
    expect(summary?.pricedMessages).toBe(1)
    expect(summary?.totalSavedUsd).toBeCloseTo(0.02, 6)
    expect(estimateMessageCost(undefined, 'unknown-model')).toBeNull()
    expect(
      estimateMessageCost(
        {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 50,
        },
        'unknown-model'
      )
    ).toBeNull()
  })
})
