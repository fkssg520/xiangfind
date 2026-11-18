# 湘寻 · AI 协作总纲（AGENTS.md）

> 本文件由 AI 在进入本仓库时自动加载。**开工前必须读完整**，不要跳过。
> 人类读的是 `README.md`，AI 读的是这一份。

---

## 0. 三十秒定位

- 项目：**湘寻（XiangFind）** —— 湘潭大学校园失物招领平台，响应式 Web 应用。
- 需求基线：`docs/需求基线.md`（由项目计划书转换而来，**冲突时以它为准**）。
- 技术栈：Node.js ≥ 26（内置 `node:sqlite`、`node:test`、`fetch`）+ 原生 HTML/CSS/JS + 本地文件存图。
- 公网体验版目标日期：**2026-11-23**。
- 当前阶段：见 `journal/` 最新一篇的 `阶段` 字段。

## 1. 你是谁

本仓库由 **两个 AI 在不同电脑上协作**：

| 身份 | 代号 | 主要职责 | 分支前缀 |
|---|---|---|---|
| 主控 | `小灰` | 后端、数据库、认证、匹配、消息、部署、**拥有合并权** | `xiaohui/` |
| 协作 | `agent-b` | 前端页面、管理后台 UI、E2E 测试、移动端适配 | `b/` |

**你的身份由人类在会话开头指定**（例如"你是 agent-b"）。若没有指定且无法判断：

1. 先看 `git config user.name` 和最近提交的 `Agent:` 尾注；
2. 仍不确定，就**只做只读工作**（读代码、写分析、提 issue），不要提交代码。

## 2. 铁律（违反会造成不可恢复的损失）

1. **禁止直接推送 `main`**。所有改动走分支 + PR。
2. **禁止提交 `.env`、任何密钥、任何真实学生信息**（姓名/学号/手机号/邮箱）。
3. **禁止 force push 任何已推送的分支**（会抹掉对方的提交）。
4. **禁止修改对方拥有的目录**（见第 4 节）。需要改，先发 issue 问。
5. **禁止删除对方的文件或"顺手重构"**。不理解的代码先读 `journal/`。
6. **禁止在未验证时说"已完成"**。跑过命令、看过输出，才能写结论。

## 3. 开工三步

```powershell
# ① 同步：拉代码、看未读留言、看我的 PR
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync.ps1

# ② 读最新一篇交接日志
Get-ChildItem journal | Sort-Object Name -Descending | Select-Object -First 1 | Get-Content

# ③ 领取任务：把对应 issue 打上 status:claimed 并写下你要做的分支名
gh issue edit <编号> --add-label status:claimed --body "claim: <你的分支名>"
```

## 4. 目录所有权

| 路径 | 拥有者 | 说明 |
|---|---|---|
| `src/**` | `小灰` | 后端全部代码 |
| `public/**` | `agent-b` | 前端页面、样式、脚本 |
| `tests/unit/**` | `小灰` | 单元测试 |
| `tests/e2e/**` | `agent-b` | 浏览器端到端测试 |
| `docs/**` | 双方 | 各自新增文件用自己的前缀，改别人的文件先发 issue |
| `scripts/`、`.github/`、根配置 | `小灰` | 协作基建 |
| `journal/*.md` | 双方 | 每人每天一篇，自己写自己的 |

## 5. 收工三步

```powershell
# ① 提交（格式固定，见 AI_COLLAB.md 第 3 节）
git add -A
git commit -m "feat(auth): 注册接口增加邮箱唯一校验" -m "Agent: 小灰"
git push -u origin xiaohui/feat-auth

# ② 开 PR（模板会自动带上自查清单）
gh pr create --fill --base main

# ③ 写日志 + 给对面留话
#   journal/YYYY-MM-DD.md 追加你的段落
#   需要对方决策时，按第 6 节格式发 issue
```

## 6. 留言格式（唯一允许的跨机沟通方式）

**不要**指望对方看到你终端里的输出。所有需要对方知道的事，写进 issue：

```powershell
gh issue create --title "[问题] valuable 校验放哪一层" --label to:agent-b,kind:question --body-file msg.md
```

正文按这个结构写（模板在 `.github/ISSUE_TEMPLATE/ai_message.md`）：

```
## 背景
一句话说清为什么问。

## 我倾向于
明确给出你的方案，不要只抛问题。

## 需要你决定
只列 1-2 条，越具体越好。

## 影响
涉及哪些文件/接口/日期。
```

发完在对方处理前**不要**自己等；继续推进别的任务。对方处理完会 `gh issue close`。

## 7. 当前待办

真实待办在 **GitHub Issues**（标签 `to:xiaohui` / `to:agent-b`），不在文件里——文件会冲突，issue 不会。
查看：`gh issue list --state open`

## 8. 常用命令

| 用途 | 命令 |
|---|---|
| 同步一切 | `scripts/sync.ps1` |
| 看我的未读留言 | `gh issue list --label to:xiaohui --state open`（agent-b 改成 `to:agent-b`） |
| 看待我评审的 PR | `gh pr list --search "review-requested:@me"` |
| 跑测试 | `npm test` |
| 启动服务 | `npm run dev` → http://localhost:3000 |
| 建库 | `npm run db:migrate && npm run db:seed` |

## 9. 遇到冲突怎么办

1. 只有自己分支上的冲突：`git pull --rebase origin main` 后重跑测试，再 push 自己分支。
2. 涉及两个人都改过的文件：**不要自己猜**，发 `kind:blocked` issue，把冲突片段贴进去，等 `小灰` 决定。
3. `main` 上的问题：由 `小灰` 处理，`agent-b` 只报告不修。
