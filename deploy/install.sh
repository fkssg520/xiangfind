#!/usr/bin/env bash
# 湘寻 · Ubuntu 一键部署脚本（把 deploy/DEPLOY.md 的 9 步变成一条命令）
#
# 用法（在服务器上，用有 sudo 权限的账号）：
#   curl -fsSL https://raw.githubusercontent.com/fkssg520/xiangfind/main/deploy/install.sh -o install.sh
#   sudo bash install.sh --domain xiangfind.example.com --email you@example.com
#
# 可选参数：
#   --dir /opt/xiangfind      安装目录（默认 /opt/xiangfind）
#   --port 3000               应用端口（默认 3000）
#   --no-ssl                  只配 HTTP，不申请证书（域名还没解析好时用）
#   --skip-seed               不灌演示数据（正式上线用）
#   --repo <git url>          仓库地址
#
# 幂等：重复执行会更新代码并重启，不会重复建用户/库。
set -euo pipefail

DOMAIN=""
EMAIL=""
APPDIR="/opt/xiangfind"
APPPORT="3000"
USE_SSL=1
SEED=1
REPO="https://github.com/fkssg520/xiangfind.git"
SVC_USER="xiangfind"

log()  { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email)  EMAIL="${2:-}"; shift 2 ;;
    --dir)    APPDIR="${2:-}"; shift 2 ;;
    --port)   APPPORT="${2:-}"; shift 2 ;;
    --repo)   REPO="${2:-}"; shift 2 ;;
    --no-ssl) USE_SSL=0; shift ;;
    --skip-seed) SEED=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "请用 sudo 运行"
[ -n "$DOMAIN" ] || die "缺少 --domain（例：--domain xiangfind.example.com）"

log "0/9 检查环境"
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ok "系统 ${PRETTY_NAME}" ;;
  *) warn "未测试的系统：${PRETTY_NAME:-unknown}，继续但可能失败" ;;
esac
command -v curl >/dev/null || die "缺少 curl"

log "1/9 安装依赖（git / nginx / certbot）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git nginx ca-certificates >/dev/null
ok "系统包就绪"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  log "2/9 安装 Node.js 24 LTS"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "Node $(node -v)"
else
  log "2/9 Node.js 已满足要求"
  ok "Node $(node -v)"
fi

log "3/9 创建服务用户与目录"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$SVC_USER"
  ok "创建用户 $SVC_USER"
else
  ok "用户 $SVC_USER 已存在"
fi
mkdir -p "$APPDIR"
chown -R "$SVC_USER:$SVC_USER" "$APPDIR"

log "4/9 拉取代码"
if [ -d "$APPDIR/.git" ]; then
  sudo -u "$SVC_USER" git -C "$APPDIR" fetch --all --quiet
  sudo -u "$SVC_USER" git -C "$APPDIR" reset --hard origin/main --quiet
  ok "已更新到最新 main"
else
  sudo -u "$SVC_USER" git clone --quiet "$REPO" "$APPDIR"
  ok "已克隆仓库"
fi
cd "$APPDIR"
sudo -u "$SVC_USER" npm ci --omit=dev --silent 2>/dev/null || sudo -u "$SVC_USER" npm install --omit=dev --silent
ok "依赖安装完成"

log "5/9 生成 .env"
if [ -f "$APPDIR/.env" ]; then
  ok ".env 已存在，保持不变（如需修改请手工编辑）"
else
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  cat > "$APPDIR/.env" <<ENVEOF
PORT=$APPPORT
DATABASE_PATH=./data/xiangfind.db
SESSION_SECRET=$SECRET
UPLOAD_DIR=./uploads
MAX_UPLOAD_MB=5
REGISTER_LIMIT_PER_HOUR=5
# 邮件：不填则验证码打到日志（journalctl -u xiangfind）
SMTP_HOST=
SMTP_PORT=465
SMTP_USER=
SMTP_PASSWORD=
# 发件人必须与 SMTP_USER 同一个邮箱，否则 QQ/163 会拒发；留空则自动用 SMTP_USER
MAIL_FROM=
PUBLIC_BASE_URL=$( [ "$USE_SSL" -eq 1 ] && echo "https://$DOMAIN" || echo "http://$DOMAIN" )
ENVEOF
  chown "$SVC_USER:$SVC_USER" "$APPDIR/.env"
  chmod 600 "$APPDIR/.env"
  ok "已生成 .env（SESSION_SECRET 随机）"
  warn "邮件未配置：验证码会打在 journalctl，稍后填 SMTP_* 并 systemctl restart xiangfind"
fi

log "6/9 初始化数据库"
sudo -u "$SVC_USER" mkdir -p "$APPDIR/data" "$APPDIR/uploads"
sudo -u "$SVC_USER" env DATABASE_PATH="$APPDIR/data/xiangfind.db" node src/db/migrate.js >/dev/null
ok "表结构就绪"
if [ "$SEED" -eq 1 ]; then
  sudo -u "$SVC_USER" env DATABASE_PATH="$APPDIR/data/xiangfind.db" node src/db/seed.js >/dev/null
  ok "演示数据已灌入（正式上线可加 --skip-seed）"
else
  ok "跳过演示数据"
fi

log "7/9 安装 systemd 服务"
sed -e "s#/opt/xiangfind#$APPDIR#g" -e "s#User=xiangfind#User=$SVC_USER#" \
    -e "s#Group=xiangfind#Group=$SVC_USER#" "$APPDIR/deploy/xiangfind.service" > /etc/systemd/system/xiangfind.service
systemctl daemon-reload
systemctl enable xiangfind >/dev/null 2>&1
systemctl restart xiangfind
sleep 2
systemctl is-active --quiet xiangfind && ok "服务已启动" || { journalctl -u xiangfind -n 20 --no-pager; die "服务启动失败"; }

for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$APPPORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
H="$(curl -fsS "http://127.0.0.1:$APPPORT/health" 2>/dev/null || echo '')"
[ -n "$H" ] && ok "/health → $H" || die "本机 /health 打不通，检查 journalctl -u xiangfind"

log "8/9 配置 nginx"
sed -e "s#xiangfind.example.com#$DOMAIN#g" "$APPDIR/deploy/nginx.conf" \
  | sed -e "s#127.0.0.1:3000#127.0.0.1:$APPPORT#g" > /etc/nginx/sites-available/xiangfind
ln -sf /etc/nginx/sites-available/xiangfind /etc/nginx/sites-enabled/xiangfind
rm -f /etc/nginx/sites-enabled/default

if [ "$USE_SSL" -eq 0 ]; then
  # 只配 HTTP：把 443 段整体注释掉，避免证书不存在导致 nginx -t 失败
  awk '/listen 443 ssl;/{skip=1} skip&&/^}/{print "# }";skip=0;next} !skip{print}' \
      /etc/nginx/sites-available/xiangfind > /tmp/xf-nginx.tmp
  mv /tmp/xf-nginx.tmp /etc/nginx/sites-available/xiangfind
  warn "--no-ssl：已配置纯 HTTP（http://$DOMAIN）"
fi

nginx -t 2>/dev/null || { nginx -t; die "nginx 配置有误"; }
systemctl reload nginx
ok "nginx 已reload"

log "9/9 HTTPS"
if [ "$USE_SSL" -eq 1 ]; then
  if [ -z "$EMAIL" ]; then
    warn "没给 --email，跳过证书申请。稍后手工跑："
    warn "  certbot --nginx -d $DOMAIN"
  else
    mkdir -p /var/www/html
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect >/dev/null 2>&1; then
      ok "证书已签发并配置自动续期"
    else
      warn "证书申请失败（域名可能还没解析到本机）"
      warn "解析生效后重跑：certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $EMAIL --redirect"
    fi
  fi
else
  ok "已按要求跳过 HTTPS"
fi

log "防火墙（有 ufw 才配）"
if command -v ufw >/dev/null; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ok "已放行 22/80/443"
else
  warn "没装 ufw，请自行确认云厂商安全组放行 80/443"
fi

log "部署完成"
cat <<EOF

  访问地址   $( [ "$USE_SSL" -eq 1 ] && echo "https://$DOMAIN" || echo "http://$DOMAIN" )
  安装目录   $APPDIR
  服务管理   systemctl status|restart|stop xiangfind
  日志       journalctl -u xiangfind -f
  配置文件   $APPDIR/.env（改完 systemctl restart xiangfind）
  健康检查   curl -s http://127.0.0.1:$APPPORT/health

  演示账号（若灌了 seed）：20230001 / 20230002 / 90000001，密码 demo1234

  上线后请逐条过 docs/验收对照表.md 的验证方式；
  没配 SMTP 时，验证码在：journalctl -u xiangfind -n 50 | grep mail

EOF
