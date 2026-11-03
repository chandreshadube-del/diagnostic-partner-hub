# One-time setup on Windows. Run from the project root in PowerShell.
#   powershell -ExecutionPolicy Bypass -File tools\windows\install.ps1
#
# Installs nothing silently: each external tool is fetched from its official
# vendor source and you are told what is happening.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

Write-Host "== Python 3.12 check ==" -ForegroundColor Cyan
$py = $null
foreach ($candidate in @("py -3.12", "python3.12", "python")) {
    try {
        $parts = $candidate.Split(" ")
        $v = & $parts[0] $parts[1..($parts.Length-1)] -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
        if ($v -eq "3.12") { $py = $candidate; break }
    } catch { }
}
if (-not $py) {
    throw "Python 3.12 not found. kokoro and misaki require >=3.10,<3.13. Install 3.12 from https://www.python.org/downloads/ and re-run."
}
Write-Host "using $py" -ForegroundColor Green

Write-Host "== virtual environment ==" -ForegroundColor Cyan
if (-not (Test-Path ".venv")) {
    $parts = $py.Split(" ")
    & $parts[0] $parts[1..($parts.Length-1)] -m venv .venv
}
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt

Write-Host "== Chromium for Playwright ==" -ForegroundColor Cyan
& .\.venv\Scripts\python.exe -m playwright install chromium

Write-Host "== FFmpeg ==" -ForegroundColor Cyan
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "FFmpeg not on PATH. Installing Gyan.FFmpeg via winget (official build)." -ForegroundColor Yellow
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
    Write-Host "Open a new terminal afterwards so PATH refreshes." -ForegroundColor Yellow
} else { Write-Host "ffmpeg present" -ForegroundColor Green }

Write-Host "== Ollama ==" -ForegroundColor Cyan
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "Ollama not on PATH. Install from https://ollama.com/download/windows, then run:" -ForegroundColor Yellow
    Write-Host "  ollama pull qwen2.5:7b-instruct" -ForegroundColor Yellow
    Write-Host "  ollama pull llama3.1:8b-instruct-q4_K_M" -ForegroundColor Yellow
} else { Write-Host "ollama present" -ForegroundColor Green }

Write-Host "== avatar ==" -ForegroundColor Cyan
& .\.venv\Scripts\python.exe tools\make_avatar.py

Write-Host "== next steps ==" -ForegroundColor Cyan
Write-Host "  copy config\config.example.toml config\config.toml" -ForegroundColor Yellow
Write-Host "  .venv\Scripts\python -m vtuber bootstrap   # pins the voice model, shows its licence" -ForegroundColor Yellow

Write-Host "== doctor ==" -ForegroundColor Cyan
& .\.venv\Scripts\python.exe -m vtuber doctor
