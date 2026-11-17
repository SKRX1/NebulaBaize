# Restart standalone gateway 8099: kill the CURRENT listening worker, its parent
# (the launcher loop) relaunches it. PIDs are DISCOVERED AT RUNTIME (netstat + CIM),
# never hardcoded -- a previous session's snapshot PID goes stale after any process
# tree shuffle and the old hardcoded guard aborted spuriously.
# Self-contained: ASCII-only output + on-disk report + start grace.
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File _restart_8099.ps1 [-DryRun]
param([switch]$DryRun)
$ErrorActionPreference = "SilentlyContinue"
$report = "C:\Users\sk\strata_snapshots\_restart_8099_report.txt"
function Log($msg) { $msg | Out-File -Encoding ascii -Append $report }

# ---- runtime discovery: who listens on 8099 right now ----
$listener = $null
foreach ($l in (netstat -ano | Select-String ":8099" | Select-String "LISTENING")) {
    $p = ($l -split '\s+')[-1]
    if ($p -match '^\d+$') { $listener = [int]$p }
}
"start $(Get-Date -Format o)" | Out-File -Encoding ascii $report
if (-not $listener) { Log "ABORT: no listener on 8099"; exit 1 }

# ---- runtime discovery: the parent that will relaunch the worker ----
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$listener").ParentProcessId
if (-not $parent) { Log "ABORT: cannot resolve parent of $listener"; exit 1 }
Log "listener=$listener parent=$parent dryrun=$DryRun"

$pd = Get-Process -Id $parent -ErrorAction SilentlyContinue
if (-not $pd) { Log "ABORT: parent $parent not alive, no one to relaunch"; exit 1 }
Log "parent-alive: $parent ($($pd.ProcessName))"

# ---- dry-run: discovery worked, report and stop (nothing is killed) ----
if ($DryRun) { Log "VERDICT: DRY-RUN PASS (listener+parent discovered, would kill listener)"; exit 0 }

# ---- self-protection: never kill ourselves (guard applies to REAL runs only) ----
$anc = @($PID); $cur = $anc[0]
while ($cur) {
    $pp = (Get-CimInstance Win32_Process -Filter "ProcessId=$cur").ParentProcessId
    if (-not $pp -or $anc -contains $pp) { break }
    $anc += $pp; $cur = $pp
}
if ($anc -contains $listener -or $anc -contains $parent) {
    Log "ABORT: listener/parent is in our own ancestry (self-suicide) -- must run DETACHED (Start-Process Bypass)"
    exit 1
}

"grace-10s" | Out-File -Encoding ascii -Append $report
Start-Sleep -Seconds 10
Stop-Process -Id $listener -Force
Log "killed-listener: $listener"
Start-Sleep -Seconds 8

$newPid = $null
foreach ($l in (netstat -ano | Select-String ":8099" | Select-String "LISTENING")) {
    $p = ($l -split '\s+')[-1]
    if ($p -match '^\d+$') { $newPid = $p }
}
Log "new-listener: $newPid"
if ($newPid -and $newPid -ne "$listener") { Log "VERDICT: PASS (relaunched, PID changed)" }
else { Log "VERDICT: CHECK (no new distinct listener yet)" }
