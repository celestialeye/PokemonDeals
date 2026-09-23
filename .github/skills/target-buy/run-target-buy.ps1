[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$logDirectory = Join-Path $repoRoot "logs"
$runTimestamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
$env:TARGET_RUN_LOG_PATH = Join-Path (
  New-Item -ItemType Directory -Path $logDirectory -Force
).FullName "target-buy-$runTimestamp-$PID.jsonl"
$mutex = [System.Threading.Mutex]::new(
  $false,
  "Local\PokemonDealsPurchase"
)
$mutexHeld = $false
Push-Location $repoRoot

function Protect-TargetLogText {
  param([AllowNull()][object]$Value)

  return ([string]$Value) `
    -replace '(?i)(https://(?:www\.)?target\.com/[^\s"''<>?]+)\?[^\s"''<>]*', '$1?<redacted>' `
    -replace '(?i)("(?:authorization|proxy-authorization|cookie|set-cookie|session-token|x-amz-security-token)"\s*:\s*)"(?:\\.|[^"\\])*"', '$1"<redacted>"' `
    -replace '(?i)((?:authorization|proxy-authorization|cookie|set-cookie|session-token|x-amz-security-token)\s*[=:]\s*)[^\r\n]*', '$1<redacted>' `
    -replace '(?i)\b(?:order(?:\s+number)?|confirmation)\s*(?:#|:)?\s*[A-Z0-9-]{6,}\b', '<redacted-order-id>'
}

function Write-TargetRunEvent {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Level,

    [Parameter(Mandatory = $true)]
    [string]$Event,

    [hashtable]$Data = @{}
  )

  $record = [ordered]@{
    timestamp = [DateTimeOffset]::UtcNow.ToString("o")
    workflow = "target-buy-launcher"
    pid = $PID
    level = $Level
    event = $Event
    message = $Event
  }
  foreach ($key in $Data.Keys) {
    $record[$key] = Protect-TargetLogText $Data[$key]
  }
  $record |
    ConvertTo-Json -Compress |
    Add-Content -LiteralPath $env:TARGET_RUN_LOG_PATH -Encoding utf8
}

try {
  Write-TargetRunEvent -Level "info" -Event "TARGET_LAUNCHER_STARTED"
  Write-Host "TARGET_LOG_FILE $([System.Uri]::new($env:TARGET_RUN_LOG_PATH).AbsoluteUri)"

  try {
    $mutexHeld = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $mutexHeld = $true
  }
  if (-not $mutexHeld) {
    throw "Another PokemonDeals purchase invocation is already active."
  }
  Write-TargetRunEvent -Level "info" -Event "TARGET_LAUNCHER_LOCK_ACQUIRED"

  $env:TARGET_BUY_MODE = "auto"
  $inputJson = & node -e 'const { readActiveTargetBuyInvocation } = require("./src/target-buy-invocation"); const { normalizeTargetBuyMode } = require("./src/target-buy-input"); try { const input = readActiveTargetBuyInvocation(); const mode = normalizeTargetBuyMode(process.env.TARGET_BUY_MODE); process.stdout.write(JSON.stringify({ url: input.url, type: input.type, productId: input.product?.id || null, mode })); } catch (error) { console.error(error.message); process.exitCode = 1; }'
  if ($LASTEXITCODE -ne 0) {
    throw "Target invocation validation failed."
  }
  $inputMetadata = $inputJson | ConvertFrom-Json
  $env:TARGET_BUY_PRODUCT_URL = [string]$inputMetadata.url
  $inputProductId = [string]$inputMetadata.productId
  if (-not $inputProductId) {
    $inputProductId = "short-link"
  }
  Write-TargetRunEvent `
    -Level "info" `
    -Event "TARGET_INPUT_ACCEPTED" `
    -Data @{
      inputType = [string]$inputMetadata.type
      productId = [string]$inputMetadata.productId
      mode = [string]$inputMetadata.mode
      quantity = 1
    }
  Write-Host (
    "TARGET_INPUT_ACCEPTED type={0} product={1} mode={2}" -f
      $inputMetadata.type,
      $inputProductId,
      $inputMetadata.mode
  )

  & node -e 'require.resolve("patchright"); require.resolve("playwright-core")' *> $null
  if ($LASTEXITCODE -ne 0) {
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed."
    }
  }
  Write-TargetRunEvent -Level "info" -Event "TARGET_DEPENDENCIES_READY"

  $workerPattern =
    '(?i)(?:^|[\s\\/"])(?:target-direct-buy|target-watch|monitor|preorder|amazon-preorder|amazon-checkout|amazon-multi-preorder|pokemoncenter-preorder)\.js(?:["\s]|$)'
  $workers = @(
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -match $workerPattern }
  )
  if ($workers.Count -gt 0) {
    $workerPids = ($workers | Select-Object -ExpandProperty ProcessId) -join ","
    throw "A competing PokemonDeals purchase worker is already running (PID(s): $workerPids). Stop it before starting target-buy."
  }
  Write-TargetRunEvent -Level "info" -Event "TARGET_WORKER_PREFLIGHT_READY"

  Write-TargetRunEvent `
    -Level "info" `
    -Event "TARGET_WORKER_STARTING" `
    -Data @{
      inputType = [string]$inputMetadata.type
      productId = [string]$inputMetadata.productId
      mode = [string]$inputMetadata.mode
      quantity = 1
    }
  npm run target:direct-buy
  $workerExitCode = $LASTEXITCODE
  Write-TargetRunEvent `
    -Level $(if ($workerExitCode -eq 0) { "info" } else { "error" }) `
    -Event "TARGET_WORKER_EXIT" `
    -Data @{ exitCode = $workerExitCode }
  if ($workerExitCode -ne 0) {
    throw "Target direct-buy worker exited with code $workerExitCode."
  }
  Write-TargetRunEvent -Level "info" -Event "TARGET_LAUNCHER_COMPLETED"
} catch {
  Write-TargetRunEvent `
    -Level "error" `
    -Event "TARGET_LAUNCHER_FAILED" `
    -Data @{ error = $_.Exception.Message }
  throw
} finally {
  Remove-Item Env:TARGET_BUY_PRODUCT_URL -ErrorAction SilentlyContinue
  Remove-Item Env:TARGET_BUY_MODE -ErrorAction SilentlyContinue
  if ($mutexHeld) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
  Pop-Location
}
