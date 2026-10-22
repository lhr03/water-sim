@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM 依次尝试 py / python / python3，不依赖任何本机绝对路径
where py >nul 2>nul && (
    py -3 serve.py
    goto :end
)
where python >nul 2>nul && (
    python serve.py
    goto :end
)
where python3 >nul 2>nul && (
    python3 serve.py
    goto :end
)

echo.
echo [!] 没有找到 Python。请先安装 Python 3：https://www.python.org/downloads/
echo     或者直接从 Release 下载 水世界.exe（免安装，双击即用）。
echo.

:end
pause
