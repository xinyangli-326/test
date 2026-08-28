"""函数计算 Web 函数（自定义运行时）启动入口。

FC 会把 HTTP 请求透传到本进程监听的端口（默认 9000，或读环境变量 FC_SERVER_PORT）。
这里用标准库 wsgiref 起一个多线程 WSGI 服务，把请求转给 index.app（中转业务逻辑）。
"""
import os
import socketserver
from wsgiref.simple_server import WSGIServer, WSGIRequestHandler, make_server

from index import app as application


class ThreadingWSGIServer(socketserver.ThreadingMixIn, WSGIServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    port = int(os.environ.get("FC_SERVER_PORT", "9000"))
    httpd = make_server(
        "0.0.0.0",
        port,
        application,
        server_class=ThreadingWSGIServer,
        handler_class=WSGIRequestHandler,
    )
    print(f"Trip MALL 中转已启动，监听 0.0.0.0:{port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
