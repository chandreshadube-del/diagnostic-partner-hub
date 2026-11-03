# Create the daily job: generation starts 17:00 local, targeting an 18:00 publish.
# The machine's own time zone is used, so set Windows to Asia/Kolkata (IST) or
# adjust -At below. Run this PowerShell as the user the pipeline should run as.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskName = "VTuberShortsDaily"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$root\tools\windows\run_daily.ps1`" -Publish" `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At 17:00
# No catch-up: a missed run is a skipped day, never a backlog published at once.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable:$false `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Description "Daily AI VTuber short: generate at 17:00, publish 18:00." -Force

Write-Host "Registered '$taskName'. Disable it at any time with:" -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File tools\windows\schedule_disable.ps1" -ForegroundColor Green
