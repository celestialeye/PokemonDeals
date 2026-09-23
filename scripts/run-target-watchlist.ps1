[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$purchaseMutex = [System.Threading.Mutex]::new(
  $false,
  "Local\PokemonDealsPurchase"
)
$mutexHeld = $false
Push-Location $repoRoot

try {
  try {
    $mutexHeld = $purchaseMutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $mutexHeld = $true
  }
  if (-not $mutexHeld) {
    throw "Another PokemonDeals purchase invocation is already active."
  }

  $workerPattern =
    '(?i)(?:^|[\s\\/"])(?:target-watchlist-buy|target-direct-buy|target-watch|monitor|preorder|amazon-preorder|amazon-checkout|amazon-multi-preorder|pokemoncenter-preorder)\.js(?:["\s]|$)'
  $workers = @(
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -match $workerPattern }
  )
  if ($workers.Count -gt 0) {
    throw "A competing PokemonDeals purchase worker is already running."
  }

  & node -e 'require.resolve("patchright"); require.resolve("playwright-core")' *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Target watchlist dependencies are missing."
  }

  & node target-watchlist-buy.js
  if ($LASTEXITCODE -ne 0) {
    throw "Target watchlist worker exited with code $LASTEXITCODE."
  }
} finally {
  if ($mutexHeld) {
    $purchaseMutex.ReleaseMutex()
  }
  $purchaseMutex.Dispose()
  Pop-Location
}
