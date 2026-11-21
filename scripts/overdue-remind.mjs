// 物品超期未领取提醒（需求基线 §4.8 表 6：物品超期未领取 → 申请人和管理员）
// 与 archive.mjs 同类：默认预演，加 --apply 才真写消息；7 天内同一物品同一用户只提醒一次
//
// 用法：
//   node scripts/overdue-remind.mjs                 # 预演
//   node scripts/overdue-remind.mjs --apply         # 真发消息
//   node scripts/overdue-remind.mjs --days 3 --apply
// 建议放进 cron：每天 09:00
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { notifyOnce } from '../src/lib/notify.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const daysIdx = args.indexOf('--days');
const DAYS = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 7;

const DB_PATH = resolve(process.env.DATABASE_PATH || './data/xiangfind.db');
if (!existsSync(DB_PATH)) {
  console.error(`数据库不存在：${DB_PATH}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const cutoff = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString();

// 待领取且超过 N 天没动静的物品
const rows = db
  .prepare(
    `SELECT i.id, i.title, i.user_id, i.updated_at,
            (SELECT applicant_id FROM claims WHERE item_id = i.id AND status = 'approved' LIMIT 1) AS applicant_id
       FROM items i
      WHERE i.status = 'ready_for_pickup' AND i.updated_at <= ?
      ORDER BY i.updated_at`
  )
  .all(cutoff);

const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all().map((r) => r.id);

console.log(`\n=== 超期未领取提醒${apply ? '' : '（预演，不发消息）'} ===`);
console.log(`  阈值：待领取超过 ${DAYS} 天（截止 ${cutoff}）`);
console.log(`  命中物品：${rows.length} 条，管理员 ${admins.length} 人\n`);

if (rows.length === 0) {
  console.log('  没有超期未领取的物品。\n');
  db.close();
  process.exit(0);
}

let sent = 0;
let skippedDup = 0;

for (const it of rows) {
  const overdueDays = Math.floor((Date.now() - new Date(it.updated_at).getTime()) / (24 * 3600 * 1000));
  const title = '物品超期未领取';
  const body = `「${it.title}」已待领取 ${overdueDays} 天，请尽快到存放点领取或联系管理员处理。`;

  const targets = [];
  if (it.applicant_id) targets.push(it.applicant_id);
  for (const a of admins) targets.push(a);

  console.log(`  · ${it.id}  ${it.title}  待领取 ${overdueDays} 天  → 通知 ${targets.length} 人`);

  if (!apply) continue;
  for (const uid of targets) {
    const ok = notifyOnce(db, uid, title, body, it.id, 24 * 7);
    if (ok) sent += 1;
    else skippedDup += 1;
  }
}

if (!apply) {
  console.log(`\n  这是预演。要真发消息：加 --apply\n`);
  db.close();
  process.exit(0);
}

console.log(`\n  已发送 ${sent} 条，跳过重复 ${skippedDup} 条\n`);
db.close();
process.exit(0);
