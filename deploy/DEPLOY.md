# 部署清单（Ubuntu + Nginx + systemd）

> 状态：**方案待人类拍板**（见文末「两条路线」）。
> 本文档按「一台 Ubuntu 云服务器 + 域名 + HTTPS」写。
> **没有服务器、想今天就拿到公网地址 → 看 [`TUNNEL.md`](TUNNEL.md)（Cloudflare 隧道，免费，10 分钟）。**

---

## 0. 前置

| 项 | 要求 |
|---|---|
| 服务器 | Ubuntu 22.04 / 24.04，2 核 2GB 起，**40GB 持久盘**（不能是无持久盘的临时容器） |
| 域名 | 已解析到服务器 IP（A 记录） |
| 端口 | 安全组/防火墙只放 22、80、443 |
| 备案 | 服务器在**中国大陆**则必须先完成 ICP 备案；境外/香港不需要 |

## 1. 系统与 Node

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx ufw

# Node 24 LTS（与本地保持同一大版本，避免 node:sqlite API 漂移）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # 期望 v24.x
```

## 2. 用户与目录

```bash
sudo useradd -m -s /bin/bash xiangfind
sudo mkdir -p /opt/xiangfind
sudo chown -R xiangfind:xiangfind /opt/xiangfind

sudo -iu xiangfind
cd /opt/xiangfind
git clone https://github.com/fkssg520/xiangfind.git .
npm ci --omit=dev
```

## 3. 配置 .env

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 生成 SESSION_SECRET
nano .env
```

必须填的 9 项：

```ini
PORT=3000
DATABASE_PATH=./data/xiangfind.db
SESSION_SECRET=<上面生成的那串>
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=<你的邮箱>
SMTP_PASSWORD=<邮箱授权码，不是登录密码>
MAIL_FROM=湘寻 <你的邮箱>
PUBLIC_BASE_URL=https://xiangfind.example.com
```

```bash
chmod 600 .env          # 只有属主可读
mkdir -p data uploads
```

## 4. 初始化数据库

```bash
npm run db:migrate
npm run db:seed        # 演示数据；正式上线可跳过，然后用后台建真实存放点
```

## 5. systemd

```bash
# 退出 xiangfind 用户
exit

sudo cp /opt/xiangfind/deploy/xiangfind.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xiangfind
sudo systemctl status xiangfind --no-pager

# 本地自测
curl -s http://127.0.0.1:3000/health
```

期望：`{"status":"ok","database":"ok","items":4,...}`

## 6. Nginx + HTTPS

```bash
sudo cp /opt/xiangfind/deploy/nginx.conf /etc/nginx/sites-available/xiangfind
sudo ln -s /etc/nginx/sites-available/xiangfind /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# 先把域名换成你的
sudo sed -i 's/xiangfind.example.com/你的域名/g' /etc/nginx/sites-available/xiangfind

# 先只开 80 端口那段（443 段会因为证书不存在而报错，先注释掉再 nginx -t）
sudo nginx -t && sudo systemctl reload nginx

# 签证书（会自动改 nginx 配置并 reload）
sudo certbot --nginx -d 你的域名
```

## 7. 防火墙

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```

## 8. 备份（每日 3:10）

```bash
# 装 cron 任务（用 root 跑，备份到 /var/backups/xiangfind）
sudo crontab -e
```

加一行：

```cron
10 3 * * * cd /opt/xiangfind && /usr/bin/pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1 -BackupRoot /var/backups/xiangfind -Quiet
```

> 服务器上需要 PowerShell：`sudo snap install powershell --classic`。
> 不想装 pwsh 的话，直接用一行等价命令：
> `10 3 * * * cd /opt/xiangfind && node scripts/db-snapshot.mjs data/xiangfind.db /var/backups/xiangfind/db-$(date +\%Y\%m\%d).db && tar czf /var/backups/xiangfind/uploads-$(date +\%Y\%m\%d).tgz uploads/`

## 9. 上线后验证（逐条打勾）

- [ ] 校内网络 + 校外网络 + 手机流量各打开一次首页
- [ ] 匿名浏览广场（不登录）能看到物品
- [ ] 注册 → 收真实验证码邮件 → 验证 → 登录
- [ ] 发布带图招领 → 状态 `pending_storage`
- [ ] 志愿者登录确认入库 → 自动匹配 → 收到站内消息
- [ ] 认领 → 发布者表态 → 志愿者终审 → 待领取
- [ ] 确认归还 → 状态 `returned`，`returned_at` 有值
- [ ] `curl https://域名/health` 返回 ok（注意 nginx 里 /health 限制了本机访问，从服务器上 curl）
- [ ] 重启服务器后数据仍在（`systemctl restart xiangfind` 后再看）

---

## 两条路线（人类 11/21 前拍板）

### 路线 A：境外 / 香港轻量服务器

| 项 | 说明 |
|---|---|
| 成本 | 约 ¥25-60/月 + 域名 ¥30-70/年 |
| 备案 | **不需要** |
| 优点 | 完全是真服务器，systemd/nginx/cron 都用得上，最接近正式上线 |
| 缺点 | 国内访问延迟 100-200ms；微信内置浏览器偶有跨境慢 |

### 路线 B：Cloudflare 隧道（免费）

| 项 | 说明 |
|---|---|
| 成本 | 0（需要一个域名，可用免费子域服务） |
| 备案 | 不需要 |
| 优点 | 当天可用，不需要买服务器；本机跑服务，隧道暴露到公网 |
| 缺点 | 需要本机常开；地址依赖 Cloudflare；不适合作为长期正式服务 |

### 路线 C（如果有人给大陆服务器）

必须先 ICP 备案（个人 1-3 周），**11/23 之前来不及**，只能作为后续正式化的路径。

---

## 排障

| 现象 | 检查 |
|---|---|
| 502 Bad Gateway | `systemctl status xiangfind`；端口是否 3000；`.env` 是否被 systemd 读到 |
| 上传 413 | nginx `client_max_body_size` 是否 20m |
| 图片 404 | `uploads` 目录是否存在且有写权限；`ReadWritePaths` 是否包含它 |
| 验证码收不到 | 服务端日志有没有 `[mail:...]`；SMTP 授权码是否过期 |
| 登录后立刻掉线 | 是否 HTTPS 下 cookie 被标了 Secure 但实际是 HTTP；检查 `NODE_ENV` |
