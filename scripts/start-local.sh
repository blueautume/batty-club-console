#!/bin/zsh
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  echo '请先安装 Node.js 24 或更新版本。'
  exit 1
fi
if [ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 24')" != true ]; then
  echo '此本地版本需要 Node.js 24 或更新版本。'
  exit 1
fi
if curl -fsS http://127.0.0.1:4318/api/health >/dev/null 2>&1; then
  echo '贝蒂工作台已经启动：http://127.0.0.1:4318'
  if [ "${BATTY_NO_OPEN:-0}" != 1 ]; then open http://127.0.0.1:4318; fi
  exit 0
fi
if [ ! -d node_modules ]; then npm ci; fi
if [ ! -f dist/index.html ]; then npm run build; fi
echo '贝蒂工作台：http://127.0.0.1:4318'
mkdir -p data
nohup node --env-file-if-exists=.env --experimental-strip-types "$PWD/server/index.ts" > data/local-server.log 2>&1 &
task_server_pid=$!
echo "$task_server_pid" > data/local-server.pid
for task_attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:4318/api/health >/dev/null 2>&1; then
    echo '服务已在后台启动，可以关闭此窗口。'
    echo '停止服务：双击 停止贝蒂工作台.command'
    if [ "${BATTY_NO_OPEN:-0}" != 1 ]; then open http://127.0.0.1:4318; fi
    exit 0
  fi
  sleep 0.3
done
echo '启动未完成，请查看 data/local-server.log。'
exit 1
