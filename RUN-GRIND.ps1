<#
================================================================================
  RUN-GRIND.ps1  —  Training Ground quick runner
================================================================================

  Default use:

    .\RUN-GRIND.ps1

  Stream ordered event logs:

    .\RUN-GRIND.ps1 -Stream

  Bigger smoke:

    .\RUN-GRIND.ps1 -Runs 32 -Workers 4 -Limit 5000 -Name coinflip-play

  Full decision trace for a small window:

    .\RUN-GRIND.ps1 -Runs 1 -Workers 1 -Limit 300 -DecisionTrace all -Stream

  WHAT THIS SCRIPT WRITES
  -----------------------
  output\training-ground\<name>.html           summary table
  output\training-ground\<name>.csv            per-run stats
  output\training-ground\<name>.json           manifest + summary
  output\training-ground\<name>.trades.csv     completed trades
  output\training-ground\<name>.events.csv     runner lifecycle events
  output\training-ground\<name>.decisions.csv  agent intent/action rows
  output\training-ground\<name>.anomalies.csv  model/leak warnings

  TRACE NOTES
  -----------
  - Default DecisionTrace is "actions": only non-WAIT decisions are written.
  - Use "-DecisionTrace all" only on a small Limit if you want every WAIT candle.
  - "-Stream" is ordered only with one worker; this script enforces that.
  - Parallel runs still write ordered CSV artifacts after completion.

================================================================================
#>

param(
    [ValidateSet("coin-flip")]
    [string]$Agent = "coin-flip",

    [int]$Runs = 1,
    [int]$Workers = 1,
    [int]$Limit = 1000,
    [int]$Seed = 9201,

    [string]$Name = "",

    [string]$Trace = "summary,trades,events,decisions,anomalies",

    [ValidateSet("actions", "all")]
    [string]$DecisionTrace = "actions",

    [switch]$Stream,
    [switch]$OpenHtml
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step { param([string]$msg) Write-Host "`n  $msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "   ..  $msg" -ForegroundColor Yellow }
function Write-Fail {
    param([string]$msg)
    Write-Host ""
    Write-Host "   ERR $msg" -ForegroundColor Red
    exit 1
}

$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

if (-not $Name) {
    $Name = "grind-play-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
}

if ($Stream -and $Workers -ne 1) {
    Write-Warn "Ordered streaming is only reliable with one worker; setting -Workers 1"
    $Workers = 1
}

Write-Step "Checking runner prerequisites"

$node = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
    Write-Fail "Node.js is not on PATH."
}
Write-Ok "Node: $($node.Source)"

$runner = Join-Path $ProjectRoot "training_ground\run-experiment.js"
if (-not (Test-Path $runner)) {
    Write-Fail "Missing training_ground\run-experiment.js"
}
Write-Ok "Runner found"

$db = Join-Path $ProjectRoot "data\market.db"
if (-not (Test-Path $db)) {
    Write-Fail "Missing data\market.db. Run .\RUNME.ps1 first to seed data."
}
Write-Ok "Database found"

Write-Step "Running training ground"

$runnerArgs = @(
    "training_ground\run-experiment.js",
    "--agent", $Agent,
    "--runs", "$Runs",
    "--workers", "$Workers",
    "--limit", "$Limit",
    "--seed", "$Seed",
    "--name", $Name,
    "--trace", $Trace,
    "--decisionTrace", $DecisionTrace
)

if ($Stream) {
    $runnerArgs += @("--streamTrace", "true")
}

Write-Host ""
Write-Host "  node $($runnerArgs -join ' ')" -ForegroundColor DarkGray
Write-Host ""

& node @runnerArgs
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Training ground failed with exit code $LASTEXITCODE"
}

Write-Step "Outputs"

$outDir = Join-Path $ProjectRoot "output\training-ground"
$files = @(
    "$Name.html",
    "$Name.csv",
    "$Name.json",
    "$Name.trades.csv",
    "$Name.events.csv",
    "$Name.decisions.csv",
    "$Name.anomalies.csv"
)

foreach ($file in $files) {
    $path = Join-Path $outDir $file
    if (Test-Path $path) {
        Write-Ok $path
    }
}

if ($OpenHtml) {
    $html = Join-Path $outDir "$Name.html"
    if (Test-Path $html) {
        Start-Process $html
    }
}
