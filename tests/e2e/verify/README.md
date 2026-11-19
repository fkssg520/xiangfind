# 验收复验脚本（tests/e2e/verify）

配合 `docs/验收对照表.md` 用的**可复现**检查。跑完把输出直接粘到 issue / PR 里，对方 10 秒就能复现。

## 为什么有这些脚本

2026-11-19 给同事报数据时被指出：

> 「下次给我这类数据时，建议附上你是用哪条命令/哪个脚本跑出来的。
> 这次我是靠 grep 代码和重跑才确认的；如果有现成脚本，我就能 10 秒复现，而不是花 20 分钟重做。」

所以把一次性的探测改成了脚本。

## `check-static.ps1` —— 前端静态自检

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e/verify/check-static.ps1
```

检查 5 项：

| # | 检查 | 为什么 |
|---|---|---|
| 1 | `app.js` 顶层声明重复 | 2026-11-19 出过 `openClaimDialog` 声明两次 → 整个 `app.js` SyntaxError，全站交互静默失效 |
| 2 | `index.html` 的 `id` 重复 | 重复 id 会让 `getElementById` 静默拿到错的那个 |
| 3 | 冲突标记残留（`<<<<<<<` / `=======` / `>>>>>>>`） | 解冲突时漏删 |
| 4 | `styles.css` 花括号配平 | 少一个 `}` 后面的样式全失效 |
| 5 | `node --check app.js` | 语法错误 |

不需要启动服务，随时可跑。

## `check-390.ps1` —— A-07 移动端横向溢出

```powershell
# 先起应用
npm run dev

powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e/verify/check-390.ps1
```

固定 390×844 视口，用管理员登录后依次切 12 个路由，记录 `documentElement.scrollWidth`。

输出（可直接粘贴）：

```
视口宽度：390px   路由数：12

| 路由 | scrollWidth | 溢出 |
|---|---|---|
| `#/plaza` | 375 | 否 |
| `#/me` | 390 | 否 |
...
结论：12 个路由全部无横向溢出（A-07 通过）
```

想换端口：`-Base http://127.0.0.1:3001`。

## 原理

和 `tests/e2e/run.ps1` 同一套：探针页临时拷进 `public/`（同源才能读 iframe 的 DOM）→
无头 Edge 打开 → 结果写进 `<title>RESULT:{json}` → PowerShell 读回 → 输出表格 → 删临时文件。

## 已知限制

- 只在本机 Edge 上验证过；`EDGE_PATH` 可覆盖
- `check-390.ps1` 需要应用在跑，`check-static.ps1` 不需要
