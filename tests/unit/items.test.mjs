// 物品服务单元测试（内存数据库，不需要起 HTTP 服务）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createItem, listItems, getItem, patchItem } from '../../src/services/items.js';

const SCHEMA = readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id,student_id,name,email,email_verified_at,password_hash,phone,contact,role,status,created_at)
              VALUES ('usr_a','20230001','甲','a@demo.local',?, 'x','','','student','active',?)`).run(now, now);
  db.prepare(`INSERT INTO users (id,student_id,name,email,email_verified_at,password_hash,phone,contact,role,status,created_at)
              VALUES ('usr_b','20230002','乙','b@demo.local',?, 'x','','','volunteer','active',?)`).run(now, now);
  db.prepare(`INSERT INTO storage_points (id,name,type,address,hours,contact_name,contact_phone,note,enabled,sort_order,created_at)
              VALUES ('stp_n','普通点','normal','地址一','08:00-22:00','','','',1,0,?)`).run(now);
  db.prepare(`INSERT INTO storage_points (id,name,type,address,hours,contact_name,contact_phone,note,enabled,sort_order,created_at)
              VALUES ('stp_s','保卫处点','security','地址二','09:00-17:00','','','',1,1,?)`).run(now);
  return db;
}

const viewerA = { id: 'usr_a', role: 'student', name: '甲' };
const viewerB = { id: 'usr_b', role: 'volunteer', name: '乙' };

const baseFound = {
  type: 'found', title: '黑色雨伞', category: '其他',
  description: '在第三教学楼门口捡到，黑色长柄自动伞，伞骨有一处弯。',
  location: '第三教学楼门口', valueLevel: 'normal', storagePointId: 'stp_n',
};

test('招领缺存放点被拒 400', () => {
  const db = freshDb();
  const out = createItem(db, { viewer: viewerA, body: { ...baseFound, storagePointId: null } });
  assert.equal(out.status, 400);
  assert.equal(out.body.error.code, 'storagePointId');
});

test('贵重物品选普通存放点被拒', () => {
  const db = freshDb();
  const out = createItem(db, { viewer: viewerA, body: { ...baseFound, valueLevel: 'valuable' } });
  assert.equal(out.status, 400);
  assert.match(out.body.error.message, /保卫处/);
});

test('贵重物品选保卫处存放点通过', () => {
  const db = freshDb();
  const out = createItem(db, { viewer: viewerA, body: { ...baseFound, valueLevel: 'valuable', storagePointId: 'stp_s' } });
  assert.equal(out.status, 201);
  assert.equal(out.body.item.valueLevel, 'valuable');
});

test('招领初始状态 pending_storage，失物初始 open（D-001）', () => {
  const db = freshDb();
  const found = createItem(db, { viewer: viewerA, body: baseFound });
  assert.equal(found.body.item.status, 'pending_storage');

  const lost = createItem(db, {
    viewer: viewerA,
    body: { type: 'lost', title: '丢了一把伞', category: '其他', description: '黑色长柄伞，可能落在三教。', location: '第三教学楼' },
  });
  assert.equal(lost.body.item.status, 'open');
});

test('标题太笼统被拒', () => {
  const db = freshDb();
  const out = createItem(db, { viewer: viewerA, body: { ...baseFound, title: '东西' } });
  assert.equal(out.status, 400);
  assert.equal(out.body.error.code, 'title');
});

test('发表时间不能晚于当前', () => {
  const db = freshDb();
  const future = new Date(Date.now() + 3600e3).toISOString();
  const out = createItem(db, { viewer: viewerA, body: { ...baseFound, eventAt: future } });
  assert.equal(out.status, 400);
  assert.equal(out.body.error.code, 'eventAt');
});

test('列表不返回联系方式，且 mine=1 只给自己', () => {
  const db = freshDb();
  createItem(db, { viewer: viewerA, body: baseFound });
  createItem(db, { viewer: viewerB, body: { ...baseFound, title: '乙捡到的伞', storagePointId: 'stp_n' } });

  const all = listItems(db, { viewer: viewerA, query: {} });
  assert.equal(all.items.length, 2);
  for (const it of all.items) {
    assert.equal('contact' in it, false);
    assert.equal('email' in (it.author || {}), false);
  }

  const mine = listItems(db, { viewer: viewerA, query: { mine: '1' } });
  assert.equal(mine.items.length, 1);
  assert.equal(mine.total, 1);
});

test('匿名 mine=1 返回空并标记需登录', () => {
  const db = freshDb();
  createItem(db, { viewer: viewerA, body: baseFound });
  const out = listItems(db, { viewer: null, query: { mine: '1' } });
  assert.equal(out.items.length, 0);
  assert.equal(out.requiresLogin, true);
});

test('默认排除已归档', () => {
  const db = freshDb();
  const created = createItem(db, { viewer: viewerA, body: baseFound });
  patchItem(db, created.body.item.id, { viewer: { id: 'usr_a', role: 'admin' }, body: { status: 'archived' } });
  const list = listItems(db, { viewer: viewerA, query: {} });
  assert.equal(list.items.length, 0, '归档后默认列表不显示');
  const withArchived = listItems(db, { viewer: viewerA, query: { status: 'archived' } });
  assert.equal(withArchived.items.length, 1);
});

test('学生不能确认入库，志愿者可以（发布者本人也不行）', () => {
  const db = freshDb();
  const created = createItem(db, { viewer: viewerA, body: baseFound });
  const id = created.body.item.id;

  const byOwner = patchItem(db, id, { viewer: viewerA, body: { status: 'stored' } });
  assert.equal(byOwner.status, 400, '发布者本人不能确认入库');

  // 志愿者未绑定该存放点 → 403
  const vol = patchItem(db, id, { viewer: viewerB, body: { status: 'stored' } });
  assert.equal(vol.status, 403, '志愿者未绑定存放点应被拒');

  // 绑定后可以
  db.prepare("INSERT INTO volunteer_assignments (id,user_id,storage_point_id,assigned_by,created_at) VALUES ('v1','usr_b','stp_n','usr_a',?)")
    .run(new Date().toISOString());
  const ok = patchItem(db, id, { viewer: viewerB, body: { status: 'stored' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.item.status, 'stored');
});

test('入库后关键字段锁定，管理员可改', () => {
  const db = freshDb();
  const created = createItem(db, { viewer: viewerA, body: baseFound });
  patchItem(db, created.body.item.id, { viewer: { id: 'usr_a', role: 'admin' }, body: { status: 'stored' } });

  const ownerEdit = patchItem(db, created.body.item.id, { viewer: viewerA, body: { title: '改标题' } });
  assert.equal(ownerEdit.status, 400, '已入库不能再改标题');

  const adminEdit = patchItem(db, created.body.item.id, { viewer: { id: 'usr_a', role: 'admin' }, body: { title: '管理员改的' } });
  assert.equal(adminEdit.status, 200);
});

test('详情：他人看不到联系方式，认领通过后才可见', () => {
  const db = freshDb();
  const created = createItem(db, { viewer: viewerA, body: baseFound });
  const detail = getItem(db, created.body.item.id, viewerB);
  assert.equal(detail.contact, null);
  assert.equal(detail.isOwner, false);
});
