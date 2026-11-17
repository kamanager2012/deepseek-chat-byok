import { describe, expect, it, vi } from 'vitest'
import { streamProviderMessage } from '../src/services/api/client.js'
import {
  buildOpenAIMessages,
  OpenAIStreamError,
  parseOpenAIStream,
  type OpenAIInlineAttachment,
} from '../src/services/api/openai.js'
import {
  createDefaultProvider,
  findProviderPreset,
  isProviderConfigured,
  resolveFetchTarget,
  resolveProviderEndpoints,
  shouldProbeLocalProxy,
  type ProviderConfig,
} from '../src/services/api/providers.js'

const streamFromChunks = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

describe('provider endpoint resolution', () => {
  it('resolves DeepSeek Official Anthropic endpoints cleanly', () => {
    const p = createDefaultProvider('sk-test')
    expect(resolveProviderEndpoints(p)).toEqual({
      messagesUrl: 'https://api.deepseek.com/anthropic/v1/messages',
      filesUrl: 'https://api.deepseek.com/anthropic/v1/files',
      modelsUrl: 'https://api.deepseek.com/models',
      toolsUrl: 'https://api.deepseek.com/v1/tools',
    })
  })

  it('resolves OpenCode Go, OpenAI, and Ollama endpoints cleanly', () => {
    const goPreset = findProviderPreset('opencode-go')
    const goProvider: ProviderConfig = {
      id: 'go',
      preset: goPreset.id,
      name: goPreset.nameEn,
      protocol: goPreset.protocol,
      baseUrl: `${goPreset.defaultBaseUrl}/`,
      apiKey: 'oc-key',
      model: goPreset.defaultModel,
      useCorsProxy: false,
    }
    expect(resolveProviderEndpoints(goProvider)).toEqual({
      messagesUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
      modelsUrl: 'https://opencode.ai/zen/go/v1/models',
    })

    const bareOpenAi: ProviderConfig = {
      ...goProvider,
      baseUrl: 'https://proxy.example.com',
    }
    expect(resolveProviderEndpoints(bareOpenAi)).toEqual({
      messagesUrl: 'https://proxy.example.com/v1/chat/completions',
      modelsUrl: 'https://proxy.example.com/v1/models',
    })

    const ollamaPreset = findProviderPreset('ollama')
    const ollama: ProviderConfig = {
      id: 'ollama',
      preset: ollamaPreset.id,
      name: ollamaPreset.nameEn,
      protocol: ollamaPreset.protocol,
      baseUrl: ollamaPreset.defaultBaseUrl,
      apiKey: '',
      model: ollamaPreset.defaultModel,
      useCorsProxy: false,
    }
    expect(isProviderConfigured(ollama)).toBe(true)
    expect(isProviderConfigured(createDefaultProvider(''))).toBe(false)
  })

  it('routes through local CORS proxy only when enabled', () => {
    const url = 'https://opencode.ai/zen/go/v1/chat/completions'
    expect(resolveFetchTarget(url, false, '/_proxy')).toBe(url)
    expect(resolveFetchTarget(url, true, '/_proxy')).toBe(`/_proxy?url=${encodeURIComponent(url)}`)
  })
})

describe('OpenAI protocol adapter', () => {
  it('converts latest_reminder, multimodal inline images, and drops DeepSeek server tool blocks', () => {
    const inlineFiles = new Map<string, OpenAIInlineAttachment>([
      [
        'local-inline:img-1',
        {
          fileId: 'local-inline:img-1',
          dataUrl: 'data:image/png;base64,AAA',
          name: 'pic.png',
          isImage: true,
        },
      ],
    ])
    const msgs = buildOpenAIMessages(
      'System rule',
      [
        { role: 'latest_reminder', content: '2026-11-17,Tuesday,Beijing,Web,中文' },
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'file', file_id: 'local-inline:img-1' } },
            { type: 'text', text: 'Describe this' },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 't1',
              name: 'deepseek_read_url',
              input: { action: 'read_link', url: 'https://example.com' },
              kind: 'read_link',
            },
            { type: 'text', text: 'Here is the description.' },
          ],
        },
        { role: 'user', content: 'Next question' },
      ],
      inlineFiles
    )

    expect(msgs).toEqual([
      { role: 'system', content: 'System rule' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[2026-11-17,Tuesday,Beijing,Web,中文]' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          { type: 'text', text: 'Describe this' },
        ],
      },
      { role: 'assistant', content: 'Here is the description.' },
      { role: 'user', content: 'Next question' },
    ])
  })

  it('translates streaming reasoning_content + content + cached usage into MessageStreamEvents', async () => {
    const stream = streamFromChunks([
      'data: {"id":"c1","model":"deepseek-v4.1-flash","choices":[{"delta":{"reasoning_content":"Think step 1. "}}]}\n\n',
      'data: {"id":"c1","model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"Final "}}]}\n\n',
      'data: {"id":"c1","model":"deepseek-v4.1-flash","choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":42,"prompt_tokens_details":{"cached_tokens":800}}}\n\n',
      'data: [DONE]\n\n',
    ])

    const events = []
    for await (const ev of parseOpenAIStream(stream, new AbortController().signal, 'fallback')) {
      events.push(ev)
    }

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    const messageDelta = events.find((e) => e.type === 'message_delta')
    expect(messageDelta?.usage).toEqual({
      input_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 800,
      output_tokens: 42,
    })
  })

  it('throws interrupted when OpenAI stream truncates without finish_reason or [DONE]', async () => {
    const stream = streamFromChunks([
      'data: {"id":"c1","model":"deepseek-chat","choices":[{"delta":{"content":"partial"}}]}\n\n',
    ])
    const collect = async () => {
      for await (const ev of parseOpenAIStream(
        stream,
        new AbortController().signal,
        'deepseek-chat'
      )) {
        void ev
      }
    }
    await expect(collect()).rejects.toThrow(OpenAIStreamError)
  })

  it('appends a safe user continuation instruction instead of ending with bare assistant prefill', () => {
    const msgs = buildOpenAIMessages('System', [
      { role: 'user', content: 'Write chapter 1' },
      { role: 'assistant', content: [{ type: 'text', text: 'Once upon a time,' }] },
    ])
    expect(msgs.at(-2)).toEqual({ role: 'assistant', content: 'Once upon a time,' })
    expect(msgs.at(-1)?.role).toBe('user')
  })

  it('extracts inline <think>...</think> blocks split across SSE chunks while preserving literal mid-answer tags', async () => {
    const stream = streamFromChunks([
      'data: {"id":"r1","model":"deepseek-r1:8b","choices":[{"delta":{"content":"<th"}}]}\n\n',
      'data: {"id":"r1","model":"deepseek-r1:8b","choices":[{"delta":{"content":"ink>Step 1"}}]}\n\n',
      'data: {"id":"r1","model":"deepseek-r1:8b","choices":[{"delta":{"content":" Step 2</thi"}}]}\n\n',
      'data: {"id":"r1","model":"deepseek-r1:8b","choices":[{"delta":{"content":"nk>\\nAnswer uses <think> literally."},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ])

    const events = []
    for await (const ev of parseOpenAIStream(stream, new AbortController().signal, 'r1')) {
      events.push(ev)
    }

    const thinkingText = events
      .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'thinking_delta')
      .map((e) =>
        e.type === 'content_block_delta' && e.delta.type === 'thinking_delta'
          ? e.delta.thinking
          : ''
      )
      .join('')
    const answerText = events
      .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'text_delta')
      .map((e) =>
        e.type === 'content_block_delta' && e.delta.type === 'text_delta' ? e.delta.text : ''
      )
      .join('')

    expect(thinkingText).toBe('Step 1 Step 2')
    expect(answerText).toContain('Answer uses <think> literally.')
  })

  it('retries OpenAI stream request cleanly without stream_options when strict gateways reject it with 400', async () => {
    const seenPayloads: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        seenPayloads.push(parsed)
        if (parsed.stream_options) {
          return new Response(
            JSON.stringify({ error: { message: 'Unknown field: stream_options' } }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new Response(
          streamFromChunks([
            'data: {"id":"f1","choices":[{"delta":{"content":"fallback-ok"},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }
        )
      })
    )

    try {
      const provider: ProviderConfig = {
        ...createDefaultProvider('sk-test', 'p-strict'),
        preset: 'custom',
        protocol: 'openai',
        baseUrl: 'https://strict-gateway.example/v1',
        model: 'deepseek-chat',
      }
      const events = []
      for await (const ev of streamProviderMessage({
        provider,
        signal: new AbortController().signal,
        body: {
          model: 'deepseek-chat',
          system: '',
          messages: [{ role: 'user', content: 'hi' }],
        },
      })) {
        events.push(ev)
      }

      expect(seenPayloads.length).toBe(2)
      expect(seenPayloads[0]?.stream_options).toEqual({ include_usage: true })
      expect(seenPayloads[1]?.stream_options).toBeUndefined()
      expect(events.some((e) => e.type === 'message_stop')).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('skips local /_proxy probing on static hosting domains and file:// origins', () => {
    expect(shouldProbeLocalProxy('https:', 'kamanager2012.github.io')).toBe(false)
    expect(shouldProbeLocalProxy('https:', 'demo.pages.dev')).toBe(false)
    expect(shouldProbeLocalProxy('file:', '')).toBe(false)
    expect(shouldProbeLocalProxy('http:', '127.0.0.1')).toBe(true)
    expect(shouldProbeLocalProxy('https:', 'chat.custom-vps.example')).toBe(true)
  })
})
