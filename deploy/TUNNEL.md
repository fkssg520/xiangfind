# 部署路线 B：Cloudflare 隧道（免费、当天可用）

> 适合：**没有服务器、想今天就能给老师一个链接**的情况。
> 代价：本机必须常开；地址依赖 Cloudflare；不适合长期正式服务。
> 如果人类选了路线 A（境外/香港服务器），看 `DEPLOY.md`。

---

## 它是什么

```
老师浏览器 ──HTTPS──> Cloudflare 边缘 ──加密隧道──> 你本机的 Node 服务
```

- **不需要公网 IP，不需要开端口，不需要备案**
- 你本机的 `cloudflared` 主动连出去，Cloudflare 把请求转进来
- 免费版给你一个 `xxx.trycloudflare.com` 的临时域名（每次重启会变）

---

## ⚠️ 先看这个：UDP 被封时 QUIC 会失败

实测（2026-11-21，本机校园网）：

```
INF Requesting new quick Tunnel on trycloudflare.com...
INF |  https://xxx.trycloudflare.com  |        ← 域名拿到了
ERR Failed to dial a quic connection ... timeout
INF |  UDP Connectivity  region1.v2.argotunnel.com  FAIL  QUIC connection failed
```

**域名拿到了，但隧道从来没连上**——这是最坏的一种失败：看着像成功，访问却 000。

解法：强制走 TCP（`--protocol http2`）。

```powershell
cloudflared tunnel --protocol http2 --url http://127.0.0.1:3000
```

加上之后立刻注册成功：

```
INF Registered tunnel connection ... protocol=http2 location=lax13
```

`scripts/tunnel-up.ps1` **默认就用 http2**，不用手动加。想试 QUIC 传 `-Protocol quic`。
## 五分钟起步（临时域名，够演示用）

### 1. 装 cloudflared

**Windows（推荐用 winget）**

```powershell
winget install --id Cloudflare.cloudflared
```

装不上就下 zip：<https://github.com/cloudflare/cloudflared/releases/latest>
选 `cloudflared-windows-amd64.exe`，改名为 `cloudflared.exe` 放到 `D:\DeepseekWork\tools\`。

### 2. 先确认本机服务是通的

```powershell
# 另开一个窗口
npm start
# 应该能打开 http://localhost:3000
curl http://127.0.0.1:3000/health
```

### 3. 起隧道

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tunnel-up.ps1
```

它会打印类似：

```
https://random-words-here.trycloudflare.com
```

**这个地址就是公网地址**，手机流量能打开，HTTPS 自动有。

### 4. 改一处配置（重要）

隧道地址每次重启都变，所以 `.env` 里的 `PUBLIC_BASE_URL` 要跟着改：

```ini
PUBLIC_BASE_URL=https://random-words-here.trycloudflare.com
```

改完重启 Node 服务。**如果不改，邮件里的链接会指向 localhost，收件人点不开。**

---

## 想要固定域名（推荐，10 分钟）

临时域名每次重启都变，演示中途重启就废了。用固定域名更稳。

### 前提

- 一个域名（可以是你已有的任意域名，把 NS 交给 Cloudflare）
- 免费 Cloudflare 账号

### 步骤

```powershell
# 1. 登录（会打开浏览器，让你选域名授权）
cloudflared tunnel login

# 2. 建隧道（名字随意）
cloudflared tunnel create xiangfind
#    它会生成一个 JSON 凭证，路径形如
#    C:\Users\<你>\.cloudflared\<uuid>.json

# 3. 绑定域名
cloudflared tunnel route dns xiangfind xiangfind.你的域名.com

# 4. 写配置文件 %USERPROFILE%\.cloudflared\config.yml
```

```yaml
tunnel: xiangfind
credentials-file: C:\Users\<你>\.cloudflared\<uuid>.json

ingress:
  - hostname: xiangfind.你的域名.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

```powershell
# 5. 启动（固定域名，重启地址不变）
cloudflared tunnel run xiangfind
```

这时 `.env` 里写：

```ini
PUBLIC_BASE_URL=https://xiangfind.你的域名.com
```

### 想让它开机自启

```powershell
cloudflared service install
# 之后由 Windows 服务管理，不用手动开窗口
```

---

## 演示当天的注意事项

| 事项 | 说明 |
|---|---|
| **电脑不能睡眠** | 设置 → 电源 → 睡眠改成「从不」；演示期间别合盖 |
| **网络不能断** | 断网隧道就断，地址立刻 502 |
| **服务要活着** | `npm start` 的窗口别关；崩了重启 |
| **先自测一遍** | 用手机流量（不连 WiFi）打开一次，别在老师面前第一次试 |
| **准备截图兜底** | 隧道断了就放截图讲流程（`docs/演示脚本.md` 里有预案） |

---

## 和路线 A 的取舍（一句话版）

| | B 隧道 | A 服务器 |
|---|---|---|
| 成本 | 0 | ¥25-60/月 |
| 上线时间 | 10 分钟 | 1-2 小时 |
| 稳定性 | 依赖你的电脑开着 | 7×24 |
| 适合 | **11/23 演示** | 演示后长期用 |

**两者不冲突**：可以先用 B 应付 11/23，之后再迁到 A。迁移时只换 `PUBLIC_BASE_URL` 和 nginx，代码不动。

---

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开显示 502 | Node 服务没起或端口不对 | `curl http://127.0.0.1:3000/health` 确认 |
| `cloudflared` 命令找不到 | 没进 PATH | 用全路径 `D:\DeepseekWork\tools\cloudflared.exe` |
| 隧道连不上 | 公司/校园网限制出站 | 换手机热点试试 |
| 地址能开但很慢 | 走的境外节点 | 正常现象，演示时提前打开预热 |
| 图片打不开 | 上传目录权限 | 确认 `uploads/` 存在且服务能写 |
