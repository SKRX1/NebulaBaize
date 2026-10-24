# Restart standalone gateway 8099: kill listening worker, watchdog parent relaunches it.
# Self-contained detached script (ASCII-only output + on-disk report + start grace).
$ErrorActionPreference = "SilentlyContinue"
$report = "C:\Users\sk\strata_snapshots\_restart_8099_report.txt"
$killPid = 21828
$watchdogPid = 19148

"start $(Get-Date -Format o)" | Out-File -Encoding ascii $report
"grace-10s" | Out-File -Encoding ascii -Append $report
Start-Sleep -Seconds 10

# verify watchdog still alive before killing worker
$wd = Get-Process -Id $watchdogPid -ErrorAction SilentlyContinue
if (-not $wd) {
    "ABORT: watchdog $watchdogPid not alive, no one to relaunch" | Out-File -Encoding ascii -Append $report
    exit 1
}
"watchdog-alive: $watchdogPid" | Out-File -Encoding ascii -Append $report

Stop-Process -Id $killPid -Force
"killed-listener: $killPid" | Out-File -Encoding ascii -Append $report
Start-Sleep -Seconds 8

# read back new listening pid on 8099
$lines = netstat -ano | Select-String ":8099" | Select-String "LISTENING"
$newPid = ""
foreach ($l in $lines) { $p = ($l -split '\s+')[-1]; if ($p -match '^\d+$') { $newPid = $p } }
"new-listener: $newPid" | Out-File -Encoding ascii -Append $report
if ($newPid -and $newPid -ne "$killPid") {
    "VERDICT: PASS (relaunched, PID changed)" | Out-File -Encoding ascii -Append $report
} else {
    "VERDICT: CHECK (no new distinct listener yet)" | Out-File -Encoding ascii -Append $report
}
