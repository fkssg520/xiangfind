# 接口契约（前后端对齐用）

> 用途：前端（小冯）按此写 mock，后端（小灰）按此实现，**字段名以此为准**。
> 路径与状态码来自 `docs/需求基线.md` 第 9 节；字段名是本文件的约定。
> 发现不一致 → 开 `to:xiaohui` + `kind:question` 的 issue，不要各自改。

## 0. 全局约定

| 项 | 约定 |
|---|---|
| 编码 | JSON，`content-type: application/json; charset=utf-8` |
| 时间 | 一律 UTC ISO 8601 字符串，如 `2026-11-18T09:38:11.000Z`；前端按本地时区展示 |
| ID | 字符串，带前缀：`usr_` `itm_` `clm_` `msg_` `stp_` |
| 错误体 | `{ "error": { "code": "字段名或短码", "message": "中文说明" } }` |
| 状态码 | 400 参数错 / 401 未登录 / 403 无权限 / 404 不存在 / 409 冲突 / 429 限流 / 500 服务端 |
| 分页 | `?page=1&pageSize=20`，响应带 `total` |

## 1. 会话

### POST /api/auth/login
请求：`{ "studentId": "2023xxxx", "password": "..." }`
响应 200：
```json
{ "user": { "id": "usr_01", "studentId": "2023xxxx", "name": "张三", "email": "a@b.c",
            "role": "student", "isVolunteer": false, "emailVerified": true } }
```

### GET /api/me
响应 200：`{ "user": { ...同上..., "phone": "", "contact": "" } }`　未登录 → 401

### POST /api/auth/logout
响应 204（无正文）

## 2. 物品列表

### GET /api/items?type=found&category=电子&status=stored&q=耳机&page=1&pageSize=20

响应 200：
```json
{
  "items": [
    {
      "id": "itm_01",
      "type": "found",
      "title": "白色蓝牙耳机",
      "category": "电子产品",
      "summary": "描述前 60 字……",
      "location": "图书馆三楼自习区",
      "eventAt": "2026-11-17T02:00:00.000Z",
      "valueLevel": "normal",
      "status": "stored",
      "images": [{ "url": "/uploads/xxx.webp", "sortOrder": 0 }],
      "author": { "id": "usr_01", "name": "李四", "isVolunteer": false },
      "storagePoint": { "id": "stp_01", "name": "图书馆服务台", "type": "normal" },
      "createdAt": "2026-11-17T03:12:00.000Z",
      "isFavorited": false
    }
  ],
  "total": 42, "page": 1, "pageSize": 20
}
```

> **绝不返回**：完整邮箱、电话、QQ、微信。列表里作者只给 `id + name + isVolunteer`。

## 3. 物品详情

### GET /api/items/:id
在列表项基础上增加：
```json
{
  "description": "完整描述……",
  "matches": [{ "itemId": "itm_02", "score": 78, "reasons": ["分类一致","时间接近"], "title": "丢失白色耳机" }],
  "claim": { "id": "clm_01", "status": "pending", "canReview": true },
  "contact": null,
  "isOwner": false
}
```
- `contact`：仅当认领通过（`ready_for_pickup`/`returned`）且请求者是双方之一时才有值，
  形如 `{ "name":"张三","phone":"138****","email":"a@b.c" }`，否则 `null`
- `matches` 只给摘要（`itemId/title/score/reasons`），不给对方联系方式

## 4. 发布

### POST /api/items
```json
{
  "type": "found",
  "title": "白色蓝牙耳机",
  "category": "电子产品",
  "description": "……",
  "location": "图书馆三楼自习区",
  "eventAt": "2026-11-17T02:00:00.000Z",
  "valueLevel": "valuable",
  "storagePointId": "stp_02",
  "imageIds": ["img_01"]
}
```
响应 201：`{ "item": { ...详情对象... } }`
约束：`found` 必须有 `storagePointId`；`valuable` 的存放点必须是 `security` 类型，否则 400。

## 5. 认领

### POST /api/items/:id/claims
请求：`{ "note": "物品特征与丢失经过……" }`
响应 201：`{ "claim": { "id":"clm_01","status":"pending" } }`
约束：不能申请自己的物品（400）；同一物品同一用户只能有一条 pending（409）。

### POST /api/claims/:id/decision
请求：`{ "decision": "approve", "note": "核对无误" }`　`decision` ∈ `approve | reject | agree`
响应 200：`{ "claim": { "id":"clm_01", "status":"approved" }, "item": { "id":"itm_01", "status":"ready_for_pickup" } }`

## 6. 消息

### GET /api/messages?filter=unread
```json
{
  "messages": [
    { "id": "msg_01", "type": "claim", "title": "有人申请认领你的物品",
      "body": "……", "relatedType": "item", "relatedId": "itm_01",
      "readAt": null, "createdAt": "2026-11-18T01:00:00.000Z" }
  ],
  "unreadCount": 3
}
```

### POST /api/messages/:id/read　→ 204

## 7. 前端 mock 约定

- 放在 `public/mock/`，一个接口一个文件：`items.json`、`item-detail.json`、`messages.json`、`me.json`
- **字段名必须和本文件一致**，值可用假数据（不得含真实学生信息）
- 切换真实接口时只改 `app.js` 里的 `fetch` 前缀，不改字段映射
