param(
  [switch]$SkipVerification,
  [switch]$NoScheduler
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$extensionPath = Join-Path $repoRoot "extension\target-purchase"
$manifestPath = Join-Path $extensionPath "manifest.json"
$schedulerScript = Join-Path $PSScriptRoot "target-extension-scheduler.js"
$runtimeDirectory = Join-Path $repoRoot "data\runtime"
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"

if (-not (Test-Path -LiteralPath $chromePath)) {
  throw "Google Chrome was not found at $chromePath"
}
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Extension manifest was not found at $manifestPath"
}
if (-not (Test-Path -LiteralPath $schedulerScript)) {
  throw "Scheduler was not found at $schedulerScript"
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.manifest_version -ne 3) {
  throw "The extension manifest must use Manifest V3."
}

if (-not $SkipVerification) {
  Push-Location $repoRoot
  try {
    npm test
    if ($LASTEXITCODE -ne 0) {
      throw "npm test failed."
    }
    npm run check
    if ($LASTEXITCODE -ne 0) {
      throw "npm run check failed."
    }
  } finally {
    Pop-Location
  }
}

$schedulerPid = $null
if (-not $NoScheduler) {
  $listener = Get-NetTCPConnection `
    -LocalAddress "127.0.0.1" `
    -LocalPort 18765 `
    -State Listen `
    -ErrorAction SilentlyContinue

  if ($listener) {
    $schedulerPid = $listener[0].OwningProcess
    $schedulerProcess = Get-CimInstance Win32_Process `
      -Filter "ProcessId=$schedulerPid"
    if (
      -not $schedulerProcess -or
      $schedulerProcess.CommandLine -notlike "*$schedulerScript*"
    ) {
      throw "Port 18765 is already owned by another process."
    }
  } else {
    New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
    $stdoutPath = Join-Path $runtimeDirectory "target-extension-scheduler.out.log"
    $stderrPath = Join-Path $runtimeDirectory "target-extension-scheduler.err.log"
    $nodePath = (Get-Command node.exe).Source
    $process = Start-Process `
      -FilePath $nodePath `
      -ArgumentList @($schedulerScript) `
      -WorkingDirectory $repoRoot `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -PassThru
    $schedulerPid = $process.Id
    $deadline = (Get-Date).AddSeconds(5)
    do {
      if ($process.HasExited) {
        throw "Scheduler exited before opening port 18765."
      }
      Start-Sleep -Milliseconds 100
      $listener = Get-NetTCPConnection `
        -LocalAddress "127.0.0.1" `
        -LocalPort 18765 `
        -State Listen `
        -ErrorAction SilentlyContinue
    } while (-not $listener -and (Get-Date) -lt $deadline)
    if (-not $listener -or $listener[0].OwningProcess -ne $schedulerPid) {
      throw "Scheduler did not start listening on port 18765."
    }
  }
}

[pscustomobject]@{
  ChromePath = $chromePath
  ExtensionPath = $extensionPath
  ManifestName = $manifest.name
  ManifestVersion = $manifest.version
  SchedulerPid = $schedulerPid
  SchedulerPort = 18765
} | ConvertTo-Json -Depth 3
