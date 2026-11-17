# test.lihao.wiki 部署

测试和演示共用 `batty-club-test.service`。它使用同名系统账号，在 `127.0.0.1:4319` 监听，独立数据库由 systemd 存放在 `/var/lib/batty-club-test/batty.sqlite`。

## 应用

将 Node 运行环境和发布版本放入 `/opt/batty-club-test/runtime` 与 `/opt/batty-club-test/releases`，让 `/opt/batty-club-test/current` 指向选中的版本。根据 `test.env.example` 创建 `/etc/batty-club-test/app.env`，权限设为 `0600`。空库首次启动需要为两个账号分别生成随机密码，初始化成功后可从环境文件移除。安装并启动 `batty-club-test.service` 后，先验证 `http://127.0.0.1:4319/api/health`。

## Nginx 和证书

1. 创建 `/var/lib/batty-club-test-acme` 作为可供 Nginx 读取的 HTTP-01 验证目录，创建 `/etc/batty-club-test/acme` 作为 root 专用的证书与 ACME 账号目录，权限设为 `0700`。
2. 首次签发时，只加载 `batty-club-test.nginx.conf` 中监听 80 端口的 `server` 块。执行 `nginx -t` 后重载 Nginx。用官方 Lego v5 在 `/opt/batty-club-test/acme-tools/lego` 签发 `test.lihao.wiki` 的证书。签发命令使用 `run` 及续期服务中的域名、存储目录和 webroot 参数，省略 `--deploy-hook`。
3. 确认证书和私钥就绪后，将完整的 `batty-club-test.nginx.conf` 安装到 `/etc/nginx/conf.d/batty-club-test.conf`，执行 `nginx -t` 后重载。验证 `https://test.lihao.wiki/api/health` 和 `https://lihao.wiki/api/health`。
4. 将 `batty-club-test-reload-nginx.sh` 以 `0755` 安装到 `/opt/batty-club-test/acme-tools/reload-nginx.sh`。若签发时指定了账号邮箱或 ID，在仅 root 可读的 `/etc/batty-club-test/acme.env` 设置对应的 `LEGO_EMAIL` 或 `LEGO_ACCOUNT_ID`。安装 `batty-club-test-tls.service` 和 `batty-club-test-tls.timer` 后，运行 `systemctl daemon-reload`，再运行 `systemctl enable --now batty-club-test-tls.timer`。查看续期日志可使用 `journalctl -u batty-club-test-tls.service`。

## 演示样例

HTTPS 可用后，在开发机运行 `node --env-file=<账号文件> --experimental-strip-types scripts/seed-test-demo.ts`。账号文件设为 `0600`，包含测试站 `PUBLIC_ORIGIN`、测试超管和客服的初始账号与密码，以及 `DEMO_MANAGER_PASSWORD` 和 `DEMO_SHAREHOLDER_PASSWORD`。脚本通过测试站 API 创建虚构客户、陪玩、订单和待审批记录。初始化后可用 SQLite `.backup` 将测试库的一致性快照保存在独立的 `/var/lib/batty-club-test-backups`，便于演示前恢复。
