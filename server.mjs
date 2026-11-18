import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIST_DIR = path.resolve(ROOT, 'dist')
const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

const ALLOWED_PROXY_METHODS = new Set(['GET', 'POST', 'DELETE', 'HEAD'])

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

const FORWARDED_REQ_HEADERS = [
  'authorization',
  'x-api-key',
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'accept',
]

const CSP_HEADER_VALUE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; media-src 'self' blob:; font-src 'self' data:; " +
  "connect-src 'self' https: http://127.0.0.1:* http://localhost:* http://[::1]:*; " +
  "worker-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; " +
  "base-uri 'self'; form-action 'self'"

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body too large')
    this.name = 'PayloadTooLargeError'
  }
}

export const isLoopbackIp = (ip) => {
  const clean = ip.replace(/^::ffff:/iu, '').toLowerCase()
  return clean === '127.0.0.1' || clean === '::1'
}

const extractMappedIpv4FromHexV6 = (ip) => {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(ip)
  if (!match) {
    return null
  }
  const hi = Number.parseInt(match[1], 16)
  const lo = Number.parseInt(match[2], 16)
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

const parseIpv6Words = (rawIp) => {
  const ip = rawIp.split('%')[0]
  if (!net.isIPv6(ip)) {
    return null
  }
  let v6 = ip
  const lastColon = v6.lastIndexOf(':')
  if (lastColon >= 0 && v6.slice(lastColon + 1).includes('.')) {
    const v4Part = v6.slice(lastColon + 1)
    if (!net.isIPv4(v4Part)) {
      return null
    }
    const [o0, o1, o2, o3] = v4Part.split('.').map(Number)
    const hi = ((o0 << 8) | o1).toString(16)
    const lo = ((o2 << 8) | o3).toString(16)
    const prefix = v6.slice(0, lastColon)
    v6 = `${prefix.endsWith(':') ? prefix : `${prefix}:`}${hi}:${lo}`
  }
  const halves = v6.split('::')
  if (halves.length > 2) {
    return null
  }
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0
  if ((halves.length === 1 && left.length !== 8) || missing < 0) {
    return null
  }
  const full = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (full.length !== 8) {
    return null
  }
  return full.map((seg) => Number.parseInt(seg || '0', 16))
}

export const isPrivateOrMetadataIp = (rawIp) => {
  const lowered = rawIp.trim().toLowerCase()
  const mappedHexIpv4 = extractMappedIpv4FromHexV6(lowered)
  const ip = mappedHexIpv4 ?? lowered.replace(/^::ffff:/u, '')

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number)
    const [a, b, c] = parts
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    ) {
      return true
    }
    return false
  }
  const w = parseIpv6Words(ip)
  if (w) {
    const first80Zero = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0
    if (first80Zero && (w[5] === 0 || w[5] === 0xffff)) {
      return true // ::/96 (incl. ::, ::1, deprecated IPv4-compatible) & ::ffff:0:0/96
    }
    if ((w[0] & 0xfe00) === 0xfc00) {
      return true // fc00::/7 ULA
    }
    if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) {
      return true // fe80::/10 link-local & fec0::/10 site-local
    }
    if ((w[0] & 0xff00) === 0xff00) {
      return true // ff00::/8 multicast
    }
    if (
      w[0] === 0x0064 &&
      w[1] === 0xff9b &&
      w[2] === 0 &&
      w[3] === 0 &&
      w[4] === 0 &&
      w[5] === 0
    ) {
      return true // 64:ff9b::/96 NAT64
    }
    if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) {
      return true // 100::/64 discard
    }
    if (w[0] === 0x2001 && w[1] === 0x0000) {
      return true // 2001::/32 Teredo
    }
    if (w[0] === 0x2001 && w[1] === 0x0002 && w[2] === 0x0000) {
      return true // 2001:2::/48 benchmarking
    }
    if (w[0] === 0x2001 && w[1] === 0x0db8) {
      return true // 2001:db8::/32 documentation
    }
    if (w[0] === 0x2002) {
      return true // 2002::/16 6to4 tunnel
    }
    return false
  }
  return true
}

const isLocalhostName = (hostname) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'

const parseAuthorityHostname = (authority) => {
  if (!authority) {
    return ''
  }
  try {
    return new URL(`http://${authority}`).hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  } catch {
    return ''
  }
}

export const checkProxyOrigin = (headers, allowedOrigins = new Set(), options = {}) => {
  const hostHeader = typeof headers.host === 'string' ? headers.host.trim().toLowerCase() : ''
  const rawOrigin = typeof headers.origin === 'string' ? headers.origin.trim() : ''
  const secFetchSite =
    typeof headers['sec-fetch-site'] === 'string'
      ? headers['sec-fetch-site'].trim().toLowerCase()
      : ''

  if (options.restrictLoopbackHost) {
    const hostOnly = parseAuthorityHostname(hostHeader)
    if (!isLocalhostName(hostOnly)) {
      return 'Non-loopback Host header blocked by proxy DNS-rebinding policy'
    }
  }

  let originAllowedExplicitly = false
  if (rawOrigin) {
    if (rawOrigin.toLowerCase() === 'null') {
      return 'Null Origin is blocked by proxy CSRF policy'
    }
    let parsedOrigin
    try {
      parsedOrigin = new URL(rawOrigin)
    } catch {
      return 'Invalid Origin header'
    }
    originAllowedExplicitly = allowedOrigins.has(parsedOrigin.origin)
    if (!originAllowedExplicitly) {
      if (!hostHeader || parsedOrigin.host.toLowerCase() !== hostHeader) {
        return 'Cross-origin proxy request blocked'
      }
    }
  }

  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    if (!originAllowedExplicitly) {
      return 'Cross-site fetch blocked by proxy CSRF policy'
    }
  }

  if (!rawOrigin && typeof headers.referer === 'string' && headers.referer.trim()) {
    try {
      const refUrl = new URL(headers.referer.trim())
      if (
        !allowedOrigins.has(refUrl.origin) &&
        (!hostHeader || refUrl.host.toLowerCase() !== hostHeader)
      ) {
        return 'Cross-origin Referer blocked by proxy CSRF policy'
      }
    } catch {
      return 'Invalid Referer header'
    }
  }

  return null
}

const resolveAndValidateAddresses = (hostname, expectLoopbackOnly, options, callback) => {
  dnsLookup(hostname, options, (err, addressOrList, family) => {
    if (err) {
      callback(err)
      return
    }
    const records = Array.isArray(addressOrList)
      ? addressOrList
      : [{ address: addressOrList, family }]
    if (records.length === 0) {
      callback(new Error('DNS lookup returned no addresses'))
      return
    }
    for (const record of records) {
      if (expectLoopbackOnly) {
        if (!isLoopbackIp(record.address)) {
          callback(new Error('Localhost target resolved to non-loopback IP'))
          return
        }
      } else if (isPrivateOrMetadataIp(record.address)) {
        callback(new Error('Target resolves to private or metadata IP'))
        return
      }
    }
    if (Array.isArray(addressOrList)) {
      callback(null, addressOrList)
      return
    }
    callback(null, addressOrList, family)
  })
}

export const checkProxyTargetAllowed = async (targetUrl, clientIsLoopback, selfPort = null) => {
  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
    return 'Unsupported target protocol'
  }
  if (targetUrl.username || targetUrl.password) {
    return 'Credentials in target URL are not allowed'
  }
  const hostname = targetUrl.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (isLocalhostName(hostname)) {
    if (!clientIsLoopback) {
      return 'Loopback target is restricted to loopback clients'
    }
    const targetPort = targetUrl.port
      ? Number(targetUrl.port)
      : targetUrl.protocol === 'https:'
        ? 443
        : 80
    if (
      (selfPort !== null && targetPort === selfPort) ||
      targetUrl.pathname === '/_proxy' ||
      targetUrl.pathname.startsWith('/_proxy/')
    ) {
      return 'Self-proxy recursion blocked'
    }
    return null
  }
  if (targetUrl.protocol !== 'https:') {
    return 'Remote proxy targets must use HTTPS'
  }
  if (net.isIP(hostname)) {
    return isPrivateOrMetadataIp(hostname) ? 'Private/metadata IP blocked' : null
  }
  return new Promise((resolve) => {
    resolveAndValidateAddresses(hostname, false, { all: true }, (err) => {
      if (!err) {
        resolve(null)
        return
      }
      resolve(
        err.message === 'Target resolves to private or metadata IP'
          ? err.message
          : 'Target DNS lookup failed'
      )
    })
  })
}

const readBody = (req, maxBytes) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let finished = false
    req.on('data', (chunk) => {
      if (finished) {
        return
      }
      total += chunk.length
      if (total > maxBytes) {
        finished = true
        req.pause()
        reject(new PayloadTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!finished) {
        finished = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', (err) => {
      if (!finished) {
        finished = true
        reject(err)
      }
    })
  })

const forwardUpstream = ({
  targetUrl,
  method,
  headers,
  body,
  expectLoopbackOnly,
  connectTimeoutMs,
  signal,
}) =>
  new Promise((resolve, reject) => {
    const transport = targetUrl.protocol === 'https:' ? https : http
    const port = targetUrl.port
      ? Number(targetUrl.port)
      : targetUrl.protocol === 'https:'
        ? 443
        : 80
    const cleanHostname = targetUrl.hostname.replace(/^\[|\]$/gu, '')

    const reqHeaders = {
      ...headers,
      'accept-encoding': 'identity',
    }
    if (body !== undefined) {
      reqHeaders['content-length'] = String(body.length)
    }

    let settled = false
    const done = (fn, arg) => {
      if (!settled) {
        settled = true
        clearTimeout(connectTimer)
        fn(arg)
      }
    }

    const upstreamReq = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname: cleanHostname,
        port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        headers: reqHeaders,
        agent: false,
        lookup: (host, opts, cb) => resolveAndValidateAddresses(host, expectLoopbackOnly, opts, cb),
      },
      (upstreamRes) => {
        upstreamRes.once('close', () => {
          signal.removeEventListener('abort', onAbort)
        })
        done(resolve, upstreamRes)
      }
    )

    const connectTimer = setTimeout(() => {
      upstreamReq.destroy(new Error('Upstream connection timeout'))
    }, connectTimeoutMs)

    const onAbort = () => {
      upstreamReq.destroy(new Error('Client aborted request'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })

    upstreamReq.on('error', (err) => {
      done(reject, err)
    })

    if (body && body.length > 0) {
      upstreamReq.write(body)
    }
    upstreamReq.end()
  })

const handleProxy = async (req, res, urlObj, options) => {
  const method = (req.method || 'GET').toUpperCase()
  if (!ALLOWED_PROXY_METHODS.has(method)) {
    res.writeHead(405, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      Allow: 'GET, POST, DELETE, HEAD',
    })
    res.end('Method Not Allowed')
    return
  }

  const originError = checkProxyOrigin(req.headers, options.allowedOrigins, {
    restrictLoopbackHost: options.restrictLoopbackHost,
  })
  if (originError) {
    res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(originError)
    return
  }

  if ((method === 'HEAD' || method === 'GET') && urlObj.searchParams.get('probe') === '1') {
    res.writeHead(204, { ...SECURITY_HEADERS, 'Content-Length': '0' })
    res.end()
    return
  }

  const rawTarget = urlObj.searchParams.get('url')
  if (!rawTarget) {
    res.writeHead(400, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Missing ?url= parameter')
    return
  }

  let targetUrl
  try {
    targetUrl = new URL(rawTarget)
  } catch {
    res.writeHead(400, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Invalid target URL')
    return
  }

  const clientIp = req.socket.remoteAddress ?? ''
  const selfPort = req.socket.localPort ?? null
  const blockReason = await checkProxyTargetAllowed(targetUrl, isLoopbackIp(clientIp), selfPort)
  if (blockReason) {
    res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(blockReason)
    return
  }

  const declaredLength = Number(req.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBodyBytes) {
    res.writeHead(413, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Request body too large')
    req.destroy()
    return
  }

  let body
  if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
    try {
      body = await readBody(req, options.maxBodyBytes)
    } catch (error) {
      const status = error instanceof PayloadTooLargeError ? 413 : 400
      res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(error instanceof Error ? error.message : 'Failed to read request body')
      return
    }
  }

  const headers = {}
  for (const name of FORWARDED_REQ_HEADERS) {
    const val = req.headers[name]
    if (typeof val === 'string' && val) {
      headers[name] = val
    }
  }

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort()
    }
  })

  const hostname = targetUrl.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  const expectLoopbackOnly = isLocalhostName(hostname)

  try {
    const upstreamRes = await forwardUpstream({
      targetUrl,
      method,
      headers,
      body,
      expectLoopbackOnly,
      connectTimeoutMs: options.connectTimeoutMs,
      signal: controller.signal,
    })

    const status = upstreamRes.statusCode ?? 502
    if (status >= 300 && status < 400) {
      upstreamRes.resume()
      res.writeHead(502, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Upstream redirects are blocked by proxy policy')
      return
    }

    const outHeaders = {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
    }
    const contentType = upstreamRes.headers['content-type']
    if (typeof contentType === 'string' && contentType) {
      outHeaders['Content-Type'] = contentType
    }

    res.writeHead(status, outHeaders)
    const abortStream = () => upstreamRes.destroy()
    controller.signal.addEventListener('abort', abortStream, { once: true })

    upstreamRes.on('data', (chunk) => {
      if (!res.destroyed) {
        if (!res.write(chunk)) {
          upstreamRes.pause()
        }
      }
    })
    res.on('drain', () => {
      upstreamRes.resume()
    })
    upstreamRes.on('end', () => {
      controller.signal.removeEventListener('abort', abortStream)
      if (!res.writableEnded) {
        res.end()
      }
    })
    upstreamRes.on('error', () => {
      controller.signal.removeEventListener('abort', abortStream)
      if (!res.destroyed) {
        res.destroy()
      }
    })
  } catch (error) {
    if (controller.signal.aborted) {
      return
    }
    if (!res.headersSent) {
      res.writeHead(502, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    }
    if (!res.writableEnded) {
      res.end(error instanceof Error ? error.message : String(error))
    }
  }
}

const serveStatic = (req, res, reqPath, rawDistDir) => {
  const method = (req.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' })
    res.end('Method Not Allowed')
    return
  }
  const distDir = path.resolve(rawDistDir)
  let cleanPath
  try {
    cleanPath = decodeURIComponent(reqPath).replace(/^\/+/u, '')
  } catch {
    res.writeHead(400, SECURITY_HEADERS)
    res.end('Bad Request')
    return
  }
  const candidate = path.resolve(distDir, cleanPath || 'index.html')
  if (candidate !== distDir && !candidate.startsWith(`${distDir}${path.sep}`)) {
    res.writeHead(403, SECURITY_HEADERS)
    res.end('Forbidden')
    return
  }
  if (!existsSync(distDir)) {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('dist/ not found. Run pnpm build first.')
    return
  }
  let rootReal
  try {
    rootReal = realpathSync(distDir)
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('dist/ not found. Run pnpm build first.')
    return
  }

  let target = null
  if (existsSync(candidate)) {
    try {
      const candidateReal = realpathSync(candidate)
      if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${path.sep}`)) {
        res.writeHead(403, SECURITY_HEADERS)
        res.end('Forbidden')
        return
      }
      if (statSync(candidateReal).isFile()) {
        target = candidateReal
      }
    } catch {
      target = null
    }
  }

  if (!target) {
    const lastSeg = cleanPath.split('/').pop() ?? ''
    if (lastSeg.includes('.')) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
    const fallback = path.resolve(rootReal, 'index.html')
    if (!existsSync(fallback)) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('dist/ not found. Run pnpm build first.')
      return
    }
    target = fallback
  }

  const ext = path.extname(target).toLowerCase()
  const baseName = path.basename(target)
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
  }
  if (contentType.startsWith('text/html')) {
    headers['Content-Security-Policy'] = CSP_HEADER_VALUE
  }
  if (baseName === 'sw.js' || baseName === 'index.html') {
    headers['Cache-Control'] = 'no-cache'
  } else if (reqPath.includes('/static/')) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  }
  if (method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return
  }
  const stream = createReadStream(target)
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
    } else {
      res.destroy()
    }
  })
  res.writeHead(200, headers)
  stream.pipe(res)
}

export const createAppServer = (options = {}) => {
  const distDir = options.distDir ?? DEFAULT_DIST_DIR
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const allowedOrigins = new Set(options.allowedOrigins ?? [])
  const restrictLoopbackHost = options.restrictLoopbackHost === true

  return http.createServer((req, res) => {
    let urlObj
    try {
      urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    } catch {
      res.writeHead(400, SECURITY_HEADERS)
      res.end('Bad Request')
      return
    }
    if (urlObj.pathname === '/_proxy') {
      void handleProxy(req, res, urlObj, {
        maxBodyBytes,
        connectTimeoutMs,
        allowedOrigins,
        restrictLoopbackHost,
      })
      return
    }
    serveStatic(req, res, urlObj.pathname, distDir)
  })
}

export const parseArgs = (argv = process.argv.slice(2)) => {
  let host = process.env.HOST || '127.0.0.1'
  let port = Number(process.env.PORT || 8787)
  const allowedOrigins = (process.env.ALLOWED_PROXY_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--host' && argv[i + 1]) {
      host = argv[++i]
    } else if (argv[i] === '--port' && argv[i + 1]) {
      port = Number(argv[++i])
    } else if (argv[i] === '--allow-origin' && argv[i + 1]) {
      allowedOrigins.push(argv[++i])
    }
  }
  return { host, port, allowedOrigins }
}

const isEntrypoint = () => {
  if (!process.argv[1]) {
    return false
  }
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))
    )
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  }
}

if (isEntrypoint()) {
  const { host, port, allowedOrigins } = parseArgs()
  const cleanBindHost = host.replace(/^\[|\]$/gu, '').toLowerCase()
  const server = createAppServer({
    allowedOrigins,
    restrictLoopbackHost: isLocalhostName(cleanBindHost),
  })

  const shutdown = () => {
    server.closeAllConnections?.()
    server.close(() => {
      process.exit(0)
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  server.on('error', (error) => {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'EADDRINUSE') {
      process.stderr.write(
        `Error: Port ${port} on ${host} is already in use. Retry with PORT=8788 pnpm start\n`
      )
    } else {
      process.stderr.write(
        `Server error: ${error instanceof Error ? error.message : String(error)}\n`
      )
    }
    process.exit(1)
  })

  server.listen(port, host, () => {
    const addr = server.address()
    const actualPort = typeof addr === 'object' && addr ? addr.port : port
    process.stdout.write(`DeepSeek Chat BYOK server listening at http://${host}:${actualPort}\n`)
  })
}
