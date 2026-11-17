import subprocess, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable
servers = {
    "filesystem": ["servers/fs_server.py"],
    "shell": ["servers/shell_server.py"],
    "websearch": ["servers/websearch_server.py"],
    "memory": ["servers/memory_server.py"],
    "browser": ["servers/browser_server.py"],
    "schedule": ["servers/schedule_server.py"],
}
env = dict(os.environ)
env.update({
    "FS_ROOT": ROOT,
    "FS_ALLOW": os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "FS_ALLOW_FILE": os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fs_allowed_roots.txt"),
})

for name, args in servers.items():
    try:
        p = subprocess.Popen([PY, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=env, text=True, cwd=ROOT)
        def call(obj):
            p.stdin.write(json.dumps(obj) + "\n"); p.stdin.flush()
            return json.loads(p.stdout.readline())
        r = call({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        info = (r.get("result", {}).get("serverInfo") if r else None)
        r = call({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = [t["name"] for t in (r.get("result", {}).get("tools") or [])]
        # drain stderr to see any startup warnings
        p.stdin.close()
        err = p.stderr.read()
        p.terminate()
        print(f"[{name}] init={info} tools={tools} stderr={err.strip()[:160]!r}")
    except Exception as e:
        print(f"[{name}] EXCEPTION: {e}")
