import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  checkProxyOrigin,
  checkProxyTargetAllowed,
  createAppServer,
  isPrivateOrMetadataIp,
} from '../server.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const startCliServer = (): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.mjs', '--host', '127.0.0.1', '--port', '0'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Server startup timeout. stdout=${out} stderr=${err}`))
    }, 10_000)

    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const match = /http:\/\/127\.0\.0\.1:(\d+)/u.exec(out)
      if (match) {
        clearTimeout(timer)
        resolve({
          url: `http://127.0.0.1:${match[1]}`,
          close: () =>
            new Promise((done) => {
              child.once('exit', () => done())
              child.kill('SIGTERM')
            }),
        })
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`Server exited early (${code}): ${err}`))
      }
    })
  })

const listenInProcess = (
  options?: Parameters<typeof createAppServer>[0]
): Promise<{
  url: string
  hostHeader: string
  close: () => Promise<void>
}> =>
  new Promise((resolve) => {
    const srv = createAppServer(options)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        hostHeader: `127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            srv.closeAllConnections?.()
            srv.close(() => done())
          }),
      })
    })
  })

const startMockUpstream = (
  handler: http.RequestListener
): Promise<{ port: number; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const srv = http.createServer(handler)
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

describe('server.mjs static & hardened SSRF/CSRF-safe /_proxy', () => {
  it('serves built dist/ assets with security headers, streams loopback SSE, and blocks SSRF targets', async () => {
    const srv = await startCliServer()
    const upstream = await startMockUpstream((req, res) => {
      if (req.url === '/redirect-ssrf') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' })
        res.end()
        return
      }
      expect(req.headers.authorization).toBe('Bearer byok-secret')
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      res.write('data: {"id":"m1","choices":[{"delta":{"reasoning_content":"step"}}]}\n\n')
      res.write(
        'data: {"id":"m1","choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n'
      )
      res.end('data: [DONE]\n\n')
    })

    try {
      const home = await fetch(`${srv.url}/`)
      expect(home.status).toBe(200)
      expect(home.headers.get('cache-control')).toBe('no-cache')
      expect(home.headers.get('x-content-type-options')).toBe('nosniff')
      expect(home.headers.get('x-frame-options')).toBe('SAMEORIGIN')
      const homeHtml = await home.text()
      expect(homeHtml).toContain('DeepSeek Chat BYOK')

      const staticAssetMatch = /src="(static\/js\/[^"]+\.js)"/u.exec(homeHtml)
      if (staticAssetMatch?.[1]) {
        const assetRes = await fetch(`${srv.url}/${staticAssetMatch[1]}`)
        expect(assetRes.status).toBe(200)
        expect(assetRes.headers.get('cache-control')).toContain('immutable')
      }

      const manifest = await fetch(`${srv.url}/manifest.webmanifest`)
      expect(manifest.status).toBe(200)
      expect(await manifest.text()).toContain('DeepSeek Chat BYOK')

      const traversal = await fetch(`${srv.url}/../package.json`)
      expect(traversal.status).toBe(200)
      expect(await traversal.text()).toContain('<!doctype html>')

      for (const blocked of [
        'https://169.254.169.254/latest/meta-data',
        'https://192.168.1.10/v1/chat/completions',
        'https://[::ffff:127.0.0.1]/v1/chat/completions',
        'https://user:pass@api.example.com/v1/models',
        'http://api.example.com/v1/chat/completions',
      ]) {
        const res = await fetch(`${srv.url}/_proxy?url=${encodeURIComponent(blocked)}`, {
          method: 'POST',
        })
        expect(res.status).toBe(403)
      }

      const redirectRes = await fetch(
        `${srv.url}/_proxy?url=${encodeURIComponent(`http://127.0.0.1:${upstream.port}/redirect-ssrf`)}`,
        { method: 'GET' }
      )
      expect(redirectRes.status).toBe(502)
      expect(await redirectRes.text()).toContain('redirects are blocked')

      const methodBlocked = await fetch(
        `${srv.url}/_proxy?url=${encodeURIComponent(`http://127.0.0.1:${upstream.port}/v1/chat/completions`)}`,
        { method: 'PUT', body: '{}' }
      )
      expect(methodBlocked.status).toBe(405)

      const sseRes = await fetch(
        `${srv.url}/_proxy?url=${encodeURIComponent(`http://127.0.0.1:${upstream.port}/v1/chat/completions`)}`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer byok-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: 'deepseek-r1:latest', stream: true }),
        }
      )
      expect(sseRes.status).toBe(200)
      const body = await sseRes.text()
      expect(body).toContain('"reasoning_content":"step"')
      expect(body).toContain('data: [DONE]')
    } finally {
      await upstream.close()
      await srv.close()
    }
  }, 15_000)

  it('blocks cross-origin/CSRF browser requests and enforces maxBodyBytes 413 cleanly', async () => {
    const upstream = await startMockUpstream((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    const srv = await listenInProcess({
      maxBodyBytes: 64,
      allowedOrigins: ['http://127.0.0.1:3000'],
    })

    try {
      const target = encodeURIComponent(`http://127.0.0.1:${upstream.port}/ok`)

      const crossOrigin = await fetch(`${srv.url}/_proxy?url=${target}`, {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
        body: 'hi',
      })
      expect(crossOrigin.status).toBe(403)

      const nullOrigin = await fetch(`${srv.url}/_proxy?url=${target}`, {
        method: 'GET',
        headers: { Origin: 'null' },
      })
      expect(nullOrigin.status).toBe(403)

      const crossSite = await fetch(`${srv.url}/_proxy?url=${target}`, {
        method: 'GET',
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      })
      expect(crossSite.status).toBe(403)

      const evilReferer = await fetch(`${srv.url}/_proxy?url=${target}`, {
        method: 'GET',
        headers: { Referer: 'https://evil.example/page.html' },
      })
      expect(evilReferer.status).toBe(403)

      const sameOrigin = await fetch(`${srv.url}/_proxy?url=${target}`, {
        method: 'POST',
        headers: {
          Origin: srv.url,
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: '{"ok":1}',
      })
      expect(sameOrigin.status).toBe(200)

      const allowlistedOrigin = await fetch(`${srv.url}/_proxy?url=${target}`, {
        method: 'GET',
        headers: {
          Origin: 'http://127.0.0.1:3000',
          'Sec-Fetch-Site': 'cross-site',
        },
      })
      expect(allowlistedOrigin.status).toBe(200)

      const tooLarge = await fetch(`${srv.url}/_proxy?url=${target}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pad: 'x'.repeat(256) }),
      })
      expect(tooLarge.status).toBe(413)
    } finally {
      await srv.close()
      await upstream.close()
    }
  })

  it('validates IPv4/IPv6 special ranges, Origin helpers, and loopback restrictions', async () => {
    expect(isPrivateOrMetadataIp('127.0.0.1')).toBe(true)
    expect(isPrivateOrMetadataIp('100.64.0.1')).toBe(true)
    expect(isPrivateOrMetadataIp('169.254.169.254')).toBe(true)
    expect(isPrivateOrMetadataIp('198.18.0.1')).toBe(true)
    expect(isPrivateOrMetadataIp('224.0.0.1')).toBe(true)
    expect(isPrivateOrMetadataIp('::ffff:7f00:1')).toBe(true)
    expect(isPrivateOrMetadataIp('fe80::1')).toBe(true)
    expect(isPrivateOrMetadataIp('8.8.8.8')).toBe(false)
    expect(isPrivateOrMetadataIp('1.1.1.1')).toBe(false)

    expect(
      checkProxyOrigin({
        host: '127.0.0.1:8787',
        origin: 'http://127.0.0.1:8787',
        'sec-fetch-site': 'same-origin',
      })
    ).toBeNull()
    expect(
      checkProxyOrigin({
        host: '127.0.0.1:8787',
        origin: 'https://attacker.tld',
      })
    ).not.toBeNull()

    expect(
      await checkProxyTargetAllowed(new URL('http://127.0.0.1:11434/v1/models'), false)
    ).toContain('loopback')
    expect(await checkProxyTargetAllowed(new URL('https://8.8.8.8/v1/models'), false)).toBeNull()
  })
})
