// 数据保留策略（计划书 OI-10）
// 已归还满 90 天 → 归档；归档满 365 天 → 连同图片/申请/消息/匹配一起清除
// 默认 dry-run，只有传 dryRun:false 才真的改库
import { nowIso } from '../lib/id.js';

export const DEFAULTS = {
  returnedKeepDays: 90,
  archivedKeepDays: 365,
};

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

export function previewArchive(db, opts = {}) {
  const returnedKeepDays = Number(opts.returnedKeepDays ?? DEFAULTS.returnedKeepDays);
  const archivedKeepDays = Number(opts.archivedKeepDays ?? DEFAULTS.archivedKeepDays);
  const returnedCutoff = daysAgo(returnedKeepDays);
  const archivedCutoff = daysAgo(archivedKeepDays);

  const toArchive = db
    .prepare(`SELECT id, title, returned_at, updated_at FROM items
               WHERE status = 'returned'
                 AND COALESCE(returned_at, updated_at) <= ?
               ORDER BY COALESCE(returned_at, updated_at)`)
    .all(returnedCutoff);

  const toPurge = db
    .prepare(`SELECT id, title, archived_at, updated_at FROM items
               WHERE status = 'archived'
                 AND COALESCE(archived_at, updated_at) <= ?
               ORDER BY COALESCE(archived_at, updated_at)`)
    .all(archivedCutoff);

  return { returnedKeepDays, archivedKeepDays, returnedCutoff, archivedCutoff, toArchive, toPurge };
}

// 真正执行：归档 + 清除（同一事务）
export function runArchive(db, opts = {}) {
  const plan = previewArchive(db, opts);
  const dryRun = opts.dryRun !== false;

  if (dryRun) return { ...plan, dryRun: true, archived: 0, purged: 0 };

  const now = nowIso();
  let archived = 0;
  let purged = 0;
  const purgedFiles = [];

  db.exec('BEGIN');
  try {
    const markArchived = db.prepare("UPDATE items SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ? AND status = 'returned'");
    for (const it of plan.toArchive) {
      archived += markArchived.run(now, now, it.id).changes || 0;
    }

    for (const it of plan.toPurge) {
      const files = db.prepare('SELECT file_name FROM item_images WHERE item_id = ?').all(it.id).map((r) => r.file_name);
      purgedFiles.push(...files);

      db.prepare('DELETE FROM claims WHERE item_id = ?').run(it.id);
      db.prepare('DELETE FROM messages WHERE related_id = ? AND related_type = \'item\'').run(it.id);
      db.prepare('DELETE FROM matches WHERE lost_item_id = ? OR found_item_id = ?').run(it.id, it.id);
      db.prepare('DELETE FROM favorites WHERE item_id = ?').run(it.id);
      db.prepare('DELETE FROM item_images WHERE item_id = ?').run(it.id);
      purged += db.prepare('DELETE FROM items WHERE id = ?').run(it.id).changes || 0;
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { ...plan, dryRun: false, archived, purged, purgedFiles };
}
