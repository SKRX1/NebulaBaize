"""Web search MCP server.

方案A（双保险 + scheme 驱动分派）：
  * 主路径：cn.bing.com / www.bing.com 直连（实测可达，不依赖代理）。
  * 回退路径：主路径失败时，若配置了代理（环境变量 STRATA_PROXY /
    HTTPS_PROXY / HTTP_PROXY / ALL_PROXY，形如 socks5://127.0.0.1:10808 或
    http://127.0.0.1:7890），则走代理重试；
    回退同时支持 Bing 与 DuckDuckGo。PySocks 缺失时 socks 回退自动跳过（仅直连 Bing）。

代理 scheme 分派：
  socks5:// / socks5h:// / socks4:// / socks4a:// → sockshandler.SocksiPyHandler（PySocks）
  http:// / https://                              → urllib.request.ProxyHandler（标准库原生）
  host:port（裸地址）                              → 默认按 SOCKS5 处理（向后兼容）

代理设置由前端 Tools 页的代理卡写入 mcp_servers.json 的 websearch env 块，
executor 启动子进程时通过 _child_env() 叠加进 os.environ，本进程继承后生效。
"""
from __future__ import annotations

import html as _htmlmod
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import base64
import subprocess
from _mcp_base import McpServerBase


# ── 搜索通道 UA：命令行工具 UA 触发 Bing 服务端渲染（SSR）──────────────────
# 实测坐实（2026-11）：urllib 发 Mozilla/5.0（"能跑 JS 的现代浏览器"）抓 Bing，
# Bing 返回 JS-only SPA 壳页（结果靠前端异步填，DOM 里 b_algo=0），urllib 不跑 JS
# 所以解析器拿不到结果节点 → 表现为"中文查询被污染/无结果"。换成命令行工具 UA
# (curl/...) 会让 Bing 返回 SSR 页（b_algo=10），中文查询直接命中真实结果。
# 故搜索通道用 _SSR_UA；下载通道 _UA 保持浏览器 UA（图床 CDN 看 Referer 防盗链）。
_SSR_UA = "curl/8.6.0"


# ── 解析器：Bing 与 DuckDuckGo 各一套（HTML 结构不同）────────────────────────
def _parse_bing(html: str):
    """Bing 结果：标题在 <h2><a href="http...">…</a></h2>，摘要在 b_caption / b_lineclamp。"""
    results = re.findall(r'<h2[^>]*>\s*<a[^>]*href="(http[^"]+)"[^>]*>(.*?)</a>', html)
    # 摘要：b_lineclamp / b_caption 里的纯文本（容错抓多条，按 URL 顺序对齐）
    snippets = re.findall(r'class="(?:b_lineclamp[^"]*|b_caption)[^"]*"[^>]*>(.*?)</p>', html, re.S)
    return results, snippets


def _parse_ddg(html: str):
    """DuckDuckGo HTML 版（仅回退走代理时使用，类名 result__a / result__snippet）。"""
    results = re.findall(r'result__a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html)
    snippets = re.findall(r'result__snippet[^>]*>(.*?)</a>', html)
    return results, snippets


def _strip(s: str) -> str:
    return re.sub("<.*?>", "", s).strip()


# Bing Images 的结果塞在 <a class="iusc" m="{...}"> 的 m 属性里：m 是 HTML 实体
# 转义过的 JSON，字段 murl=原图直链 / t=标题 / purl=来源页。
_IMG_M_RE = re.compile(r'class="iusc"[^>]*\bm="(.*?)"', re.S)


def _parse_bing_images(html: str):
    """解析 Bing Images 的 iusc 块；Bing 偶发返回无数据的精简壳页时返回空列表。"""
    out = []
    for blob in _IMG_M_RE.findall(html):
        try:
            data = json.loads(_htmlmod.unescape(blob))
        except Exception:
            print('[websearch] bad iusc json, skipped', file=sys.stderr)
            continue
        url = data.get('murl') or data.get('url') or ''
        if not url:
            continue
        out.append((url, _strip(data.get('t') or ''), data.get('purl') or ''))
    return out


# ── 拼音/罗马字品牌词陷阱（实测坐实 2026-11）──────────────────────────────
# Bing 把"白泽"的罗马字 Baize 当作品牌"毕亚兹(BIAZE)"(京东旗舰店)，搜图几乎只回
# 该品牌店招图；同坑:同音/近形罗马字若恰是注册品牌，Bing 查询理解会优先品牌而非本义。
# 这是 Bing 上游的查询理解行为(品牌词优先)，不是解析 bug。规避=用原语言词，或在罗马字
# 后加语境限定词(如 "Baize legendary beast")把意图从品牌拉回本义。词典命中→结果里追加指引。
# 键=触发品牌误读的罗马字(小写)，值=(原语言词, 误读品牌, 建议加在查询末尾的限定词)。
_BRAND_TRAPS = {
    "baize": ("\u767d\u6cfd", "BIAZE \u6bd5\u4e9a\u5179", "legendary beast"),
}

def _brand_trap_note(query):
    """查询命中已知拼音/罗马字品牌陷阱→返回一行 ASCII 指引；否则 None。"""
    toks = set(re.findall(r"[a-z]+", (query or "").lower()))
    for tok, (native, brand, qualifier) in _BRAND_TRAPS.items():
        if tok in toks:
            return ("[websearch] brand-trap hit: '%s' -> Bing reads it as the brand "
                    "%s, not the intended meaning. Re-search in the native script "
                    "'%s', or append a qualifier like '%s %s'."
                    % (tok, brand, native, tok.capitalize(), qualifier))
    return None


def _with_brand_note(args, result):
    """若查询命中拼音品牌陷阱，把指引追加到结果末尾；否则原样返回。"""
    note = _brand_trap_note(args.get("query", ""))
    return (result + "\n" + note) if note else result


def _format_images(items, count=10):
    out = []
    for url, title, purl in items[:count]:
        line = '- ' + (title or 'image') + '  ' + url
        if purl:
            line += '  (page: ' + purl + ')'
        out.append(line)
    return '\n'.join(out) if out else 'no results'


# ── 代理环境变量读取（优先级见模块 docstring）──────────────────────────────
_PROXY_ENV_ORDER = ("STRATA_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
                    "https_proxy", "http_proxy", "all_proxy")

# socks scheme → (PySocks PROXY_TYPE 属性名, 是否需要代理端解析 DNS/rdns)
# socks5/socks4 = 客户端解析 DNS（rdns=False）；socks5h/socks4a = 代理端解析（rdns=True）
_SOCKS_SCHEME_MAP = {
    "socks5":  ("PROXY_TYPE_SOCKS5", False),
    "socks5h": ("PROXY_TYPE_SOCKS5", True),
    "socks4":  ("PROXY_TYPE_SOCKS4", False),
    "socks4a": ("PROXY_TYPE_SOCKS4", True),
}
# http/https scheme（走 urllib 原生 ProxyHandler，无需 PySocks）
_HTTP_PROXY_SCHEMES = ("http", "https")


def _proxy_parts():
    """从环境变量读取代理，返回完整 proxy URL 字符串（含 scheme），无配置返回 None。

    返回值示例：
      "socks5://127.0.0.1:10808"
      "http://user:pass@127.0.0.1:7890"
    """
    raw = None
    for k in _PROXY_ENV_ORDER:
        v = (os.environ.get(k) or "").strip()
        if v:
            raw = v
            break
    if not raw:
        return None
    # 裸 host:port 默认按 socks5 处理（向后兼容）
    if "://" not in raw:
        return "socks5://" + raw
    return raw


def _scheme_of(proxy_url: str) -> str:
    """提取 scheme（小写）。"""
    return urllib.parse.urlparse(proxy_url).scheme.lower()


def _build_opener(proxy_url: str | None):
    """按 proxy scheme 构建 per-request opener，不污染全局。

    socks5/socks5h/socks4/socks4a → sockshandler.SocksiPyHandler（PySocks，位置参数）
    http/https                     → urllib.request.ProxyHandler（标准库原生）
    None                           → 默认 build_opener()（直连）
    返回 None 表示该 scheme 的后端不可用（socks 但 PySocks 缺失 / 未知 scheme）。
    """
    if not proxy_url:
        return urllib.request.build_opener()

    p = urllib.parse.urlparse(proxy_url)
    scheme = p.scheme.lower()

    if scheme in _SOCKS_SCHEME_MAP:
        try:
            import socks
            import sockshandler
        except ImportError:
            return None
        ptype_attr, rdns = _SOCKS_SCHEME_MAP[scheme]
        proxytype = getattr(socks, ptype_attr)
        host = p.hostname
        port = p.port or 1080
        user = p.username
        pwd = p.password
        # SocksiPyHandler(proxytype, proxyaddr, proxyport, rdns, username, password)
        handler = sockshandler.SocksiPyHandler(proxytype, host, port, rdns, user, pwd)
        return urllib.request.build_opener(handler)

    if scheme in _HTTP_PROXY_SCHEMES:
        proxies_dict = {"http": proxy_url, "https": proxy_url}
        handler = urllib.request.ProxyHandler(proxies_dict)
        return urllib.request.build_opener(handler)

    return None


class WebSearchServer(McpServerBase):
    name = "websearch"
    tools = [
        {"name": "search", "description": "Web search a query, return top results",
         "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}},
                         "required": ["query"]}},
        {"name": "search_images",
         "description": "Image search a query, return top image URLs (Bing Images). "
                          "CAUTION: a romanized/pinyin query that happens to be a registered brand gets hijacked by that brand "
                          "(e.g. 'Baize' -> the BIAZE audio brand, not the legend). Prefer the native script, or append a context qualifier.",
         "inputSchema": {"type": "object",
                         "properties": {"query": {"type": "string"},
                                        "count": {"type": "integer",
                                                  "description": "max results, default 10"}},
                         "required": ["query"]}},
        {"name": "download",
         "description": "Download an image/binary URL to data/uploads/search/ and return the saved local path (for inline display). Soft GC: when the cache dir exceeds MAX_BYTES it sends the OLDEST files to the Windows Recycle Bin (never a physical delete).",
         "inputSchema": {"type": "object",
                         "properties": {"url": {"type": "string"},
                                        "name": {"type": "string",
                                                   "description": "optional output filename (with extension)"},
                                        "query": {"type": "string",
                                                   "description": "the search query that produced this URL; if no name is given the file is named after this (original language, sanitized)"}},
                         "required": ["url"]}},
    ]

    def _fetch(self, url, proxy):
        """抓取一个 URL；proxy=None 直连，否则按 scheme 分派 opener（无全局污染）。"""
        req = urllib.request.Request(url, headers={"User-Agent": _SSR_UA})
        opener = _build_opener(proxy)
        if opener is None:
            # socks scheme 但 PySocks 不可用，跳过
            return None
        with opener.open(req, timeout=30) as r:
            return r.read().decode("utf-8", "replace")

    def _format(self, results, snippets):
        out = []
        for i, item in enumerate(results[:10]):
            url, title = item if isinstance(item, (tuple, list)) else ("", item)
            title = _strip(title)
            if not title:
                continue
            sn = _strip(snippets[i]) if i < len(snippets) else ""
            line = f"- {title}"
            if url:
                line += f"  {url}"
            if sn:
                line += f"  {sn}"
            out.append(line)
        return "\n".join(out) if out else "no results"

    def call_tool(self, name, args):
        if name == "download":
            return _call_download(args)
        if name == "search_images":
            return self._call_images(args)
        if name != "search":
            raise Exception(f"unknown tool: {name}")
        q = urllib.parse.quote_plus(args.get("query", ""))
        proxy = _proxy_parts()
        last_err = None

        # ── 主路径：Bing 直连（实测可达，不依赖代理）──────────────────────
        try:
            html = self._fetch(f"https://cn.bing.com/search?q={q}", proxy=None)
            res = self._format(*_parse_bing(html))
            if res != "no results":
                return res
        except Exception as e:
            last_err = e
        try:
            html = self._fetch(f"https://www.bing.com/search?q={q}", proxy=None)
            res = self._format(*_parse_bing(html))
            if res != "no results":
                return res
        except Exception as e:
            last_err = e

        # ── 回退路径：走代理（per-request opener，按 scheme 分派）───────────
        if proxy:
            # Bing via proxy
            try:
                html = self._fetch(f"https://cn.bing.com/search?q={q}", proxy=proxy)
                if html is not None:
                    res = self._format(*_parse_bing(html))
                    if res != "no results":
                        return res
            except Exception as e:
                last_err = e
            # DuckDuckGo via proxy（原 result__a 解析器）
            try:
                html = self._fetch(f"https://html.duckduckgo.com/html/?q={q}", proxy=proxy)
                if html is not None:
                    res = self._format(*_parse_ddg(html))
                    if res != "no results":
                        return res
            except Exception as e:
                last_err = e
            if last_err is not None:
                raise Exception(f"proxy fallback failed: {last_err}")

        return "no results"

    def _call_images(self, args):
        q = urllib.parse.quote_plus(args.get("query", ""))
        try:
            count = max(1, min(int(args.get("count") or 10), 35))
        except (TypeError, ValueError):
            count = 10
        proxy = _proxy_parts()

        # 主路径：直连（实测可达，稳定态一趟即 35 条）。Bing 偶发返回无数据的
        # 精简壳页（实测同查询同 UA 时而 35 时而 0），故空数据时重试一趟。
        for attempt in range(1, 3):
            hit = self._images_pass(q, count, proxy=None)
            if hit:
                return _with_brand_note(args, hit)
            if attempt < 2:
                time.sleep(1.0)

        # 回退路径：配了代理就走代理再试一趟
        if proxy:
            hit = self._images_pass(q, count, proxy)
            if hit:
                return _with_brand_note(args, hit)

        return _with_brand_note(args, "no results")

    def _images_pass(self, q, count, proxy):
        """跑一趟图片搜索（cn/www 两个 Bing 端点）；拿到数据返回字符串，否则 None。"""
        for url in ("https://cn.bing.com/images/search?q=" + q,
                    "https://www.bing.com/images/search?q=" + q):
            try:
                res = _format_images(_parse_bing_images(self._fetch(url, proxy=proxy)), count)
                if res != "no results":
                    return res
            except Exception as e:
                print(f"[websearch] images pass failed: {type(e).__name__}: {e}",
                      file=sys.stderr)
        return None

# ── 下载落盘通道（决策卡 A）：抓 URL 二进制落 data/uploads/search/，软上限送回收站 ──
_UPLOADS_SUBDIR = os.path.join("data", "uploads", "search")
_MAX_BYTES = 1024 * 1024 * 1024     # 软上限 1GB（活跃工作集，磁盘容得下）；超限把最旧文件送回收站
# 常见格式白名单（A：扩充，覆盖图片/文档/压缩包/音视频，含中文站常见类型）。
# 注意：B 之后此表仅作「已知安全类型」参考——即便不在表内，只要 URL 扩展名形状合理
# （纯字母数字 1~10）也原样落盘（见 _ext_from_url），实现「浏览器能下就能下」。
_ALLOWED_EXT = {
    # 图片
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".ico", ".svg",
    ".tif", ".tiff", ".heic", ".heif", ".jp2", ".apng",
    ".ani",   # 动画光标(RIFF ACON)：浏览器多半打不开但命名/嗅探要认得
    # 文档
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md",
    ".csv", ".rtf", ".epub", ".mobi", ".odt", ".ods", ".odp",
    # 压缩包
    ".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".zipx",
    # 音视频
    ".mp4", ".webm", ".mov", ".avi", ".mkv", ".mp3", ".m4a", ".m4v", ".wav",
    ".flac", ".ogg", ".opus", ".aac", ".wmv", ".mpg", ".mpeg",
}
# 表外扩展名的形状下限：必须纯小写字母数字、长 1~10，否则才落 .bin（畸形/超长不认）。
_EXT_SHAPE_RE = re.compile(r"^[a-z0-9]{1,10}$")
_UA = "Mozilla/5.0"
# 文件名清洗:去掉 Windows 非法字符与首尾杂质(保留扩展名)。反斜杠用双写保证源码合法。
_BAD_NAME_CHARS = '<>:"/?*|\\'

# ── MIME 兜底嗅探（2026-11）：落盘扩展名与实际内容不符时自动纠正 ─────────────────
# 容器族(office-zip/ISO-BMFF-mp4)嗅探器返回 family=全部族成员（含 canonical 本身），
# 保证「族内不动、跨族才纠正」：docx 内容是 zip 不把 .docx 改成 .zip；名 .jpg 内容是 PNG 才修 .png。
_SNIFF_FAMILY = {
    ".png":  {".png"},
    ".jpg":  {".jpg", ".jpeg"},
    ".gif":  {".gif"},
    ".webp": {".webp"},
    ".bmp":  {".bmp"},
    ".tif":  {".tif", ".tiff"},
    ".pdf":  {".pdf"},
    ".heic": {".heic", ".heif", ".avif"},
    ".mov":  {".mov", ".m4v", ".m4a", ".mp4"},
    ".wav":  {".wav"},
    ".zip":  {".zip", ".zipx", ".docx", ".xlsx", ".pptx",
                ".epub", ".odt", ".ods", ".odp"},
    ".gz":   {".gz", ".tgz"},
    ".bz2":  {".bz2"},
    ".xz":   {".xz"},
    ".7z":   {".7z"},
    ".rar":  {".rar"},
    # RIFF 族补全（2026-11）：除 WEBP/WAVE 外加 AVI(form "AVI ")/ANI(form "ACON")
    ".avi":  {".avi"},
    ".ani":  {".ani"},
}
_ISOBRAND_HEIC = {b"heic", b"heix", b"mif1", b"heim", b"heif", b"hevc", b"avif"}
_ISOBRAND_MOV  = {b"qt  "}
# 嗅探器只对「能一锤定音」的签名返回；容器族返回族代表，由 _reconcile_ext 决定要不要改
_RIFF_WEBP = 8
_RIFF_WAVE = 8
_RIFF_AVI  = 8   # RIFF form-type 固定在偏移8(RIFF+4字节size+form-type)
_RIFF_ACON = 8   # ANI 动画光标的 form-type 是 "ACON"(非 ANI)
_FTYP_OFF  = 4
_FTYP_BRAND = 8


def _cache_dir():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # servers/ -> ROOT
    return os.path.join(root, _UPLOADS_SUBDIR)


def _ext_from_url(url):
    path = urllib.parse.urlparse(url).path
    ext = os.path.splitext(path)[1].lower()   # 含点，如 ".xyz"
    bare = ext[1:]
    if not bare:
        return ""
    if ext in _ALLOWED_EXT:
        return ext
    # B「浏览器能下就能下」：表外但形状合理（纯字母数字 1~10）也原样落盘。
    if _EXT_SHAPE_RE.match(bare):
        return ext
    return ""


def _sanitize_name(name):
    """落盘文件名去脏:去首尾空白、去掉 Windows 非法字符与测试里出现的尾括号。仅 ASCII 清洗,保留扩展名。"""
    name = name.strip().strip(".").rstrip(")")
    for ch in _BAD_NAME_CHARS:
        name = name.replace(ch, "_")
    return name or "download"


def _sniff_ext(data):
    """嗅探真实类型，返回 (canonical_ext, family_set)；确信才返回，否则 (None, set())."""
    if len(data) < 16:
        return None, set()
    # 单一签名——直接返回（无歧义）
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png", _SNIFF_FAMILY[".png"]
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg", _SNIFF_FAMILY[".jpg"]
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif", _SNIFF_FAMILY[".gif"]
    if data[:2] == b"BM":
        return ".bmp", _SNIFF_FAMILY[".bmp"]
    if data[:5] == b"%PDF-":
        return ".pdf", _SNIFF_FAMILY[".pdf"]
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return ".tif", _SNIFF_FAMILY[".tif"]
    if data[:4] == b"RIFF" and data[_RIFF_WEBP:_RIFF_WEBP+4] == b"WEBP":
        return ".webp", _SNIFF_FAMILY[".webp"]
    if data[:4] == b"RIFF" and data[_RIFF_WAVE:_RIFF_WAVE+4] == b"WAVE":
        return ".wav", _SNIFF_FAMILY[".wav"]
    if data[:4] == b"RIFF" and data[_RIFF_AVI:_RIFF_AVI+4] == b"AVI ":
        return ".avi", _SNIFF_FAMILY[".avi"]
    if data[:4] == b"RIFF" and data[_RIFF_ACON:_RIFF_ACON+4] == b"ACON":
        return ".ani", _SNIFF_FAMILY[".ani"]
    if data[:2] == b"\x1f\x8b":   # gzip magic 是 2 字节（曾误配 [:4] 永假）
        return ".gz", _SNIFF_FAMILY[".gz"]
    if data[:3] == b"BZh":
        return ".bz2", _SNIFF_FAMILY[".bz2"]
    if data[:6] == b"7z\xbc\xaf\x27\x1c":
        return ".7z", _SNIFF_FAMILY[".7z"]
    if data[:8] == b"Rar!\x1a\x07\x00" or data[:7] == b"Rar!\x1a\x07\x01":
        return ".rar", _SNIFF_FAMILY[".rar"]
    # 容器族：返回族代表，family 含全部族成员，reconcile 决定要不要跨族改
    if data[:4] == b"PK\x03\x04":
        return ".zip", _SNIFF_FAMILY[".zip"]
    if len(data) >= 12 and data[_FTYP_OFF:_FTYP_OFF+4] == b"ftyp":
        brand = data[_FTYP_BRAND:_FTYP_BRAND+4]
        if brand in _ISOBRAND_HEIC:
            return ".heic", _SNIFF_FAMILY[".heic"]
        if brand in _ISOBRAND_MOV:
            return ".mov", _SNIFF_FAMILY[".mov"]
        return ".mp4", _SNIFF_FAMILY[".mov"]   # 其他 ISO-BMFF brand 归 mp4 族
    return None, set()


def _reconcile_ext(name, data):
    """如果嗅探确信且现有扩展名不在 sniffed family 里，把扩展名改成 canonical。"""
    canonical, family = _sniff_ext(data)
    if not canonical:
        return name   # 嗅不到，尊重命名（含 .bin）
    current = os.path.splitext(name)[1].lower()
    if current in family:
        return name   # 族内（含相等），尊重原扩展名，绝不误伤
    stem = os.path.splitext(name)[0]
    return stem + canonical


def _fetch_bytes(url):
    """按 URL 抓二进制 bytes（复用代理 scheme 分派）。

    补 Referer + Accept：很多图床 CDN 检查 Referer 防盗链，裸 UA 直连会被 403。
    """
    host = urllib.parse.urlparse(url).scheme + "://" + urllib.parse.urlparse(url).netloc
    req = urllib.request.Request(url, headers={
        "User-Agent": _UA, "Referer": host + "/",
        "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"})
    opener = _build_opener(_proxy_parts())
    if opener is None:
        return None
    with opener.open(req, timeout=30) as r:
        return r.read()


def _recycle(path):
    """把一个文件送 Windows 回收站（PowerShell Shell.Application COM，纯 stdlib）。

    中文路径走 -EncodedCommand（base64 UTF-16LE）——绕开"命令行 argv 传中文进 PowerShell
    被代码页吞"铁律坑。路径嵌进 PS 单引号串(单反斜杠是字面量),路径里的单引号按 PS 规则
    转成两个。绝不物理删除。
    """
    dirn = os.path.dirname(path).replace("'", "''")
    name = os.path.basename(path).replace("'", "''")
    ps = ("$sh=New-Object -ComObject Shell.Application;"
          "$rb=$sh.Namespace(10); $src=$sh.Namespace('" + dirn + "'); $it=$src.ParseName('" + name + "');"
          "if($it){$rb.MoveHere($it.Path,0x114)}")   # 0x10 no-confirm|0x100 no-ui|0x4 new-decl
    enc = base64.b64encode(ps.encode("utf-16-le")).decode("ascii")
    try:
        subprocess.run(["powershell", "-NoProfile", "-EncodedCommand", enc],
                       capture_output=True, timeout=20, stdin=subprocess.DEVNULL)
    except Exception as e:
        print("[websearch] recycle failed: %s: %s" % (type(e).__name__, e), file=sys.stderr)


def _gc(d):
    """软上限 GC：目录总字节 > _MAX_BYTES 时，按 mtime 从最旧开始送回收站，直到回到上限下。"""
    try:
        items = []
        for fn in os.listdir(d):
            fp = os.path.join(d, fn)
            if os.path.isfile(fp):
                items.append((os.path.getmtime(fp), os.path.getsize(fp), fp))
    except OSError:
        return
    total = sum(sz for _, sz, _ in items)
    if total <= _MAX_BYTES:
        return
    for _, sz, fp in sorted(items):     # 最旧优先
        if total <= _MAX_BYTES:
            break
        _recycle(fp)
        for _ in range(8):              # COM 移动是异步的，短轮询等它落地（最多 2s）
            if not os.path.exists(fp):
                total -= sz
                break
            time.sleep(0.25)
    print("[websearch] GC: cache was over %d bytes, recycled oldest to fit" % _MAX_BYTES,
          file=sys.stderr)


def _call_download(args):
    url = (args.get("url") or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        raise Exception("download needs an http(s) URL")
    name = (args.get("name") or "").strip()
    if not name:
        # 命名优先级：显式 name > 本次搜索词(原样语言，清洗非法字符) > URL basename。
        # 用户要"输入什么语言的文字就用什么语言命名"——搜索词即真相源，故未传 name 时优先用 query。
        name = (args.get("query") or "").strip()
    if not name:
        name = os.path.basename(urllib.parse.urlparse(url).path)
    name = _sanitize_name(name)
    if not os.path.splitext(name)[1]:
        name += _ext_from_url(url) or ".bin"
    d = _cache_dir()
    os.makedirs(d, exist_ok=True)
    try:
        data = _fetch_bytes(url)
    except Exception as e:
        raise Exception("fetch failed: %s: %s" % (type(e).__name__, e))
    if not data:
        raise Exception("download returned empty (socks proxy unavailable?)")
    name = _reconcile_ext(name, data)   # MIME 兜底：嗅探确信且跨族才改扩展名
    path = os.path.join(d, name)
    with open(path, "wb") as fh:
        fh.write(data)
    _gc(d)                              # 写完即查上限，超了清最旧
    return ("saved %s (%d bytes)" % (path, len(data)) +
            "\n(inlined for the chat; reference this path to display it inline)")


if __name__ == "__main__":
    sys.exit(WebSearchServer().run())
