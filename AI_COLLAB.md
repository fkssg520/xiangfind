# AI 协作细则（AI_COLLAB.md）

> `AGENTS.md` 是给 AI 看的速查版；本文件是完整规范，两者冲突时以 `AGENTS.md` 为准。
> 人类（项目负责人）只需要看第 6 节的"每日节奏"和最后一节"人工事项"。

---

## 1. 设计原则

两个 AI 在两台电脑上，**没有共享内存、没有实时通道、无法互相唤醒**。所以：

| 事实 | 设计应对 |
|---|---|
| 只能通过 GitHub 交换信息 | 一切结论都落到 GitHub（issue / PR / commit / journal），不留在聊天里 |
| 消息是异步的，可能几小时才被读到 | 消息必须自包含：说清楚背景、方案、要对方做什么 |
| 无法感知对方正在改什么 | 用目录所有权 + 分支隔离，从结构上避免撞车 |
| 两边的上下文窗口互相看不见 | `journal/` 记录"为什么这么改"，代码只记录"改成什么" |
| 出错代价高（可能覆盖对方一天的工作） | 保护 `main`、禁止 force push、禁止跨目录修改 |

**核心心法：把 GitHub 当数据库，把 issue 当消息队列，把 PR 当事务提交。**

---

## 2. 分支

| 规则 | 说明 |
|---|---|
| 命名 | `xiaohui/feat-auth`、`b/ui-login`、`xiaohui/fix-claim-403` |
| 一个分支只做一件事 | 超过 400 行 diff 就该拆 |
| 生命周期 | 合并后由 `小灰` 删除；未合并的分支不得删除 |
| 同步方式 | 自己的分支用 `git rebase origin/main`；**绝不 force push 已推送分支**（改用 `git merge origin/main`） |

> 如果确实需要 force push（例如 rebase 后修正历史），先在 issue 里 @ 对方确认，且只对自己独占的分支做。

---

## 3. 提交

```
<type>(<scope>): <中文描述，不超过 50 字>

<可选的正文：为什么这么改，不是改了什么>

Agent: <小灰|agent-b>
```

- `type`：`feat` `fix` `docs` `refactor` `test` `chore` `style`
- `scope`：`auth` `items` `claims` `matching` `messages` `admin` `ui` `db` `deploy`
- `Agent:` 尾注**必须有**，它是 `git log` 能区分是谁写的唯一依据
- 示例：`feat(items): 招领物品发布强制校验存放点类型`

---

## 4. PR

- **base 永远填 `main`**，标题格式同提交
- 正文用 `.github/pull_request_template.md`，自查清单逐条勾
- 大小：单个 PR 尽量 ≤ 400 行；超了先拆
- 评审：`agent-b` 的 PR 由 `小灰` 看；`小灰` 的 PR 至少由 `agent-b` 看一眼 diff（不是走过场，是并行发现问题的机会）
- 合并：**只有 `小灰` 能合并**，用 squash merge，保持 `main` 线性
- 合并前必须：`npm test` 通过 + 无冲突 + 无密钥

---

## 5. 留言协议

### 5.1 标签体系（仓库里已有）

| 标签 | 含义 |
|---|---|
| `to:xiaohui` / `to:agent-b` | **收件人**（决定谁去看） |
| `kind:question` | 需要对方回答 |
| `kind:decision` | 需要对方拍板，附方案 |
| `kind:blocked` | 我被卡住，需要对方解阻 |
| `kind:handoff` | 交接：我这边做完了，轮到你 |
| `kind:review` | 请评审具体 PR |
| `status:claimed` | 已被某人认领 |
| `status:waiting` | 等对方，暂停 |

### 5.2 发件

```powershell
gh issue create --title "[决策] 匹配通知去重策略" --label to:agent-b,kind:decision --body-file msg.md
```

### 5.3 收件

```powershell
gh issue list --label to:xiaohui --state open --json number,title,labels,createdAt
gh issue view <编号> --comments      # 看完整对话与回复
```

### 5.4 回复与关闭

```powershell
gh issue comment <编号> --body "同意方案 A。理由：…"    # 回复
gh issue close <编号> --comment "已按方案 A 实现，见 #12"  # 关闭时必须指向落地位置
```

### 5.5 超时升级（避免两边互相等死）

| 情况 | 动作 |
|---|---|
| 发出 24 小时无回复 | 追加一条评论，改标签为 `kind:blocked` |
| 阻塞超过 48 小时 | **自己按"我倾向于"的方案先做**，在 issue 里写明"已按 X 实施，可回滚"，并继续推进 |
| 涉及不可逆操作（删数据、改表结构、动 `main`） | 不适用上面的自动推进，必须等 `小灰` |

> 这条是为了防止"两个 AI 礼貌地互相等待，项目停摆"。默认策略：**宁可先做再改，不要空等。**

---

## 6. 每日节奏（人类只当调度员）

| 时间 | 人类说什么 | 两边 AI 做什么 |
|---|---|---|
| 12:00 | "同步" | 跑 `scripts/sync.ps1` → 处理 `to:我` 的 issue → 推进当前分支 |
| 21:00 | "同步" | 同上，并把当天工作收尾：push 分支、开/更新 PR、写 `journal/当天.md` |

`journal/YYYY-MM-DD.md` 格式：

```markdown
# 2026-11-18

## 小灰
- 阶段：后端骨架
- 完成：schema、认证接口
- 进行中：认领流程
- 阻塞：等 SMTP 授权码
- 决定：地点匹配先用字符二元组，不做词典（记录原因：工期）
- 明天：匹配模块

## agent-b
- 阶段：前端骨架
- 完成：登录页、广场页静态版
```

两人同一天写同一文件会冲突 → **各自只追加自己的 `## <名字>` 段落**，冲突时以"保留双方段落"解决。

---

## 7. 冲突与回滚

| 场景 | 正确做法 |
|---|---|
| 自己分支落后 main | `git fetch origin && git merge origin/main`（不要 rebase 已推送的分支） |
| 同一文件被两人改 | 以 PR 里的 diff 为准人工合并；拿不准就发 `kind:blocked` |
| 合并后发现 `main` 坏了 | 由 `小灰` 执行 `git revert <合并提交>`，**不要 reset** |
| 对方的代码有问题 | 不改他的代码，开 issue 指出；紧急情况由 `小灰` 修并在 issue 说明 |

---

## 8. 人工事项（只有人类能做）

1. **在两台机器的会话里指定身份**（"你是 agent-b"），否则 AI 只能做只读工作。
2. **每天说两次"同步"**，否则两个 AI 不会自己醒来。
3. **提供 SMTP 授权码**（否则邮箱验证只能写日志）。
4. **决定公网部署方案**（服务器/域名/备案）。
5. **合并冲突的最终裁决**（两个 AI 僵持时）。
