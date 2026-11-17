import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const PKG = 'com.deepseekbyok.app'
const ACTIVITY = `${PKG}/.MainActivity`
const DUMP_REMOTE = '/sdcard/ds-ui-dump.xml'

const adb = (...args) =>
  execFileSync('adb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const getScreenSize = () => {
  const out = adb('shell', 'wm', 'size')
  const matches = [...out.matchAll(/(\d+)x(\d+)/gu)]
  const last = matches[matches.length - 1]
  return last ? { width: Number(last[1]), height: Number(last[2]) } : { width: 1080, height: 2400 }
}

const dumpUi = () => {
  try {
    adb('shell', 'uiautomator', 'dump', DUMP_REMOTE)
    return adb('shell', 'cat', DUMP_REMOTE)
  } catch {
    return ''
  }
}

const findNodes = (xml) => {
  const nodes = []
  const tagRe = /<node\b([^>]+)\/?>/gu
  let match
  while ((match = tagRe.exec(xml)) !== null) {
    const attrs = match[1]
    const getAttr = (name) => {
      const m = new RegExp(`${name}="([^"]*)"`, 'u').exec(attrs)
      return m ? m[1] : ''
    }
    const boundsStr = getAttr('bounds')
    const bMatch = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/u.exec(boundsStr)
    if (!bMatch) continue
    const x1 = Number(bMatch[1])
    const y1 = Number(bMatch[2])
    const x2 = Number(bMatch[3])
    const y2 = Number(bMatch[4])
    nodes.push({
      cls: getAttr('class'),
      text: getAttr('text'),
      desc: getAttr('content-desc'),
      hint: getAttr('hint'),
      password: getAttr('password') === 'true',
      x1,
      y1,
      x2,
      y2,
      w: x2 - x1,
      h: y2 - y1,
      cx: Math.round((x1 + x2) / 2),
      cy: Math.round((y1 + y2) / 2),
    })
  }
  return nodes
}

const summarizeNodes = (nodes) =>
  nodes
    .filter((n) => n.w > 0 && n.h > 0 && (n.text || n.desc || n.hint || n.cls.endsWith('EditText')))
    .slice(0, 40)
    .map(
      (n) =>
        `${n.cls.split('.').pop()}[${n.w}x${n.h}@${n.cx},${n.cy} pw=${n.password} t="${n.text}" h="${n.hint}" d="${n.desc}"]`
    )
    .join('\n')

const waitForNode = async (predicate, description, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs
  let lastNodes = []
  while (Date.now() < deadline) {
    const xml = dumpUi()
    lastNodes = findNodes(xml)
    const found = lastNodes.find(predicate)
    if (found) return { found, nodes: lastNodes }
    await sleep(1000)
  }
  throw new Error(
    `Timed out waiting for UI node (${description}). Visible nodes:\n${summarizeNodes(lastNodes)}`
  )
}

const scrollUntilVisible = async (
  predicate,
  description,
  screen,
  maxSwipes = 6,
  maxCyRatio = 0.85
) => {
  const x = Math.round(screen.width * 0.5)
  const yStart = Math.round(screen.height * 0.52)
  const yEnd = Math.round(screen.height * 0.24)
  const maxCy = Math.round(screen.height * maxCyRatio)
  let lastNodes = []
  for (let i = 0; i <= maxSwipes; i += 1) {
    lastNodes = findNodes(dumpUi())
    const found = lastNodes.find(
      (n) => n.w > 0 && n.h > 0 && n.cy > 60 && n.cy < maxCy && predicate(n)
    )
    if (found) return found
    if (i < maxSwipes) {
      adb('shell', 'input', 'swipe', String(x), String(yStart), String(x), String(yEnd), '280')
      await sleep(700)
    }
  }
  throw new Error(
    `Could not scroll into view (${description}). Visible nodes:\n${summarizeNodes(lastNodes)}`
  )
}

const getPackageMeta = () => {
  const out = adb('shell', 'dumpsys', 'package', PKG)
  const vc = /versionCode=(\d+)/u.exec(out)?.[1] ?? ''
  const vn = /versionName=([^\s]+)/u.exec(out)?.[1] ?? ''
  const firstInstall = /firstInstallTime=([^\r\n]+)/u.exec(out)?.[1]?.trim() ?? ''
  const lastUpdate = /lastUpdateTime=([^\r\n]+)/u.exec(out)?.[1]?.trim() ?? ''
  return { vc, vn, firstInstall, lastUpdate }
}

const [v1Apk, v2Apk, outPath = 'android-upgrade-evidence.json'] = process.argv.slice(2)
if (!v1Apk || !v2Apk) {
  throw new Error(
    'Usage: node scripts/ci-verify-android-upgrade.mjs <v1.apk> <v2.apk> [evidence.json]'
  )
}

const screen = getScreenSize()
console.log('Emulator screen size:', screen)

try {
  adb('uninstall', PKG)
} catch {
  // Ignore if not previously installed
}

console.log(`Installing V1 Release APK: ${v1Apk}`)
adb('install', v1Apk)
const meta1 = getPackageMeta()
console.log('V1 package metadata:', meta1)
if (!meta1.vc) throw new Error('Failed to read V1 versionCode')

adb('shell', 'am', 'start', '-W', '-n', ACTIVITY)

// 1. Wait until WebView renders Settings -> Models & API
await waitForNode(
  (n) => n.w > 0 && n.h > 0 && /Models & API|模型与 API|Provider/iu.test(`${n.text} ${n.desc}`),
  'Settings Models & API tab inside V1 WebView',
  45_000
)

// 2. Scroll to password EditText (API Key input) in upper half and fill test BYOK secret
const keyField = await scrollUntilVisible(
  (n) =>
    n.cls.endsWith('EditText') &&
    (n.password || /API Key|请输入 API Key|Enter API Key/iu.test(`${n.hint} ${n.desc} ${n.text}`)),
  'API Key EditText',
  screen,
  6,
  0.48
)

console.log(`Tapping visible API Key EditText at (${keyField.cx}, ${keyField.cy})`)
adb('shell', 'input', 'tap', String(keyField.cx), String(keyField.cy))
await sleep(500)
adb('shell', 'input', 'text', 'sk-upgrade-retention-proof')
await sleep(500)

// 3. Scroll Settings modal to Save Directly button in upper half (above any IME) and tap
const saveBtn = await scrollUntilVisible(
  (n) => /^(Save Directly|直接保存)$/u.test(n.text || n.desc),
  'Save Directly button',
  screen,
  6,
  0.56
)

console.log(`Tapping visible Save Directly at (${saveBtn.cx}, ${saveBtn.cy})`)
adb('shell', 'input', 'tap', String(saveBtn.cx), String(saveBtn.cy))

await waitForNode(
  (n) =>
    n.w > 0 &&
    n.h > 0 &&
    /Saved and activated provider profile|已保存并切换当前 API 配置/u.test(n.text || n.desc),
  'providerSaved confirmation banner',
  15_000
)
console.log('Confirmed BYOK API key persisted in V1 Release APK!')

adb('shell', 'am', 'force-stop', PKG)
await sleep(600)

// 4. In-place upgrade to V2 Release APK (same release certificate, no uninstall)
console.log(`Installing V2 Release APK IN PLACE (adb install -r): ${v2Apk}`)
const installOut = adb('install', '-r', v2Apk)
console.log(installOut.trim())
const meta2 = getPackageMeta()
console.log('V2 package metadata:', meta2)

if (Number(meta2.vc) <= Number(meta1.vc)) {
  throw new Error(`Expected V2 versionCode > V1 (${meta1.vc} -> ${meta2.vc})`)
}
if (meta1.firstInstall && meta2.firstInstall && meta1.firstInstall !== meta2.firstInstall) {
  throw new Error(
    `firstInstallTime changed (${meta1.firstInstall} vs ${meta2.firstInstall}); upgrade was not in-place`
  )
}

// 5. Launch V2 and prove saved API key survived in-place upgrade
adb('shell', 'am', 'start', '-W', '-n', ACTIVITY)

const { nodes: v2Nodes } = await waitForNode(
  (n) =>
    n.w > 0 &&
    n.h > 0 &&
    /How can I help you|今天有什么可以帮到你|Enter a message|请输入消息/u.test(
      `${n.text} ${n.desc}`
    ),
  'V2 Welcome screen after in-place upgrade',
  45_000
)

const joinedV2 = v2Nodes.map((n) => `${n.text} ${n.desc}`).join(' | ')
if (/Key needed|未填 Key/u.test(joinedV2)) {
  throw new Error(`Saved BYOK key was lost after in-place upgrade! Visible UI text: ${joinedV2}`)
}
if (/Save Directly|直接保存/u.test(joinedV2)) {
  throw new Error(`Onboarding API key dialog reopened unexpectedly after upgrade! UI: ${joinedV2}`)
}

const summary = {
  package: PKG,
  v1: meta1,
  v2: meta2,
  inPlaceUpgradeSuccess: true,
  savedKeyPreserved: true,
}
writeFileSync(outPath, JSON.stringify(summary, null, 2))
console.log('IN-PLACE UPGRADE ACCEPTANCE PASSED:', JSON.stringify(summary))
