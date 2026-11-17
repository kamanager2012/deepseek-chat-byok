import { describe, expect, it } from 'vitest'
import { sanitizeGenericAnthropicBody } from '../src/services/api/client.js'
import type { OpenAIInlineAttachment } from '../src/services/api/openai.js'
import { buildInlineAttachmentData, LOCAL_INLINE_PREFIX } from '../src/services/attachments.js'

describe('generic Anthropic adapter & inline text/image attachments', () => {
  it('inlines images as base64, keeps small text files intact, truncates >256KB text cleanly, and skips binary PDF', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const img = await buildInlineAttachmentData(
      {
        id: 'img1',
        serverId: null,
        name: 'pic.png',
        size: 4,
        isImage: true,
        mimeType: 'image/png',
      },
      new Blob([pngBytes], { type: 'image/png' })
    )
    expect(img).toEqual({
      fileId: `${LOCAL_INLINE_PREFIX}img1`,
      dataUrl: 'data:image/png;base64,iVBORw==',
      name: 'pic.png',
      isImage: true,
    })

    const smallMd = await buildInlineAttachmentData(
      {
        id: 'md1',
        serverId: null,
        name: 'outline.md',
        size: 12,
        isImage: false,
        mimeType: 'text/markdown',
      },
      new Blob(['# Chapter 1\n'], { type: 'text/markdown' })
    )
    expect(smallMd?.textExcerpt).toBe('# Chapter 1\n')

    const largeText = 'a'.repeat(270 * 1024)
    const bigTxt = await buildInlineAttachmentData(
      {
        id: 'txt1',
        serverId: null,
        name: 'draft.txt',
        size: largeText.length,
        isImage: false,
        mimeType: 'text/plain',
      },
      new Blob([largeText], { type: 'text/plain' })
    )
    expect(bigTxt?.textExcerpt).toContain('超过 256 KB')
    expect((bigTxt?.textExcerpt?.length ?? 0) < largeText.length).toBe(true)

    const pdf = await buildInlineAttachmentData(
      {
        id: 'pdf1',
        serverId: null,
        name: 'book.pdf',
        size: 100,
        isImage: false,
        mimeType: 'application/pdf',
      },
      new Blob(['%PDF-1.7'], { type: 'application/pdf' })
    )
    expect(pdf).toBeNull()
  })

  it('adds thinking.budget_tokens, expands base64 images & text excerpts, and omits unsigned thinking blocks', () => {
    const inlineFiles = new Map<string, OpenAIInlineAttachment>([
      [
        `${LOCAL_INLINE_PREFIX}img1`,
        {
          fileId: `${LOCAL_INLINE_PREFIX}img1`,
          dataUrl: 'data:image/png;base64,AAAA',
          name: 'cover.png',
          isImage: true,
        },
      ],
      [
        `${LOCAL_INLINE_PREFIX}txt1`,
        {
          fileId: `${LOCAL_INLINE_PREFIX}txt1`,
          textExcerpt: 'Character sheet notes',
          name: 'notes.txt',
          isImage: false,
        },
      ],
    ])

    const payload = sanitizeGenericAnthropicBody(
      {
        model: 'claude-sonnet-4-5',
        system: 'Be concise',
        thinking: { type: 'enabled' },
        safety_check: { level: 'high' },
        messages: [
          { role: 'latest_reminder', content: '2026-11-17' },
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'file', file_id: `${LOCAL_INLINE_PREFIX}img1` } },
              { type: 'document', source: { type: 'file', file_id: `${LOCAL_INLINE_PREFIX}txt1` } },
              { type: 'text', text: 'Summarize these.' },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'unsigned draft', signature: '' },
              { type: 'text', text: 'Partial answer' },
            ],
          },
        ],
      },
      inlineFiles
    )

    expect(payload.safety_check).toBeUndefined()
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
    expect(payload.max_tokens).toBe(16_384)
    expect(payload.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '[2026-11-17]' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: '\n[附件: notes.txt]\nCharacter sheet notes\n' },
          { type: 'text', text: 'Summarize these.' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Partial answer' }],
      },
    ])
  })
})
