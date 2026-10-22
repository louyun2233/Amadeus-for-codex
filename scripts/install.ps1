# Amadeus for Codex - installer
#
# Registers the MCP server with Codex, prepares the data directory and starts
# the daemon.
#
# Properties this script owns:
#   - preflight: every file the runtime needs is verified before anything is
#     touched, and all missing ones are reported together
#   - atomicity: config.toml is written to a temp file and moved into place, so
#     an interrupt cannot leave a half-written config
#   - idempotency: re-running never duplicates the entry
#   - reversibility: -Uninstall removes the entry and keeps user data
#   - encoding safety: user files are read and written as explicit UTF-8
#     without a BOM, so a config containing non-ASCII survives untouched
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-NoStart]
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Marketplace
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -NoAutoStart
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall
#
# By default the installer drops a shortcut in the Startup folder that runs
# a small watcher when the user logs in. The MCP server also opens the panel
# when Codex starts, so a stopped watcher cannot prevent the next launch.
# That replaces the plugin-hook route (Codex builds differ in whether they list
# plugin hooks at all); -NoAutoStart skips it.
#
# -Marketplace additionally registers this folder as a Codex plugin marketplace
# and enables amadeus@amadeus, so Codex Desktop can manage the plugin itself
# (the MCP registration above stays as-is either way).
#
# TWO CONSTRAINTS, both learned by actually running the packaged copy:
#   1. ASCII ONLY. Windows PowerShell 5.1 reads .ps1 as system ANSI unless the
#      file starts with a UTF-8 BOM; non-ASCII text here becomes mojibake and
#      can swallow a quote into a parse error. tests/dist.test.mjs enforces it.
#   2. Never use Get-Content/Set-Content for files that may contain non-ASCII
#      (config.toml, dist-manifest.json): PS 5.1 decodes them as ANSI. Use the
#      .NET helpers below.
#   3. No param() block, so the script also survives `irm | iex`.

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$ConfigPath = Join-Path $CodexHome 'config.toml'
$McpEntry = Join-Path $Root 'bin\amadeus-mcp.mjs'
$ManifestPath = Join-Path $Root 'config\dist-manifest.json'
$DataDir = if ($env:AMADEUS_DATA_DIR) { $env:AMADEUS_DATA_DIR } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Amadeus' } else { Join-Path $env:USERPROFILE '.amadeus' }
$UsesCustomDataDir = [bool]$env:AMADEUS_DATA_DIR

$Uninstall = $args -contains '-Uninstall'
$NoStart = $args -contains '-NoStart'
$Marketplace = $args -contains '-Marketplace'
$AutoStart = -not ($args -contains '-NoAutoStart')

$StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$WatchShortcut = Join-Path $StartupDir 'Amadeus Panel.lnk'
$WatchVbs = Join-Path $Root 'Amadeus-watch.vbs'
$AutoOpenMarker = Join-Path $DataDir 'runtime\mcp-auto-open'
$QwenTaskName = 'Amadeus Qwen TTS'
$QwenWatchVbs = Join-Path $Root 'scripts\qwen-watch.vbs'

function Read-Utf8Text {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return '' }
  return [System.IO.File]::ReadAllText($Path)
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Text)
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Install-WatchEntry {
  $script = Join-Path $Root 'bin\amadeus-watch.mjs'
  if (-not (Test-Path $script)) { return 'watch script missing' }
  $body = 'Set sh = CreateObject("WScript.Shell")' + "`r`n" +
    'Set fs = CreateObject("Scripting.FileSystemObject")' + "`r`n" +
    'root = fs.GetParentFolderName(WScript.ScriptFullName)' + "`r`n" +
    'script = fs.BuildPath(fs.BuildPath(root, "bin"), "amadeus-watch.mjs")' + "`r`n" +
    'Do' + "`r`n" +
    '  sh.Run "node """ & script & """ --silent", 0, True' + "`r`n" +
    '  WScript.Sleep 5000' + "`r`n" +
    'Loop' + "`r`n"
  Write-Utf8NoBom -Path $WatchVbs -Text $body
  if (-not (Test-Path $StartupDir)) { return 'startup folder not found; run the watcher manually' }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($WatchShortcut)
    $shortcut.TargetPath = 'wscript.exe'
    $shortcut.Arguments = '"' + $WatchVbs + '"'
    $shortcut.WorkingDirectory = $Root
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Amadeus panel watcher'
    $shortcut.Save()
  } catch {
    return 'could not create the startup shortcut'
  }
  return 'ok'
}

function Remove-WatchEntry {
  $removed = $false
  if (Test-Path $WatchShortcut) {
    Remove-Item -LiteralPath $WatchShortcut -Force
    $removed = $true
  }
  if (Test-Path $WatchVbs) {
    Remove-Item -LiteralPath $WatchVbs -Force
    $removed = $true
  }
  return $removed
}

function Remove-QwenTask {
  if ($UsesCustomDataDir) { return $false }
  $task = Get-ScheduledTask -TaskName $QwenTaskName -ErrorAction SilentlyContinue
  if (-not $task) { return $false }
  if ($task.Actions.Arguments -notlike ('*' + $QwenWatchVbs + '*')) { return $false }
  Stop-ScheduledTask -TaskName $QwenTaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $QwenTaskName -Confirm:$false
  return $true
}

function Install-QwenTask {
  if ($UsesCustomDataDir) { return 'custom data directory (start Qwen manually)' }
  $configPath = Join-Path $DataDir 'qwen-service.json'
  if (-not (Test-Path $configPath)) { return 'not configured (skipped)' }
  if (-not (Test-Path $QwenWatchVbs)) { return 'watch script missing' }
  try {
    $config = Read-Utf8Text -Path $configPath | ConvertFrom-Json
    $python = [string]$config.python
    $script = [string]$config.script
    if (-not [System.IO.Path]::IsPathRooted($python) -or -not [System.IO.Path]::IsPathRooted($script)) {
      return 'configured paths must be absolute'
    }
    if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $script)) {
      return 'configured Python or launch script is missing'
    }
    $arguments = '"' + $QwenWatchVbs + '" "' + $python + '" "' + $script + '"'
    $existingTask = Get-ScheduledTask -TaskName $QwenTaskName -ErrorAction SilentlyContinue
    if ($existingTask -and $existingTask.Actions.Arguments -notlike ('*' + $QwenWatchVbs + '*')) {
      return 'task name already used by another app'
    }
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument $arguments -WorkingDirectory (Split-Path -Parent $script)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $QwenTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $QwenTaskName
    return 'local Qwen starts hidden at sign-in and restarts on exit'
  } catch {
    return 'could not register local Qwen startup task: ' + $_.Exception.Message
  }
}

function ConvertTo-TomlString {
  param([string]$Value)
  return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Parse-TomlArray {
  param([string]$Body)
  $items = New-Object System.Collections.Generic.List[string]
  $rx = [regex]'"((?:\\.|[^"\\])*)"|''([^'']*)'''
  foreach ($m in $rx.Matches($Body)) {
    if ($m.Groups[1].Success) {
      $value = $m.Groups[1].Value
      $value = $value.Replace('\"', '"').Replace('\\', '\')
      $items.Add($value)
    } else {
      $items.Add($m.Groups[2].Value)
    }
  }
  return $items
}

function Write-NotifyChainFile {
  param([System.Collections.Generic.List[string]]$Command)
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $jsonParts = @()
  for ($i = 0; $i -lt $Command.Count; $i++) {
    # Codex's computer-use notifier may wrap our hook as --previous-notify.
    # Chaining that wrapper back from our hook would recurse indefinitely.
    if ($Command[$i] -eq '--previous-notify' -and $i + 1 -lt $Command.Count -and
        $Command[$i + 1] -match 'amadeus-notify\.mjs') {
      $i++
      continue
    }
    $jsonParts += (ConvertTo-TomlString $Command[$i])
  }
  $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $json = '{ "command": [' + ($jsonParts -join ', ') + '], "savedAt": ' + $stamp + ' }'
  Write-Utf8NoBom -Path (Join-Path $DataDir 'notify-chain.json') -Text $json
}

# Codex allows exactly one `notify` command. If the user already had one, we
# keep it in notify-chain.json and point `notify` at our script, which replays
# the old command - replacing it outright would silently break their setup.
function Install-NotifyHook {
  $notifyScript = Join-Path $Root 'bin\amadeus-notify.mjs'
  if (-not (Test-Path $notifyScript)) { return 'notify script missing' }
  $text = Read-Utf8Text -Path $ConfigPath
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in ($text -split "`r?`n")) { $lines.Add($line) }
  $ours = 'notify = ["node", ' + (ConvertTo-TomlString $notifyScript) + ', "turn-ended"]'
  $changed = $false
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*notify\s*=\s*\[(.*)\]\s*$') {
      $found = $true
      $existing = Parse-TomlArray $Matches[1]
      if ($existing.Count -ge 2 -and $existing[1] -eq $notifyScript) { return 'ok' }
      Write-NotifyChainFile -Command $existing
      $lines[$i] = $ours
      $changed = $true
    }
  }
  if (-not $found) {
    $lines.Add($ours)
    $changed = $true
  }
  if (-not $changed) { return 'ok' }
  if (Test-Path $ConfigPath) {
    Copy-Item $ConfigPath "$ConfigPath.bak-amadeus-$(Get-Date -Format yyyyMMddHHmmss)"
  }
  $tmp = "$ConfigPath.tmp-amadeus"
  Write-Utf8NoBom -Path $tmp -Text ($lines -join "`r`n")
  Move-Item -Force -LiteralPath $tmp -Destination $ConfigPath
  return 'ok'
}

function Remove-NotifyHook {
  $notifyScript = Join-Path $Root 'bin\amadeus-notify.mjs'
  $text = Read-Utf8Text -Path $ConfigPath
  if ($text -notmatch [regex]::Escape($notifyScript)) { return $false }
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in ($text -split "`r?`n")) { $lines.Add($line) }
  $chainFile = Join-Path $DataDir 'notify-chain.json'
  $restore = $null
  if (Test-Path $chainFile) {
    try {
      $chain = (Read-Utf8Text -Path $chainFile) | ConvertFrom-Json
      if ($chain.command -and $chain.command.Count -gt 0) { $restore = $chain.command }
    } catch { $restore = $null }
  }
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    if ($line -match '^\s*notify\s*=' -and $line -match [regex]::Escape($notifyScript)) {
      if ($restore) {
        $parts = @()
        foreach ($part in $restore) { $parts += (ConvertTo-TomlString $part) }
        $out.Add('notify = [' + ($parts -join ', ') + ']')
      }
      continue
    }
    $out.Add($line)
  }
  Copy-Item $ConfigPath "$ConfigPath.bak-amadeus-$(Get-Date -Format yyyyMMddHHmmss)"
  $tmp = "$ConfigPath.tmp-amadeus"
  Write-Utf8NoBom -Path $tmp -Text ($out -join "`r`n")
  Move-Item -Force -LiteralPath $tmp -Destination $ConfigPath
  return $true
}

function Remove-ConfigSections {
  param([string]$Path, [string[]]$Patterns)
  if (-not (Test-Path $Path)) { return $false }
  $text = Read-Utf8Text -Path $Path
  $lines = $text -split "`r?`n"
  $out = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  $removed = $false
  foreach ($line in $lines) {
    $isTarget = $false
    foreach ($pattern in $Patterns) {
      if ($line -match $pattern) { $isTarget = $true }
    }
    if ($isTarget) {
      $skipping = $true
      $removed = $true
      continue
    }
    if ($skipping -and $line -match '^\s*\[') { $skipping = $false }
    if (-not $skipping) { $out.Add($line) }
  }
  if (-not $removed) { return $false }
  $backup = "$Path.bak-amadeus-$(Get-Date -Format yyyyMMddHHmmss)"
  Copy-Item $Path $backup
  $tmp = "$Path.tmp-amadeus"
  Write-Utf8NoBom -Path $tmp -Text ($out -join "`r`n")
  Move-Item -Force -LiteralPath $tmp -Destination $Path
  Write-Host "  backup   : $backup"
  return $true
}

Write-Host '== Amadeus for Codex ==' -ForegroundColor Cyan

if (-not (Test-Path $ManifestPath)) {
  Write-Host "FAIL: dist manifest not found: $ManifestPath" -ForegroundColor Red
  exit 1
}

if ($Uninstall) {
  Write-Host 'Removing the MCP registration (your data is kept)...' -ForegroundColor Cyan
  if (Test-Path (Join-Path $Root 'bin\amadeus.mjs')) {
    Push-Location $Root
    try { & node bin\amadeus.mjs stop 2>&1 | Out-Null } catch { }
    finally { Pop-Location }
  }
  if (Remove-WatchEntry) {
    Write-Host '  watch    : autostart shortcut removed' -ForegroundColor Green
  } else {
    Write-Host '  watch    : nothing to remove'
  }
  if (Remove-QwenTask) {
    Write-Host '  qwen     : startup task removed' -ForegroundColor Green
  }
  if (Test-Path $AutoOpenMarker) { Remove-Item -LiteralPath $AutoOpenMarker -Force }
  if (Remove-NotifyHook) {
    Write-Host '  notify   : previous notify command restored' -ForegroundColor Green
  } else {
    Write-Host '  notify   : nothing to remove'
  }
  $sections = @(
    '^\s*\[mcp_servers\.amadeus\]\s*$',
    '^\s*\[marketplaces\.amadeus\]\s*$',
    '^\s*\[plugins\."amadeus@amadeus"\]\s*$'
  )
  if (Remove-ConfigSections -Path $ConfigPath -Patterns $sections) {
    Write-Host '  config   : removed amadeus sections (mcp / marketplace / plugin)' -ForegroundColor Green
  } else {
    Write-Host '  config   : nothing to remove'
  }
  Write-Host "  data     : kept at $DataDir" -ForegroundColor Green
  Write-Host 'Restart Codex Desktop to apply.' -ForegroundColor Green
  exit 0
}

# --- preflight --------------------------------------------------------------

$problems = New-Object System.Collections.Generic.List[string]
$nodeVersion = $null

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $problems.Add('Node.js 22+ not found (node is not on PATH)')
} else {
  $nodeVersion = (& node --version).TrimStart('v')
  if ([int]($nodeVersion.Split('.')[0]) -lt 22) {
    $problems.Add("Node.js 22+ required, found $nodeVersion")
  }
}

$manifest = Read-Utf8Text -Path $ManifestPath | ConvertFrom-Json
$missing = @()
foreach ($rel in $manifest.requiredForInstall) {
  $full = Join-Path $Root ($rel -replace '/', '\')
  if (-not (Test-Path $full)) { $missing += $rel }
}
if ($missing.Count -gt 0) {
  $problems.Add("incomplete distribution: $($missing.Count) file(s) missing: " + ($missing -join ', '))
}

if ($problems.Count -gt 0) {
  Write-Host ''
  Write-Host 'Preflight failed:' -ForegroundColor Red
  foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
  Write-Host ''
  Write-Host 'Nothing was modified. Fix the problems above and re-run.' -ForegroundColor Yellow
  exit 1
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
if ($AutoStart) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $AutoOpenMarker) | Out-Null
  Write-Utf8NoBom -Path $AutoOpenMarker -Text 'enabled'
} elseif (Test-Path $AutoOpenMarker) {
  Remove-Item -LiteralPath $AutoOpenMarker -Force
}
Write-Host "  node     : $nodeVersion"
Write-Host "  data dir : $DataDir"

# --- connector launcher: double-click to start, and the panel window --------

$launcherBuilder = Join-Path $PSScriptRoot 'build-launcher.ps1'
if (Test-Path $launcherBuilder) {
  & powershell -ExecutionPolicy Bypass -File $launcherBuilder
}

if ($AutoStart) {
  $watch = Install-WatchEntry
  if ($watch -eq 'ok') {
    Write-Host '  watch    : panel opens with Codex (Startup shortcut)' -ForegroundColor Green
  } else {
    Write-Host "  watch    : $watch" -ForegroundColor Yellow
  }
  $qwen = Install-QwenTask
  Write-Host "  qwen     : $qwen"
} elseif (Remove-WatchEntry) {
  Write-Host '  watch    : automatic opening disabled' -ForegroundColor Green
}
if (-not $AutoStart -and (Remove-QwenTask)) {
  Write-Host '  qwen     : automatic startup disabled' -ForegroundColor Green
}

# --- register MCP server idempotently --------------------------------------

if (-not (Test-Path $CodexHome)) { New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null }
$existing = Read-Utf8Text -Path $ConfigPath

if ($existing -match '(?m)^\s*\[mcp_servers\.amadeus\]') {
  Write-Host '  mcp      : already registered (left as-is)'
} else {
  if (Test-Path $ConfigPath) {
    $backup = "$ConfigPath.bak-amadeus-$(Get-Date -Format yyyyMMddHHmmss)"
    Copy-Item $ConfigPath $backup
    Write-Host "  backup   : $backup"
  }
  $block = @"

[mcp_servers.amadeus]
command = "node"
args = ['$($McpEntry -replace '\\','\\')']
startup_timeout_sec = 30
"@
  $tmp = "$ConfigPath.tmp-amadeus"
  Write-Utf8NoBom -Path $tmp -Text ($existing + $block)
  Move-Item -Force -LiteralPath $tmp -Destination $ConfigPath
  Write-Host '  mcp      : registered [mcp_servers.amadeus]'
}

$notifyResult = Install-NotifyHook
if ($notifyResult -eq 'ok') {
  Write-Host '  notify   : task completion is forwarded (previous notifier kept)' -ForegroundColor Green
} else {
  Write-Host "  notify   : $notifyResult" -ForegroundColor Yellow
}

# --- optional: register the bundled plugin marketplace ---------------------

if ($Marketplace) {
  $mktManifest = Join-Path $Root '.agents\plugins\marketplace.json'
  $current = Read-Utf8Text -Path $ConfigPath
  if (-not (Test-Path $mktManifest)) {
    Write-Host '  market   : skipped (this package has no marketplace manifest)' -ForegroundColor Yellow
  } elseif ($current -match '(?m)^\s*\[marketplaces\.amadeus\]') {
    Write-Host '  market   : already registered (left as-is)'
  } elseif ($Root -match "'") {
    Write-Host '  market   : skipped (install path contains a single quote)' -ForegroundColor Yellow
  } else {
    $block = @"

[marketplaces.amadeus]
source_type = "local"
source = '$Root'

[plugins."amadeus@amadeus"]
enabled = true
"@
    $tmp = "$ConfigPath.tmp-amadeus"
    Write-Utf8NoBom -Path $tmp -Text ($current + $block)
    Move-Item -Force -LiteralPath $tmp -Destination $ConfigPath
    Write-Host '  market   : registered amadeus@amadeus' -ForegroundColor Green
  }
}

if (-not $NoStart) {
  Write-Host ''
  Write-Host 'Starting daemon...' -ForegroundColor Cyan
  Push-Location $Root
  try {
    & node bin\amadeus.mjs start
    if ($LASTEXITCODE -ne 0) {
      Write-Host ''
      Write-Host 'daemon failed to start. Diagnose with:' -ForegroundColor Yellow
      Write-Host "  node `"$Root\bin\amadeus.mjs`" doctor" -ForegroundColor Yellow
      exit 1
    }
  } finally { Pop-Location }
  Write-Host ''
  Write-Host 'Open the panel:' -ForegroundColor Green
  Write-Host "  node `"$Root\bin\amadeus.mjs`" open"
}

Write-Host ''
Write-Host 'Done. Restart Codex Desktop so it picks up the new MCP server.' -ForegroundColor Green
exit 0
