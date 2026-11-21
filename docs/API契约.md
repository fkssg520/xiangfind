# 接口契约（前后端对齐用）

> **字段名与状态码以此为准。** 前端按此写页面，后端按此实现。
> 发现不一致 → 开 `to:xiaohui` + `kind:question` 的 issue，**不要各自改**。
> 最后同步：2026-11-19 · 对应 `main` 上的实现

## 0. 全局约定

| 项 | 约定 |
|---|---|
| 编码 | JSON，`content-type: application/json; charset=utf-8` |
| 时间 | 一律 UTC ISO 8601，如 `2026-11-18T09:38:11.000Z`；前端按本地时区展示 |
| ID | 字符串，带前缀：`usr_` `itm_` `clm_` `msg_` `stp_` `img_` `mtc_`。**可能含 `-` 和 `_`**（base64url） |
| 错误体 | `{ "error": { "code": "短码", "message": "中文说明" } }` |
| 状态码 | 400 参数错 / 401 未登录 / 403 无权限 / 404 不存在 / 409 冲突 / 429 限流 / 500 服务端 |
| 分页 | `?page=1&pageSize=20`，响应带 `total` / `page` / `pageSize` |
| CSRF | 所有写操作必须带 `x-csrf-token` 头，值取自 `xf_csrf` Cookie（`GET /` 会下发） |
| 会话 | HttpOnly Cookie `xf_sid`，7 天；前端不需要也不应该存 token |

---

# 一、认证

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/auth/register` | 公开 | 注册并发验证码 |
| POST | `/api/auth/verify-email` | 公开 | 验证邮箱，**成功后自动登录** |
| POST | `/api/auth/resend-code` | 公开 | 重发验证码，60 秒冷却 |
| POST | `/api/auth/login` | 公开 | 登录 |
| POST | `/api/auth/logout` | 登录 | 销毁会话，返回 204 |
| POST | `/api/auth/forgot-password` | 公开 | 发重置验证码（不透露邮箱是否存在） |
| POST | `/api/auth/reset-password` | 公开 | 用验证码改密码，**会踢掉该用户所有会话** |
| GET | `/api/me` | 登录 | 当前用户 |

### POST /api/auth/register

```json
{ "studentId": "20230001", "name": "张三", "email": "a@b.c", "password": "demo1234", "confirmPassword": "demo1234" }
```
→ `201 { "user": {...}, "codeSent": true, "delivery": "email" | "smtp_not_configured", "fallback": null }`

**`codeSent` 只在邮件真正发出时为 `true`**（即 `delivery === "email"`）。

| 字段 | 含义 |
|---|---|
| `codeSent` | 用户能否收到验证码 |
| `delivery` | `email` / `smtp_not_configured` / `nodemailer_missing` / `send_failed` / `cooldown` |
| `fallback` | 发信失败时为 `"log"`，此时验证码打在服务端日志 `[mail:fallback] ... code=XXXXXX` |

> 前端注意：`codeSent: false` 时必须提示「邮件发送失败，请稍后重试」，
> **不能显示「验证码已发送」**——否则用户会等一封永远不来的信。
> 演示现场若邮件通道故障，可从服务端日志取码救急。

约束：学号 6-20 位字母数字且唯一；邮箱唯一；密码 8-64 位且含字母与数字。

### 用户对象

```json
{ "id": "usr_x", "studentId": "20230001", "name": "张三", "email": "a@b.c",
  "role": "student", "isVolunteer": false, "emailVerified": true,
  "storagePoints": [] }
```

`storagePoints` 仅志愿者非空，形如 `[{ "id": "stp_x", "name": "图书馆一楼服务台", "type": "normal" }]`。
前端可用它**提前**判断"能确认哪些存放点的入库"，不必点一次再吃 403。

**`POST /api/auth/login` 返回的 user 与此结构一致**（同样带 `storagePoints`），
登录后首屏即可准确判断，不必再拉一次 `/api/me`。

---

# 二、物品

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/items` | **匿名可读** | 列表 + 筛选 + 分页 |
| POST | `/api/items` | 登录 | 发布 |
| GET | `/api/items/:id` | **匿名可读** | 详情 |
| PATCH | `/api/items/:id` | 登录 | 编辑 / 状态流转 |
| POST | `/api/items/:id/favorite` | 登录 | 收藏切换 |
| POST | `/api/items/:id/storage-confirm` | 志愿者/管理员 | 确认入库（等价 `PATCH status=stored`） |
| POST | `/api/items/:id/return` | 志愿者/管理员 | 确认归还 |
| GET | `/api/matches/:itemId` | 登录 | 匹配摘要 |

### GET /api/items 查询参数

| 参数 | 值 | 说明 |
|---|---|---|
| `type` | `lost` / `found` | |
| `category` | `证件` `电子产品` `钥匙` `书籍` `衣物` `其他` | |
| `status` | 见状态机 | 不传则**排除 `archived`** |
| `valueLevel` | `normal` / `valuable` | |
| `storagePointId` | `stp_*` | |
| `q` | 关键词 | 搜标题、描述、地点、分类 |
| `mine` | `1` | **只看我发布的**；匿名返回空 + `requiresLogin: true` |
| `fav` | `1` | **只看我收藏的**；匿名同上 |
| `page` / `pageSize` | 数字 | pageSize 上限 50 |

排序：进行中优先 → `created_at` 倒序。

响应：
```json
{ "items": [{
    "id": "itm_x", "type": "found", "title": "白色蓝牙耳机", "category": "电子产品",
    "summary": "描述前 60 字…", "location": "图书馆三楼", "eventAt": "2026-11-16T02:30:00.000Z",
    "valueLevel": "normal", "status": "stored",
    "images": [{ "url": "/uploads/x.webp", "sortOrder": 0 }],
    "author": { "id": "usr_x", "name": "张三", "isVolunteer": false },
    "storagePoint": { "id": "stp_x", "name": "图书馆服务台", "type": "normal" },
    "createdAt": "2026-11-16T03:10:00.000Z", "isFavorited": false
}], "total": 42, "page": 1, "pageSize": 20 }
```

> **列表与详情都不返回邮箱/电话/QQ/微信。** 联系方式只在认领通过后单独给。

### POST /api/items

```json
{ "type": "found", "title": "白色蓝牙耳机", "category": "电子产品",
  "description": "…", "location": "图书馆三楼", "eventAt": "2026-11-17T02:00:00.000Z",
  "valueLevel": "valuable", "storagePointId": "stp_02",
  "images": ["a1b2c3.png"] }
```
→ `201 { "item": {...详情对象...} }`

约束：`found` 必须有 `storagePointId`；`valuable` 必须指向 `security` 类型存放点；
标题不得是「东西/物品/失物/招领」；`eventAt` 不晚于当前；`images` 最多 3 个 fileName。

### GET /api/items/:id 额外字段

```json
{ "description": "完整描述", "matches": [{ "itemId": "itm_y", "title": "…", "score": 78,
    "reasons": ["分类一致","时间接近"] }],
  "claim": { "id": "clm_x", "status": "pending", "canReview": true, "publisherVerdict": null,
             "applicantName": "李四", "note": "…" } | null,
  "contact": null | { "name": "张三", "email": "a@b.c", "phone": "" },
  "isOwner": false }
```

`contact` 只在物品状态为 `ready_for_pickup` / `returned` 且请求者是发布者或已通过认领的申请人时非 null。

### 状态机（D-001）

| 类型 | 允许的状态 |
|---|---|
| `lost` | `open` → `reunited` → `archived` |
| `found` | `pending_storage` → `stored` → `claim_pending` → `ready_for_pickup` → `returned` → `archived` |

**确认入库（`stored`）权限**：所属存放点志愿者、管理员、保卫处（仅 security 点）。
**发布者本人不能确认入库**（需求基线 §3）。

无权限时返回两种 403，前端可区分：

| code | 含义 | message |
|---|---|---|
| `forbidden` | 角色本来就无权改这条物品 | 无权修改他人发布的信息 |
| `not_assigned_to_point` | 是志愿者/保卫处，但不是这个存放点的人 | 你不是该存放点的志愿者，无法确认入库 |

---

# 三、图片上传

### POST /api/uploads

`multipart/form-data`，字段名 `files`，一次最多 3 张，单张 ≤ 5MB。

```json
{ "files": [{ "fileName": "a1b2c3.png", "url": "/uploads/a1b2c3.png",
              "mimeType": "image/png", "size": 12345 }] }
```

- 类型按**文件头**判断，只接受 JPEG / PNG / WebP；扩展名与实际格式不符 → `400 ext_mismatch`
- 图片通过 `GET /uploads/<fileName>` 访问

---

# 四、存放点

### GET /api/storage-points（公开）

```json
{ "storagePoints": [{ "id": "stp_x", "name": "图书馆服务台", "type": "normal",
                      "address": "…", "hours": "08:00-22:00", "note": "" }] }
```
只返回 `enabled = 1` 的；按 `sort_order` 排序。**发布页不要硬编码存放点。**

---

# 五、认领（D-005 双签）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/items/:id/claims` | 登录 | 提交认领 |
| GET | `/api/items/:id/claims` | 登录 | 该物品的申请列表 |
| POST | `/api/claims/:id/decision` | 见下表 | 表态 / 终审 |
| GET | `/api/claims/mine` | 登录 | **我提交的认领**（个人中心） |

### POST /api/items/:id/claims

```json
{ "note": "至少 10 字的特征与经过说明" }
```
→ `201 { "claim": { "id": "clm_x", "itemId": "itm_x", "status": "pending", "itemStatus": "claim_pending" } }`

约束：只能认领 `found`；不能认领自己的；同物品同用户只能有一条 pending（409）。

### POST /api/claims/:id/decision —— **四种取值，含义不同**

| `decision` | 谁能调 | 效果 |
|---|---|---|
| `agree` | **只有发布者** | 表态同意，等待授权角色终审 |
| `reject` | 发布者 | 直接拒绝，物品退回 `stored` |
| `approve` | 所属点志愿者 / 管理员 / 保卫处 | **终审通过** → `ready_for_pickup`，其余 pending 自动拒绝 |
| `reject` | 同上（审核者） | 审核不通过 |

请求：`{ "decision": "approve", "note": "核对无误" }`

通过时响应：
```json
{ "claim": { "id": "clm_x", "status": "approved" },
  "item": { "id": "itm_x", "status": "ready_for_pickup" } }
```

> 发布者已 `reject` 后，授权角色不能强行 `approve` → `409 publisher_rejected`。

### GET /api/claims/mine

```json
{ "claims": [{ "id": "clm_x", "itemId": "itm_y", "itemTitle": "…", "itemStatus": "ready_for_pickup",
   "itemType": "found", "itemLocation": "…", "status": "approved", "note": "…",
   "reviewNote": "核对无误", "createdAt": "…", "reviewedAt": "…",
   "storagePoint": { "id": "stp_x", "name": "…", "address": "…", "hours": "…" } | null }] }
```
`storagePoint` 只在 `approved` 时非 null（去哪领）。

---

# 六、站内消息

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/messages?filter=all\|unread` | 登录 | 列表 + 未读数 |
| POST | `/api/messages/:id/read` | 登录 | 标记已读，204 |

```json
{ "messages": [{ "id": "msg_x", "type": "claim|match|system|storage", "title": "…", "body": "…",
   "relatedType": "item", "relatedId": "itm_x", "important": true,
   "readAt": null, "createdAt": "…" }], "unreadCount": 3 }
```

---

# 七、管理后台

**全部需要 `role = admin`**，非管理员一律 403。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/overview` | 概览计数 |
| GET | `/api/admin/users?q=` | 搜用户（学号/邮箱/姓名） |
| POST | `/api/admin/users/:id/volunteer` | 授予/移除志愿者 |
| POST | `/api/admin/users/:id/status` | 停用/启用（停用会踢会话） |
| POST | `/api/admin/users/:id/reset-password` | 替用户发重置验证码 |
| GET | `/api/admin/storage-points` | 存放点列表（含停用） |
| POST | `/api/admin/storage-points` | 新增 |
| PATCH | `/api/admin/storage-points/:id` | 修改 / 启停 |
| GET | `/api/admin/items` | 物品管理列表（含归档，可筛选） |
| GET | `/api/admin/claims?status=pending\|all` | 跨物品的申请列表 |
| POST | `/api/admin/messages` | 群发系统消息 |
| GET | `/api/admin/stats` | 导出统计 |
| POST | `/api/admin/recompute-matches` | 重算全部匹配（§7「数据修正后刷新」） |
| POST | `/api/admin/reset-demo` | 恢复演示数据（破坏性：**清空全部物品/认领/消息/匹配/收藏后重新播种**，保留账号、存放点、审计日志；见 D-016） |
| GET | `/api/admin/audit-logs?limit=50` | 审计日志 |

### 关键请求体

```jsonc
// 志愿者授权
{ "enabled": true, "storagePointIds": ["stp_a", "stp_b"] }
// 移除志愿者（清空绑定，角色回 student）
{ "enabled": false }

// 停用账号
{ "status": "disabled" }   // 或 "active"；不能停用自己或管理员

// 新增/修改存放点
{ "name": "…", "type": "normal|security", "address": "…", "hours": "…",
  "contactName": "…", "contactPhone": "…", "note": "…", "enabled": true, "sortOrder": 0 }

// 群发系统消息（二选一：role 或 userIds）
{ "role": "all|student|volunteer|admin", "userIds": ["usr_x"],
  "title": "1-60 字", "body": "1-1000 字" }
→ 201 { "ok": true, "recipients": 12 }
```

### 概览

```json
{ "users": 3, "volunteers": 1, "items": 4, "inProgress": 4, "pendingStorage": 1,
  "pendingClaims": 1, "returned": 0, "archived": 0, "unreadMessages": 1 }
```

### 导出统计

```json
{ "generatedAt": "…",
  "users": [{ "role": "student", "c": 2 }],
  "items": { "byStatus": [...], "byCategory": [...], "byType": [...] },
  "claims": [{ "status": "pending", "c": 1 }],
  "daily": [{ "day": "2026-11-19", "c": 4 }] }
```

---

# 八、健康检查

`GET /health` → 200 / 503

```json
{ "status": "ok", "service": "xiangfind", "version": "0.1.0", "uptime": 120,
  "time": "…", "database": "ok", "items": 4, "diskFreeMB": 325828, "uploads": "ok" }
```

生产环境 nginx 里限制为仅本机可访问。

---

# 九、前端 mock 约定

- 放 `public/mock/`，字段名必须和本文件一致
- 值可用假数据，**不得含真实学生信息**
- 接真实接口时只改 `fetch` 地址，不改字段映射
