# -*- coding: utf-8 -*-
# Single-point-of-failure guard: snapshot the source-of-truth serve/web/ plus the tests/
# suite plus the deployment-chain assets (2026-10-21: tests added, then the deploy chain:
# deploy_host_patch.bat + tools/apply_host_patch.py + tools/_patch_browser_resolve.py;
# 2026-10-22 §2: runtime/http_server.py added — the output-budget-ceiling backend change)
# into a zip under outputs/ (no cloud sync client detected on this box -- user drags it up).
# Layout: web files keep the bare root, tests under tests/, deploy chain under deploy/.
import os, zipfile, datetime
base = r"E:\WorkBuddy\星云智能体\strata-agent"
out = os.path.join(base, "outputs", "serve_web_backup_" + datetime.date.today().strftime("%Y%m%d") + ".zip")
n = 0
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    web = os.path.join(base, "serve", "web")
    for root, dirs, files in os.walk(web):
        for f in files:
            fp = os.path.join(root, f)
            z.write(fp, os.path.relpath(fp, web))
            n += 1
    tests = os.path.join(base, "tests")
    for root, dirs, files in os.walk(tests):
        for f in files:
            fp = os.path.join(root, f)
            z.write(fp, os.path.join("tests", os.path.relpath(fp, tests)))
            n += 1
    deploy = ["deploy_host_patch.bat", os.path.join("tools", "apply_host_patch.py"),
              os.path.join("tools", "_patch_browser_resolve.py"),
              os.path.join("tools", "_seg_scroll_baseline.py"),
              os.path.join("tools", "_semantic_summarizer_gate.py"),
              os.path.join("tools", "_archive_gate.py"),
              os.path.join("tools", "run_tests.py"),
              os.path.join("runtime", "gateway.py"),
              os.path.join("runtime", "http_server.py"),   # 2026-10-22 §2 backend: raisable output ceiling
              os.path.join("config", "mcp_servers.json"),
              os.path.join("skills", "example.yaml")]
    for d in deploy:
        fp = os.path.join(base, d)
        if os.path.exists(fp):
            z.write(fp, os.path.join("deploy", os.path.basename(d)))
            n += 1
        else:
            print("MISS-DEPLOY", d)
print("ZIP-FILES", n)
print("ZIP-SIZE", os.path.getsize(out))
print("ZIP-PATH", out)
