# lihao.wiki 独立部署

本目录只包含可公开的配置模板，不保存真实密码、证书、私钥或数据库。生产账号通过随机密码初始化，仅使用账号密码登录。

| 项目 | 生产位置 |
| --- | --- |
| 运行账号 | `batty-club`，无交互登录 |
| Node 运行环境 | `/opt/batty-club/runtime`，独立于其他应用 |
| 版本目录 | `/opt/batty-club/releases/<commit>` |
| 当前版本 | `/opt/batty-club/current`，指向版本目录 |
| 业务数据库 | `/var/lib/batty-club/batty.sqlite` |
| 密码及环境配置 | `/etc/batty-club/app.env`，root 0600 |
| 本机一致性备份 | `/var/lib/batty-club-backups`，batty-club 0700 |
| TLS 证书 | `/etc/nginx/tls/lihao.wiki` |
| 独立监听 | `127.0.0.1:4318` |
| 应用服务 | `batty-club.service` |
| Nginx 站点 | `/etc/nginx/conf.d/batty-club.conf` |

首次启动使用全新数据库；`NODE_ENV=production` 会拒绝演示库与缺少随机初始密码的初始化，不创建演示客户、陪玩、充值或订单。账号初始化完成后应删除环境文件中的两项初始密码，重启不会覆盖已有账号。不要将本地试用数据库上传为生产数据库，也不要运行本地 `.command` 启动脚本。

发布时先在开发机完成 `npm test`、`npm run check` 和前端构建，上传对应 Git 提交的源码及 `dist`；服务器仅在新版本目录安装 `npm ci --omit=dev --ignore-scripts`。校验配置和 loopback 健康接口后，再切换 `current` 并启动本应用。更新前做一致性备份。仅添加本域名的虚拟主机，执行 `nginx -t` 后使用 `systemctl reload nginx`，保留原服务及其配置。

`batty-club-backup.timer` 每日北京时间 03:30 左右做 SQLite 一致性备份，文件不在网站目录；需另行保管异机副本，并定期检查备份空间。备份目录使用 `/var/lib` 下的独立路径，部署时先创建为 batty-club 所有、权限 0700；不要放宽其他应用共用的 `/var/backups` 父目录权限。首次启用定时器前，手动启动备份服务并验证生成文件与 SQLite `quick_check`。证书续期只替换本域名的证书文件，校验匹配后测试并重载 Nginx。

检查服务：`systemctl status batty-club`、`journalctl -u batty-club`；检查备份：`systemctl list-timers batty-club-backup.timer`。应用回滚只需将 `current` 切回先前版本并重启 `batty-club`。数据库恢复前先停止本应用并保留现有数据副本，不能在运行中替换 SQLite 数据库。
