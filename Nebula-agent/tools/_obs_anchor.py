import os, sys, subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPLY = "--apply" in sys.argv

# ---------- 1) app.js: poll() catch -> follow selected custom endpoint ----------
APP = os.path.join(ROOT, "serve", "web", "app.js")
OLD_P = '''  } catch (e) {
    if (++metricsFailures === 3) setPill("error", t("mon.pill.serverdown"));
  }'''
NEW_P = '''  } catch (e) {
    // The health poll measures the DEFAULT upstream (the 8080 engine). When a CUSTOM model is
    // selected, its own endpoint liveness — the same one the switcher dot uses — is what decides
    // whether a message can actually reach it, so the top pill follows the selection instead of
    // blaming a dead default upstream the message never goes through (2026-10-31).
    const sel = currentModel();
    if (sel && sel.kind === "custom" && modelOnline(sel) === true) {
      metricsFailures = 0;
      setPill("idle", t("mon.pill.endpoint"));
    } else if (++metricsFailures === 3) setPill("error", t("mon.pill.serverdown"));
  }'''

# ---------- 2) i18n.js: one new key per language (parity) ----------
I18N = os.path.join(ROOT, "serve", "web", "i18n.js")
OLD_ZH = '      "mon.pill.serverdown": "\u670d\u52a1\u5668\u4e0d\u53ef\u8fbe",'
NEW_ZH = OLD_ZH + '\n      "mon.pill.endpoint": "\u7aef\u70b9\u5728\u7ebf\uff08\u5df2\u8fde\u63a5\u6240\u9009\u6a21\u578b\uff09",'
OLD_EN = '      "mon.pill.serverdown": "Server not reachable",'
NEW_EN = OLD_EN + '\n      "mon.pill.endpoint": "Endpoint live (selected model)",'

def patch(path, pairs, label):
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    out = src
    for old, new in pairs:
        n = out.count(old)
        print("[%s] anchor hits=%d  %r" % (label, n, old[:40]))
        if n != 1:
            print("  ABORT: expected 1"); sys.exit(2)
        out = out.replace(old, new, 1)
    # node --check on the patched text (write temp, never touch original yet)
    import tempfile
    ext = os.path.splitext(path)[1]
    fd, tmp = tempfile.mkstemp(suffix=ext)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(out)
    r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
    print("  node --check:", "OK" if r.returncode == 0 else "FAIL " + (r.stderr or "")[:300])
    os.unlink(tmp)
    if r.returncode != 0:
        sys.exit(3)
    if APPLY:
        bak = path + ".bak-prefix"
        with open(bak, "w", encoding="utf-8") as f:
            f.write(src)
        with open(path, "w", encoding="utf-8") as f:
            f.write(out)
        print("  WROTE (backup %s)" % bak)
    else:
        print("  (dry-run, not written)")

patch(APP,  [(OLD_P, NEW_P)], "app.js poll")
patch(I18N, [(OLD_ZH, NEW_ZH), (OLD_EN, NEW_EN)], "i18n")
print("ALL GREEN" if APPLY else "(dry-run done)")
