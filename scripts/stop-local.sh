#!/bin/zsh
set -e
cd "$(dirname "$0")/.."
if [ ! -f data/local-server.pid ]; then
  echo '没有找到本项目的后台服务记录。'
  exit 0
fi
task_server_pid="$(cat data/local-server.pid)"
if [[ "$task_server_pid" != <-> ]]; then
  echo '服务记录无效，请核对。'
  exit 1
fi
task_server_command="$(ps -p "$task_server_pid" -o command= 2>/dev/null || true)"
case "$task_server_command" in
  *"$PWD/server/index.ts"*)
    kill "$task_server_pid"
    rm -f data/local-server.pid
    echo '贝蒂工作台已停止，业务数据已保留。'
    ;;
  *) echo '原服务已经退出，未停止其他进程。' ;;
esac
