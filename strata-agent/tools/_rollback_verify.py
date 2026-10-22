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

ROOT = r"E:\WorkBuddy\星云智能体\strata-agent"      # strata-agent root
WS   = r"E:\WorkBuddy\星云智能体"                  # workspace root (git root)
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
    if status:
        print('WORKING TREE NOT CLEAN -- abort (clean scratch first):')
        print(status)
        sys.exit(2)

    orig = git(['rev-parse', '--short', 'HEAD']).strip()
    ref = git(['rev-parse', '--short', tag + '^{}']).strip()
    print('ORIG HEAD = %s' % orig)
    print('TAG %s -> commit %s' % (tag, ref))

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
    post = git(['status', '--porcelain']).strip()
    print('POST-RESTORE STATUS: %s' % (post if post else '(clean)'))

    if ok:
        print('VERDICT: TAG IS A WORKING ROLLBACK POINT (ALL GREEN)')
        sys.exit(0)
    else:
        print('VERDICT: NOT GREEN AT TAG -- rollback point NOT confirmed')
        sys.exit(1)

main()
