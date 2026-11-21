import subprocess, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); PY = sys.executable
env = dict(os.environ)
env.update({
    "FS_ROOT": ROOT,
    "FS_ALLOW": os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "FS_ALLOW_FILE": os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fs_allowed_roots.txt"),
})

p = subprocess.Popen([PY, "servers/fs_server.py"], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True,
                     cwd=ROOT)

def call(obj):
    p.stdin.write(json.dumps(obj) + "\n"); p.stdin.flush()
    line = p.stdout.readline()
    return json.loads(line) if line else None

try:
    r = call({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    print("initialize:", (r.get("result", {}).get("serverInfo") if r else r))
    r = call({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    print("tools:", [t["name"] for t in (r.get("result", {}).get("tools") or [])])

    target = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "__fs_test__", "hello.txt")
    r = call({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
              "params": {"name": "write", "arguments": {"path": target, "content": "sandbox ok"}}})
    print("write allowed:", r.get("result", {}).get("content"), "| error:", r.get("error"))

    r = call({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
              "params": {"name": "write", "arguments": {"path": r"C:\Windows\__evil__.txt", "content": "x"}}})
    print("write forbidden: error=", r.get("error"), "| result=", r.get("result"))

    # dynamic FS_ALLOW_FILE test: add a path at request time
    snapshot = None
    if os.path.exists(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fs_allowed_roots.txt")):
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fs_allowed_roots.txt"), "r", encoding="utf-8") as f:
            snapshot = f.read()
    with open(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fs_allowed_roots.txt"), "w", encoding="utf-8") as f:
        f.write("E:\\temp_extra_root\n")
    r = call({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
              "params": {"name": "write", "arguments": {"path": r"E:\temp_extra_root\dynamic.txt", "content": "dyn"}}})
    print("write dynamic-allowed:", r.get("result", {}).get("content"), "| error:", r.get("error"))
finally:
    p.terminate()
    for f in [target, r"E:\temp_extra_root\dynamic.txt"]:
        try:
            if os.path.exists(f):
                os.remove(f); os.rmdir(os.path.dirname(f))
        except Exception:
            pass
    try:
        if snapshot is not None:
            with open(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fs_allowed_roots.txt"), "w", encoding="utf-8") as f:
                f.write(snapshot)
        else:
            if os.path.exists(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fs_allowed_roots.txt")):
                os.remove(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fs_allowed_roots.txt"))
    except Exception:
        pass
