@echo off
cd /d "%~dp0"
echo 正在启动 Trip MALL 本地服务（本地中转，直达阿里云，月付套餐可用）...
start "" http://127.0.0.1:8000
python server.py
pause
