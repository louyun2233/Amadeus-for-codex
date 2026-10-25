# Build Amadeus.exe with the Windows .NET Framework compiler.
# ASCII only: Windows PowerShell 5.1 reads a BOM-less file using ANSI.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $PSScriptRoot 'launcher.cs'
$Exe = Join-Path $Root 'Amadeus.exe'
$NextExe = Join-Path $Root 'Amadeus.next.exe'
$NativeStamp = Join-Path $Root 'Amadeus.native'
$IconSource = Join-Path $PSScriptRoot 'Amadeus.ico'

if ((Test-Path $Exe) -and (Test-Path $NativeStamp) -and
    ((Get-Content $NativeStamp -Raw).Trim() -eq 'qt-opengl') -and
    (Get-Item $Exe).LastWriteTimeUtc -ge (Get-Item $Source).LastWriteTimeUtc -and
    (Get-Item $Exe).LastWriteTimeUtc -ge (Get-Item $IconSource).LastWriteTimeUtc) {
  Write-Host '  launcher : native Qt/OpenGL app is current'
  exit 0
}

$csc = Get-ChildItem -LiteralPath (Join-Path $env:WINDIR 'Microsoft.NET\Framework64') -Directory |
  Sort-Object Name -Descending |
  ForEach-Object { Join-Path $_.FullName 'csc.exe' } |
  Where-Object { Test-Path $_ } |
  Select-Object -First 1
if (-not $csc -or -not (Test-Path $IconSource)) {
  Write-Host '  launcher : compiler or icon is missing'
  exit 1
}

$compilerArgs = @('/nologo', '/platform:x64', '/target:winexe', "/out:$NextExe", '/r:System.Windows.Forms.dll', "/win32icon:$IconSource", $Source)
& $csc @compilerArgs | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $NextExe)) {
  Write-Host '  launcher : compilation failed'
  exit 1
}
try {
  Move-Item -LiteralPath $NextExe -Destination $Exe -Force -ErrorAction Stop
} catch {
  Write-Host '  launcher : close Amadeus, then re-run setup' -ForegroundColor Yellow
  exit 1
}
[System.IO.File]::WriteAllText($NativeStamp, 'qt-opengl', (New-Object System.Text.UTF8Encoding($false)))
Write-Host '  launcher : Amadeus.exe built'
exit 0
