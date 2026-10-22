$ErrorActionPreference = "Stop"

$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RootDir

npm install --no-audit --no-fund
npm install --prefix assessment --no-audit --no-fund
npm install --prefix assignment --no-audit --no-fund
& (Join-Path $PSScriptRoot "setup-python-env.ps1")
npm run build:windows

Write-Host ""
Write-Host "Windows build complete."
Write-Host "Output: $RootDir\release"
