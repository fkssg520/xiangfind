# 验收复验脚本（tests/e2e/verify）

配合 `docs/验收对照表.md` 用的**可复现**检查。

## 为什么有这些脚本

2026-11-19 给同事报数据时被指出：

> 「下次给我这类数据时，建议附上你是用哪条命令/哪个脚本跑出来的。
> 这次我是靠 grep 代码和重跑才确认的；如果有现成脚本，我就能 10 秒复现，而不是花 20 分钟重做。」

## 静态检查 → 用 `scripts/check-dom.mjs`（不在这里）

我原先写了个 `check-static.ps1`，后来发现**小灰的 `scripts/check-dom.mjs` 已经覆盖且更全**，于是删掉了自己的，避免两份实现各自漂移。

```powershell
node scripts/check-dom.mjs
```

它检查 9 项：

| 检查 | 说明 |
|---|---|
| 文件齐全 | `public/` 三个文件都在 |
| `app.js` 语法 | 语法错误会让全站静默失效 |
| 顶层重复声明 | `openClaimDialog` 事故的守卫（`node --check` 拦不住这个） |
| 冲突标记残留 | `<<<<<<<` / `=======` / `>>>>>>>` |
| `index.html` id 数量 | 统计 |
| `app.js` 引用的 id 都存在 | 改了 id 但忘改 JS → 静默失效 |
| 导航项都有视图容器 | |
| `VIEWS` 与容器一致 | |
| 表单字段全部存在 | |

**结论：静态检查只保留一处（`scripts/check-dom.mjs`），这个目录只放它覆盖不到的浏览器侧检查。**

## `check-390.ps1` —— A-07 移动端横向溢出

这是 `check-dom.mjs` **做不到**的：它需要真实渲染才知道有没有溢出。

```powershell
npm run dev     # 另一个窗口

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

换端口：`-Base http://127.0.0.1:3001`。

## 原理

探针页临时拷进 `public/`（同源才能读 iframe 的 DOM）→ 无头 Edge 打开 →
结果写进 `<title>RESULT:{json}` → PowerShell 读回 → 输出表格 → 删临时文件。

## 已知限制

- 只在本机 Edge 上验证过；`EDGE_PATH` 可覆盖
- 需要应用在跑（不像 `check-dom.mjs` 纯静态）
