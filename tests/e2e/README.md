# E2E 冒烟（tests/e2e）

用**本机 Edge 的无头模式**跑真实页面，不依赖 Playwright / npm 装包。

## 推荐：一条命令跑完（独立数据库）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-e2e.ps1
```

它会自动：建独立库 `data/e2e-smoke.db` → 迁移 + 种子 → 起服务（3300 端口）→ 跑 E2E → 停服务 → 删库和日志。

**不碰你的开发库**，所以 `publish` 场景造的数据不会污染演示数据。

只跑某几个场景：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-e2e.ps1 -Scenarios login,admin
```

## 另一种：跑在你自己的开发服务上

适合调试（能看到自己造的数据、能开 DevTools 对照）：

```powershell
npm run dev                                             # 另一个窗口
powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e/run.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e/run.ps1 -Scenarios login,claim
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `BASE` | `http://127.0.0.1:3000` | 被测应用地址（换端口用这个） |
| `EDGE_PATH` | Edge 默认安装路径 | 换浏览器时指定 |

> ⚠️ 这种方式下 `publish` 场景会**真的往你的开发库插一条招领**。
> 清：`DELETE FROM items WHERE title LIKE 'E2E %';`
> 用 `scripts/smoke-e2e.ps1` 就没这个问题。

## 覆盖的场景

| 场景 | 断言 |
|---|---|
| `login` | 20230001 登录后顶栏变名字、跳 `#/plaza` |
| `plaza` | 广场至少 1 张卡（真实接口） |
| `detail` | 详情标题非空、属性行 ≥ 5 |
| `claim` | 可认领的物品，点「申请认领」能弹出表单 |
| `publish` | 填发布表单提交后跳到详情页、标题带 E2E 标记 |
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

四个踩过的坑，都写在代码注释里：

1. **必须同源**：`file://` 里 iframe `http://` 读不到 `contentDocument`，加 `--disable-web-security` 也没用 → harness 要临时放进 `public/`，跑完删除
2. **不能用管道**：这台机器上 Node 起子进程传管道会被限制，输出永远是空的 → 用 PowerShell + `cmd /c > 文件`
3. **PowerShell 的 `>` 是 UTF-16**：所以读文件要指定 UTF-8；另外 Edge 退出后句柄会短暂占用，读取要重试
4. **headless 里原生 `confirm()` / `alert()` 会静默阻塞**（不报错、不超时，脚本就停在那），harness 里统一打了桩

## 加场景

在 `harness.html` 的 `SCENARIOS` 里加一个 async 函数，返回一个对象即可；再到 `run.ps1` 的 `switch` 里加断言。

## 相关

- `tests/e2e/verify/` —— 验收复验脚本（静态自检、390px 溢出）
