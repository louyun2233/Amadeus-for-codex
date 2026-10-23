# Build the native WebView2 panel host (Amadeus.exe) in the plugin root.
#
# Windows ships a .NET Framework C# compiler, so the launcher can be built on
# the target machine instead of shipping an EXE. A missing compiler is an
# explicit setup failure; the .cmd shim remains available for diagnostics.
#
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI unless the file has a
# UTF-8 BOM, and tests/dist.test.mjs enforces that this file stays ASCII.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\build-launcher.ps1

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $PSScriptRoot 'launcher.cs'
$Exe = Join-Path $Root 'Amadeus.exe'
$Cmd = Join-Path $Root 'Amadeus.cmd'
$NativeStamp = Join-Path $Root 'Amadeus.native'
$WebView = Join-Path $PSScriptRoot 'webview2'
$IconSource = Join-Path $PSScriptRoot 'Amadeus.ico'

# Keep the diagnostic shim available without making it the default UI.
$shim = "@echo off`r`nstart `"`" /min cmd /c `"node `"%~dp0bin\amadeus-panel.mjs`" --silent --welcome`"`r`n"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($Cmd, $shim, $utf8)

if ((Test-Path $IconSource) -and (Test-Path $Exe) -and (Test-Path $NativeStamp) -and
    (Get-Item $Exe).LastWriteTimeUtc -ge (Get-Item $Source).LastWriteTimeUtc -and
    (Get-Item $Exe).LastWriteTimeUtc -ge (Get-Item $IconSource).LastWriteTimeUtc -and
    (Test-Path (Join-Path $Root 'Microsoft.Web.WebView2.Core.dll')) -and
    (Test-Path (Join-Path $Root 'Microsoft.Web.WebView2.WinForms.dll')) -and
    (Test-Path (Join-Path $Root 'WebView2Loader.dll'))) {
  Write-Host '  launcher : existing WebView2 desktop app is current'
  exit 0
}

$csc = $null
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64'
if (Test-Path $framework) {
  $csc = Get-ChildItem -LiteralPath $framework -Directory |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'csc.exe' } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
}

if (-not $csc) {
  Write-Host '  launcher : no C# compiler found; native desktop window cannot be built'
  exit 1
}

if (-not (Test-Path $IconSource)) {
  Write-Host '  launcher : bundled Amadeus icon is missing'
  exit 1
}

foreach ($name in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')) {
  $from = Join-Path $WebView $name
  if (-not (Test-Path $from)) {
    Write-Host "  launcher : missing WebView2 SDK file $name"
    exit 1
  }
  $to = Join-Path $Root $name
  if (-not (Test-Path $to) -or (Get-FileHash $from).Hash -ne (Get-FileHash $to).Hash) {
    Copy-Item -LiteralPath $from -Destination $to -Force
  }
}

$CoreDll = Join-Path $Root 'Microsoft.Web.WebView2.Core.dll'
$FormsDll = Join-Path $Root 'Microsoft.Web.WebView2.WinForms.dll'
$NextExe = Join-Path $Root 'Amadeus.next.exe'
$compilerArgs = @('/nologo', '/platform:x64', '/target:winexe', "/out:$NextExe", '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', "/r:$CoreDll", "/r:$FormsDll", "/win32icon:$IconSource")
$compilerArgs += $Source
& $csc @compilerArgs | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $NextExe)) {
  Write-Host '  launcher : compilation failed; native desktop window unavailable'
  exit 1
}

try {
  Move-Item -LiteralPath $NextExe -Destination $Exe -Force -ErrorAction Stop
} catch {
  Write-Host '  launcher : close the running Amadeus window, then re-run setup' -ForegroundColor Yellow
  exit 1
}

[System.IO.File]::WriteAllText($NativeStamp, 'webview2', $utf8)

Write-Host '  launcher : Amadeus.exe built'
exit 0
