import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import app_core

ROOT = Path(__file__).resolve().parent


class H(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def respond(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json;charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0].endswith("/api/knowledge"):
            self.respond(200, app_core.KB)
        else:
            super().do_GET()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) or b"{}"
            payload = json.loads(raw)
            path = self.path.split("?")[0]
            if path.endswith("/api/generate"):
                self.respond(200, {"content": app_core.generate(payload)})
            elif path.endswith("/api/poster-copy"):
                self.respond(200, app_core.poster_copy(payload))
            elif path.endswith("/api/profile"):
                self.respond(200, {"content": app_core.profile_summary(payload.get("source", ""))})
            elif path.endswith("/api/research"):
                self.respond(200, {"content": app_core.research(payload)})
            elif path.endswith("/api/sticker"):
                result = app_core.sticker(
                    str(payload.get("subject", "卡通橘猫")),
                    str(payload.get("style", "卡通萌趣")),
                )
                self.respond(200, {"image": "data:image/png;base64," + result})
            elif path.endswith("/api/poster"):
                result = app_core.poster(payload)
                self.respond(200, {"image": "data:image/png;base64," + result})
            elif path.endswith("/api/poster-learn"):
                self.respond(200, app_core.poster_learn(payload))
            elif path.endswith("/api/poster-edit"):
                self.respond(200, app_core.poster_edit(payload))
            elif path.endswith("/api/extract"):
                self.respond(200, app_core.extract(payload))
            else:
                self.send_error(404)
        except Exception as error:
            self.respond(400, {"error": str(error)})


if __name__ == "__main__":
    print("Trip MALL营销知识库：http://127.0.0.1:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), H).serve_forever()
