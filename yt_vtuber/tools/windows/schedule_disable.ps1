# The single documented off switch. Stops any running instance and unregisters
# the job, so nothing can be generated or uploaded until it is re-enabled.
$ErrorActionPreference = "Stop"
$taskName = "VTuberShortsDaily"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Disabled and removed '$taskName'." -ForegroundColor Green
} else {
    Write-Host "'$taskName' is not registered; nothing to disable." -ForegroundColor Yellow
}
