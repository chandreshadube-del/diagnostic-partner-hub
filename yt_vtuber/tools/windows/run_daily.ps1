# What Task Scheduler runs. Generates one episode and, with -Publish, schedules it.
param([switch]$Publish)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$env:PYTHONPATH = "$root\src"
$args = @("-m", "vtuber", "daily")
if ($Publish) { $args += "--publish" }
& .\.venv\Scripts\python.exe @args
exit $LASTEXITCODE
