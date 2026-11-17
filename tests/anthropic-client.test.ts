import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { ApiError, streamProviderMessage, verifyProvider } from '../src/services/api/client.js'
import { LOCAL_INLINE_PREFIX } from '../src/services/attachments.js'
import type { OpenAIInlineAttachment } from '../src/services/api/openai.js'
import type { ProviderConfig } from '../src/services/api/providers.js'

const startMockAnthropicServer = (): Promise<{
  port: number
  close: () => Promise<void>
}> =>
  new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/v1/models' && req.method === 'GET') {
        expect(req.headers['x-api-key']).toBe('sk-ant-test')
        expect(req.headers['anthropic-version']).toBe('2023-06-01')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-1' }] }))
        return
      }

      if (req.url === '/v1/messages' && req.method === 'POST') {
        expect(req.headers['x-api-key']).toBe('sk-ant-test')
        expect(req.headers['anthropic-version']).toBe('2023-06-01')
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            model: string
            max_tokens: number
            thinking?: { type: string; budget_tokens?: number }
            messages: Array<{ role: string; content: unknown }>
            safety_check?: unknown
          }
          if (JSON.stringify(payload.messages).includes('TRIGGER_STREAM_ERROR')) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
            res.write('event: error\n')
            res.write('data: {"error":{"message":"Upstream overloaded"}}\n\n')
            res.end()
            return
          }

          expect(payload.model).toBe('claude-sonnet-4-5')
          expect(payload.safety_check).toBeUndefined()
          expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
          expect(payload.max_tokens).toBe(16_384)
          expect(JSON.stringify(payload.messages)).toContain('"media_type":"image/png"')
          expect(JSON.stringify(payload.messages)).toContain('[附件: outline.md]')

          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
          res.write(
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ant_1","model":"claude-sonnet-4-5","usage":{"input_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}}\n\n'
          )
          res.write(
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n'
          )
          res.write(
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Analyzing image"}}\n\n'
          )
          res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
          res.write(
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n'
          )
          res.write(
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Anthropic reply ok."}}\n\n'
          )
          res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n')
          res.write(
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":10,"output_tokens":12}}\n\n'
          )
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
          res.end()
        })
        return
      }

      res.writeHead(404)
      res.end()
    })

    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            srv.closeAllConnections?.()
            srv.close(() => done())
          }),
      })
    })
  })

describe('Generic Anthropic Messages provider HTTP & SSE end-to-end', () => {
  it('verifies Anthropic models, streams thinking + inline vision/text, and surfaces stream errors', async () => {
    const srv = await startMockAnthropicServer()
    try {
      const provider: ProviderConfig = {
        id: 'ant-1',
        preset: 'anthropic',
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: `http://127.0.0.1:${srv.port}/v1`,
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5',
        useCorsProxy: false,
      }

      const models = await verifyProvider(provider)
      expect(models).toEqual(['claude-sonnet-4-5', 'claude-opus-4-1'])

      const inlineFiles = new Map<string, OpenAIInlineAttachment>([
        [
          `${LOCAL_INLINE_PREFIX}img1`,
          {
            fileId: `${LOCAL_INLINE_PREFIX}img1`,
            dataUrl: 'data:image/png;base64,iVBORw==',
            name: 'pic.png',
            isImage: true,
          },
        ],
        [
          `${LOCAL_INLINE_PREFIX}md1`,
          {
            fileId: `${LOCAL_INLINE_PREFIX}md1`,
            textExcerpt: 'Chapter 1 beat sheet',
            name: 'outline.md',
            isImage: false,
          },
        ],
      ])

      const events = []
      for await (const ev of streamProviderMessage({
        provider,
        inlineFiles,
        signal: new AbortController().signal,
        body: {
          model: 'claude-sonnet-4-5',
          system: 'System instruction',
          thinking: { type: 'enabled' },
          safety_check: { level: 'high' },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'file', file_id: `${LOCAL_INLINE_PREFIX}img1` } },
                {
                  type: 'document',
                  source: { type: 'file', file_id: `${LOCAL_INLINE_PREFIX}md1` },
                },
                { type: 'text', text: 'Analyze both' },
              ],
            },
          ],
        },
      })) {
        events.push(ev)
      }

      expect(events.map((e) => e.type)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ])

      const runErr = async () => {
        for await (const ev of streamProviderMessage({
          provider,
          inlineFiles,
          signal: new AbortController().signal,
          body: {
            model: 'claude-sonnet-4-5',
            system: '',
            thinking: { type: 'enabled' },
            messages: [{ role: 'user', content: 'TRIGGER_STREAM_ERROR' }],
          },
        })) {
          void ev
        }
      }
      await expect(runErr()).rejects.toThrow(ApiError)
    } finally {
      await srv.close()
    }
  })
})
