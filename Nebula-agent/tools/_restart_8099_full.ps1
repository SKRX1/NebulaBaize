# Full restart chain per owner sign-off: keep ONE watchdog, kill the redundant
# watchdog, kill BOTH 8099 gateways, let the kept watchdog relaunch a fresh 8099.
# PIDs DISCOVERED AT RUNTIME, never hardcoded. ASCII-only, on-disk report.
# Must run DETACHED (Start-Process Bypass) -- killing the listener cuts this session.
param([switch]$DryRun)
$ErrorActionPreference = "SilentlyContinue"
$report = Join-Path $env:USERPROFILE "strata_snapshots\_restart_8099_full_report.txt"
$dir = Split-Path $report -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
function Log($msg) { $msg | Out-File -Encoding ascii -Append $report }
function WatchdogPids {
  $r = (Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -match 'gw_watchdog\.py' } |
    Select-Object -ExpandProperty ProcessId)
  return @($r)
}
function GatewayPids {
  $r = (Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -match 'gateway\.py' } |
    Select-Object -ExpandProperty ProcessId)
  return @($r)
}
"start $(Get-Date -Format o) dryrun=$DryRun" | Out-File -Encoding ascii $report

$wd  = WatchdogPids
$gw  = GatewayPids
Log "watchdogs discovered: $($wd -join ',')"
Log "gateways  discovered: $($gw -join ',')"
if ($wd.Count -lt 1) { Log "ABORT: no watchdog to relaunch later"; exit 1 }

# keep the OLDEST watchdog (lowest PID = first one that acquired the mutex), kill the rest
$keepWd = ($wd | Measure-Object -Minimum).Minimum
$killWd = @($wd | Where-Object { $_ -ne $keepWd })
Log "keep-watchdog: $keepWd"
Log "kill-watchdogs: $($killWd -join ',')"
Log "kill-gateways:  $($gw -join ',')"
if ($DryRun) { Log "VERDICT: DRY-RUN PASS (runtime discovery OK)"; exit 0 }

# real run (this runs DETACHED, so it survives the session cut)
foreach ($p in $killWd) { Stop-Process -Id $p -Force; Log "killed-watchdog: $p" }
Start-Sleep -Seconds 1
foreach ($p in $gw)     { Stop-Process -Id $p -Force; Log "killed-gateway: $p" }
Log "waiting for kept watchdog $keepWd to relaunch ..."
Start-Sleep -Seconds 14

$newListener = $null
foreach ($l in (netstat -ano | Select-String ":8099" | Select-String "LISTENING")) {
  $p = ($l -split '\s+')[-1]
  if ($p -match '^\d+$') { $newListener = $p }
}
Log "new-listener: $newListener"
$gwAfter = GatewayPids
Log "gateways-after: $($gwAfter -join ',')"
if ($newListener -and ($gwAfter.Count -eq 1)) { Log "VERDICT: PASS (single fresh gateway listening)" }
else { Log "VERDICT: CHECK (verify manually)" }
