# 湘寻（XiangFind）

湘潭大学校园失物招领平台 —— 学生发布失物/招领、规则型智能匹配、认领审核、站内消息、志愿者与管理员后台。

> **AI 协作入口：`AGENTS.md`（AI 必读）· `AI_COLLAB.md`（协作细则）· `docs/需求基线.md`（需求圣经）**

## 状态

| 项 | 值 |
|---|---|
| 阶段 | 骨架搭建（M0） |
| 公网体验版目标 | 2026-11-23 |
| 技术栈 | Node.js ≥ 26（`node:sqlite` / `node:test` / `fetch`）+ 原生 HTML/CSS/JS |
| 依赖 | 仅 `nodemailer`（发邮件），其余全部使用 Node 内置模块 |

## 跑起来

```powershell
npm install                 # 只有一个依赖
npm run dev                 # 或 npm start
# 打开 http://localhost:3000        → 静态页（暂无，待前端）
# 打开 http://localhost:3000/health → 健康检查
```

首次运行需要 `.env`：

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 生成 SESSION_SECRET 填入
```

## 目录

```
src/            后端（小灰 负责）
  server.js     入口：静态文件 + /health
public/         前端（agent-b 负责）
docs/           需求基线、接口约定
tests/unit/     单元测试（小灰）
tests/e2e/      端到端测试（agent-b）
journal/        每日交接日志，一人一段
scripts/        协作脚本（sync.ps1）
.github/        issue/PR 模板、CODEOWNERS
data/           SQLite 数据库文件（不入库）
uploads/        用户上传图片（不入库）
```

## 协作方式（两台电脑、两个 AI）

1. 每台机器的 AI 开工前读 `AGENTS.md`；
2. 跑 `scripts/sync.ps1 -Agent xiaohui`（对面传 `agent-b`）看未读留言、PR、日志；
3. 各自在自己的分支上干活，`main` 只能通过 PR 合并；
4. 需要对方知道的事，发 issue 并打 `to:xxx` + `kind:xxx` 标签；
5. 每天两次由人类说"同步"触发。

详细规范见 `AI_COLLAB.md`。

## 约定

- 所有密钥经 `.env` 注入，**不得写入源码**（`.env` 已忽略）。
- 演示数据不得包含真实学生姓名、学号、手机号、邮箱。
- 需求有冲突时以 `docs/需求基线.md` 为准，变更先记 issue。
