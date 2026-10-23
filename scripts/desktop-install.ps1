# One-click Windows entry. Keep this ASCII for Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $PSScriptRoot 'install.ps1'

Write-Host '== Amadeus desktop setup ==' -ForegroundColor Cyan
Write-Host 'Step 1/3: Registering Amadeus with Codex...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -NoStart
if ($LASTEXITCODE -ne 0) { exit 1 }

Push-Location $root
try {
  Write-Host ''
  Write-Host 'Step 2/3: Starting Amadeus...'
  & node bin\amadeus.mjs start
  if ($LASTEXITCODE -ne 0) { exit 1 }

  # The model/runtime are public downloads, not the user's private voice.
  # Skip network work on a re-install if the installed assets still verify.
  $assetsReady = $false
  try {
    $verified = (& node bin\amadeus.mjs assets verify | Out-String) | ConvertFrom-Json
    $assetsReady = ($LASTEXITCODE -eq 0 -and $verified.ok -eq $true)
  } catch { }
  if (-not $assetsReady) {
    Write-Host 'Installing the character model and Live2D runtime...'
    try {
      $installed = (& node bin\amadeus.mjs assets install | Out-String) | ConvertFrom-Json
      $assetsReady = ($LASTEXITCODE -eq 0 -and $installed.ok -eq $true)
    } catch { }
    if (-not $assetsReady) {
      Write-Host 'Assets could not be downloaded. The panel can still open; use its Install Assets button later.' -ForegroundColor Yellow
    }
  } else {
    Write-Host 'Character assets are already ready.' -ForegroundColor Green
  }

  Write-Host ''
  Write-Host 'Step 3/3: Opening the panel...'
  & node bin\amadeus.mjs open
  if ($LASTEXITCODE -ne 0) { exit 1 }

  # A Startup shortcut only runs at the next sign-in. Start its supervisor now
  # as well, so opening Codex later in this same session also reconnects.
  $watch = Join-Path $root 'Amadeus-watch.vbs'
  if (Test-Path $watch) {
    $running = @(Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like ('*' + $watch + '*') })
    if ($running.Count -eq 0) {
      Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $watch + '"') -WorkingDirectory $root -WindowStyle Hidden
    }
  }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'Setup complete. Restart Codex Desktop to load Amadeus tools.' -ForegroundColor Green
Write-Host 'Voice cloning is optional and remains a separate setup step.'
exit 0
