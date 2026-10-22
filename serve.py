# -*- coding: utf-8 -*-
"""本地静态服务器：ES Module + importmap 需要 http 协议，不能直接双击 html 打开。
双击 start.bat 或在命令行运行 `python serve.py` 即可，浏览器会自动打开。"""
import http.server
import socketserver
import os
import sys
import threading
import webbrowser

PORT = 8123
ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = (os.name != 'nt')
    daemon_threads = True


if __name__ == '__main__':
    try:
        httpd = Server(('127.0.0.1', PORT), Handler)
    except OSError:
        PORT = 8124
        httpd = Server(('127.0.0.1', PORT), Handler)
    url = 'http://127.0.0.1:%d/index.html' % PORT
    print('水世界模拟器已启动：' + url)
    print('关闭此窗口即可停止服务。')
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。')
