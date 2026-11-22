# 公网演示步骤（agent-b 维护）

> 2026-11-21 实测可用：手机流量能打开，`A-01`（校外网络访问）已通过人类验证。
> 本文只写**当天怎么开**，原理见 `deploy/TUNNEL.md`。

---

## 一句话

```powershell
# 窗口 1：起服务
cd D:\Deepseek\xiangfind
npm start

# 窗口 2：起隧道
D:\Deepseek\tools\cloudflared.exe tunnel --url http://127.0.0.1:3000
```

窗口 2 会打印：

```
|  https://xxxx-xxxx-xxxx.trycloudflare.com  |
```

**那就是公网地址**，手机/别人的电脑都能打开。

---

## 演示当天完整步骤（5 分钟）

1. **起服务**（窗口 1）
   ```powershell
   cd D:\Deepseek\xiangfind
   npm start
   ```
   等到 `http://127.0.0.1:3000` 能打开。

2. **起隧道**（窗口 2）
   ```powershell
   D:\Deepseek\tools\cloudflared.exe tunnel --url http://127.0.0.1:3000
   ```
   复制打印出来的 `https://xxx.trycloudflare.com`。

3. **同步地址**（重要）
   把 `.env` 里的 `PUBLIC_BASE_URL` 改成新地址，然后**重启窗口 1 的服务**：
   ```
   PUBLIC_BASE_URL=https://xxx.trycloudflare.com
   ```
   > 不改的话，邮件正文里的链接会指向 `localhost`，别人点开是空的。

4. **手机验证**
   关掉 WiFi，用**移动流量**打开那个地址。能打开、能点进详情 = 成功。

5. **准备好截图兜底**
   见下方「出问题怎么办」。

---

## 四个必须知道的限制

| 限制 | 说明 |
|---|---|
| **地址每次变** | `trycloudflare.com` 是临时域名，**每次重启隧道都换一个**。演示当天必须重新拿地址。 |
| **电脑不能睡** | 服务进程 + 隧道进程都得活着。笔记本记得插电、关掉睡眠。 |
| **断网就全断** | 家里/宿舍网断了，公网地址立刻 502。手机热点可以作为备份网络。 |
| **免费隧道无 SLA** | Cloudflare 明说不保证可用性。**所以必须有截图兜底。** |

---

## 出问题怎么办

| 现象 | 原因 | 处理 |
|---|---|---|
| 公网地址打不开 | 隧道进程挂了 | 看窗口 2 是否还在，重开一次（地址会变，记得改 `.env`） |
| 打开是 502 | 服务没起 / 崩了 | 看窗口 1，`npm start` 重起 |
| 手机能开、电脑打不开 | 本机 DNS/代理干扰 | 用 `http://127.0.0.1:3000` 演示 |
| 完全连不上 | 网络断了 | **切截图兜底**，口头讲流程 |
| 演示中途断了 | 隧道掉线 | 别重启演示环境；改用本机地址继续讲，事后补发地址 |

---

## 截图兜底（建议提前拍好）

三条主线各准备一组：

1. 游客广场 → 搜索 → 详情
2. 学生发布（含图片）→ 志愿者确认入库 → 匹配列表
3. 认领申请 → 发布者同意 → 志愿者终审 → 待领取 → 确认归还

拍好后放本地，演示时直接当图片放。

---

## 为什么不用云服务器

`deploy/` 里有完整的 nginx + systemd 方案，但需要：买 VPS、配域名、开 443、可能涉及备案。
**11/23 前做不完，也不该在这时候冒险。** 隧道方案够用，缺点是依赖这台机器。

---

## 记录

- 2026-11-21 14:00 首次打通，地址 `https://upgrade-stockings-green-over.trycloudflare.com`
- 下载 `cloudflared.exe`（52.9 MB）花了约 15 分钟：GitHub 直连被反复重置，最后靠
  `curl --ssl-no-revoke --http1.1 -C - --limit-rate 400k` 断点续传完成。
  **装过一次就不用再装**，文件在 `D:\Deepseek\tools\cloudflared.exe`。

---

## ⚠️ 实测踩过的坑：隧道会「自己死」

**2026-11-21 16:50 实测**：隧道域名解析正常，但访问返回

```
HTTP 530  Cloudflare Tunnel error
```

原因：`cloudflared` 进程不在了（**关掉终端窗口就跟着死**）。地址还是好的，但后面没人接。

### 两条硬性规定

**① 用隐藏窗口起隧道**（不要把 cloudflared 跑在前台终端里）

```powershell
Start-Process -FilePath "D:\DeepseekWork\tools\cloudflared.exe" `
  -ArgumentList 'tunnel','--protocol','http2','--url','http://127.0.0.1:3000','--no-autoupdate' `
  -WindowStyle Hidden `
  -RedirectStandardError "$env:TEMP\cf.log"

# 看地址
Get-Content "$env:TEMP\cf.log" | Select-String 'trycloudflare.com'
```

**② 关掉睡眠**（电脑睡了，服务和隧道一起停）

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

演示结束再改回来：`powercfg /change standby-timeout-ac 30`。

### 演示前 30 秒自检

```powershell
curl -s -o NUL -w "%{http_code}" https://你的地址/health
# 期望 200；530 就是隧道死了，按上面重拉
```
---

## ⚠️ 更关键的一条：进程不能靠 `Start-Process` 起（会被回收）

2026-11-22 实测：用 `Start-Process ... -WindowStyle Hidden` 起的 `node` / `cloudflared`，
**在那条 PowerShell 命令结束时会被回收**——日志里有 `Registered tunnel connection`，
但几秒后公网就是 530，因为进程已经没了。

**正确做法：把服务和隧道都作为「长驻后台任务」启动**（本会话用 `run_in_background` 的方式），
而不是一次性命令里的 `Start-Process`。

判断进程是否真活着：

```powershell
curl -s -o NUL -w "%{http_code}" http://127.0.0.1:3000/health   # 200 才算活
```

> 这个坑的表现和"隧道被封"一模一样（都是 530/000），所以**先确认进程还在**，再怀疑网络。

## 2026-11-22 的实测结果（本机可当演示主机）

之前测过本机隧道返回 `000`，11/22 晚复测**通了**（三次全 200）。所以出网策略会变，**换网络环境要重测**。

实测：公网地址上跑完整彩排（发布 → 入库 → 匹配 → 认领双签 → 归还）**20/20 通过**。