"""Vercel Serverless 入口：WSGI 应用，路由 /api/* 请求到 app_core"""
import json
from urllib.parse import urlparse

import app_core


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
    if method == "OPTIONS":
        return 204, None
    if method == "GET" and path.endswith("/api/health"):
        return 200, {"ok": True, "version": "token-plan-sync-fallback-v2"}
    if method == "GET" and path.endswith("/api/knowledge"):
        return 200, app_core.KB
    if method == "POST":
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
            if path.endswith("/api/token-plan-chat"):
                return 200, app_core.token_plan_chat(payload)
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
        status_text = {200: "OK", 204: "No Content", 400: "Bad Request", 404: "Not Found", 500: "Internal Server Error"}.get(status, "OK")
        headers = [
            ("Content-Type", "application/json;charset=utf-8"),
            ("Content-Length", str(len(body))),
            *cors_headers(environ),
        ]
        start_response(
            f"{status} {status_text}",
            headers,
        )
        return [body]


app = App()
