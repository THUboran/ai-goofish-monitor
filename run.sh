#!/bin/bash
# 闲鱼监控后端轻量启动（不重装依赖、不重建前端；venv/dist/chromium 已就绪）
# 用法: ./run.sh       前台
#       ./run.sh -d    后台
cd "$(dirname "$0")"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.pw-browsers"

if curl -s -o /dev/null --max-time 2 http://127.0.0.1:8000/ 2>/dev/null; then
  echo "✅ 后端已在运行：http://127.0.0.1:8000"; exit 0
fi

if [ "$1" = "-d" ]; then
  nohup .venv/bin/python -u -m src.app > run.log 2>&1 &
  echo "后台启动 PID=$!，等待就绪..."
  for i in $(seq 1 15); do
    sleep 2
    if curl -s -o /dev/null --max-time 2 http://127.0.0.1:8000/ 2>/dev/null; then
      echo "✅ 就绪：http://127.0.0.1:8000"; exit 0
    fi
  done
  echo "⚠️ 较慢，看 run.log"; exit 1
else
  echo "前台启动（Ctrl+C 停止）..."
  exec .venv/bin/python -u -m src.app
fi
