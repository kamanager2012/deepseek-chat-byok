import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JAVA_SRC = path.join(
  ROOT,
  'android/app/src/main/java/com/deepseekbyok/app/LocalBridgeServer.java'
)

const HARNESS_SOURCE = `
import com.deepseekbyok.app.LocalBridgeServer;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.nio.file.Path;
import java.nio.file.Paths;

public final class BridgeHarness {
  public static void main(String[] args) throws Exception {
    final Path distRoot = Paths.get(args[0]).toAbsolutePath().normalize();
    String token = args.length > 1 && !args[1].isEmpty() ? args[1] : null;
    LocalBridgeServer server = new LocalBridgeServer(rel -> {
      Path candidate = distRoot.resolve(rel).normalize();
      if (!candidate.startsWith(distRoot)) {
        throw new FileNotFoundException("Traversal blocked");
      }
      File f = candidate.toFile();
      if (!f.exists() || !f.isFile()) {
        throw new FileNotFoundException(rel);
      }
      return new FileInputStream(f);
    }, token);
    int port = server.start(0);
    System.out.println("BRIDGE_READY http://127.0.0.1:" + port);
    System.out.flush();
    Thread.sleep(60000);
    server.close();
  }
}
`

const startJavaBridge = (
  classesDir: string,
  distDir: string,
  bridgeToken?: string
): Promise<{ url: string; port: number; close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const args = bridgeToken
      ? ['-cp', classesDir, 'BridgeHarness', distDir, bridgeToken]
      : ['-cp', classesDir, 'BridgeHarness', distDir]
    const child = spawn('java', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Java bridge timeout. stdout=${out} stderr=${err}`))
    }, 15_000)

    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const match = /BRIDGE_READY http:\/\/127\.0\.0\.1:(\d+)/u.exec(out)
      if (match) {
        clearTimeout(timer)
        const port = Number(match[1])
        resolve({
          url: `http://127.0.0.1:${port}`,
          port,
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
        reject(new Error(`Java bridge exited (${code}): ${err}`))
      }
    })
  })

const startMockUpstream = (): Promise<{ port: number; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/redirect-ssrf') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' })
        res.end()
        return
      }
      expect(req.headers.authorization).toBe('Bearer android-byok-key')
      expect(req.headers['x-ds-bridge-token']).toBeUndefined()
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      res.write('data: {"id":"a1","choices":[{"delta":{"reasoning_content":"think"}}]}\n\n')
      res.write(
        'data: {"id":"a1","choices":[{"delta":{"content":"android-ok"},"finish_reason":"stop"}]}\n\n'
      )
      res.end('data: [DONE]\n\n')
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

describe('Android LocalBridgeServer.java static & SSRF/CSRF-safe streaming /_proxy', () => {
  it('compiles with javac, serves built assets, blocks CSRF/SSRF/redirects, and streams SSE chunks', async () => {
    const distDir = path.join(ROOT, 'dist')
    if (!existsSync(path.join(distDir, 'index.html'))) {
      throw new Error('dist/index.html missing; run pnpm build before running tests')
    }
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ds-android-bridge-'))
    const harnessFile = path.join(tmpDir, 'BridgeHarness.java')

    try {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(harnessFile, HARNESS_SOURCE, 'utf8')
      execFileSync('javac', ['-d', tmpDir, JAVA_SRC, harnessFile], { encoding: 'utf8' })

      const bridge = await startJavaBridge(tmpDir, distDir)
      const upstream = await startMockUpstream()
      try {
        const home = await fetch(`${bridge.url}/`)
        expect(home.status).toBe(200)
        expect(home.headers.get('x-content-type-options')).toBe('nosniff')
        expect(await home.text()).toContain('DeepSeek Chat BYOK')

        const traversal = await fetch(`${bridge.url}/..%2fpackage.json`)
        expect(traversal.status).toBe(403)

        const methodBlocked = await fetch(
          `${bridge.url}/_proxy?url=${encodeURIComponent(`http://127.0.0.1:${upstream.port}/v1`)}`,
          { method: 'PUT', body: '{}' }
        )
        expect(methodBlocked.status).toBe(405)

        const csrfBlocked = await fetch(
          `${bridge.url}/_proxy?url=${encodeURIComponent(`http://127.0.0.1:${upstream.port}/v1`)}`,
          {
            method: 'POST',
            headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
            body: 'x',
          }
        )
        expect(csrfBlocked.status).toBe(403)

        for (const ssrfTarget of [
          'https://169.254.169.254/latest/meta-data',
          'https://192.168.1.50/v1/chat/completions',
          'https://100.64.0.1/v1',
          'http://api.example.com/v1',
          `http://127.0.0.1:${bridge.port}/_proxy?url=https://example.com`,
        ]) {
          const blocked = await fetch(
            `${bridge.url}/_proxy?url=${encodeURIComponent(ssrfTarget)}`,
            {
              method: 'POST',
            }
          )
          expect(blocked.status).toBe(403)
        }

        const redirectBlocked = await fetch(
          `${bridge.url}/_proxy?url=${encodeURIComponent(`http://127.0.0.1:${upstream.port}/redirect-ssrf`)}`,
          { method: 'GET' }
        )
        expect(redirectBlocked.status).toBe(502)

        const sseRes = await fetch(
          `${bridge.url}/_proxy?url=${encodeURIComponent(`http://127.0.0.1:${upstream.port}/v1/chat/completions`)}`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer android-byok-key',
              'Content-Type': 'application/json',
              Origin: bridge.url,
              'Sec-Fetch-Site': 'same-origin',
            },
            body: JSON.stringify({ model: 'glm-5', stream: true }),
          }
        )
        expect(sseRes.status).toBe(200)
        const sseText = await sseRes.text()
        expect(sseText).toContain('"reasoning_content":"think"')
        expect(sseText).toContain('"content":"android-ok"')
        expect(sseText).toContain('data: [DONE]')

        const rebindStatus = await new Promise<number>((resolve, reject) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port: bridge.port,
              path: `/_proxy?url=${encodeURIComponent(`http://127.0.0.1:${upstream.port}/v1/chat/completions`)}`,
              method: 'POST',
              headers: {
                Host: `rebind.evil:${bridge.port}`,
                Origin: `http://rebind.evil:${bridge.port}`,
                'Sec-Fetch-Site': 'same-origin',
              },
            },
            (res) => {
              res.resume()
              res.on('end', () => resolve(res.statusCode ?? 0))
            }
          )
          req.on('error', reject)
          req.end('{}')
        })
        expect(rebindStatus).toBe(403)
      } finally {
        await upstream.close()
        await bridge.close()
      }

      const tokenBridge = await startJavaBridge(tmpDir, distDir, 'android-secret-token-123')
      const tokenUpstream = await startMockUpstream()
      try {
        const probeRes = await fetch(`${tokenBridge.url}/_proxy`, { method: 'HEAD' })
        expect(probeRes.status).toBe(400)

        const missingToken = await fetch(
          `${tokenBridge.url}/_proxy?url=${encodeURIComponent(`http://127.0.0.1:${tokenUpstream.port}/v1/chat/completions`)}`,
          { method: 'POST', body: '{}' }
        )
        expect(missingToken.status).toBe(403)

        const wrongToken = await fetch(
          `${tokenBridge.url}/_proxy?url=${encodeURIComponent(`http://127.0.0.1:${tokenUpstream.port}/v1/chat/completions`)}`,
          {
            method: 'POST',
            headers: { 'X-DS-Bridge-Token': 'wrong-token' },
            body: '{}',
          }
        )
        expect(wrongToken.status).toBe(403)

        const authedRes = await fetch(
          `${tokenBridge.url}/_proxy?url=${encodeURIComponent(`http://127.0.0.1:${tokenUpstream.port}/v1/chat/completions`)}`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer android-byok-key',
              'Content-Type': 'application/json',
              'X-DS-Bridge-Token': 'android-secret-token-123',
            },
            body: JSON.stringify({ model: 'deepseek-chat', stream: true }),
          }
        )
        expect(authedRes.status).toBe(200)
        expect(await authedRes.text()).toContain('"content":"android-ok"')
      } finally {
        await tokenUpstream.close()
        await tokenBridge.close()
      }

      const apkPath = path.join(ROOT, 'android/app/build/outputs/apk/debug/app-debug.apk')
      if (existsSync(apkPath)) {
        // Verify APK ZIP magic bytes PK\x03\x04
        const magic = readFileSync(apkPath).subarray(0, 4)
        expect(magic[0]).toBe(0x50)
        expect(magic[1]).toBe(0x4b)
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 30_000)
})
