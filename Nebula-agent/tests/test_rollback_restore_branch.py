# -*- coding: utf-8 -*-
# 2026-11-24 GATE: post-green rollback verify must restore to the branch we STARTED
# on, not a hardcoded 'master'. ROOT-CAUSE: _rollback_verify.py ran
# `git checkout master` in its finally-style restore; on a machine whose default
# branch is 'main' (this box) that printed "pathspec 'master' did not match",
# left HEAD detached on the temp rollback tag, and the very next commit would land
# as an orphan on a detached HEAD (main unmoved).
#
# Pure-stdlib static lock over the shipped script source (no git checkout side
# effects, CI-safe, <1s):
#   G1 the source must NOT contain a hardcoded restore-to-master ('checkout', 'master')
#      or the literal RESTORING banner "-> master";
#   G2 the source MUST record the starting branch before checkout (symbolic-ref) and
#      fall back to the original sha when detached (restore_target = _sym or orig),
#      then restore via that variable;
#   G3 LOAD-BEARING DECOY: re-introducing the hardcoded 'master' restore into an
#      in-memory copy MUST flip G1 red (proves the predicate bites, not a no-op).
import io, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.normpath(os.path.join(HERE, '..', 'tools', '_rollback_verify.py'))


def hardcoded_master(text):
    # a checkout whose target is the literal string 'master'
    if "git(['checkout', 'master'])" in text:
        return True
    # the human-readable banner still saying it restores to master
    if "RESTORING HEAD -> master" in text:
        return True
    return False


def dynamic_restore(text):
    has_sym = 'symbolic-ref' in text and "'-q', 'HEAD'" in text
    has_fallback = 'restore_target = _sym or orig' in text
    has_var_restore = "git(['checkout', restore_target])" in text
    return has_sym and has_fallback and has_var_restore


def main():
    with io.open(TARGET, 'r', encoding='utf-8') as f:
        src = f.read()

    fails = 0

    # G1
    if hardcoded_master(src):
        print('FAIL G1: hardcoded restore-to-master still present')
        fails += 1
    else:
        print('ok  G1: no hardcoded checkout-of-master')

    # G2
    if not dynamic_restore(src):
        print('FAIL G2: dynamic restore target (symbolic-ref + _sym or orig + checkout var) not found')
        fails += 1
    else:
        print('ok  G2: records starting branch, falls back to orig sha, restores via variable')

    # G3 decoy: reintroduce the defect in a copy and prove G1 turns red
    decoy = src
    decoy = decoy.replace("git(['checkout', restore_target])", "git(['checkout', 'master'])")
    decoy = decoy.replace("print('RESTORING HEAD -> %s (was %s)' % (restore_target, orig))",
                          "print('RESTORING HEAD -> master (was %s)' % orig)")
    if not hardcoded_master(decoy):
        print('FAIL G3: DECOY did not reproduce hardcoded master (predicate is a no-op)')
        fails += 1
    elif dynamic_restore(src) and dynamic_restore(decoy):
        # decoy must keep the dynamic-restore markers only because we only mutated the
        # two restore sites; assert decoy actually lost the variable-restore predicate
        print('note  G3 decoy dynamic_restore=%s (expected False: var restore removed)' % dynamic_restore(decoy))
        if dynamic_restore(decoy):
            print('FAIL G3: decoy still satisfies dynamic_restore (mutation incomplete)')
            fails += 1
    else:
        print('ok  G3: DECOY re-adds hardcoded master -> G1 predicate flips red (load-bearing)')

    if fails:
        print('ROLLBACK-RESTORE-BRANCH: %d FAILS' % fails)
        sys.exit(1)
    print('ROLLBACK-RESTORE-BRANCH: ALL GREEN (restore follows the real branch; decoy proves it bites)')


main()
