import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { chromium } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { EXPORT_FORMAT_VERSION } from '../../src/services/chat/history/format.js'
import { INDEX_PATH, MANIFEST_PATH, sessionPath } from '../../src/services/chat/history/paths.js'
import { toIndexEntry, toSessionFile } from '../../src/services/chat/history/toArchive.js'
import type { Session } from '../../src/services/chat/types.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const resolveChromiumExecutable = (): string | undefined => {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv
  }
  const candidates = [
    path.join(
      os.homedir(),
      '.cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell'
    ),
    path.join(os.homedir(), '.cache/ms-playwright/chromium-1254/chrome-linux64/chrome'),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

const startServer = (): Promise<{ url: string; close: () => Promise<void> }> =>
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
    }, 8000)

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

type CapturedRequest = {
  model: string
  messages: { role: string; content: unknown }[]
}

const startMockOpenAiServer = (): Promise<{
  port: number
  getCapturedRequests: () => CapturedRequest[]
  wasUpstreamAborted: () => boolean
  close: () => Promise<void>
}> =>
  new Promise((resolve) => {
    const captured: CapturedRequest[] = []
    let upstreamAborted = false
    const srv = http.createServer((req, res) => {
      if (req.url === '/v1/models' && req.method === 'GET') {
        if (req.headers.authorization !== 'Bearer e2e-test-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Invalid token' } }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'glm-5' }, { id: 'deepseek-v3.2' }] }))
        return
      }

      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturedRequest
          captured.push(parsed)
          const firstMsg = String(parsed.messages[0]?.content ?? '')
          const lastUserMsg = JSON.stringify(parsed.messages.at(-1)?.content ?? '')
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })

          if (firstMsg.includes('记忆提炼助手')) {
            res.write(
              'data: {"id":"e2e-digest","model":"glm-5","choices":[{"delta":{"content":"- 设定：京都老街旧书店开篇。"},"finish_reason":"stop"}]}\n\n'
            )
            res.end('data: [DONE]\n\n')
            return
          }

          if (lastUserMsg.includes('Please continue directly')) {
            res.write(
              'data: {"id":"e2e-cont","model":"glm-5","choices":[{"delta":{"content":"，接续第二段完结。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1200,"completion_tokens":38,"prompt_tokens_details":{"cached_tokens":900}}}\n\n'
            )
            res.end('data: [DONE]\n\n')
            return
          }

          if (lastUserMsg.includes('请测试流式中断')) {
            res.write(
              'data: {"id":"e2e-abort","model":"glm-5","choices":[{"delta":{"content":"中途截断片段"}}]}\n\n'
            )
            const safetyTimer = setTimeout(() => {
              if (!res.writableEnded) {
                res.end()
              }
            }, 10_000)
            req.on('close', () => {
              clearTimeout(safetyTimer)
              if (!res.writableEnded) {
                upstreamAborted = true
              }
            })
            return
          }

          res.write(
            'data: {"id":"e2e-1","model":"glm-5","choices":[{"delta":{"content":"<th"}}]}\n\n'
          )
          res.write(
            'data: {"id":"e2e-1","model":"glm-5","choices":[{"delta":{"content":"ink>已阅读附件大纲。</think>这是第一段正文"},"finish_reason":"length"}],"usage":{"prompt_tokens":800,"completion_tokens":20}}\n\n'
          )
          res.end('data: [DONE]\n\n')
        })
        return
      }

      res.writeHead(404)
      res.end('Not Found')
    })

    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        getCapturedRequests: () => captured,
        wasUpstreamAborted: () => upstreamAborted,
        close: () =>
          new Promise((done) => {
            srv.closeAllConnections?.()
            srv.close(() => done())
          }),
      })
    })
  })

const buildArchiveBuffer = (): Buffer => {
  const s1: Session = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'Alpha Canon',
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_200_000,
    messages: [
      {
        id: 'u1',
        role: 'user',
        createdAt: 1_760_000_000_000,
        content: '第一章设定在哪里？',
        files: [],
      },
      {
        id: 'a1',
        role: 'assistant',
        createdAt: 1_760_000_010_000,
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        prefix: false,
        status: 'done',
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: '在京都老街的一家旧书店。' }],
      },
    ],
  }
  const s2: Session = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    title: 'Beta Skipped',
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_100_000,
    messages: [
      {
        id: 'u2',
        role: 'user',
        createdAt: 1_760_000_000_000,
        content: '闲聊测试',
        files: [],
      },
      {
        id: 'a2',
        role: 'assistant',
        createdAt: 1_760_000_010_000,
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        prefix: false,
        status: 'done',
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: '好的。' }],
      },
    ],
  }

  const longMessages: Session['messages'] = []
  for (let i = 1; i <= 35; i += 1) {
    longMessages.push(
      {
        id: `lu-${i}`,
        role: 'user',
        createdAt: 1_760_000_000_000 + i * 2000,
        content: `LongTurn-${i}`,
        files: [],
      },
      {
        id: `la-${i}`,
        role: 'assistant',
        createdAt: 1_760_000_000_000 + i * 2000 + 1000,
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        prefix: false,
        status: 'done',
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: `LongReply-${i}` }],
      }
    )
  }
  const s3: Session = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    title: 'Gamma Long Session',
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_150_000,
    messages: longMessages,
  }

  const sf1 = toSessionFile(s1, () => null)
  const sf2 = toSessionFile(s2, () => null)
  const sf3 = toSessionFile(s3, () => null)
  const archive = zipSync({
    [MANIFEST_PATH]: strToU8(JSON.stringify({ export_format_version: EXPORT_FORMAT_VERSION })),
    [sessionPath(s1.id)]: strToU8(JSON.stringify(sf1)),
    [sessionPath(s2.id)]: strToU8(JSON.stringify(sf2)),
    [sessionPath(s3.id)]: strToU8(JSON.stringify(sf3)),
    [INDEX_PATH]: strToU8(
      JSON.stringify([toIndexEntry(sf1), toIndexEntry(sf2), toIndexEntry(sf3)])
    ),
  })
  return Buffer.from(archive)
}

describe('Real Chromium E2E across desktop and mobile viewports', () => {
  it('configures BYOK OpenAI via /_proxy, selective-merges ZIP into IndexedDB, pins memory card, streams reply, exports Markdown, and renders mobile drawer', async () => {
    if (!existsSync(path.join(ROOT, 'dist/index.html'))) {
      throw new Error('dist/index.html not found; run pnpm build first')
    }

    const appServer = await startServer()
    const mockOpenAi = await startMockOpenAiServer()
    const executablePath = resolveChromiumExecutable()
    const browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: ['--no-sandbox'],
    })

    try {
      // 1. Desktop flow (1280x800, zh-CN)
      const desktopContext = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: 'zh-CN',
        acceptDownloads: true,
      })
      const page = await desktopContext.newPage()
      const pageErrors: string[] = []
      page.on('pageerror', (err) => pageErrors.push(err.message))

      await page.goto(appServer.url, { waitUntil: 'networkidle' })
      await page.waitForSelector('text=今天有什么可以帮到你？')

      const swRegistered = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) {
          return false
        }
        const reg = await navigator.serviceWorker.ready
        return Boolean(reg.active)
      })
      expect(swRegistered).toBe(true)

      // First launch with empty API key auto-opens API Settings modal
      if (!(await page.getByRole('dialog').isVisible())) {
        await page.locator('button[title]').first().click()
      }
      await page.getByRole('button', { name: '新增配置' }).click()

      const proxyToggle = page.getByLabel(
        '通过本地转发代理请求（解决第三方接口浏览器 CORS 跨域报错）'
      )
      expect(await proxyToggle.isChecked()).toBe(true)

      await page.getByLabel('Base URL').fill(`http://127.0.0.1:${mockOpenAi.port}/v1`)
      await page.getByLabel('模型 ID').fill('glm-5')
      const apiKeyInput = page.getByLabel('API Key（仅存本机）')
      await apiKeyInput.fill('e2e-test-key')
      expect(await apiKeyInput.getAttribute('type')).toBe('password')
      await page.getByRole('button', { name: '显示' }).click()
      expect(await apiKeyInput.getAttribute('type')).toBe('text')
      await page.getByRole('button', { name: '隐藏' }).click()
      expect(await apiKeyInput.getAttribute('type')).toBe('password')
      await page.getByRole('button', { name: '测试并保存' }).click()

      await page.waitForSelector('text=连通正常，已保存（发现 2 个模型）')

      // Switch to Data tab and selectively merge-import Alpha Canon
      await page.getByRole('tab', { name: '数据管理' }).click()
      const zipBuffer = buildArchiveBuffer()
      await page.locator('input[type="file"][accept*=".zip"]').setInputFiles({
        name: 'deepseek_data-e2e.zip',
        mimeType: 'application/zip',
        buffer: zipBuffer,
      })

      await page.waitForSelector('text=选择要导入的对话')
      await page.getByRole('button', { name: '清空勾选' }).click()
      await page
        .locator('label', { hasText: 'Alpha Canon' })
        .locator('input[type="checkbox"]')
        .check()
      await page
        .locator('label', { hasText: 'Gamma Long Session' })
        .locator('input[type="checkbox"]')
        .check()
      await page
        .locator('label', { hasText: '合并导入到现有对话' })
        .locator('input[type="radio"]')
        .check()
      await page.getByRole('button', { name: '确认导入' }).click()
      await page.waitForSelector('text=已导入 2 个对话')

      // Close Settings modal
      await page.getByRole('button', { name: '关闭' }).click()

      // Verify Sidebar brand & live filter & incremental windowing on Gamma Long Session
      await page.waitForSelector('text=DeepSeek Chat BYOK')
      await page.waitForSelector('text=Alpha Canon')
      expect(await page.locator('text=Beta Skipped').count()).toBe(0)
      await page.getByText('Gamma Long Session').first().click()
      await page.waitForSelector('text=前 10 条较早消息已折叠（省内存模式）')
      expect(await page.getByText('LongTurn-1', { exact: true }).count()).toBe(0)
      await page.getByRole('button', { name: '加载更早 60 条' }).click()
      await page.getByText('LongTurn-1', { exact: true }).waitFor()

      // Delete Gamma Long Session from sidebar menu and confirm modal
      const gammaRow = page.locator('[class*="item"]', { hasText: 'Gamma Long Session' }).first()
      await gammaRow.hover()
      await gammaRow.getByRole('button', { name: '更多' }).click()
      await page.getByRole('menuitem', { name: '删除' }).click()
      await page.getByRole('dialog').getByRole('button', { name: '删除' }).click()
      await expect.poll(() => page.locator('text=Gamma Long Session').count()).toBe(0)

      const siderSearch = page.getByPlaceholder('筛选历史对话...')
      await siderSearch.fill('不存在的关键字')
      await page.waitForSelector('text=没有匹配的对话')
      await siderSearch.fill('Alpha')
      await page.waitForSelector('text=Alpha Canon')
      await siderSearch.fill('')

      await page.getByText('Alpha Canon').first().click()
      await page.waitForSelector('text=在京都老街的一家旧书店。')

      // Pin Memory Card + distill early turns via mock OpenAI
      await page.getByRole('button', { name: '记忆卡' }).click()
      await page.getByRole('button', { name: '用当前模型压缩早期对话' }).click()
      await page.waitForSelector('text=已压缩早期对话')
      const memBox = page.locator('textarea').last()
      const distilledValue = await memBox.inputValue()
      expect(distilledValue).toContain('京都老街旧书店开篇')
      await memBox.fill(`${distilledValue}\n主角林夕住在东京，喜欢黑咖啡。`)
      await page.getByRole('button', { name: '保存记忆卡' }).click()

      // Verify Markdown export triggers real download
      const mdDownloadPromise = page.waitForEvent('download')
      await page.getByRole('button', { name: '导出 Markdown' }).click()
      const mdDownload = await mdDownloadPromise
      expect(mdDownload.suggestedFilename()).toContain('Alpha Canon')
      expect(mdDownload.suggestedFilename().endsWith('.md')).toBe(true)

      // Reload page to prove IndexedDB & localStorage persistence across restarts
      await page.reload({ waitUntil: 'networkidle' })
      await page.getByText('Alpha Canon').first().click()
      await page.waitForSelector('text=在京都老街的一家旧书店。')

      // Attach inline .txt lore file + 1x1 PNG vision image + send message through /_proxy
      const minimalPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      )
      await page.locator('input[type="file"]').setInputFiles([
        {
          name: 'lore.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Secret Kyoto lore note', 'utf8'),
        },
        {
          name: 'vision.png',
          mimeType: 'image/png',
          buffer: minimalPng,
        },
      ])
      await page.getByPlaceholder('请输入消息').fill('请继续第二章')
      await page.getByRole('button', { name: '发送' }).click()

      await page.waitForSelector('text=这是第一段正文')
      await page.waitForSelector('text=已思考')
      await page.getByRole('button', { name: '继续生成' }).click()

      await page.waitForSelector('text=，接续第二段完结。')
      await page.waitForSelector('text=1.2K in (hit 900) · 38 out')

      // Test mid-stream Stop generation -> aborts /_proxy upstream socket cleanly
      await page.getByPlaceholder('请输入消息').fill('请测试流式中断')
      await page.getByRole('button', { name: '发送' }).click()
      await page.waitForSelector('text=中途截断片段')
      await page.getByRole('button', { name: '停止生成' }).click()
      await page.getByRole('button', { name: '继续生成' }).waitFor()
      await expect.poll(() => mockOpenAi.wasUpstreamAborted(), { timeout: 3000 }).toBe(true)

      // Export full backup ZIP from Settings -> Data
      await page.getByRole('button', { name: '设置' }).click()
      await page.getByRole('tab', { name: '数据管理' }).click()
      const zipDownloadPromise = page.waitForEvent('download')
      await page.getByRole('button', { name: '下载' }).click()
      const zipDownload = await zipDownloadPromise
      expect(zipDownload.suggestedFilename().endsWith('.zip')).toBe(true)

      // Re-import original ZIP overlapping Alpha Canon -> verify non-destructive merge keeps newer local turns
      await page.locator('input[type="file"][accept*=".zip"]').setInputFiles({
        name: 'deepseek_data-e2e.zip',
        mimeType: 'application/zip',
        buffer: zipBuffer,
      })
      await page.waitForSelector('text=选择要导入的对话')
      await page.getByRole('button', { name: '清空勾选' }).click()
      await page
        .locator('label', { hasText: 'Alpha Canon' })
        .locator('input[type="checkbox"]')
        .check()
      await page
        .locator('label', { hasText: 'Beta Skipped' })
        .locator('input[type="checkbox"]')
        .check()
      await page.waitForSelector('text=本地已存在')
      await page.waitForSelector('text=已选中条目中有 1 个与本地对话同 ID')
      await page.getByRole('button', { name: '确认导入' }).click()
      await page.waitForSelector('text=已导入 1 个对话（已保留 1 个同名本地对话）')
      await page.getByRole('button', { name: '关闭' }).click()

      await page.getByText('Beta Skipped').first().waitFor()
      await page.getByText('Alpha Canon').first().click()
      await page.waitForSelector('text=这是第一段正文')

      const captured = mockOpenAi.getCapturedRequests()
      expect(captured.length).toBe(4)
      const firstTurn = captured[1]
      expect(firstTurn?.model).toBe('glm-5')
      expect(String(firstTurn?.messages[0]?.content ?? '')).toContain(
        '主角林夕住在东京，喜欢黑咖啡。'
      )
      expect(JSON.stringify(firstTurn?.messages ?? [])).toContain('[附件: lore.txt]')
      expect(JSON.stringify(firstTurn?.messages ?? [])).toContain('Secret Kyoto lore note')
      expect(JSON.stringify(firstTurn?.messages ?? [])).toContain('data:image/png;base64,')
      expect(JSON.stringify(captured[2]?.messages.at(-1)?.content ?? '')).toContain(
        'Please continue directly'
      )
      expect(pageErrors).toEqual([])
      await desktopContext.close()

      // 2. Mobile viewport flow (390x844 touch layout)
      const mobileContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: 'zh-CN',
      })
      const mobilePage = await mobileContext.newPage()
      const mobileErrors: string[] = []
      mobilePage.on('pageerror', (err) => mobileErrors.push(err.message))

      await mobilePage.goto(appServer.url, { waitUntil: 'networkidle' })
      await mobilePage.waitForSelector('text=今天有什么可以帮到你？')

      const overflowCheck = await mobilePage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
      expect(overflowCheck).toBe(true)

      if (await mobilePage.getByRole('dialog').isVisible()) {
        await mobilePage.getByRole('button', { name: '关闭' }).click()
      }

      await mobilePage.getByRole('button', { name: '打开边栏' }).click()
      await mobilePage.waitForSelector('text=开启新对话')
      expect(mobileErrors).toEqual([])
      await mobileContext.close()
    } finally {
      await browser.close()
      await mockOpenAi.close()
      await appServer.close()
    }
  })
})
