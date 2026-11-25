$ErrorActionPreference = "SilentlyContinue"
$report = "$env:USERPROFILE\strata_snapshots\_restart_8080_report.txt"
$lines = @()
$lines += "restart-8080 start " + (Get-Date).ToString("o")

function Get-Listener($port) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen
    if ($c) { return ($c.OwningProcess | Select-Object -First 1) } else { return $null }
}

$py = "E:\Program Files\Strata-0.2.13\.venv\Scripts\python.exe"
$srv = "E:\Program Files\Strata-0.2.13\serve\server.py"
$cfg = "E:\Program Files\Strata-0.2.13\strata-iq3_s.json"
$wd  = "E:\Program Files\Strata-0.2.13"

$old = Get-Listener 8080
$lines += ("old-listener=" + $old)

# DryRun mode: discover only, do not kill
if ($args[0] -eq "-DryRun") {
    $lines += "DRYRUN (no kill)"
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$old"
    if ($p) { $lines += ("old-cmd=" + $p.CommandLine) }
    $lines | Out-File -FilePath $report -Encoding ascii
    Write-Output "DRYRUN DONE"
    exit 0
}

# 1) kill old listener
if ($old) {
    Stop-Process -Id $old -Force
    Start-Sleep -Seconds 2
}
$killedGone = -not (Get-Listener 8080)
$lines += ("killed-listener-gone=" + $killedGone)

# 2) wait for self-heal up to 12s; if none, relaunch manually
$owner = $null
for ($i = 0; $i -lt 12; $i++) {
    $owner = Get-Listener 8080
    if ($owner) { break }
    Start-Sleep -Seconds 1
}
if (-not $owner) {
    $lines += "no-self-heal -> manual relaunch"
    Start-Process -FilePath $py -ArgumentList @($srv, "--engine", "strata", "--config", $cfg, "--port", "8080") -WorkingDirectory $wd -WindowStyle Hidden
    for ($i = 0; $i -lt 20; $i++) {
        $owner = Get-Listener 8080
        if ($owner) { break }
        Start-Sleep -Seconds 1
    }
}
$lines += ("new-listener=" + $owner)
$lines += ("PID-CHANGE: " + $(if ($owner -and $owner -ne $old) { "PASS" } else { "CHECK" }))

# 3) worker-up probe via /health
$up = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:8080/health" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $up = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
}
$lines += ("worker-up=" + $up + " after-probe")

# 4) cache-validator probe on /web/app.js (curl-like via .NET, 304 may throw -- tolerated)
try {
    $r2 = Invoke-WebRequest -Uri "http://127.0.0.1:8080/web/app.js" -UseBasicParsing -TimeoutSec 5
    $etag = $r2.Headers["ETag"]
    $lm = $r2.Headers["Last-Modified"]
    $cc = $r2.Headers["Cache-Control"]
    $lines += ("WEB-GET status=" + $r2.StatusCode + " ETag=" + $etag + " Last-Modified=" + $lm + " Cache-Control=" + $cc)
} catch {
    $lines += "WEB-GET-ERR " + $_.Exception.Message
}
if ($etag) {
    try {
        $r3 = Invoke-WebRequest -Uri "http://127.0.0.1:8080/web/app.js" -Headers @{ "If-None-Match" = $etag } -UseBasicParsing -TimeoutSec 5
        $lines += ("WEB-REVALIDATE status=" + $r3.StatusCode + " (200=stale)")
    } catch {
        $m = $_.Exception.Message
        if ($m -match "304") { $lines += "WEB-REVALIDATE: 304 NOT-MODIFIED (PASS, thrown as exception by .NET)" }
        else { $lines += "WEB-REVALIDATE-ERR " + $m }
    }
}
$lines | Out-File -FilePath $report -Encoding ascii
Write-Output "RESTART DONE new=$owner"
