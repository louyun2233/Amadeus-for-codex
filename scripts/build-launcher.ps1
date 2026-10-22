# Build the connector launcher (Amadeus.exe) in the plugin root.
#
# Windows ships a .NET Framework C# compiler, so the launcher can be built on
# the target machine instead of shipping a binary. When the compiler is missing
# we still leave a .cmd shim behind, so "double-click to start" always works.
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

# Always refresh the shim: it is the fallback when no compiler is available.
$shim = "@echo off`r`nstart `"`" /min cmd /c `"node `"%~dp0bin\amadeus-panel.mjs`" --silent --welcome`"`r`n"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($Cmd, $shim, $utf8)

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
  Write-Host '  launcher : no C# compiler found; Amadeus.cmd written instead'
  exit 0
}

& $csc /nologo /target:winexe /out:$Exe /r:System.Windows.Forms.dll $Source | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Exe)) {
  Write-Host '  launcher : compilation failed; Amadeus.cmd written instead'
  exit 0
}

Write-Host '  launcher : Amadeus.exe built'
exit 0
