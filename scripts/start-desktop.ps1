$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RootDir

$HostAddr = if ($env:HOST) { $env:HOST } else { '127.0.0.1' }
$Port = if ($env:PORT) { $env:PORT } else { '8787' }
$Url = "http://${HostAddr}:${Port}"

if (-not (Test-Path "dist/index.html")) {
  Write-Host "[deepseek-chat-byok] dist/ not found; building production bundle..."
  pnpm build
}

$Server = Start-Process -FilePath "node" -ArgumentList @("server.mjs", "--host", $HostAddr, "--port", $Port) -PassThru -NoNewWindow

try {
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1
      if ($resp.StatusCode -eq 200) { break }
    } catch {
      Start-Sleep -Milliseconds 250
    }
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
