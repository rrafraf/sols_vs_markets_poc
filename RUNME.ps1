<#
================================================================================
  RUNME.ps1  —  TSLA Physics Lab  |  Read this file = you have read the README
================================================================================

  WHAT THIS PROJECT IS
  --------------------
  A local browser workbench that replays split-adjusted TSLA one-minute bars
  from SQLite and runs two causal spring-mass agents (Physics + Pursuit) plus
  a manual paper-trading layer — all in the browser, no live broker connection.

  APP ROOMS
  ---------
  Watch     Explore candles, indicators, and the chart workbench.
  Arena     View the experiment story.
  Evidence  Inspect trace cases, anomaly reports, and raw event logs.

  WHAT THIS SCRIPT DOES (in order)
  ---------------------------------
  1. Verifies Python 3.9+
  2. Checks Alpaca API credentials are set in the environment
  3. Confirms the SQLite database exists and has bars
     - If DB is empty or missing  →  seeds it from Alpaca (IEX free feed)
  4. Starts the local server     →  http://127.0.0.1:8000
  5. Opens the browser automatically

  HOW TO GET ALPACA API KEYS (free, no deposit required)
  -------------------------------------------------------
  1. Go to  https://alpaca.markets  and sign up
  2. Open the Paper Trading dashboard:
       https://app.alpaca.markets/paper/dashboard/overview
  3. Right panel  →  "Your API Keys"  →  "View"  →  Generate a key pair
  4. You will see three things: Key ID, Secret Key, and an Endpoint URL
       - Key ID + Secret Key  →  paste into secrets.ps1  (see below)
       - Endpoint URL         →  ignore it here. That URL is for the trading
                                  API (order routing). This project only uses
                                  the data API, which is the same for everyone.
  5. Edit secrets.ps1 in the project root with your Key ID and Secret Key
  6. Re-run this script

  NOTE: The free Alpaca plan gives IEX feed access (one exchange, not full SIP).
  For full consolidated market data, upgrade to a paid plan and pass -Feed sip.

  SCRIPT PARAMETERS
  -----------------
  -Sync    Force a full data re-sync from Alpaca before starting the server
  -Feed    Alpaca feed: iex (default, free) | sip (paid) | delayed_sip
  -Port    Local server port (default: 8000)

================================================================================
#>

param(
    [switch]$Sync,
    [ValidateSet("iex", "sip", "delayed_sip")]
    [string]$Feed = "iex",
    [int]$Port = 8000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── helpers ──────────────────────────────────────────────────────────────────

function Write-Step { param([string]$msg) Write-Host "`n  $msg" -ForegroundColor Cyan   }
function Write-Ok   { param([string]$msg) Write-Host "   OK  $msg" -ForegroundColor Green  }
function Write-Warn { param([string]$msg) Write-Host "   ..  $msg" -ForegroundColor Yellow }
function Write-Fail {
    param([string]$msg)
    Write-Host ""
    Write-Host "   ERR $msg" -ForegroundColor Red
    exit 1
}

# ── project root is wherever this script lives ────────────────────────────────

$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

# ──────────────────────────────────────────────────────────────────────────────
#  STEP 1 — Python 3.9+
# ──────────────────────────────────────────────────────────────────────────────

Write-Step "Step 1/5  Checking Python"

$pythonCmd = $null
foreach ($candidate in @("python", "python3", "py")) {
    try {
        $ver = & $candidate --version 2>&1
        if ($ver -match "Python (\d+)\.(\d+)") {
            $major = [int]$Matches[1]; $minor = [int]$Matches[2]
            if ($major -eq 3 -and $minor -ge 9) {
                $pythonCmd = $candidate
                Write-Ok "$ver  (command: $candidate)"
                break
            } else {
                Write-Warn "$ver is too old (need 3.9+) — trying next candidate"
            }
        }
    } catch { <# command not found, try next #> }
}

if (-not $pythonCmd) {
    Write-Fail "Python 3.9+ not found.`n`n  Install it from https://python.org and make sure it is on PATH.`n"
}

# ──────────────────────────────────────────────────────────────────────────────
#  STEP 2 — Alpaca credentials
# ──────────────────────────────────────────────────────────────────────────────

Write-Step "Step 2/5  Checking Alpaca credentials"

# Auto-load secrets.ps1 if it exists next to this script.
# That file sets $env:APCA_API_KEY_ID and $env:APCA_API_SECRET_KEY.
# It is gitignored so your keys never accidentally get committed.
$secretsFile = Join-Path $ProjectRoot "secrets.ps1"
if (Test-Path $secretsFile) {
    Write-Warn "Loading credentials from secrets.ps1"
    . $secretsFile
} else {
    Write-Warn "secrets.ps1 not found — falling back to environment variables already in this session"
    Write-Warn "(Run:  Copy-Item .\secrets.template.ps1 .\secrets.ps1  then fill it in)"
}

# Validate — fail early with clear guidance rather than a cryptic HTTP 403 later
$keyMissing    = (-not $env:APCA_API_KEY_ID)     -or ($env:APCA_API_KEY_ID     -eq "PASTE_YOUR_KEY_ID_HERE")
$secretMissing = (-not $env:APCA_API_SECRET_KEY) -or ($env:APCA_API_SECRET_KEY -eq "PASTE_YOUR_SECRET_KEY_HERE")

if ($keyMissing -or $secretMissing) {
    Write-Fail @"
Alpaca credentials are missing or still contain placeholder text.

  1. Edit secrets.ps1 in the project root
  2. Replace the placeholder values with your real Key ID and Secret Key
  3. Re-run this script

  Don't have keys yet?
    Sign up free at  https://alpaca.markets
    Then: Paper Trading dashboard -> Your API Keys -> View -> Generate
    (The Endpoint URL shown there is for order routing - ignore it here)
"@
}

Write-Ok "APCA_API_KEY_ID      = $($env:APCA_API_KEY_ID.Substring(0, [Math]::Min(6, $env:APCA_API_KEY_ID.Length)))...  (loaded)"
Write-Ok "APCA_API_SECRET_KEY  = ****  (loaded)"

# ──────────────────────────────────────────────────────────────────────────────
#  STEP 3 — Database check / seed via Alpaca
# ──────────────────────────────────────────────────────────────────────────────

Write-Step "Step 3/5  Checking database"

$dbPath = Join-Path $ProjectRoot "data\market.db"

function Get-BarCount {
    if (-not (Test-Path $dbPath)) { return 0 }
    try {
        $n = & $pythonCmd -c "import sqlite3; c=sqlite3.connect(r'$dbPath'); print(c.execute(`"SELECT COUNT(*) FROM market_candles WHERE symbol='TSLA' AND timeframe='1Min'`").fetchone()[0])" 2>$null
        return [int]$n
    } catch { return 0 }
}

$barCount = Get-BarCount

if ($Sync -or $barCount -eq 0) {
    if ($barCount -eq 0) {
        Write-Warn "Database is empty or missing — seeding from Alpaca (feed: $Feed)..."
    } else {
        Write-Warn "-Sync requested — refreshing $barCount existing bars from Alpaca (feed: $Feed)..."
    }

    # scripts/sync_tsla.py is the only data-ingestion entry point.
    # It calls server.sync_symbol() which handles split validation + upsert.
    & $pythonCmd scripts\sync_tsla.py `
        --provider alpaca `
        --feed     $Feed  `
        --timeframe 1Min  `
        --from 2018-01-01 `
        --to   2024-12-31

    $barCount = Get-BarCount
}

if ($barCount -gt 0) {
    Write-Ok "Database ready — $barCount bars"
} else {
    Write-Warn "Could not confirm bar count. Server will start but the chart may be empty."
}

# ──────────────────────────────────────────────────────────────────────────────
#  STEP 4 — Start the server (background job so we can open the browser next)
#           server.py only accepts --host and --port; no sync flag exists.
# ──────────────────────────────────────────────────────────────────────────────

Write-Step "Step 4/5  Starting server"

$serverJob = Start-Job -ScriptBlock {
    param($root, $py, $port)
    Set-Location $root
    & $py server.py --port $port
} -ArgumentList $ProjectRoot, $pythonCmd, $Port

# Give the server time to bind the socket before we try to open the browser
Start-Sleep -Milliseconds 1500

if ($serverJob.State -eq "Failed") {
    $serverJob | Receive-Job
    Write-Fail "Server crashed at startup — see output above."
}

Write-Ok "Server running on port $Port  (job id: $($serverJob.Id))"

# ──────────────────────────────────────────────────────────────────────────────
#  STEP 5 — Open the browser
# ──────────────────────────────────────────────────────────────────────────────

Write-Step "Step 5/5  Opening browser"
Start-Process "http://127.0.0.1:$Port"
Write-Ok "Opened  http://127.0.0.1:$Port"

# ──────────────────────────────────────────────────────────────────────────────
#  Keep the terminal alive — stream server logs — Ctrl+C to shut everything down
# ──────────────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Lab is running.  Press Ctrl+C to stop the server and exit." -ForegroundColor White
Write-Host ""

try {
    while ($true) {
        $serverJob | Receive-Job | ForEach-Object { Write-Host "  [server] $_" -ForegroundColor DarkGray }
        if ($serverJob.State -in @("Completed", "Failed", "Stopped")) {
            Write-Warn "Server process ended (state: $($serverJob.State))."
            break
        }
        Start-Sleep -Seconds 1
    }
} finally {
    Write-Step "Shutting down"
    Stop-Job   $serverJob -ErrorAction SilentlyContinue
    Remove-Job $serverJob -ErrorAction SilentlyContinue
    Write-Ok "Done. Goodbye."
}
