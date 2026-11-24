// 清理「僵尸注册」：建了账号但一直没完成邮箱验证的记录
//
// 为什么需要（issue #154）：
//   注册时就把账号写进 users（email_verified_at = NULL），验证只是打时间戳。
//   用户放弃验证后，这个账号会一直占着学号与邮箱；虽然现在允许用同一学号
//   覆盖重注册（方案 B），但历史上残留的、以及换了学号重来的记录仍需清理。
//
// 安全设计：
//   · 默认**预演**，只列出会删什么，不动数据
//   · 必须显式 `--apply` 才真删；再加 `--yes` 跳过交互提醒
//   · 只删 `email_verified_at IS NULL` 且超过时限的账号（默认 24 小时）
//   · 演示账号（DEMO_USER_IDS）永不删除
//   · 有物品/认领/消息的账号**一律不删**（理论上未验证账号发不了，但要挡住意外）
//   · 删除走 users 上的 ON DELETE CASCADE，同时显式清 email_tokens，便于统计行数
//
// 用法：
//   node scripts/clean-unverified.mjs                      # 预演（默认 24 小时）
//   node scripts/clean-unverified.mjs --hours 6            # 预演：6 小时以上未验证
//   node scripts/clean-unverified.mjs --apply --yes        # 真删
//   node scripts/clean-unverified.mjs --db data/x.db       # 指定库
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DEMO_USER_IDS } from '../src/db/demo.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const YES = args.includes('--yes');
const dbIdx = args.indexOf('--db');
const hoursIdx = args.indexOf('--hours');
const HOURS = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : 24;
const DB = resolve(dbIdx >= 0 ? args[dbIdx + 1] : process.env.DATABASE_PATH || './data/xiangfind.db');

if (!Number.isFinite(HOURS) || HOURS <= 0) {
  console.error('--hours 需要一个正数，例如 --hours 24');
  process.exit(1);
}
if (!existsSync(DB)) {
  console.error(`数据库不存在：${DB}`);
  process.exit(1);
}

const db = new DatabaseSync(DB);
db.exec('PRAGMA foreign_keys = ON');

const cutoff = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();
const keep = new Set(DEMO_USER_IDS);

const rows = db
  .prepare('SELECT id, student_id, name, email, role, created_at FROM users WHERE email_verified_at IS NULL ORDER BY created_at')
  .all();

const stale = [];
const skipped = [];
for (const u of rows) {
  if (keep.has(u.id)) { skipped.push([u, '演示账号']); continue; }
  if (new Date(u.created_at).getTime() > new Date(cutoff).getTime()) { skipped.push([u, `不足 ${HOURS} 小时`]); continue; }
  const busy =
    db.prepare('SELECT COUNT(*) AS c FROM items WHERE user_id = ?').get(u.id).c +
    db.prepare('SELECT COUNT(*) AS c FROM claims WHERE applicant_id = ?').get(u.id).c +
    db.prepare('SELECT COUNT(*) AS c FROM messages WHERE user_id = ?').get(u.id).c;
  if (busy > 0) { skipped.push([u, `有 ${busy} 条业务数据`]); continue; }
  stale.push(u);
}

console.log(`\n=== 清理未验证账号${APPLY ? '' : '（预演，不改数据）'} ===`);
console.log(`  库：${DB}`);
console.log(`  阈值：${HOURS} 小时（早于 ${cutoff}）`);
console.log(`  未验证账号共 ${rows.length} 个，待清理 ${stale.length} 个，跳过 ${skipped.length} 个\n`);

for (const [u, why] of skipped) {
  console.log(`    - 跳过 ${u.student_id}  ${u.email}  （${why}）`);
}
if (stale.length === 0) {
  console.log('\n  没有需要清理的账号。\n');
  db.close();
  process.exit(0);
}

console.log('\n  待清理：');
for (const u of stale) {
  console.log(`    · ${u.student_id}  ${u.name}  ${u.email}  注册于 ${u.created_at}`);
}

if (!APPLY) {
  console.log('\n  这是预演。要真删：加 --apply --yes\n');
  db.close();
  process.exit(0);
}
if (!YES) {
  console.log('\n  即将删除以上账号（级联删除其会话与验证码，业务数据为空才会计入）。');
  console.log('  确认无误请重跑并加 --yes：');
  console.log(`    node scripts/clean-unverified.mjs --db "${DB}" --hours ${HOURS} --apply --yes\n`);
  db.close();
  process.exit(0);
}

const ids = stale.map((u) => u.id);
const ph = ids.map(() => '?').join(',');
const counts = {};
db.exec('BEGIN');
try {
  counts.emailTokens = db.prepare(`DELETE FROM email_tokens WHERE user_id IN (${ph})`).run(...ids).changes;
  counts.sessions = db.prepare(`DELETE FROM sessions WHERE user_id IN (${ph})`).run(...ids).changes;
  counts.users = db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run(...ids).changes;
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`  ✗ 失败已回滚：${err.message}`);
  db.close();
  process.exit(1);
}

console.log('\n  已删除：');
for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(14)} ${v} 行`);
console.log(`\n  剩余账号：${db.prepare('SELECT COUNT(*) AS c FROM users').get().c} 个\n`);
db.close();
