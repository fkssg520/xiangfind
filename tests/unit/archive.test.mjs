// 数据保留策略单元测试（内存库）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { previewArchive, runArchive, DEFAULTS } from '../../src/services/archive.js';

const SCHEMA = readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8');

const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id,student_id,name,email,email_verified_at,password_hash,phone,contact,role,status,created_at)
              VALUES ('usr_a','20230001','甲','a@demo.local',?,'x','','','student','active',?)`).run(now, now);
  db.prepare(`INSERT INTO storage_points (id,name,type,address,hours,contact_name,contact_phone,note,enabled,sort_order,created_at)
              VALUES ('stp_n','普通点','normal','地址','08:00-22:00','','','',1,0,?)`).run(now);
  return db;
}

function addItem(db, { id, status, when, title = '测试物品' }) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO items (id,user_id,type,title,category,description,event_at,location,
              value_level,storage_point_id,status,created_at,updated_at, returned_at, archived_at)
              VALUES (?, 'usr_a','found',?,'其他','描述文本','${now}','地点','normal','stp_n',?,?,?,?,?)`)
    .run(id, title, status, now, when, status === 'returned' ? when : null, status === 'archived' ? when : null);
}

test('默认保留期符合 OI-10：归还 90 天、归档 365 天', () => {
  assert.equal(DEFAULTS.returnedKeepDays, 90);
  assert.equal(DEFAULTS.archivedKeepDays, 365);
});

test('超过 90 天的已归还会被归档', () => {
  const db = freshDb();
  addItem(db, { id: 'itm_old', status: 'returned', when: daysAgo(100) });
  addItem(db, { id: 'itm_new', status: 'returned', when: daysAgo(10) });

  const plan = previewArchive(db);
  assert.deepEqual(plan.toArchive.map((i) => i.id), ['itm_old']);
});

test('超过 365 天的归档会被清除，且连带申请/消息/匹配/收藏', () => {
  const db = freshDb();
  addItem(db, { id: 'itm_dead', status: 'archived', when: daysAgo(400) });
  addItem(db, { id: 'itm_alive', status: 'archived', when: daysAgo(100) });

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO claims (id,item_id,applicant_id,note,status,created_at) VALUES ('clm_1','itm_dead','usr_a','说明够长了够长了','pending',?)`).run(now);
  db.prepare(`INSERT INTO messages (id,user_id,type,title,body,related_type,related_id,important,read_at,created_at)
              VALUES ('msg_1','usr_a','system','标题','正文','item','itm_dead',1,NULL,?)`).run(now);
  db.prepare(`INSERT INTO favorites (id,user_id,item_id,created_at) VALUES ('fav_1','usr_a','itm_dead',?)`).run(now);
  db.prepare(`INSERT INTO item_images (id,item_id,file_name,mime_type,size,sort_order,created_at)
              VALUES ('img_1','itm_dead','pic.png','image/png',100,0,?)`).run(now);

  const plan = previewArchive(db);
  assert.deepEqual(plan.toPurge.map((i) => i.id), ['itm_dead']);

  const out = runArchive(db, { dryRun: false });
  assert.equal(out.purged, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM items WHERE id = 'itm_dead'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM claims WHERE item_id = 'itm_dead'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE related_id = 'itm_dead'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM favorites WHERE item_id = 'itm_dead'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM item_images WHERE item_id = 'itm_dead'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM items WHERE id = 'itm_alive'").get().c, 1, '未超期的不动');
});

test('dry-run 默认不修改数据库', () => {
  const db = freshDb();
  addItem(db, { id: 'itm_old', status: 'returned', when: daysAgo(200) });
  const out = runArchive(db, {});
  assert.equal(out.dryRun, true);
  assert.equal(db.prepare("SELECT status FROM items WHERE id = 'itm_old'").get().status, 'returned');
});

test('执行归档后状态与 archived_at 都更新', () => {
  const db = freshDb();
  addItem(db, { id: 'itm_old', status: 'returned', when: daysAgo(120) });
  const out = runArchive(db, { dryRun: false });
  assert.equal(out.archived, 1);
  const row = db.prepare("SELECT status, archived_at FROM items WHERE id = 'itm_old'").get();
  assert.equal(row.status, 'archived');
  assert.ok(row.archived_at, 'archived_at 应写入');
});

test('自定义保留期生效', () => {
  const db = freshDb();
  addItem(db, { id: 'itm_30', status: 'returned', when: daysAgo(40) });
  assert.equal(previewArchive(db).toArchive.length, 0, '默认 90 天不归档');
  assert.equal(previewArchive(db, { returnedKeepDays: 30 }).toArchive.length, 1, '改成 30 天就归档');
});

test('没有超期数据时返回空计划', () => {
  const db = freshDb();
  addItem(db, { id: 'itm_new', status: 'returned', when: daysAgo(1) });
  const plan = previewArchive(db);
  assert.equal(plan.toArchive.length, 0);
  assert.equal(plan.toPurge.length, 0);
});
