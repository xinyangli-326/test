"""阿里云函数计算(FC) HTTP 触发器入口。

采用 FC 官方支持的 `def handler(environ, start_response)` WSGI 标准入口，
与 Vercel 的 api/index.py 路由逻辑保持一致（均为 /api/* -> app_core）。

部署时在 FC 控制台把「请求处理程序」/「入口函数」填为：index.handler
"""
import json
from urllib.parse import urlparse

import app_core


# 允许跨域访问的来源白名单：只放行本站页面 + 本机调试，避免中转被第三方滥用。
# 若你换了站点域名，请把新域名加进这个集合。
ALLOWED_ORIGINS = {
    "https://xinyangli-326.github.io",
    "http://127.0.0.1:8000",
    "http://localhost:8000",
}


def cors_headers(environ):
    origin = environ.get("HTTP_ORIGIN", "")
    headers = [
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type, Authorization"),
        ("Access-Control-Max-Age", "86400"),
        ("Vary", "Origin"),
    ]
    if origin in ALLOWED_ORIGINS:
        headers.append(("Access-Control-Allow-Origin", origin))
    return headers


def route(environ):
    path = urlparse(environ.get("PATH_INFO", "")).path
    method = environ.get("REQUEST_METHOD", "GET")
    origin = environ.get("HTTP_ORIGIN", "")

    if method == "OPTIONS":
        return 204, None
    # 健康检查：兼容根路径 /、/health、以及前端用的 /api/health
    if method == "GET" and (
        path in ("/", "/health") or path.endswith("/api/health")
    ):
        return 200, {"ok": True, "version": "fc-web-token-plan-v1"}
    if method == "GET" and path.endswith("/api/knowledge"):
        return 200, app_core.knowledge_live()

    if method == "POST":
        # 跨域安全：中转只放行白名单来源，防止被第三方探测/滥用
        if origin not in ALLOWED_ORIGINS:
            return 403, {"error": "forbidden origin"}
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
            raw = environ["wsgi.input"].read(length) if length else b"{}"
            payload = json.loads(raw or b"{}")
            if path.endswith("/api/generate"):
                return 200, {"content": app_core.generate(payload)}
            if path.endswith("/api/poster-copy"):
                return 200, app_core.poster_copy(payload)
            if path.endswith("/api/profile"):
                return 200, {"content": app_core.profile_summary(payload.get("source", ""))}
            if path.endswith("/api/research"):
                return 200, {"content": app_core.research(payload)}
            if path.endswith("/api/sticker"):
                result = app_core.sticker(
                    str(payload.get("subject", "卡通橘猫")),
                    str(payload.get("style", "卡通萌趣")),
                )
                return 200, {"image": "data:image/png;base64," + result}
            if path.endswith("/api/poster"):
                result = app_core.poster(payload)
                return 200, {"image": "data:image/png;base64," + result}
            if path.endswith("/api/poster-learn"):
                return 200, app_core.poster_learn(payload)
            if path.endswith("/api/poster-edit"):
                return 200, app_core.poster_edit(payload)
            if path.endswith("/api/token-plan-image"):
                return 200, app_core.token_plan_image(payload)
            if path.endswith("/api/token-plan-image-async"):
                return 200, app_core.token_plan_image_async(payload)
            if path.endswith("/api/token-plan-image-task"):
                return 200, app_core.token_plan_image_task(payload)
            if path.endswith("/api/token-plan-chat"):
                return 200, app_core.token_plan_chat(payload)
            if path.endswith("/api/token-plan-text-async"):
                return 200, app_core.token_plan_text_async(payload)
            if path.endswith("/api/token-plan-text-task"):
                return 200, app_core.token_plan_text_task(payload)
            if path.endswith("/api/token-plan-video-create"):
                return 200, app_core.token_plan_video_create(payload)
            if path.endswith("/api/token-plan-video-get"):
                return 200, app_core.token_plan_video_get(payload)
            if path.endswith("/api/token-plan-video-refs"):
                return 200, app_core.token_plan_video_refs(payload)
            if path.endswith("/api/lark-sync"):
                return 200, app_core.lark_sync(payload)
            if path.endswith("/api/extract"):
                return 200, app_core.extract(payload)
            return 404, {"error": "not found"}
        except Exception as error:
            return 400, {"error": str(error)}
    return 404, {"error": "not found"}


class App:
    def __call__(self, environ, start_response):
        try:
            status, payload = route(environ)
            body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode()
        except Exception as error:
            body = json.dumps({"error": str(error)}, ensure_ascii=False).encode()
            status = 500
        status_text = {
            200: "OK",
            204: "No Content",
            400: "Bad Request",
            403: "Forbidden",
            404: "Not Found",
            500: "Internal Server Error",
        }.get(status, "OK")
        headers = [
            ("Content-Type", "application/json;charset=utf-8"),
            ("Content-Length", str(len(body))),
            *cors_headers(environ),
        ]
        start_response(f"{status} {status_text}", headers)
        return [body]


app = App()


def handler(environ, start_response):
    """FC HTTP 触发器的 WSGI 标准入口（请求处理程序填 index.handler）。"""
    return app(environ, start_response)
