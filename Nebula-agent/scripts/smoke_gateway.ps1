# smoke_gateway.ps1 -- closed-source artifact startup smoke (Windows runners).
#
# Why a separate file: quoting this inline through YAML -> bash -> PowerShell is a
# three-layer escape game and the classic source of "the CI step is red but I cannot
# tell why". One file, ASCII only, one call site.
#
# What it proves, in order of cost:
#   1. the compiled binary parses its own CLI   (--help exits 0)
#   2. it really listens on a TCP port          (--serve, no upstream engine needed)
#   3. it serves the shipped, obfuscated UI     (GET / returns our HTML)
#   4. the compiled MCP modules start and answer (strict-tools ON = it refuses a
#      tool-less boot, so a clean start here IS the proof the .pyd chain works)
#
# Deliberately NOT required: any upstream inference engine. GitHub runners have no
# 8080 and no model, so we only assert the HTTP/UI/MCP layer, which is ours.

param(
    [int]$Port = 8123,
    [int]$Tries = 30
)

$ErrorActionPreference = 'Stop'
$dist = Join-Path $PSScriptRoot '..\gateway.dist'
$dist = (Resolve-Path -LiteralPath $dist).Path
$exe = Join-Path $dist 'gateway.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    Write-Output "RED: gateway.exe not found at $exe"
    exit 1
}

Write-Output "== artifact: $dist =="
# NOT -Filter '*_server.pyd': that is the Win32 legacy wildcard and needs the NAME to END
# with _server.pyd, but real Windows builds carry an ABI tag (fs_server.cp313-win_amd64.pyd
# ends in _win_amd64.pyd), so that pattern matches NOTHING and reports the nine landed .pyd
# as missing. FileInfo.BaseName strips only the FINAL .pyd, leaving a name that does NOT
# end in _server, so even a BaseName -like '*_server' matches nothing. The only predicate
# that hits the tagged names is on .Name (*_server*) -- the same
# predicate the CI bash step uses (ls *.pyd | grep server == 9). _mcp_base has no _server
# in its base name, so it is correctly excluded from the want-9 count.
$served = @(Get-ChildItem -LiteralPath $dist -Filter '*.pyd' -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -like '*_server*' })
if ($served.Count -eq 0) {
    Write-Output 'RED: no compiled *_server.pyd in the artifact (step 3b did not land)'
    exit 1
}
Write-Output ("compiled server modules: {0}" -f $served.Count)
foreach ($f in $served) { Write-Output ("   {0}" -f $f.Name) }
# A compiled build must contain no .py source at all -- that is the point of closed source.
$leftpy = @(Get-ChildItem -LiteralPath $dist -Recurse -Filter '*.py' -ErrorAction SilentlyContinue)
if ($leftpy.Count -gt 0) {
    Write-Output ("WARN: {0} .py file(s) shipped inside the artifact (should be zero)" -f $leftpy.Count)
    foreach ($f in $leftpy | Select-Object -First 5) {
        Write-Output ("   {0}" -f $f.FullName.Substring($dist.Length))
    }
}

Write-Output "== 1. CLI parses =="
$help = & $exe --help 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Write-Output "RED: --help exit=$LASTEXITCODE"; exit 1 }
if ($help -notmatch '--serve') { Write-Output 'RED: --help lacks --serve'; exit 1 }
if ($help -notmatch '--server') { Write-Output 'RED: --help lacks --server (the C-form entry)' ; exit 1 }
Write-Output 'OK: --help ok, and the binary knows --serve and --server'

Write-Output "== 2-4. --serve with STRICT_TOOLS=1 =="
# strict ON is load-bearing here: gateway refuses to boot when no MCP server yields a
# single tool (that guard was added for a real regression). So "it started" can only
# mean "the compiled .pyd servers answered the handshake" -- which is what we are testing.
$env:STRATA_STRICT_TOOLS = '1'
$env:STRATA_SELFCHECK = 'warn'
$null = New-Item -ItemType Directory -Force -Path (Join-Path $dist 'logs')
$outf = Join-Path $dist 'logs\_ci_serve_out.txt'
$errf = Join-Path $dist 'logs\_ci_serve_err.txt'
$p = Start-Process -FilePath $exe -ArgumentList @('--serve', '--port', "$Port") `
        -WorkingDirectory $dist -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $outf -RedirectStandardError $errf
$code = 1
try {
    $ok = $false
    for ($i = 1; $i -le $Tries; $i++) {
        if ($p.HasExited) { break }
        try {
            $c = New-Object System.Net.Sockets.TcpClient
            $c.Connect('127.0.0.1', $Port); $c.Close(); $ok = $true; break
        } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $ok) {
        Write-Output ("RED: never listened on {0} (exited={1} rc={2})" -f $Port, $p.HasExited, $p.ExitCode)
        if (Test-Path -LiteralPath $errf) {
            Write-Output '--- stderr ---'
            Get-Content -LiteralPath $errf -TotalCount 25 | ForEach-Object { Write-Output ("   " + $_) }
        }
        exit 1
    }
    Write-Output ("OK: listening on {0} after ~{1}s" -f $Port, (2 * $i))
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 15
        $len = $r.Content.Length
        if ($r.StatusCode -eq 200 -and $r.Content -match 'app\.js') {
            Write-Output ("OK: GET / served the artifact UI (status=200, {0} bytes, references app.js)" -f $len)
            $code = 0
        } else {
            Write-Output ("RED: GET / status={0} len={1}" -f $r.StatusCode, $len)
        }
    } catch {
        Write-Output ("RED: GET / failed: {0}" -f $_.Exception.Message)
    }
    # Ask the gateway what it actually sees: /api/models is the cheapest endpoint that
    # reports the tool/registry wiring without needing an upstream engine.
    try {
        $h = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/models" -TimeoutSec 15
        Write-Output ("INFO: /api/models status={0} len={1}" -f $h.StatusCode, $h.Content.Length)
    } catch {
        Write-Output ("INFO: /api/models not available ({0}) -- not required for this smoke" -f $_.Exception.Response.StatusCode.value__)
    }
    if (Test-Path -LiteralPath $errf) {
        Write-Output '--- stderr (selfcheck report) ---'
        Get-Content -LiteralPath $errf -TotalCount 30 | ForEach-Object { Write-Output ("   " + $_) }
    }
} finally {
    try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
    # The child spawns grandchildren (the compiled servers). They must not linger and hold
    # the artifact directory open after the runner starts compressing it.
    try {
        Get-CimInstance Win32_Process -Filter "Name='gateway.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*--server*' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch { }
}
if ($code -eq 0) { Write-Output 'SMOKE-GATEWAY: GREEN' } else { Write-Output 'SMOKE-GATEWAY: RED' }
exit $code
