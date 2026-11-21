// 清理"非演示账号"（演示前把测试注册的账号清掉）
//
// 为什么需要：`恢复演示数据`（reset-demo）只清业务表、**保留所有账号**，
// 所以测试时注册的账号会一直留在后台用户列表里（演示机曾残留 6 个）。
//
// 安全设计：
//   · 默认**预演**，只列出会删什么，不动数据
//   · 必须显式 `--apply` 才真删
//   · 演示账号（DEMO_USER_IDS：20230001 / 20230002 / 90000001）永不删除
//   · 删除前打印名单，删除后打印每张表的影响行数
//
// 用法：
//   node scripts/clean-demo-users.mjs                    # 预演（默认库）
//   node scripts/clean-demo-users.mjs --apply            # 真删
//   node scripts/clean-demo-users.mjs --db path/to.db    # 指定库
//   node scripts/clean-demo-users.mjs --apply --yes      # 跳过交互确认（CI 用）
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DEMO_USER_IDS } from '../src/db/demo.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const YES = args.includes('--yes');
const dbIdx = args.indexOf('--db');
const DB = resolve(dbIdx >= 0 ? args[dbIdx + 1] : process.env.DATABASE_PATH || './data/xiangfind.db');

if (!existsSync(DB)) {
  console.error(`数据库不存在：${DB}`);
  process.exit(1);
}

const db = new DatabaseSync(DB);
db.exec('PRAGMA foreign_keys = ON');

const keep = new Set(DEMO_USER_IDS);
const all = db.prepare('SELECT id, student_id, name, email, role, created_at FROM users ORDER BY created_at').all();
const victims = all.filter((u) => !keep.has(u.id));

console.log(`\n=== 清理非演示账号${APPLY ? '' : '（预演，不改数据）'} ===`);
console.log(`  库：${DB}`);
console.log(`  账号总数：${all.length}，保留演示账号：${keep.size}，待清理：${victims.length}\n`);

console.log('  保留：');
for (const u of all.filter((x) => keep.has(x.id))) {
  console.log(`    ✓ ${u.student_id}  ${u.name}  [${u.role}]`);
}

if (victims.length === 0) {
  console.log('\n  没有需要清理的账号。\n');
  db.close();
  process.exit(0);
}

console.log('\n  待清理：');
for (const u of victims) {
  const items = db.prepare('SELECT COUNT(*) AS c FROM items WHERE user_id = ?').get(u.id).c;
  console.log(`    · ${u.student_id}  ${u.name}  ${u.email}  [${u.role}]  物品 ${items} 条`);
}

if (!APPLY) {
  console.log('\n  这是预演。要真删：加 --apply\n');
  db.close();
  process.exit(0);
}

if (!YES) {
  console.log('\n  即将删除以上账号及其全部关联数据（物品/认领/消息/收藏/匹配/会话）。');
  console.log('  确认无误请重跑并加 --yes：');
  console.log(`    node scripts/clean-demo-users.mjs --db "${DB}" --apply --yes\n`);
  db.close();
  process.exit(0);
}

const ids = victims.map((u) => u.id);
const ph = ids.map(() => '?').join(',');
const counts = {};
db.exec('BEGIN');
try {
  // 先删这些用户名下物品的关联数据，再删物品
  const itemIds = db.prepare(`SELECT id FROM items WHERE user_id IN (${ph})`).all(...ids).map((r) => r.id);
  const iph = itemIds.map(() => '?').join(',');
  if (itemIds.length) {
    db.prepare(`DELETE FROM messages WHERE related_id IN (${iph})`).run(...itemIds);
    db.prepare(`DELETE FROM matches WHERE lost_item_id IN (${iph}) OR found_item_id IN (${iph})`).run(...itemIds, ...itemIds);
    db.prepare(`DELETE FROM favorites WHERE item_id IN (${iph})`).run(...itemIds);
    db.prepare(`DELETE FROM item_images WHERE item_id IN (${iph})`).run(...itemIds);
    db.prepare(`DELETE FROM claims WHERE item_id IN (${iph})`).run(...itemIds);
  }
  counts.items = db.prepare(`DELETE FROM items WHERE user_id IN (${ph})`).run(...ids).changes;
  counts.claimsAsApplicant = db.prepare(`DELETE FROM claims WHERE applicant_id IN (${ph})`).run(...ids).changes;
  counts.messages = db.prepare(`DELETE FROM messages WHERE user_id IN (${ph})`).run(...ids).changes;
  counts.favorites = db.prepare(`DELETE FROM favorites WHERE user_id IN (${ph})`).run(...ids).changes;
  counts.sessions = db.prepare(`DELETE FROM sessions WHERE user_id IN (${ph})`).run(...ids).changes;
  counts.emailTokens = db.prepare(`DELETE FROM email_tokens WHERE user_id IN (${ph})`).run(...ids).changes;
  counts.assignments = db.prepare(`DELETE FROM volunteer_assignments WHERE user_id IN (${ph})`).run(...ids).changes;
  counts.users = db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run(...ids).changes;
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`  ✗ 失败已回滚：${err.message}`);
  db.close();
  process.exit(1);
}

console.log('\n  已删除：');
for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(20)} ${v} 行`);
console.log(`\n  剩余账号：${db.prepare('SELECT COUNT(*) AS c FROM users').get().c} 个`);
console.log(`  剩余物品：${db.prepare('SELECT COUNT(*) AS c FROM items').get().c} 条\n`);
db.close();
