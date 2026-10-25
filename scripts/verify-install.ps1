# Isolated end-to-end check for the installer.
#
# Everything runs against a throwaway CODEX_HOME and data directory, so it is
# safe in CI and safe on a developer machine with a real Codex install.
#
# Scenarios:
#   1. fresh install          -> exit 0, one entry, non-ASCII config preserved
#   2. re-install             -> idempotent, still one entry
#   3. incomplete package     -> exit 1, config byte-identical
#   4. uninstall              -> entry removed, non-ASCII config preserved
#
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM, and
# tests/dist.test.mjs enforces that this file stays ASCII.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\verify-install.ps1 [-Keep]

$ErrorActionPreference = 'Stop'
$Keep = $args -contains '-Keep'

$Root = Split-Path -Parent $PSScriptRoot
$failures = New-Object System.Collections.Generic.List[string]

function Check {
  param([string]$Label, [bool]$Ok, [string]$Detail = '')
  if ($Ok) {
    Write-Host ("PASS  " + $Label + $(if ($Detail) { "  " + $Detail } else { '' })) -ForegroundColor Green
  } else {
    Write-Host ("FAIL  " + $Label + $(if ($Detail) { "  " + $Detail } else { '' })) -ForegroundColor Red
    $failures.Add($Label)
  }
}

function HashOf {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

Write-Host '== verify installer ==' -ForegroundColor Cyan

# --- build + extract --------------------------------------------------------
Push-Location $Root
try {
  & node scripts\make-dist.mjs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'make-dist failed' }
} finally { Pop-Location }

$version = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
$zip = Join-Path $Root ("dist\amadeus-codex-" + $version + ".zip")
if (-not (Test-Path $zip)) { throw "zip not found: $zip" }

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("amadeus-install-check-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force

$app = Join-Path $stage ("amadeus-codex-" + $version)
if (-not (Test-Path $app)) { throw "unexpected archive layout in $stage" }

$env:CODEX_HOME = Join-Path $stage 'codexhome'
$env:AMADEUS_DATA_DIR = Join-Path $stage 'data'
New-Item -ItemType Directory -Force -Path $env:CODEX_HOME | Out-Null

# Redirect APPDATA so the autostart shortcut lands inside the sandbox instead of
# the real Startup folder.
$env:APPDATA = Join-Path $stage 'appdata'
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
New-Item -ItemType Directory -Force -Path $startup | Out-Null
$watchLnk = Join-Path $startup 'Amadeus Panel.lnk'

$cfg = Join-Path $env:CODEX_HOME 'config.toml'
$seed = "# user comment`n[model_providers.custom]`nname = ""zh test: D:\folder\path""`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($cfg, $seed, $utf8NoBom)

$installer = Join-Path $app 'scripts\install.ps1'

function CountEntry { return (Select-String -Path $cfg -Pattern '^\[mcp_servers\.amadeus\]' -AllMatches).Count }
function ReadCfg { return [System.IO.File]::ReadAllText($cfg) }

Write-Host ''
Write-Host '--- 1) fresh install ---'
& powershell -ExecutionPolicy Bypass -File $installer -NoStart | Out-Null
Check 'fresh install exits 0' ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
Check 'exactly one registration' ((CountEntry) -eq 1) "entries=$(CountEntry)"
Check 'existing config kept' ((ReadCfg) -match 'model_providers\.custom')
Check 'non-ascii config survives' ((ReadCfg) -match 'zh test')
Check 'backup created' ((Get-ChildItem $env:CODEX_HOME -Filter 'config.toml.bak-amadeus-*').Count -ge 1)
Check 'autostart shortcut created' (Test-Path $watchLnk)
Check 'MCP auto-open enabled' (Test-Path (Join-Path $env:AMADEUS_DATA_DIR 'runtime\mcp-auto-open'))
Check 'watcher shim written' (Test-Path (Join-Path $app 'Amadeus-watch.vbs'))
$watchBody = [System.IO.File]::ReadAllText((Join-Path $app 'Amadeus-watch.vbs'))
Check 'watcher shim is relocatable' ($watchBody.Contains('WScript.ScriptFullName') -and -not $watchBody.Contains($stage))
Check 'watcher shim supervises node' ($watchBody.Contains('0, True') -and $watchBody.Contains('WScript.Sleep 5000'))
Check 'connector launcher built' (Test-Path (Join-Path $app 'Amadeus.exe'))

Write-Host ''
Write-Host '--- 2) re-install is idempotent ---'
& powershell -ExecutionPolicy Bypass -File $installer -NoStart | Out-Null
Check 're-install exits 0' ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
Check 'still exactly one registration' ((CountEntry) -eq 1) "entries=$(CountEntry)"
& powershell -ExecutionPolicy Bypass -File $installer -NoStart -NoAutoStart | Out-Null
Check 'NoAutoStart removes both auto-open paths' ((-not (Test-Path $watchLnk)) -and (-not (Test-Path (Join-Path $env:AMADEUS_DATA_DIR 'runtime\mcp-auto-open'))))
& powershell -ExecutionPolicy Bypass -File $installer -NoStart | Out-Null
Check 'autostart can be re-enabled' ((Test-Path $watchLnk) -and (Test-Path (Join-Path $env:AMADEUS_DATA_DIR 'runtime\mcp-auto-open')))

Write-Host ''
Write-Host '--- 3) incomplete package is refused without touching config ---'
$before = HashOf $cfg
$victim = Join-Path $app 'native\panel.py'
Move-Item -LiteralPath $victim -Destination "$victim.renamed" -Force
try {
  & powershell -ExecutionPolicy Bypass -File $installer -NoStart | Out-Null
  Check 'preflight fails the install' ($LASTEXITCODE -eq 1) "exit=$LASTEXITCODE"
  Check 'config untouched on failure' ((HashOf $cfg) -eq $before)
} finally {
  Move-Item -LiteralPath "$victim.renamed" -Destination $victim -Force
}

Write-Host ''
Write-Host '--- 4) marketplace registration ---'
function CountSection {
  param([string]$Pattern)
  return (Select-String -Path $cfg -Pattern $Pattern -AllMatches).Count
}
& powershell -ExecutionPolicy Bypass -File $installer -Marketplace -NoStart | Out-Null
Check 'marketplace install exits 0' ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
Check 'marketplace section written' ((CountSection '^\[marketplaces\.amadeus\]') -eq 1) "n=$(CountSection '^\[marketplaces\.amadeus\]')"
Check 'plugin enable section written' ((CountSection '^\[plugins\."amadeus@amadeus"\]') -eq 1) "n=$(CountSection '^\[plugins\."amadeus@amadeus"\]')"
Check 'mcp section still present once' ((CountEntry) -eq 1) "entries=$(CountEntry)"
& powershell -ExecutionPolicy Bypass -File $installer -Marketplace -NoStart | Out-Null
Check 'marketplace re-install is idempotent' ((CountSection '^\[marketplaces\.amadeus\]') -eq 1)

$codexCli = (Get-Command codex -ErrorAction SilentlyContinue).Source
if ($codexCli) {
  $mkt = Join-Path $app '.agents\plugins\marketplace.json'
  Check 'package ships the marketplace manifest' (Test-Path $mkt)
  # The CLI parses config.toml strictly, and the fixture above is deliberately
  # hostile (an unescaped Windows path in a TOML basic string). Register into a
  # fresh home for the CLI check so it tests our manifest, not the fixture.
  $previousHome = $env:CODEX_HOME
  $env:CODEX_HOME = Join-Path $stage 'clihome'
  New-Item -ItemType Directory -Force -Path $env:CODEX_HOME | Out-Null
  # The CLI warns on stderr when CODEX_HOME is a temp dir, and native stderr
  # output is a terminating error while ErrorActionPreference is Stop.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & powershell -ExecutionPolicy Bypass -File $installer -Marketplace -NoStart | Out-Null
    $listed = & $codexCli plugin list --available --json 2>$null | Out-String
    $cliExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
    $env:CODEX_HOME = $previousHome
  }
  Check 'codex CLI listed plugins' ($cliExit -eq 0) "exit=$cliExit"
  Check 'codex sees amadeus@amadeus' ($listed -match 'amadeus@amadeus') "cli=$codexCli"
} else {
  Write-Host 'SKIP  codex CLI not on PATH; marketplace manifest validated by tests only' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '--- 5) uninstall ---'
& powershell -ExecutionPolicy Bypass -File $installer -Uninstall | Out-Null
Check 'uninstall exits 0' ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
Check 'registration removed' ((CountEntry) -eq 0) "entries=$(CountEntry)"
Check 'autostart shortcut removed' (-not (Test-Path $watchLnk))
Check 'marketplace section removed' ((CountSection '^\[marketplaces\.amadeus\]') -eq 0)
Check 'plugin enable section removed' ((CountSection '^\[plugins\."amadeus@amadeus"\]') -eq 0)
Check 'data directory kept' (Test-Path $env:AMADEUS_DATA_DIR)
Check 'non-ascii config still intact' ((ReadCfg) -match 'zh test')

# --- cleanup ----------------------------------------------------------------
if (-not $Keep) {
  try { Remove-Item -LiteralPath $stage -Recurse -Force } catch { }
}

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host 'all installer checks passed' -ForegroundColor Green
  exit 0
}
Write-Host ("installer checks failed: " + ($failures -join '; ')) -ForegroundColor Red
exit 1
