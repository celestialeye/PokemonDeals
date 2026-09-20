[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateNotNullOrEmpty()]
  [Alias("ProductUrl")]
  [string]$AmazonUrl,

  [ValidateRange(0.01, 10000)]
  [decimal]$MaxItemPrice = 10000,

  [ValidateRange(0.01, 10000)]
  [decimal]$MaxOrderTotal = 10000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$logDirectory = Join-Path $repoRoot "logs"
$runTimestamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
$env:AMAZON_RUN_LOG_PATH = Join-Path (
  New-Item -ItemType Directory -Path $logDirectory -Force
).FullName "amazon-buy-$runTimestamp-$PID.jsonl"
$mutex = [System.Threading.Mutex]::new(
  $false,
  "Local\PokemonDealsAmazonBuy"
)
$mutexHeld = $false
Push-Location $repoRoot

function Protect-AmazonLogText {
  param([AllowNull()][object]$Value)

  return ([string]$Value) `
    -replace '(?i)(https://(?:www\.)?amazon\.com/(?:checkout|gp/buy)(?:/[^\s"''<>?]*)?)\?[^\s"''<>]*', '$1?<redacted>' `
    -replace '(?i)("(?:offeringID|offerListingID|AMAZON_CHECKOUT_URL|authorization|proxy-authorization|cookie|set-cookie|session-token|x-amz-security-token)"\s*:\s*)"(?:\\.|[^"\\])*"', '$1"<redacted>"' `
    -replace '(?i)((?:offeringID|offerListingID|AMAZON_CHECKOUT_URL)"?\s*[=:]\s*)"?[^&\s"''<>]*', '$1<redacted>' `
    -replace '(?i)((?:authorization|proxy-authorization|cookie|set-cookie|session-token|x-amz-security-token)\s*[=:]\s*)[^\r\n]*', '$1<redacted>' `
    -replace '\b\d{3}-\d{7}-\d{7}\b', '<redacted-order-id>'
}

function Write-AmazonRunEvent {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Level,

    [Parameter(Mandatory = $true)]
    [string]$Event,

    [hashtable]$Data = @{}
  )

  $record = [ordered]@{
    timestamp = [DateTimeOffset]::UtcNow.ToString("o")
    workflow = "amazon-buy-launcher"
    pid = $PID
    level = $Level
    event = $Event
    message = $Event
  }
  foreach ($key in $Data.Keys) {
    $record[$key] = Protect-AmazonLogText $Data[$key]
  }
  $record |
    ConvertTo-Json -Compress |
    Add-Content -LiteralPath $env:AMAZON_RUN_LOG_PATH -Encoding utf8
}

try {
  Write-AmazonRunEvent -Level "info" -Event "AMAZON_LAUNCHER_STARTED"
  Write-Host "AMAZON_LOG_FILE $([System.Uri]::new($env:AMAZON_RUN_LOG_PATH).AbsoluteUri)"

  try {
    $mutexHeld = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $mutexHeld = $true
  }
  if (-not $mutexHeld) {
    throw "Another amazon-buy invocation is already active."
  }
  Write-AmazonRunEvent -Level "info" -Event "AMAZON_LAUNCHER_LOCK_ACQUIRED"

  Remove-Item Env:AMAZON_CHECKOUT_URL -ErrorAction SilentlyContinue
  $env:AMAZON_PRODUCT_URL = $AmazonUrl
  $env:AMAZON_MAX_ITEM_PRICE = $MaxItemPrice.ToString(
    [System.Globalization.CultureInfo]::InvariantCulture
  )
  $env:AMAZON_MAX_ORDER_TOTAL = $MaxOrderTotal.ToString(
    [System.Globalization.CultureInfo]::InvariantCulture
  )
  Remove-Item Env:AMAZON_EXPECTED_ASIN -ErrorAction SilentlyContinue
  Remove-Item Env:AMAZON_EXPECTED_TITLE -ErrorAction SilentlyContinue

  $inputJson = & node -e 'const { parseAmazonBuyUrl } = require("./src/amazon-offers"); const input = parseAmazonBuyUrl(process.env.AMAZON_PRODUCT_URL); process.stdout.write(JSON.stringify({ type: input.type, asin: input.asin }));'
  if ($LASTEXITCODE -ne 0) {
    throw "Amazon URL validation failed."
  }
  $inputMetadata = $inputJson | ConvertFrom-Json
  $inputType = [string]$inputMetadata.type
  $inputAsin = [string]$inputMetadata.asin
  if ($inputType -eq "checkout") {
    $env:AMAZON_CHECKOUT_URL = $AmazonUrl
    Remove-Item Env:AMAZON_PRODUCT_URL
  } elseif ($inputType -ne "product") {
    throw "Amazon URL classification failed."
  }
  Write-AmazonRunEvent `
    -Level "info" `
    -Event "AMAZON_INPUT_ACCEPTED" `
    -Data @{ asin = $inputAsin; inputType = $inputType; quantity = 1 }
  Write-Host "AMAZON_INPUT_ACCEPTED type=$inputType asin=$inputAsin"

  & node -e 'require.resolve("playwright-core")' *> $null
  if ($LASTEXITCODE -ne 0) {
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed."
    }
  }
  Write-AmazonRunEvent -Level "info" -Event "AMAZON_DEPENDENCIES_READY"

  $workerPattern =
    '(?i)(?:^|[\s\\/"])(?:amazon-preorder|amazon-checkout|amazon-multi-preorder)\.js(?:["\s]|$)'
  $workers = @(
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -match $workerPattern }
  )
  if ($workers.Count -gt 0) {
    $workerPids = ($workers | Select-Object -ExpandProperty ProcessId) -join ","
    throw "A competing Amazon purchase worker is already running (PID(s): $workerPids). Stop it before starting amazon-buy."
  }
  Write-AmazonRunEvent -Level "info" -Event "AMAZON_WORKER_PREFLIGHT_READY"

  $cdpJson = & node -e 'const { ensureChromeCdp } = require("./src/chrome-cdp"); ensureChromeCdp().then((result) => process.stdout.write(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exit(1); });'
  if ($LASTEXITCODE -ne 0) {
    throw "Chrome CDP bootstrap failed."
  }
  $cdpResult = $cdpJson | ConvertFrom-Json
  if ($cdpResult.started) {
    Write-AmazonRunEvent -Level "info" -Event "AMAZON_CDP_READY"
  } else {
    Write-AmazonRunEvent -Level "info" -Event "AMAZON_CDP_REUSED"
  }

  Write-AmazonRunEvent `
    -Level "info" `
    -Event "AMAZON_WORKER_STARTING" `
    -Data @{
      asin = $inputAsin
      inputType = $inputType
      maxItemPrice = $env:AMAZON_MAX_ITEM_PRICE
      maxOrderTotal = $env:AMAZON_MAX_ORDER_TOTAL
      quantity = 1
    }
  Write-Host (
    "AMAZON_BUY_STARTED maxItemPrice={0} maxOrderTotal={1}" -f
      $env:AMAZON_MAX_ITEM_PRICE,
      $env:AMAZON_MAX_ORDER_TOTAL
  )
  npm run amazon:direct-buy
  $workerExitCode = $LASTEXITCODE
  Write-AmazonRunEvent `
    -Level $(if ($workerExitCode -eq 0) { "info" } else { "error" }) `
    -Event "AMAZON_WORKER_EXIT" `
    -Data @{ exitCode = $workerExitCode }
  if ($workerExitCode -ne 0) {
    throw "Amazon direct-buy worker exited with code $workerExitCode."
  }
  Write-AmazonRunEvent -Level "info" -Event "AMAZON_LAUNCHER_COMPLETED"
} catch {
  Write-AmazonRunEvent `
    -Level "error" `
    -Event "AMAZON_LAUNCHER_FAILED" `
    -Data @{ error = $_.Exception.Message }
  throw
} finally {
  Remove-Item Env:AMAZON_PRODUCT_URL -ErrorAction SilentlyContinue
  Remove-Item Env:AMAZON_CHECKOUT_URL -ErrorAction SilentlyContinue
  if ($mutexHeld) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
  Pop-Location
}
