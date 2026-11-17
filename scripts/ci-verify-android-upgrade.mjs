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

// 4. Close Settings modal and persist a real chat session + pinned Memory Card in V1 IndexedDB
const { found: closeSettingsBtn } = await waitForNode(
  (n) => n.w > 0 && n.h > 0 && /^(Close|关闭)$/u.test(n.text || n.desc),
  'Close Settings modal button',
  10_000
)
adb('shell', 'input', 'tap', String(closeSettingsBtn.cx), String(closeSettingsBtn.cy))
await sleep(600)

const { found: composerField } = await waitForNode(
  (n) => n.w > 0 && n.h > 0 && n.cls.endsWith('EditText'),
  'Welcome chat composer EditText',
  20_000
)
adb('shell', 'input', 'tap', String(composerField.cx), String(composerField.cy))
await sleep(500)
const SENTINEL_CHAT = 'UpgradeSentinelMsg'
adb('shell', 'input', 'text', SENTINEL_CHAT)
await sleep(600)

const { found: sendBtn } = await waitForNode(
  (n) => n.w > 0 && n.h > 0 && /^(Send|发送)$/u.test(n.text || n.desc),
  'Chat Send button',
  15_000
)
adb('shell', 'input', 'tap', String(sendBtn.cx), String(sendBtn.cy))
await waitForNode(
  (n) => n.w > 0 && n.h > 0 && n.text.includes(SENTINEL_CHAT),
  'Persisted user message in V1 SessionView',
  20_000
)
await sleep(1200)

const { found: memBtnV1 } = await waitForNode(
  (n) => n.w > 0 && n.h > 0 && /^(Memory|记忆卡)(\s*\*)?$/u.test((n.text || n.desc).trim()),
  'Memory Card button in V1 ContextBar',
  15_000
)
adb('shell', 'input', 'tap', String(memBtnV1.cx), String(memBtnV1.cy))
const { found: memTitleV1 } = await waitForNode(
  (n) =>
    n.w > 0 &&
    n.h > 0 &&
    n.h < 200 &&
    !n.cls.endsWith('Dialog') &&
    /Pinned Memory|长期记忆与人设前缀/u.test(n.text || n.desc),
  'Memory Card modal title in V1',
  15_000
)
const { found: memSaveAnchorV1 } = await waitForNode(
  (n) => n.w > 0 && n.h > 0 && /^(Save Memory|保存记忆卡)$/u.test((n.text || n.desc).trim()),
  'Save Memory anchor in V1 modal',
  15_000
)
const { found: memFieldV1 } = await waitForNode(
  (n) =>
    n.w > 0 &&
    n.h > 0 &&
    n.cls.endsWith('EditText') &&
    n.cy > memTitleV1.y2 &&
    n.cy < memSaveAnchorV1.y1,
  'Memory Card textarea inside V1 modal',
  15_000
)
adb('shell', 'input', 'tap', String(memFieldV1.cx), String(memFieldV1.cy))
await sleep(500)
const SENTINEL_MEMORY = 'UpgradeSentinelMemory'
adb('shell', 'input', 'text', SENTINEL_MEMORY)
await sleep(500)
const { found: saveMemBtn } = await waitForNode(
  (n) => n.w > 0 && n.h > 0 && /^(Save Memory|保存记忆卡)$/u.test((n.text || n.desc).trim()),
  'Save Memory button in V1 modal after text entry',
  15_000
)
adb('shell', 'input', 'tap', String(saveMemBtn.cx), String(saveMemBtn.cy))
await sleep(1800)
const afterSaveDump = findNodes(dumpUi())
if (afterSaveDump.some((n) => n.cls.endsWith('Dialog') && /Pinned Memory|长期记忆/u.test(n.text))) {
  throw new Error('Save Memory tap did not close Memory Card modal cleanly in V1')
}
console.log('Confirmed chat turn + Memory Card written to V1 IndexedDB!')

adb('shell', 'am', 'force-stop', PKG)
await sleep(700)

// 5. In-place upgrade to candidate V2 Release APK (same release certificate, no uninstall)
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

// 6. Launch V2 and prove saved API key, IndexedDB chat session, and Memory Card ALL survived
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

const { found: openSidebarBtn } = await waitForNode(
  (n) => n.w > 0 && n.h > 0 && /^(Open sidebar|打开边栏)$/u.test((n.text || n.desc).trim()),
  'Open sidebar button in V2',
  15_000
)
adb('shell', 'input', 'tap', String(openSidebarBtn.cx), String(openSidebarBtn.cy))
const { found: siderGroupHeader } = await waitForNode(
  (n) =>
    n.w > 0 &&
    n.h > 0 &&
    !n.cls.endsWith('EditText') &&
    /^(Today|今天|Yesterday|昨天)$/u.test((n.text || n.desc).trim()),
  'Sidebar date section header (proves sessions.length > 0 in V2)',
  15_000
)
const { found: sessionItem } = await waitForNode(
  (n) =>
    n.w > 0 &&
    n.h > 0 &&
    !n.cls.endsWith('EditText') &&
    n.y1 >= siderGroupHeader.y2 &&
    n.cy < Math.round(screen.height * 0.85) &&
    /^(UpgradeSentinelMsg|New chat|新对话)/u.test((n.text || n.desc).trim()),
  'Saved V1 chat item below sidebar date header in V2',
  15_000
)
adb('shell', 'input', 'tap', String(sessionItem.cx), String(sessionItem.cy))

await waitForNode(
  (n) => n.w > 0 && n.h > 0 && `${n.text} ${n.desc}`.includes(SENTINEL_CHAT),
  'Restored V1 chat message inside V2 SessionView',
  20_000
)

const { found: memBtnV2 } = await waitForNode(
  (n) => n.w > 0 && n.h > 0 && /^(Memory|记忆卡)(\s*\*)?$/u.test((n.text || n.desc).trim()),
  'Memory Card button in V2 restored session',
  15_000
)
adb('shell', 'input', 'tap', String(memBtnV2.cx), String(memBtnV2.cy))
await waitForNode(
  (n) => n.w > 0 && n.h > 0 && `${n.text} ${n.desc}`.includes(SENTINEL_MEMORY),
  'Restored V1 Memory Card inside V2 modal',
  15_000
)

const summary = {
  package: PKG,
  v1: meta1,
  v2: meta2,
  inPlaceUpgradeSuccess: true,
  savedKeyPreserved: true,
  chatSessionPreserved: true,
  memoryCardPreserved: true,
  sentinelChatMessage: SENTINEL_CHAT,
  sentinelMemoryCard: SENTINEL_MEMORY,
}
writeFileSync(outPath, JSON.stringify(summary, null, 2))
console.log('IN-PLACE UPGRADE ACCEPTANCE PASSED:', JSON.stringify(summary))
