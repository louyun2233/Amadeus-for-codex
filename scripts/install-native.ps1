# Install the browser-free Qt/OpenGL panel in the project directory.
# Keep ASCII for Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$NativeDir = Join-Path $Root '.native-venv'
$Python = Join-Path $NativeDir 'Scripts\python.exe'

if (-not (Get-Command py.exe -ErrorAction SilentlyContinue)) {
  Write-Host '  native   : Python 3.11+ x64 is required (py.exe not found)'
  exit 1
}
$version = & py.exe -3 -c 'import sys; print(int(sys.version_info >= (3,11) and sys.maxsize > 2**32))'
if ($LASTEXITCODE -ne 0 -or $version -ne '1') {
  Write-Host '  native   : Python 3.11+ x64 is required'
  exit 1
}
if (-not (Test-Path $Python)) {
  & py.exe -3 -m venv $NativeDir
  if ($LASTEXITCODE -ne 0) { exit 1 }
}
& $Python -m pip install --disable-pip-version-check --only-binary=:all: 'PySide6-Essentials==6.12.0' 'live2d-py==1.0.0' 'PyOpenGL==3.1.10' 'pythonnet==3.2.1'
if ($LASTEXITCODE -ne 0) {
  Write-Host '  native   : dependency installation failed'
  exit 1
}
& $Python -c 'import live2d; from PySide6.QtOpenGLWidgets import QOpenGLWidget; import clr; print(1)'
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host '  native   : Qt/OpenGL panel ready'
exit 0
