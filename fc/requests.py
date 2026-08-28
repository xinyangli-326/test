"""用 Python 标准库实现的微型 requests 兼容层。

阿里云函数计算的「自定义运行时」默认没有预装 requests，而 pip 安装又麻烦。
本模块只用标准库 urllib 实现本项目用到的 requests.get / requests.post，
让 app_core.py 里已有的 `import requests` 能直接命中本文件，从而做到零第三方依赖。
仅覆盖用到的接口：post/get、json= 参数、timeout、headers、status_code/text/json()/content/raise_for_status。
"""
import json as _json
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class _Response:
    def __init__(self):
        self.status_code = 0
        self.text = ""
        self.content = b""
        self.headers = {}

    def json(self):
        try:
            return _json.loads(self.text) if self.text else {}
        except Exception:
            return {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise Exception("HTTP %s: %s" % (self.status_code, self.text[:200]))


def _request(method, url, **kwargs):
    headers = dict(kwargs.get("headers") or {})
    timeout = kwargs.get("timeout", 60)
    params = kwargs.get("params")
    if params:
        url = url + ("&" if "?" in url else "?") + urlencode(params)

    body = None
    data = kwargs.get("data")
    json_body = kwargs.get("json")
    if data is not None:
        body = data if isinstance(data, (bytes, bytearray)) else str(data).encode("utf-8")
    elif json_body is not None:
        body = _json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")

    req = Request(url, data=body, method=method)
    for key, value in headers.items():
        req.add_header(key, value)

    resp = _Response()
    try:
        with urlopen(req, timeout=timeout) as raw:
            resp.status_code = getattr(raw, "status", 200)
            resp.content = raw.read()
            resp.headers = {k: v for k, v in raw.headers.items()}
    except HTTPError as error:
        resp.status_code = error.code
        resp.content = error.read() or b""
        resp.headers = {k: v for k, v in error.headers.items()} if getattr(error, "headers", None) else {}
    except URLError as error:
        resp.status_code = 0
        resp.content = b""
        resp.headers = {}

    resp.text = resp.content.decode("utf-8", "replace")
    return resp


def get(url, **kwargs):
    return _request("GET", url, **kwargs)


def post(url, **kwargs):
    return _request("POST", url, **kwargs)
