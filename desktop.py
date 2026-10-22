# -*- coding: utf-8 -*-
"""
水世界 · 3D 水中碰撞模拟器 —— 桌面启动器

打包成单个 exe 后：
  * 双击即用，不需要安装 Python / 浏览器插件 / 任何运行库（Windows 10/11 自带 Edge）
  * 内置一个只监听 127.0.0.1 的小型 http 服务，网页资源全部打包在 exe 内部
  * 用 Edge / Chrome 的「应用模式」打开，没有地址栏和标签页，看起来就是独立软件
  * 关掉窗口后约 1 分钟进程自动退出（靠页面心跳判断）

开发时也可以直接 python desktop.py 运行。
"""
import os
import sys
import time
import socket
import threading
import subprocess
import webbrowser
import http.server
import socketserver

APP_TAG = "waterworld-3d"
PORT_START = 8123
PORT_END = 8170
IDLE_EXIT = 150.0      # 页面心跳超时（秒）后自动退出
LAST_SEEN = time.time()
LOG_PATH = os.path.join(os.environ.get("TEMP", "."), "waterworld.log")


def log(msg):
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(time.strftime("[%H:%M:%S] ") + str(msg) + "\n")
    except Exception:
        pass


def web_root():
    """onefile 打包后资源在 sys._MEIPASS/app；开发时在当前目录"""
    if getattr(sys, "_MEIPASS", None):
        return os.path.join(sys._MEIPASS, "app")
    return os.path.dirname(os.path.abspath(__file__))


WEB_ROOT = web_root()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_ROOT, **kwargs)

    # 页面里的 .wasm / .glb 等需要正确 MIME
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update({
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".wasm": "application/wasm",
        ".json": "application/json; charset=utf-8",
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
        ".ktx2": "image/ktx2",
        ".bin": "application/octet-stream",
    })

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        global LAST_SEEN
        LAST_SEEN = time.time()
        if self.path.startswith("/__ping"):
            body = APP_TAG.encode()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                pass
            return
        try:
            super().do_GET()
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError):
            pass


class Server(socketserver.ThreadingTCPServer):
    # Windows 上 SO_REUSEADDR 会允许“抢占”别人已监听的端口（请求仍被旧进程接走），
    # 所以这里必须关掉，让端口冲突直接报错，才能往上找空闲端口。
    allow_reuse_address = (os.name != "nt")
    daemon_threads = True


def port_free(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def find_running():
    """已经在运行的实例？返回端口号"""
    tag = APP_TAG.encode()
    for port in range(PORT_START, PORT_END):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.35) as s:
                s.settimeout(0.35)
                s.sendall(b"GET /__ping HTTP/1.0\r\n\r\n")
                data = b""
                # 注意要读完整个响应：标识字符串在响应体里，位于几十字节的响应头之后
                try:
                    while len(data) < 4096:
                        chunk = s.recv(4096)
                        if not chunk:
                            break
                        data += chunk
                        if tag in data:
                            return port
                except OSError:
                    if tag in data:
                        return port
        except OSError:
            continue
    return None


def find_browser():
    """优先返回 Edge / Chrome 的可执行文件路径（用 --app 模式打开）"""
    env = os.environ
    cands = []
    for base in (env.get("ProgramFiles(x86)"), env.get("ProgramFiles"), env.get("LOCALAPPDATA")):
        if base:
            cands.append(os.path.join(base, r"Microsoft\Edge\Application\msedge.exe"))
            cands.append(os.path.join(base, r"Google\Chrome\Application\chrome.exe"))
    for p in cands:
        if os.path.isfile(p):
            return p
    return None


def launch(url):
    exe = find_browser()
    if exe:
        try:
            creation = 0
            if os.name == "nt":
                creation = subprocess.CREATE_NO_WINDOW
            subprocess.Popen(
                [exe, "--app=" + url, "--window-size=1560,940",
                 "--no-first-run", "--no-default-browser-check",
                 "--disable-features=Translate"],
                creationflags=creation,
            )
            return
        except Exception as e:
            log("browser app mode failed: %r" % (e,))
    try:
        webbrowser.open(url)
    except Exception as e:
        log("webbrowser failed: %r" % (e,))


def fatal(msg):
    log("FATAL " + msg)
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(
            None, str(msg), "水世界 · 启动失败", 0x10)
    except Exception:
        pass


def main():
    global LAST_SEEN
    no_open = "--no-open" in sys.argv
    start = time.time()
    LAST_SEEN = start

    # 已有一个实例 → 直接把它叫到前台
    running = find_running()
    if running:
        url = "http://127.0.0.1:%d/index.html" % running
        if not no_open:
            launch(url)
        return 0

    if not os.path.isfile(os.path.join(WEB_ROOT, "index.html")):
        fatal("找不到网页资源目录：\n%s" % WEB_ROOT)
        return 1

    httpd = None
    port = None
    for p in range(PORT_START, PORT_END):
        if not port_free(p):
            continue
        try:
            httpd = Server(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        fatal("没有可用端口（%d-%d 都被占用）" % (PORT_START, PORT_END))
        return 1

    url = "http://127.0.0.1:%d/index.html" % port
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    log("serving %s  root=%s" % (url, WEB_ROOT))

    if not no_open:
        launch(url)

    # 心跳监控：窗口关掉后自动退出
    while True:
        time.sleep(1.0)
        idle = time.time() - LAST_SEEN
        if idle > IDLE_EXIT and (time.time() - start) > IDLE_EXIT:
            log("idle %.0fs, exiting" % idle)
            httpd.shutdown()
            os._exit(0)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:
        import traceback
        fatal(traceback.format_exc())
        sys.exit(1)
