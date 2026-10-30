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

import os
import re
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _mcp_base import McpServerBase


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
    ]

    def _fetch(self, url, proxy):
        """抓取一个 URL；proxy=None 直连，否则按 scheme 分派 opener（无全局污染）。"""
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
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


if __name__ == "__main__":
    sys.exit(WebSearchServer().run())
