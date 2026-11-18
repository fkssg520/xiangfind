# 接口样例（fixtures）

> 用途：前端照这里的**真实响应结构**写页面，不用自己猜嵌套和边界。
> 这些是样例，不是 mock 服务；字段名以 `docs/API契约.md` 为准，两者不一致时以契约为准。

| 文件 | 对应接口 | 说明 |
|---|---|---|
| `items.json` | `GET /api/items` | 列表，含 lost/found 混合、valuable、`storagePoint: null`、已收藏 |
| `item-detail.json` | `GET /api/items/:id` | 详情，含 `matches`、`claim`、`contact: null`（未通过认领时的样子） |
| `messages.json` | `GET /api/messages` | 消息列表 + `unreadCount` |
| `me.json` | `GET /api/me` | 当前用户 |

## 写页面时要注意的边界

1. **`storagePoint` 可能是 `null`**（失物帖没有存放点）——卡片和详情都要能容错
2. **`images` 可能是空数组**——必须有占位样式，不能塌陷
3. **`matches` 分数从 45 起**，低于 70 不弹通知；`reasons` 是中文短语数组，直接展示
4. **`claim.publisherVerdict`**：`null` / `"agree"` / `"reject"`，对应 D-005 双签的第一阶段
5. **状态取值**按 D-001：lost 是 `open/reunited/archived`，found 是另外六个，**不要穷举错**
6. **时间全是 UTC ISO 8601**，展示前转本地时区（`new Date(s).toLocaleString()`）
7. **`contact`**：未通过认领时是 `null`，通过后是 `{name, phone, email}` 对象——判空再渲染

## 接真实接口时

只改 `app.js` 里的 `fetch` 前缀，**不要改字段映射**。发现契约与样例不一致，开 issue 找我。
