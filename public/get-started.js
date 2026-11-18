;(() => {
  const status = document.getElementById('download-status')
  const android = document.getElementById('android-download')
  const desktop = document.getElementById('desktop-download')
  const releaseTagEl = document.getElementById('release-tag')
  const androidMetaEl = document.getElementById('android-meta')
  const desktopMetaEl = document.getElementById('desktop-meta')
  const releasePage = 'https://github.com/kamanager2012/deepseek-chat-byok/releases/latest'
  const prefix = '/kamanager2012/deepseek-chat-byok/releases/download/'
  const isDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  const formatMb = (bytes) =>
    Number.isSafeInteger(bytes) && bytes > 0
      ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
      : '未知大小'

  const verifiedMirrorUrl = (item, tag, suffix) => {
    if (
      !item ||
      typeof item.filename !== 'string' ||
      item.filename !== `deepseek-chat-byok-${tag}${suffix}` ||
      !isDigest(item.sha256)
    ) {
      return null
    }
    return new URL(`./downloads/${encodeURIComponent(item.filename)}`, location.href).href
  }

  const trySameSiteDownloads = async () => {
    const response = await fetch('./downloads/manifest.json', { cache: 'no-store' })
    if (!response.ok) throw new Error('No mirror manifest')
    const manifest = await response.json()
    if (
      manifest?.schemaVersion !== 1 ||
      typeof manifest.tag !== 'string' ||
      !/^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(manifest.tag)
    ) {
      throw new Error('Unrecognized mirror manifest')
    }
    const apk = verifiedMirrorUrl(manifest.android, manifest.tag, '-android-release.apk')
    const zip = verifiedMirrorUrl(manifest.desktop, manifest.tag, '-portable.zip')
    if (!apk || !zip) throw new Error('Missing mirrored installers')
    android.href = apk
    android.download = manifest.android.filename
    android.textContent = `直接下载安卓正式版（${manifest.tag}）`
    desktop.href = zip
    desktop.download = manifest.desktop.filename
    desktop.textContent = `直接下载电脑便携包（${manifest.tag}）`
    if (releaseTagEl) {
      releaseTagEl.textContent = `${manifest.tag}（本站 SHA-256 镜像已核验）`
    }
    if (androidMetaEl) {
      androidMetaEl.textContent = `${manifest.android.filename} · ${formatMb(manifest.android.bytes)} · SHA-256 ${manifest.android.sha256.slice(0, 16)}…`
    }
    if (desktopMetaEl) {
      desktopMetaEl.textContent = `${manifest.desktop.filename} · ${formatMb(manifest.desktop.bytes)} · SHA-256 ${manifest.desktop.sha256.slice(0, 16)}…`
    }
    status.textContent = '已准备好当前最新正式版安卓安装包（可直接点击下载）。'
    return true
  }

  const safeGithubAssetUrl = (assets, suffix) => {
    const asset = assets.find(
      (item) =>
        typeof item.name === 'string' &&
        item.name.startsWith('deepseek-chat-byok-') &&
        item.name.endsWith(suffix)
    )
    if (!asset || typeof asset.browser_download_url !== 'string') return null
    try {
      const url = new URL(asset.browser_download_url)
      return url.protocol === 'https:' &&
        url.hostname === 'github.com' &&
        url.pathname.startsWith(prefix)
        ? url.href
        : null
    } catch {
      return null
    }
  }

  const tryGithubRelease = async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(
        'https://api.github.com/repos/kamanager2012/deepseek-chat-byok/releases/latest',
        { signal: controller.signal, cache: 'no-store' }
      )
      if (!response.ok) throw new Error('Release lookup failed')
      const release = await response.json()
      if (!release || release.draft || release.prerelease || !Array.isArray(release.assets)) {
        throw new Error('Invalid release')
      }
      const apk = safeGithubAssetUrl(release.assets, '-android-release.apk')
      const zip = safeGithubAssetUrl(release.assets, '-portable.zip')
      if (!apk || !zip) throw new Error('Release files not found')
      android.href = apk
      android.textContent = '下载安卓正式版 APK（GitHub）'
      desktop.href = zip
      desktop.textContent = '下载电脑便携 ZIP（GitHub）'
      if (releaseTagEl && typeof release.tag_name === 'string') {
        releaseTagEl.textContent = `${release.tag_name}（GitHub API 在线查询）`
      }
      status.textContent = '已找到最新官方安卓正式版安装包。'
    } catch {
      android.href = releasePage
      desktop.href = releasePage
      if (releaseTagEl) {
        releaseTagEl.textContent = '请查看 GitHub Releases 最新正式发行'
      }
      status.textContent = '暂时无法加载下载地址；如果当前网络访问海外站点受限，可稍后再试。'
    } finally {
      clearTimeout(timeout)
    }
  }

  void trySameSiteDownloads().catch(() => tryGithubRelease())
})()
