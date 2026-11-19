# 湘寻（XiangFind）

湘潭大学校园失物招领平台 —— 学生发布失物/招领、规则型智能匹配、认领双签审核、站内消息、志愿者与管理员后台。

> **AI 协作入口**：`AGENTS.md`（AI 必读）· `AI_COLLAB.md`（协作细则）· `docs/需求基线.md`（需求圣经）

## 现在能做什么

| 能力 | 状态 |
|---|---|
| 注册 / 邮箱验证码 / 登录 / 找回密码 | ✅ 完整 |
| 游客浏览广场与详情（不用登录） | ✅ |
| 发布失物/招领（含最多 3 张图片） | ✅ |
| 关键词搜索、类型/分类/状态/贵重等级筛选 | ✅ |
| 规则型智能匹配（5 维评分 + 可解释原因） | ✅ |
| 认领提交 → 发布者表态 → 授权角色终审 | ✅ |
| 站内消息与未读数 | ✅ |
| 志愿者确认入库、确认归还 | ✅ |
| 管理后台（用户/志愿者/存放点/审核/审计/恢复演示） | ✅ 接口完整 |
| 公网部署 | ⏳ 方案待定（见 `deploy/DEPLOY.md`） |

## 跑起来（3 分钟）

```powershell
npm install                          # 只有 nodemailer 一个依赖
Copy-Item .env.example .env          # 然后填 SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 生成密钥填进 .env

npm run db:migrate                   # 建表（可重复执行）
npm run db:seed                      # 演示数据
npm run dev                          # 或 npm start
```

打开 <http://localhost:3000>。

### 演示账号（密码统一 `demo1234`）

| 学号 | 角色 | 能做什么 |
|---|---|---|
| `20230001` | 学生 | 发布、认领、收藏 |
| `20230002` | 志愿者（图书馆点） | 确认入库、终审认领、确认归还 |
| `90000001` | 管理员 | 全部后台能力 |

> 演示数据全部是假信息（`*@demo.local`、示例地址），**不含真实学生姓名/学号/手机号**。

### 没配 SMTP 时怎么收验证码

开发环境不配 SMTP 也能跑，验证码打在**服务端日志**：

```
[mail:dev] to=student@demo.local code=123456 purpose=verify
```

生产环境必须配 `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD`（QQ 邮箱用授权码，不是密码）。

## 脚本

| 命令 | 作用 |
|---|---|
| `npm start` / `npm run dev` | 启动服务（dev 带 --watch） |
| `npm run db:migrate` | 建表 + 补列（可重复执行） |
| `npm run db:seed` | 演示数据（幂等） |
| `npm test` | 单元测试（`node --test`） |
| `scripts\smoke-all.ps1` | **12 个套件 / 203 项集成冒烟**，每个套件独立库与端口 |
| `scripts\smoke-e2e.ps1` | **一键浏览器 E2E**（本机 Edge 无头，6 场景；需普通终端，受限环境跑不了） |
| `scripts\push.ps1` | 一键推送（自动处理本机 SSH 走 443） |
| `scripts\backup.ps1` | 备份数据库与上传目录（保留 7 日 + 4 周） |

## 接口一览

认证：`register` · `verify-email` · `resend-code` · `login` · `logout` · `forgot-password` · `reset-password` · `me`

物品：`GET/POST /api/items`（支持 `?mine=1`）· `GET/PATCH /api/items/:id` · `favorite` · `storage-confirm` · `return` · `GET /api/matches/:itemId`

认领：`GET/POST /api/items/:id/claims` · `POST /api/claims/:id/decision`（`agree`/`reject`/`approve`）· `GET /api/claims/mine`

其他：`POST /api/uploads` · `GET /api/storage-points` · `GET /api/messages` · `POST /api/messages/:id/read`

管理：`overview` · `users` · `users/:id/volunteer` · `storage-points`（CRUD）· `claims` · `reset-demo` · `audit-logs`

完整字段见 `docs/API契约.md`；错误统一 `{ error: { code, message } }`。

## 目录

```
src/            后端（小灰）
  api/          路由分发
  services/     auth / items / uploads / matching / claims / admin
  lib/          http / session / csrf / ratelimit / password / mailer / id
  db/           schema.sql / migrate / evolve / seed / demo
public/         前端（小冯）
docs/           需求基线、API 契约、决策记录、分工协议、设计规范、fixtures
tests/          单元与端到端测试
scripts/        冒烟测试、推送、备份
deploy/         nginx / systemd / 部署清单
journal/        每日交接日志
```

## 部署

两条路线，都准备好了：

| 路线 | 成本 | 上线时间 | 适合 | 文档 |
|---|---|---|---|---|
| **A. Ubuntu 云服务器** | ¥25-60/月 | **约 15 分钟**（一键脚本） | 演示后长期用 | [`deploy/DEPLOY.md`](deploy/DEPLOY.md) |
| **B. Cloudflare 隧道** | 免费 | 10 分钟 | 11/23 演示当天 | [`deploy/TUNNEL.md`](deploy/TUNNEL.md) |

```bash
# 路线 A 一键部署（Ubuntu 服务器上，sudo）
sudo bash deploy/install.sh --domain 你的域名 --email 你的邮箱
```

```powershell
# 路线 B 一键起（先 npm start 把服务跑起来）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tunnel-up.ps1
```

> 两者不冲突：可以先用 B 应付演示，之后再迁到 A。迁移只换 `PUBLIC_BASE_URL` 和 nginx，代码不动。

部署前自检：

```powershell
node scripts/check-secrets.mjs    # 确认没有密钥/真实个人信息被提交
node scripts/mail-check.mjs       # 确认 SMTP 配置（不带参数只校验完整性）
powershell -File scripts/restore-drill.ps1   # 备份恢复演练
```

## 已知限制

| 项 | 说明 |
|---|---|
| 公网部署 | 方案未定，11/21 拍板（境外/香港机 或 Cloudflare 隧道） |
| 图片匹配 | 只做文本规则，不做图片向量（计划书明确不做） |
| 中文分词 | 字符二元组 + 停用词，未引 NLP 库 |
| 地点匹配 | 不做地名词典，靠字符串包含与关键词重合（D-002） |
| 限流 | 进程内存实现，单实例有效；多实例需换共享存储 |
| 会话 | DB 存储，7 天有效；改密码会踢掉所有旧会话 |

## 约定

- 所有密钥经 `.env` 注入，**不得写入源码**（`.env` 已忽略）
- 演示数据不得包含真实学生信息
- 需求有冲突时以 `docs/需求基线.md` 为准，变更先记 `docs/决策记录.md`
- `main` 有分支保护：**必须走 PR**，管理员也不能直推
