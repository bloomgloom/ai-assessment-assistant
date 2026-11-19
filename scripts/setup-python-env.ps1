$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$PythonDir = Join-Path $RootDir "assessment\python"
$VenvDir = Join-Path $PythonDir ".venv"

$PythonVersion = $env:PYTHON_VERSION
if (-not $PythonVersion) {
  foreach ($Candidate in @("3.12", "3.11")) {
    try {
      py "-$Candidate" --version | Out-Null
      $PythonVersion = $Candidate
      break
    } catch {}
  }
}

if (-not $PythonVersion) {
  throw "Python 3.11 or 3.12 is required. Install one of them or set PYTHON_VERSION."
}

if (Test-Path $VenvDir) {
  Remove-Item -Recurse -Force $VenvDir
}

py "-$PythonVersion" -m venv $VenvDir
& (Join-Path $VenvDir "Scripts\python.exe") -m pip install -r (Join-Path $PythonDir "requirements.txt")
Write-Host "Python bootstrap environment ready: $VenvDir"
