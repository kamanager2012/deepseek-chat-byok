import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const PKG = 'com.deepseekbyok.app'
const ACTIVITY = `${PKG}/.MainActivity`
const DUMP_REMOTE = '/sdcard/ds-ui-dump.xml'

const adb = (...args) =>
  execFileSync('adb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
      cx: Math.round((x1 + x2) / 2),
      cy: Math.round((y1 + y2) / 2),
    })
  }
  return nodes
}

const waitForNode = async (predicate, description, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  let lastXml = ''
  while (Date.now() < deadline) {
    lastXml = dumpUi()
    const nodes = findNodes(lastXml)
    const found = nodes.find(predicate)
    if (found) return { found, nodes }
    await sleep(1000)
  }
  throw new Error(
    `Timed out waiting for UI node (${description}). Last dump tail:\n${lastXml.slice(-2000)}`
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

// 1. Wait for first-run BYOK Settings dialog inside WebView & locate password API Key EditText
const { nodes: v1Nodes } = await waitForNode(
  (n) =>
    n.cls.endsWith('EditText') &&
    (n.password || /API Key|请输入 API Key|Enter API Key/iu.test(`${n.text} ${n.hint} ${n.desc}`)),
  'API Key password EditText in onboarding Settings',
  45_000
)

const editNodes = v1Nodes.filter((n) => n.cls.endsWith('EditText'))
const keyField =
  editNodes.find((n) => n.password) ??
  editNodes.find((n) =>
    /API Key|请输入 API Key|Enter API Key/iu.test(`${n.hint} ${n.desc} ${n.text}`)
  )
if (!keyField) {
  throw new Error('No API Key EditText found in V1 WebView onboarding')
}

console.log('Tapping API Key EditText at', keyField.cx, keyField.cy)
adb('shell', 'input', 'tap', String(keyField.cx), String(keyField.cy))
await sleep(400)
adb('shell', 'input', 'text', 'sk-upgrade-retention-proof')
await sleep(400)
try {
  adb('shell', 'input', 'keyevent', '111') // Dismiss IME if open (KEYCODE_ESCAPE)
} catch {
  // ignore
}
await sleep(300)

// Scroll Settings modal so Save Directly button is visible
let saveBtn = null
for (let attempt = 0; attempt < 5; attempt += 1) {
  const xml = dumpUi()
  const match = findNodes(xml).find((n) => /^(Save Directly|直接保存)$/u.test(n.text || n.desc))
  if (match) {
    saveBtn = match
    break
  }
  adb('shell', 'input', 'swipe', '540', '1350', '540', '650', '300')
  await sleep(600)
}
if (!saveBtn) {
  throw new Error('Could not locate Save Directly button after scrolling Settings modal')
}

console.log('Tapping Save Directly at', saveBtn.cx, saveBtn.cy)
adb('shell', 'input', 'tap', String(saveBtn.cx), String(saveBtn.cy))

await waitForNode(
  (n) => /Saved and activated provider profile|已保存并切换当前 API 配置/u.test(n.text || n.desc),
  'providerSaved confirmation banner',
  15_000
)
console.log('Confirmed BYOK API key persisted in V1 Release APK!')

adb('shell', 'am', 'force-stop', PKG)
await sleep(500)

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

adb('shell', 'am', 'start', '-W', '-n', ACTIVITY)

// After in-place upgrade, saved API key must survive: main Welcome composer appears WITHOUT "Key needed"
const { nodes: v2Nodes } = await waitForNode(
  (n) =>
    /How can I help you|今天有什么可以帮到你|Enter a message|请输入消息/u.test(n.text || n.desc),
  'V2 Welcome screen after in-place upgrade',
  30_000
)

const joinedV2 = v2Nodes.map((n) => `${n.text} ${n.desc}`).join(' | ')
if (/Key needed|未填 Key/u.test(joinedV2)) {
  throw new Error(`Saved BYOK key was lost after in-place upgrade! Visible UI text: ${joinedV2}`)
}
if (/Enter API Key|Save Directly|直接保存/u.test(joinedV2)) {
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
