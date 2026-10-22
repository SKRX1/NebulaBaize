# -*- coding: utf-8 -*-
# One-click rollback verification for the milestone tag.
# Checks out the tag, re-runs the FULL suite, then restores the original HEAD.
# Exit 0 only if the suite is ALL GREEN at the tag. ASCII-only prints.
import os, subprocess, sys, io

ROOT = r"E:\WorkBuddy\星云智能体\strata-agent"      # strata-agent root
WS   = r"E:\WorkBuddy\星云智能体"                  # workspace root (git root)
TAG  = "v-baseline-2026-10-22"

def git(args, cwd=WS):
    r = subprocess.run(['git', '-c', 'core.quotepath=false'] + args,
                       capture_output=True, text=True, cwd=cwd)
    return (r.stdout or '') + (r.stderr or '')

def main():
    env = dict(os.environ)
    env['STRATA_CI'] = '1'
    # capture current position so we can always restore it
    orig = git(['rev-parse', '--short', 'HEAD']).strip()
    print('ORIG HEAD = %s' % orig)

    status = git(['status', '--porcelain']).strip()
    if status:
        print('WORKING TREE NOT CLEAN -- abort (clean scratch first):')
        print(status)
        sys.exit(2)

    # verify the tag exists and dereference it
    ref = git(['rev-parse', '--short', TAG + '^{}']).strip()
    print('TAG %s -> commit %s' % (TAG, ref))

    print('CHECKING OUT TAG ...')
    co = git(['checkout', TAG])
    print(co.strip())

    ok = False
    report = ''
    try:
        r = subprocess.run(['python', os.path.join(ROOT, 'tools', 'run_tests.py')],
                           capture_output=True, text=True, cwd=ROOT, env=env, timeout=280)
        report = (r.stdout or '') + (r.stderr or '')
        ok = ('REGRESSION: ALL GREEN' in report) and (r.returncode == 0)
    except subprocess.TimeoutExpired:
        report = 'TIMEOUT'
        ok = False

    print('--- SUITE RESULT AT TAG ---')
    for line in report.splitlines():
        if ('GATE' in line or 'gate' in line or 'GREEN' in line
                or 'FAIL' in line or 'TIMEOUT' in line):
            print(line)

    # ALWAYS restore original HEAD no matter what
    print('RESTORING HEAD -> %s' % orig)
    print(git(['checkout', orig]).strip())
    post = git(['status', '--porcelain']).strip()
    print('POST-RESTORE STATUS: %s' % (post if post else '(clean)'))

    if ok:
        print('VERDICT: TAG IS A WORKING ROLLBACK POINT (ALL GREEN)')
        sys.exit(0)
    else:
        print('VERDICT: NOT GREEN AT TAG -- rollback point NOT confirmed')
        sys.exit(1)

main()
