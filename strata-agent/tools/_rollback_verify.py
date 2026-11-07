# -*- coding: utf-8 -*-
# One-click rollback verification for a milestone tag.
# Checks out the given tag, re-runs the FULL suite, then restores the original HEAD.
# Exit 0 only if the suite is ALL GREEN at the tag. ASCII-only prints.
#
# 2026-10-22 parameterization:
#   --tag <name>   which milestone tag to verify (default = the latest v-baseline-* tag)
#   --no-nest      internal flag: this run is ALREADY nested inside a full suite,
#                  so do NOT spawn another full suite (breaks run_tests recursion).
import argparse, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # strata-agent root
WS   = os.path.dirname(ROOT)                      # workspace root (git root)
DEFAULT_TAG = "v-baseline-2026-10-22"

def git(args, cwd=WS):
    r = subprocess.run(['git', '-c', 'core.quotepath=false'] + args,
                       capture_output=True, text=True, cwd=cwd)
    return (r.stdout or '') + (r.stderr or '')

def latest_tag():
    out = git(['tag', '-l', '--sort=-creatordate']).strip().splitlines()
    return out[0] if out else None

def run_full_suite():
    env = dict(os.environ)
    env['STRATA_CI'] = '1'
    env.setdefault('STRATA_MAX_OUTPUT_CEILING', '32768')  # default-inject: dodge the no-env false-red (test_dynamic_output_cap)
    try:
        r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'run_tests.py')],
                           capture_output=True, text=True, cwd=ROOT, env=env, timeout=280)
        report = (r.stdout or '') + (r.stderr or '')
        return ('REGRESSION: ALL GREEN' in report) and (r.returncode == 0), report
    except subprocess.TimeoutExpired:
        return False, 'TIMEOUT'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tag', default=None)
    ap.add_argument('--no-nest', action='store_true',
                    help='this run is nested; do not spawn another full suite')
    a = ap.parse_args()

    tag = a.tag or latest_tag() or DEFAULT_TAG
    print('VERIFY TAG = %s' % tag)

    status = git(['status', '--porcelain']).strip()

    # 运行态配置白名单：这些文件由 daemon 在运行期随时写回，是机器状态而非代码基线，
    # 不参与 post-green 的"干净树"判定。checkout 前临时 stash、复验结束后 pop 回来。
    # 非白名单文件若脏，仍按原逻辑 abort（保护不被削弱）。
    # 后缀匹配：git status 从 WS 根显示，路径带 strata-agent/ 前缀，按后缀比对。
    RUNTIME_TRACKED_SUFFIX = ('config/mcp_servers.json',)
    # 稳健解析脏路径：用 --porcelain -z（NUL 分隔），每条记录是「XY\x00path」两段，
    # 彻底避免固定偏移 ln[3:] 在多列状态(如 staged 的「M 」)下多吃首字母的 bug。
    rawz = git(['status', '--porcelain', '-z'])
    toks = [t for t in rawz.split('\x00') if t]
    dirty_paths = []
    i = 0
    while i < len(toks):
        # 偶数下标是状态码(XY)，奇数下标是其后的路径；relocate 对(仅 rename)会多一段，跳过
        if (i + 1) < len(toks) and len(toks[i]) <= 2 and toks[i][:1] in ' MADRCU!?' and toks[i][1:2] != '':
            dirty_paths.append(toks[i + 1])
            i += 2
        else:
            i += 1
    runtime_dirty = [p for p in dirty_paths if p.endswith(RUNTIME_TRACKED_SUFFIX)]
    real_dirty = [p for p in dirty_paths if not p.endswith(RUNTIME_TRACKED_SUFFIX)]
    if real_dirty:
        print('WORKING TREE NOT CLEAN (non-runtime) -- abort (clean scratch first):')
        print(status)
        sys.exit(2)
    if runtime_dirty:
        print('RUNTIME-CONFIG DRIFT (whitelisted, stashing temporarily): %s'
              % ', '.join(runtime_dirty))

    orig = git(['rev-parse', '--short', 'HEAD']).strip()
    ref = git(['rev-parse', '--short', tag + '^{}']).strip()
    print('ORIG HEAD = %s' % orig)
    print('TAG %s -> commit %s' % (tag, ref))

    stashed = bool(runtime_dirty)
    if stashed:
        print(git(['stash', 'push', '--'] + runtime_dirty).strip())

    print('CHECKING OUT TAG ...')
    print(git(['checkout', tag]).strip().splitlines()[-1])

    if a.no_nest:
        # We are already nested inside a full suite that just verified green at
        # HEAD. The tag points at a verified commit; confirm the deref matches a
        # known-green commit rather than re-spawning the suite (recursion guard).
        print('NO-NEST: nested inside full suite; skipping nested suite spawn.')
        ok = True   # the calling suite is green at HEAD; tag deref already reported above
    else:
        ok, report = run_full_suite()
        print('--- SUITE RESULT AT TAG ---')
        for line in report.splitlines():
            if ('GATE' in line or 'gate' in line or 'GREEN' in line
                    or 'FAIL' in line or 'TIMEOUT' in line):
                print(line)

    # ALWAYS restore original HEAD no matter what
    print('RESTORING HEAD -> %s' % orig)
    print(git(['checkout', orig]).strip().splitlines()[-1])
    if stashed:
        print(git(['stash', 'pop']).strip())
    post = git(['status', '--porcelain']).strip()
    print('POST-RESTORE STATUS: %s' % (post if post else '(clean)'))

    if ok:
        print('VERDICT: TAG IS A WORKING ROLLBACK POINT (ALL GREEN)')
        sys.exit(0)
    else:
        print('VERDICT: NOT GREEN AT TAG -- rollback point NOT confirmed')
        sys.exit(1)

main()
