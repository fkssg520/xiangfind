// 站内消息写入（各 service 共用）
// 需求基线 §4.8 表 6 规定了触发规则，这里只负责落库
import { nowIso, ID } from './id.js';

export function notify(db, userId, title, body, relatedId = null, important = 0) {
  if (!userId) return;
  db.prepare(
    `INSERT INTO messages (id, user_id, type, title, body, related_type, related_id, important, read_at, created_at)
     VALUES (?, ?, 'system', ?, ?, 'item', ?, ?, NULL, ?)`
  ).run(ID.message(), userId, title, body, relatedId, important ? 1 : 0, nowIso());
}

// 去重：同一用户、同一标题、同一物品在 windowHours 内只发一次
export function notifyOnce(db, userId, title, body, relatedId, windowHours = 24 * 7) {
  if (!userId) return false;
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const dup = db
    .prepare('SELECT 1 AS x FROM messages WHERE user_id = ? AND title = ? AND related_id = ? AND created_at >= ?')
    .get(userId, title, relatedId, since);
  if (dup) return false;
  notify(db, userId, title, body, relatedId);
  return true;
}
