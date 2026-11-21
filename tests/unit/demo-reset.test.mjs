// 「恢复演示数据」的语义：必须能清掉测试遗留，回到已知状态
// 2026-11-21 修正的 bug：原实现只删固定 DEMO_ITEM_IDS，
// 演示账号在测试时新建的物品不会被删（公网实例残留 20+ 条测试数据）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resetDemo, DEMO_ITEM_IDS, DEMO_USER_IDS } from '../../src/db/demo.js';

const SCHEMA = readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  resetDemo(db); // 先播种出基线
  return db;
}

function insertJunkItem(db, id, title) {
  db.prepare(
    `INSERT INTO items (id,user_id,type,title,category,description,event_at,location,value_level,storage_point_id,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, DEMO_USER_IDS[1], 'found', title, '其他',
    '这是测试遗留数据，描述需要够长才能通过校验。', '2026-11-20T00:00:00.000Z',
    '图书馆', 'normal', 'stp_demo_lib', 'stored',
    new Date().toISOString(), new Date().toISOString());
}

test('resetDemo 清掉演示账号新建的测试遗留', () => {
  const db = freshDb();
  insertJunkItem(db, 'itm_junk_1', '测试遗留 A');
  insertJunkItem(db, 'itm_junk_2', '测试遗留 B');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM items').get().c, DEMO_ITEM_IDS.length + 2);

  resetDemo(db);

  const titles = db.prepare('SELECT title FROM items').all().map((r) => r.title);
  assert.equal(titles.length, DEMO_ITEM_IDS.length, '只应剩下演示物品：' + titles.join(','));
  assert.ok(!titles.some((t) => t.startsWith('测试遗留')), '测试遗留必须被清掉');
});

test('resetDemo 清空业务表但保留用户与审计', () => {
  const db = freshDb();
  const usersBefore = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  db.prepare('INSERT INTO audit_logs (id,actor_id,action,target_type,target_id,summary,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('aud_keep', 'usr_demo_admin', 'test.action', 'system', '', '这条审计应保留', new Date().toISOString());

  resetDemo(db);

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, usersBefore, '用户不应被删');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE id = ?').get('aud_keep').c, 1,
    '审计日志不应被删（需求基线 §4.10 要求可追溯）');
});

test('resetDemo 是幂等的：连跑两次结果一致', () => {
  const db = freshDb();
  insertJunkItem(db, 'itm_junk_3', '测试遗留 C');
  resetDemo(db);
  const first = db.prepare('SELECT id FROM items ORDER BY id').all().map((r) => r.id);
  resetDemo(db);
  const second = db.prepare('SELECT id FROM items ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(second, first, '两次恢复应得到同一组演示物品');
  assert.equal(second.length, DEMO_ITEM_IDS.length);
});

test('resetDemo 之后没有悬挂的认领/消息引用', () => {
  const db = freshDb();
  insertJunkItem(db, 'itm_junk_4', '测试遗留 D');
  db.prepare('INSERT INTO claims (id,item_id,applicant_id,note,status,created_at) VALUES (?,?,?,?,?,?)')
    .run('clm_junk', 'itm_junk_4', DEMO_USER_IDS[1], '这是一条测试认领，说明需要够长。', 'pending', new Date().toISOString());

  resetDemo(db);

  const orphanClaims = db.prepare(
    'SELECT COUNT(*) AS c FROM claims WHERE item_id NOT IN (SELECT id FROM items)'
  ).get().c;
  const orphanMsgs = db.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE related_id IS NOT NULL AND related_type = 'item' AND related_id NOT IN (SELECT id FROM items)"
  ).get().c;
  assert.equal(orphanClaims, 0, '不应有指向已删物品的认领');
  assert.equal(orphanMsgs, 0, '不应有指向已删物品的消息');
});
