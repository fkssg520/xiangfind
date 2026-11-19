# E2E 冒烟（tests/e2e）

用**本机 Edge 的无头模式**跑真实页面，不依赖 Playwright / npm 装包。

## 怎么跑

```powershell
# 1. 先把应用起起来（另一个窗口）
npm run dev

# 2. 跑全部场景
powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e/run.ps1

# 3. 只跑某几个
powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e/run.ps1 -Scenarios login,claim
```

需要先 `npm run db:migrate && npm run db:seed`（用的是 seed 里的演示账号）。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `BASE` | `http://127.0.0.1:3000` | 被测应用地址 |
| `EDGE_PATH` | Edge 默认安装路径 | 换浏览器时指定 |

## 覆盖的场景

| 场景 | 断言 |
|---|---|
| `login` | 20230001 登录后顶栏变名字、跳 `#/plaza` |
| `plaza` | 广场至少 1 张卡（真实接口） |
| `detail` | 详情标题非空、属性行 ≥ 5 |
| `claim` | 可认领的物品，点「申请认领」能弹出表单 |
| `admin` | 管理员进后台：5 个页签 + KPI 有数 |
| `forbidden` | 学生进后台被拦（不渲染 KPI） |

## 原理（为什么长这样）

```
run.ps1  ──拷贝──▶  public/__e2e-harness.html   （同源，才能读 iframe 的 DOM）
   │                        │
   │                        ▼
   └──启动 Edge──▶  打开 harness?scenario=xxx
                            │
                            ├─ iframe 加载真实页面
                            ├─ 脚本操作 DOM、断言
                            └─ 结果写进 <title>RESULT:{json}
   │
   └──读回 dump 的 <title>，比对断言，删掉临时文件
```

三个踩过的坑，都写在代码注释里：

1. **必须同源**：`file://` 里 iframe `http://` 读不到 `contentDocument`，所以 harness 要临时放进 `public/`，跑完删除
2. **不能用管道**：这台机器上 Node 起子进程传管道会被限制，所以用 PowerShell + `cmd /c > 文件`
3. **PowerShell 的 `>` 是 UTF-16**：所以读文件要指定 UTF-8，并且 Edge 退出后文件句柄可能短暂占用，读取要重试

## 加场景

在 `harness.html` 的 `SCENARIOS` 里加一个 async 函数，返回一个对象即可；再到 `run.ps1` 的 `switch` 里加断言。
