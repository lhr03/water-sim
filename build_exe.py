# -*- coding: utf-8 -*-
"""
把 water-sim 打包成单个免安装 exe。

  python build_exe.py

做的事：
  1. 从 index.html 入口递归解析 import，只保留真正用到的 vendor 文件（体积从 14MB 降到 ~1MB）
  2. 生成一个 64x64 的 ico 图标（纯代码画，无外部素材）
  3. 调 PyInstaller 打成 onefile + noconsole 的单文件 exe
输出：dist/水世界.exe
"""
import os
import re
import shutil
import struct
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(ROOT, 'build')
WEB = os.path.join(BUILD, 'web')
DIST = os.path.join(ROOT, 'dist')
ICO = os.path.join(BUILD, 'app.ico')
PY = sys.executable

RE_IMPORT = re.compile(r"""(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]""", re.S)
RE_DYN = re.compile(r"""import\s*\(\s*['"]([^'"]+)['"]\s*\)""")
RE_SCRIPT = re.compile(r"""<script[^>]+src=['"]([^'"]+)['"]""", re.I)


# ----------------------------------------------------------------- 依赖收集
def resolve(spec, base_rel):
    if spec == 'three':
        return 'vendor/three/three.module.js'
    if spec == 'cannon-es':
        return 'vendor/cannon-es.js'
    if spec.startswith('three/addons/'):
        return 'vendor/three/addons/' + spec[len('three/addons/'):]
    if spec.startswith('./') or spec.startswith('../'):
        p = os.path.normpath(os.path.join(os.path.dirname(base_rel), spec))
        return p.replace('\\', '/')
    return None


def collect(entry_html='index.html'):
    keep = set([entry_html])
    html = open(os.path.join(ROOT, entry_html), encoding='utf-8').read()
    queue = []
    for m in RE_SCRIPT.finditer(html):
        src = m.group(1).lstrip('./')
        queue.append(src)
        keep.add(src)

    seen = set()
    while queue:
        cur = queue.pop()
        if cur in seen:
            continue
        seen.add(cur)
        path = os.path.join(ROOT, cur)
        if not os.path.isfile(path):
            print('  ! 找不到依赖：' + cur)
            continue
        try:
            text = open(path, encoding='utf-8').read()
        except UnicodeDecodeError:
            continue
        specs = [m.group(1) for m in RE_IMPORT.finditer(text)]
        specs += [m.group(1) for m in RE_DYN.finditer(text)]
        for s in specs:
            r = resolve(s, cur)
            if r and os.path.isfile(os.path.join(ROOT, r)) and r not in seen:
                keep.add(r)
                queue.append(r)

    # DRACO 解码器是运行时按 URL 取的文件，不在 import 里，手工带上
    draco_dir = os.path.join(ROOT, 'vendor/three/addons/libs/draco/gltf')
    if os.path.isdir(draco_dir):
        for f in os.listdir(draco_dir):
            keep.add('vendor/three/addons/libs/draco/gltf/' + f)
    return keep


def build_web():
    if os.path.isdir(WEB):
        shutil.rmtree(WEB)
    keep = collect()
    total = 0
    for rel in sorted(keep):
        src = os.path.join(ROOT, rel)
        if not os.path.isfile(src):
            continue
        dst = os.path.join(WEB, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        total += os.path.getsize(src)
    print('  打包网页资源 %d 个文件，%.2f MB' % (len(keep), total / 1048576.0))
    return total


# ----------------------------------------------------------------- 图标
def make_ico(path):
    import math
    S = 64
    px = [[(0, 0, 0, 0)] * S for _ in range(S)]
    cx, cy, R = (S - 1) / 2.0, (S - 1) / 2.0, S / 2.0

    def wave_y(x, phase, amp, base):
        t = x / float(S)
        return base + amp * (0.55 * math.sin(t * 6.0 + phase)
                            + 0.45 * math.sin(t * 11.0 - phase * 1.7))

    for y in range(S):
        for x in range(S):
            dx, dy = x - cx, y - cy
            d = math.hypot(dx, dy)
            if d > R - 0.5:
                continue
            # 深蓝→亮蓝渐变
            t = max(0.0, min(1.0, (x + y) / (2.0 * S)))
            r = int(10 + 30 * t)
            g = int(70 + 90 * t)
            b = int(150 + 90 * t)
            # 水面亮度
            for i, (phase, amp, base) in enumerate(((0.0, 3.2, 40.0), (1.4, 2.4, 46.0), (2.6, 1.8, 51.0))):
                wy = wave_y(x, phase, amp, base)
                if abs(y - wy) < 1.5:
                    k = 0.85 if i == 0 else 0.55
                    r = int(r + (255 - r) * k)
                    g = int(g + (255 - g) * k)
                    b = int(b + (255 - b) * k)
            px[y][x] = (r, g, b, 255)

    # BMP（BGRA，自底向上）
    rows = []
    for y in range(S - 1, -1, -1):
        row = bytearray()
        for x in range(S):
            r, g, b, a = px[y][x]
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    pixels = b''.join(rows)
    and_stride = ((S + 31) // 32) * 4
    and_mask = b'\x00' * (and_stride * S)

    bmp_header = struct.pack('<IiiHHIIiiII', 40, S, S * 2, 1, 32, 0,
                             len(pixels) + len(and_mask), 0, 0, 0, 0)
    img = bmp_header + pixels + and_mask

    icondir = struct.pack('<HHH', 0, 1, 1)
    entry = struct.pack('<BBBBHHII', S, S, 0, 0, 1, 32, len(img), 22)
    with open(path, 'wb') as f:
        f.write(icondir + entry + img)
    print('  生成图标 %s (%d 字节)' % (os.path.basename(path), len(img) + 22))


# ----------------------------------------------------------------- 打包
def main():
    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(DIST, exist_ok=True)

    print('[1/3] 收集网页资源…')
    build_web()

    print('[2/3] 生成图标…')
    make_ico(ICO)

    print('[3/3] PyInstaller 打包（约 1-2 分钟）…')
    cmd = [
        PY, '-m', 'PyInstaller',
        '--noconfirm', '--clean',
        '--onefile', '--windowed',
        '--name', '水世界',
        '--icon', ICO,
        '--add-data', WEB + ';app',
        '--distpath', DIST,
        '--workpath', os.path.join(BUILD, 'pyi'),
        '--specpath', BUILD,
        'desktop.py',
    ]
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        print('打包失败，返回码 %d' % r.returncode)
        return 1

    exe = os.path.join(DIST, '水世界.exe')
    if os.path.isfile(exe):
        print('\n完成：%s  (%.1f MB)' % (exe, os.path.getsize(exe) / 1048576.0))
    return 0


if __name__ == '__main__':
    sys.exit(main())
