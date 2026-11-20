# test_smoke_gateway_filter.ps1 -- regression lock for the artifact server-module filter in
# scripts/smoke_gateway.ps1 (the closed-source CI step "Assert the artifact really carries
# compiled servers").
#
# ROOT CAUSE it locks (CI run 44719608183, windows-only): smoke_gateway.ps1 asserted the
# build landed by listing '*_server.pyd'. That -Filter is the Win32 legacy wildcard and needs
# the file NAME to END in _server.pyd, but real Windows CPython builds carry an ABI tag --
# step 9 produces fs_server.cp313-win_amd64.pyd (ends in _win_amd64.pyd) -- so the pattern
# matched NOTHING and reported the nine already-compiled servers as missing.
#
# The fix matches on .Name with '*_server*'. This test proves, on a fake artifact dir holding
# the REAL tagged names, that all THREE candidate predicates differ:
#   OLD  -Filter '*_server.pyd'        -> 0  (the bug)
#   BAD  BaseName -like '*_server'     -> 0  (my wrong first attempt: BaseName strips only the
#                                            FINAL .pyd, leaving fs_server.cp313-win_amd64)
#   GOOD Name     -like '*_server*'    -> 9  (8 server + example; _mcp_base/config_loader/memory
#                                            correctly excluded because their names lack _server)
# The two zero counts are the load-bearing differentials: they show the shipped predicate is
# the only one that works on the real artifact names -- not a weakened always-green check.
#
# Run directly:  powershell -NoProfile -ExecutionPolicy Bypass -File test_smoke_gateway_filter.ps1
# Exit 0 == green. Pure ASCII (canary rule: a .ps1 with no BOM must not contain CJK).

$ErrorActionPreference = 'Stop'
$tmp = Join-Path $env:TEMP ('mre_filter_' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# The exact names Nuitka emits on windows (observed in CI step 9 of run 44719608183).
$names = @(
  'fs_server.cp313-win_amd64.pyd', 'shell_server.cp313-win_amd64.pyd',
  'websearch_server.cp313-win_amd64.pyd', 'memory_server.cp313-win_amd64.pyd',
  'browser_server.cp313-win_amd64.pyd', 'schedule_server.cp313-win_amd64.pyd',
  'skillhub_server.cp313-win_amd64.pyd', 'registry_server.cp313-win_amd64.pyd',
  'example_server.cp313-win_amd64.pyd',
  # non-server companions that must NOT be counted by the want-9 check:
  '_mcp_base.cp313-win_amd64.pyd', 'config_loader.cp313-win_amd64.pyd', 'memory.cp313-win_amd64.pyd'
)
foreach ($n in $names) {
  [System.IO.File]::WriteAllBytes((Join-Path $tmp $n), [byte[]](0))
}

$old   = @(Get-ChildItem -LiteralPath $tmp -Filter '*_server.pyd' -ErrorAction SilentlyContinue)
$badbn = @(Get-ChildItem -LiteralPath $tmp -Filter '*.pyd' -ErrorAction SilentlyContinue |
          Where-Object { $_.BaseName -like '*_server' })
$good  = @(Get-ChildItem -LiteralPath $tmp -Filter '*.pyd' -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -like '*_server*' })

$hasMc = @($good | Where-Object { $_.Name -like '*_mcp_base*' }).Count

Write-Output ('OLD_FILTER_COUNT='   + $old.Count   + '  (expect 0 = the original dead-spell bug)')
Write-Output ('BAD_BASENAME_COUNT=' + $badbn.Count + '  (expect 0 = the BaseName pitfall)')
Write-Output ('GOOD_NAME_COUNT='    + $good.Count  + '  (expect 9 = 8 server + example)')
Write-Output ('MCP_BASE_INCLUDED='  + $hasMc       + '  (expect 0)')

Remove-Item -LiteralPath $tmp -Recurse -Force

# Also lock that the shipped smoke_gateway.ps1 actually uses the GOOD predicate on .Name, so a
# future edit cannot silently revert to a dead-spelled or BaseName form without turning this red.
$src = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\smoke_gateway.ps1') -Raw
$usesGood = ($src -match [regex]::Escape("`$_.Name -like '*_server*'"))
# Negative lock anchored to the DATA-FETCH statement, not to any mention: the comment in
# smoke_gateway.ps1 deliberately QUOTES the bad pattern to explain why it fails, so a bare
# substring check would also hit that comment. Match only where $served = is assigned with a
# dead-spelled -Filter within the same short span (an explanatory comment has no '$served =').
# PS single-quote the literal: double quotes here would interpolate $served (empty) -> ' = '.
# Negative lock: only a REGRESSED data-fetch line would put `served =` and the dead-spelled
# -Filter on the SAME line (.NET regex '.' never spans newlines). The explanatory comment in
# smoke_gateway.ps1 quotes the bad pattern but has no `served =`, so it cannot trip this.
# '*' and '.' are escaped so the regex matches the literal pattern text.
$deadFetch = "served = .{0,120}-Filter '\*_server\.pyd'"
$noBad = -not ($src -match $deadFetch)
Write-Output ('SRC_USES_GOOD_PREDICATE=' + $usesGood + '  (expect True)')
Write-Output ('SRC_FREE_OF_DEAD_SPELL=' + $noBad + '  (expect True)')

if ($old.Count -eq 0 -and $badbn.Count -eq 0 -and $good.Count -eq 9 -and
    $hasMc -eq 0 -and $usesGood -and $noBad) {
  Write-Output 'SMOKE-GATEWAY-FILTER: ALL GREEN'
  exit 0
} else {
  Write-Output 'SMOKE-GATEWAY-FILTER: RED'
  exit 1
}
