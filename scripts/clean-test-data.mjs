// 清理 E2E / 测试遗留数据
// 只认标题前缀，默认预演；加 --apply 才真删，且按关联表顺序删（避免孤儿记录）
//
// 用法：
//   node scripts/clean-test-data.mjs                 # 预演，列出会删什么
//   node scripts/clean-test-data.mjs --apply         # 真删
//   node scripts/clean-test-data.mjs --prefix "E2E " --apply
//   node scripts/clean-test-data.mjs --all-test-users --apply   # 连测试账号一起清
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const withUsers = args.includes('--all-test-users');
const prefixIdx = args.indexOf('--prefix');
const PREFIX = prefixIdx >= 0 ? args[prefixIdx + 1] : 'E2E ';

// 测试账号特征：邮箱或学号带明显测试标记
const TEST_USER_PATTERNS = ['%@e2e.test', '%@demo.local', '%@test.local'];

const DB_PATH = resolve(process.env.DATABASE_PATH || './data/xiangfind.db');
if (!existsSync(DB_PATH)) {
  console.error(`数据库不存在：${DB_PATH}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

console.log(`\n=== 测试数据清理${apply ? '' : '（预演，不改数据）'} ===`);
console.log(`  数据库：${DB_PATH}`);
console.log(`  标题前缀：${JSON.stringify(PREFIX)}`);

// 1) 找出要删的物品
const items = db.prepare('SELECT id, title, status, created_at FROM items WHERE title LIKE ? ORDER BY created_at').all(`${PREFIX}%`);
console.log(`\n  匹配物品：${items.length} 条`);
for (const it of items.slice(0, 20)) {
  console.log(`    · ${it.id}  ${it.title}  (${it.status}, ${it.created_at})`);
}
if (items.length > 20) console.log(`    … 还有 ${items.length - 20} 条`);

// 2) 统计会被连带删除的关联记录
const ids = items.map((i) => i.id);
const inList = ids.length ? ids.map(() => '?').join(',') : null;
const countRel = (table, col) => (inList ? db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} IN (${inList})`).get(...ids).c : 0);
const rel = {
  claims: countRel('claims', 'item_id'),
  item_images: countRel('item_images', 'item_id'),
  favorites: countRel('favorites', 'item_id'),
  messages: (inList ? db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE related_type = 'item' AND related_id IN (${inList})`).get(...ids).c : 0),
  matches: (inList ? db.prepare(`SELECT COUNT(*) AS c FROM matches WHERE lost_item_id IN (${inList}) OR found_item_id IN (${inList})`).get(...ids, ...ids).c : 0),
};
console.log('\n  连带删除：');
for (const [k, v] of Object.entries(rel)) console.log(`    ${k.padEnd(12)} ${v}`);

// 3) 测试账号
let users = [];
if (withUsers) {
  const where = TEST_USER_PATTERNS.map(() => 'email LIKE ?').join(' OR ');
  users = db.prepare(`SELECT id, student_id, email FROM users WHERE ${where}`).all(...TEST_USER_PATTERNS);
  console.log(`\n  匹配测试账号：${users.length} 个`);
  for (const u of users.slice(0, 10)) console.log(`    · ${u.student_id}  ${u.email}`);
}

const total = items.length + Object.values(rel).reduce((a, b) => a + b, 0) + users.length;
if (total === 0) {
  console.log('\n  没有需要清理的数据。\n');
  db.close();
  process.exit(0);
}

if (!apply) {
  console.log('\n  这是预演。真要删：加 --apply');
  console.log('  （建议先备份：powershell -File scripts/backup.ps1）\n');
  db.close();
  process.exit(0);
}

// 4) 真删：先关联后主表，事务包裹
db.exec('BEGIN');
try {
  if (ids.length) {
    db.prepare(`DELETE FROM claims WHERE item_id IN (${inList})`).run(...ids);
    db.prepare(`DELETE FROM messages WHERE related_type = 'item' AND related_id IN (${inList})`).run(...ids);
    db.prepare(`DELETE FROM matches WHERE lost_item_id IN (${inList}) OR found_item_id IN (${inList})`).run(...ids, ...ids);
    db.prepare(`DELETE FROM favorites WHERE item_id IN (${inList})`).run(...ids);
    db.prepare(`DELETE FROM item_images WHERE item_id IN (${inList})`).run(...ids);
    db.prepare(`DELETE FROM items WHERE id IN (${inList})`).run(...ids);
  }
  if (users.length) {
    const uIds = users.map((u) => u.id);
    const uIn = uIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM sessions WHERE user_id IN (${uIn})`).run(...uIds);
    db.prepare(`DELETE FROM email_tokens WHERE user_id IN (${uIn})`).run(...uIds);
    db.prepare(`DELETE FROM volunteer_assignments WHERE user_id IN (${uIn})`).run(...uIds);
    db.prepare(`DELETE FROM items WHERE user_id IN (${uIn})`).run(...uIds);
    db.prepare(`DELETE FROM users WHERE id IN (${uIn})`).run(...uIds);
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`\n  清理失败，已回滚：${err.message}\n`);
  db.close();
  process.exit(1);
}

// 5) 复查：不该再有残留
const leftItems = db.prepare('SELECT COUNT(*) AS c FROM items WHERE title LIKE ?').get(`${PREFIX}%`).c;
const orphanClaims = db.prepare('SELECT COUNT(*) AS c FROM claims WHERE item_id NOT IN (SELECT id FROM items)').get().c;
console.log(`\n  已删除 ${items.length} 条物品、${users.length} 个测试账号`);
console.log(`  复查：残留匹配物品 ${leftItems} 条，孤儿认领 ${orphanClaims} 条`);
console.log(leftItems === 0 && orphanClaims === 0 ? '  CLEAN_OK\n' : '  CLEAN_INCOMPLETE\n');
db.close();
process.exit(leftItems === 0 && orphanClaims === 0 ? 0 : 1);
