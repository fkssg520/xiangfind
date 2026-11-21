// 站内消息触发规则（需求基线 §4.8 表 6）——补上的两处漏项
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createItem, patchItem } from '../../src/services/items.js';
import { setVolunteer } from '../../src/services/admin.js';

const SCHEMA = readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  const insUser = db.prepare(`INSERT INTO users (id,student_id,name,email,email_verified_at,password_hash,phone,contact,role,status,created_at)
                              VALUES (?,?,?,?,?, 'x','','',?,'active',?)`);
  insUser.run('usr_admin', '90000001', '管理员', 'a@demo.local', now, 'admin', now);
  insUser.run('usr_stu', '20230001', '学生甲', 's@demo.local', now, 'student', now);
  insUser.run('usr_stu2', '20230002', '学生乙', 's2@demo.local', now, 'student', now);
  insUser.run('usr_vol', '20230003', '志愿者', 'v@demo.local', now, 'volunteer', now);
  db.prepare(`INSERT INTO storage_points (id,name,type,address,hours,contact_name,contact_phone,note,enabled,sort_order,created_at)
              VALUES ('stp_lib','图书馆服务台','normal','地址','08:00-22:00','','','',1,0,?)`).run(now);
  db.prepare('INSERT INTO volunteer_assignments (id,user_id,storage_point_id,assigned_by,created_at) VALUES (?,?,?,?,?)')
    .run('vas_1', 'usr_vol', 'stp_lib', 'usr_admin', now);
  return db;
}

const admin = { id: 'usr_admin', role: 'admin', email_verified_at: '2026-11-01T00:00:00.000Z', name: '管理员' };
const stu = { id: 'usr_stu', role: 'student', email_verified_at: '2026-11-01T00:00:00.000Z', name: '学生甲' };

const found = {
  type: 'found', title: '灰色保温杯', category: '其他',
  description: '杯底有划痕，在第八教学楼 201 捡到。', location: '第八教学楼 201',
  valueLevel: 'normal', storagePointId: 'stp_lib',
};

const msgsTo = (db, uid) => db.prepare('SELECT title, body FROM messages WHERE user_id = ? ORDER BY created_at').all(uid);

test('表 6：物品已存放 → 通知发布者', () => {
  const db = freshDb();
  const created = createItem(db, { viewer: stu, body: found });
  const id = created.body.item.id;
  patchItem(db, id, { viewer: admin, body: { status: 'stored' } });

  const list = msgsTo(db, 'usr_stu');
  const m = list.find((x) => x.title === '物品已存放');
  assert.ok(m, '发布者应收到「物品已存放」：' + JSON.stringify(list));
  assert.match(m.body, /图书馆服务台/, '正文应含存放点名称');
});

test('表 6：物品已存放 → 关注用户（收藏者）也收到', () => {
  const db = freshDb();
  const created = createItem(db, { viewer: stu, body: found });
  const id = created.body.item.id;
  db.prepare('INSERT INTO favorites (id,user_id,item_id,created_at) VALUES (?,?,?,?)')
    .run('fav_1', 'usr_stu2', id, new Date().toISOString());

  patchItem(db, id, { viewer: admin, body: { status: 'stored' } });
  const got = msgsTo(db, 'usr_stu2').find((x) => x.title === '关注的物品已存放');
  assert.ok(got, '收藏者应收到「关注的物品已存放」');
});

test('收藏者不会收到重复通知（notifyOnce）', () => {
  const db = freshDb();
  const created = createItem(db, { viewer: stu, body: found });
  const id = created.body.item.id;
  db.prepare('INSERT INTO favorites (id,user_id,item_id,created_at) VALUES (?,?,?,?)')
    .run('fav_1', 'usr_stu2', id, new Date().toISOString());

  patchItem(db, id, { viewer: admin, body: { status: 'stored' } });
  // 再退回 pending_storage 再入库一次
  db.prepare("UPDATE items SET status = 'pending_storage' WHERE id = ?").run(id);
  patchItem(db, id, { viewer: admin, body: { status: 'stored' } });

  const n = msgsTo(db, 'usr_stu2').filter((x) => x.title === '关注的物品已存放').length;
  assert.equal(n, 1, '同一物品对同一用户只通知一次');
});

test('表 6：管理员添加志愿者 → 通知被授权用户', () => {
  const db = freshDb();
  const out = setVolunteer(db, 'usr_stu', admin, { enabled: true, storagePointIds: ['stp_lib'] });
  assert.equal(out.status, 200, JSON.stringify(out.body));

  const m = msgsTo(db, 'usr_stu').find((x) => x.title === '你已成为志愿者');
  assert.ok(m, '被授权用户应收到通知');
  assert.match(m.body, /图书馆服务台/, '正文应含负责的存放点');
});

test('移除志愿者时不发「已成为志愿者」（避免误导）', () => {
  const db = freshDb();
  setVolunteer(db, 'usr_stu', admin, { enabled: true, storagePointIds: ['stp_lib'] });
  setVolunteer(db, 'usr_stu', admin, { enabled: false });
  const n = msgsTo(db, 'usr_stu').filter((x) => x.title === '你已成为志愿者').length;
  assert.equal(n, 1, '只有授予时发一次');
});
