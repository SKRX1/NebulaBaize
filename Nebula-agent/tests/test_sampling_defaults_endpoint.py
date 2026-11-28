# -*- coding: utf-8 -*-
# 方案A 门禁（后端）：用 fake-self 直接调 _api_sampling_defaults，真测 GET 兜底 / POST 白名单 /
# GET 合并三类行为，端点落盘路径用 STRATA_SAMPLING_DEFAULTS 隔离到 temp。纯离线、不依赖网络。
import io, os, sys, json, tempfile
sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RT = os.path.join(HERE, "runtime")
sys.path.insert(0, RT)
_tmp = os.path.join(tempfile.mkdtemp(), "sampling_defaults.json")
os.environ["STRATA_SAMPLING_DEFAULTS"] = _tmp

import http_server as hs  # noqa: E402

checks = 0
def ok(c, m):
    global checks
    assert c, m
    checks += 1

class FakeSelf:
    """替 BaseHTTPRequestHandler 提供 _read_json/_json：捕获响应、喂 POST body。"""
    def __init__(self, body=None):
        self._body = body or {}
        self.resp = None
    def _read_json(self):
        return self._body
    def _json(self, code, payload):
        self.resp = (code, payload)

def call(method, body=None):
    fs = FakeSelf(body)
    hs.GatewayHandler._api_sampling_defaults(fs, method)
    return fs.resp

# 1) GET 兜底（无文件）→ euler_a / simple
os.path.exists(_tmp) and os.remove(_tmp)
code, p = call("GET")
ok(code == 200, "GET code 200")
ok(p["settings"]["sampling"] == "euler_a", "GET fallback sampling=euler_a")
ok(p["settings"]["scheduler"] == "simple", "GET fallback scheduler=simple")

# 2) POST 白名单：只写 sampling/scheduler，多余键被剥离
code, p = call("POST", {"sampling": "dpm++2m", "scheduler": "karras", "junk": "x", "n": 5})
ok(code == 200, "POST code 200")
ok(p["settings"] == {"sampling": "dpm++2m", "scheduler": "karras"}, "POST strips non-whitelist")
# 落盘校验
disk = json.loads(io.open(_tmp, encoding="utf-8").read())
ok(disk == {"sampling": "dpm++2m", "scheduler": "karras"}, "disk persisted whitelist-only")

# 3) GET 读回落盘值
code, p = call("GET")
ok(p["settings"] == {"sampling": "dpm++2m", "scheduler": "karras"}, "GET returns persisted")

# 4) GET 部分缺失回落兜底（文件只有 sampling）
io.open(_tmp, "w", encoding="utf-8").write(json.dumps({"sampling": "heun"}))
code, p = call("GET")
ok(p["settings"] == {"sampling": "heun", "scheduler": "simple"}, "GET partial->fallback fills")

# 5) POST 仅一项（只换调度器）：sampling 不被 POST 覆盖（端点语义=只写提交项，未提交下次 GET 仍兜底/旧值由文件决定）
io.open(_tmp, "w", encoding="utf-8").write(json.dumps({"sampling": "heun", "scheduler": "karras"}))
code, p = call("POST", {"scheduler": "beta"})
ok(code == 200 and p["settings"] == {"scheduler": "beta"}, "POST single key 200")

# 6) POST 空对象 → 400
code, p = call("POST", {})
ok(code == 400, "POST empty -> 400")

# 7) POST 空白值被拒（strip 后空）
code, p = call("POST", {"sampling": "   "})
ok(code == 400, "POST blank -> 400")

# 8) 非法 method → 405
code, p = call("DELETE")
ok(code == 405, "bad method -> 405")

print("SAMPLING-DEFAULTS-ENDPOINT: ALL %d CHECKS PASSED" % checks)
