$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RootDir

function Pause-OnFailure {
  param([string]$Message)
  Write-Host "`n[deepseek-chat-byok] ERROR: $Message" -ForegroundColor Red
  Write-Host "Please install Node.js 22+ LTS from https://nodejs.org/ or use the Android APK / Web PWA."
  if ($Host.Name -eq 'ConsoleHost') {
    Read-Host "Press Enter to close" | Out-Null
  }
  exit 1
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
  Pause-OnFailure "Node.js 22+ was not found in PATH."
}
$NodeMajor = 0
try {
  $NodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
} catch {
  $NodeMajor = 0
}
if ($NodeMajor -lt 22) {
  Pause-OnFailure "Detected Node.js v$NodeMajor, but Node.js 22+ is required."
}

$HostAddr = if ($env:HOST) { $env:HOST } else { '127.0.0.1' }
$Port = if ($env:PORT) { $env:PORT } else { '8787' }
$Url = "http://${HostAddr}:${Port}"

if (-not (Test-Path "dist/index.html")) {
  Write-Host "[deepseek-chat-byok] dist/ not found; building production bundle..."
  pnpm build
}

$Server = Start-Process -FilePath "node" -ArgumentList @("server.mjs", "--host", $HostAddr, "--port", $Port) -PassThru -NoNewWindow

try {
  $Ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    if ($Server.HasExited) {
      Pause-OnFailure "Local server exited immediately (port $Port may already be in use)."
    }
    try {
      $resp = Invoke-WebRequest -Uri "$Url/_proxy?probe=1" -UseBasicParsing -TimeoutSec 1
      if ($resp.StatusCode -eq 204) {
        $Ready = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $Ready) {
    Pause-OnFailure "Timed out waiting for local server at $Url."
  }

  $EdgeCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
  )
  $AppBrowser = $EdgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($AppBrowser) {
    Start-Process -FilePath $AppBrowser -ArgumentList "--app=$Url" | Out-Null
  } else {
    Start-Process $Url | Out-Null
  }

  Write-Host "[deepseek-chat-byok] Running at $Url. Press Ctrl+C or close window to stop."
  Wait-Process -Id $Server.Id
} finally {
  if ($Server -and -not $Server.HasExited) {
    Stop-Process -Id $Server.Id -Force -ErrorAction SilentlyContinue
  }
}
