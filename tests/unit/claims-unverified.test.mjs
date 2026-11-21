// 认领的「未验证邮箱」拦截（需求基线 §2.2；必测场景 2 的认领侧）
// 发布侧已在 items.test.mjs 覆盖，这里补认领侧——两条路径都要拦，缺一条就等于开了后门。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createItem } from '../../src/services/items.js';
import { submitClaim } from '../../src/services/claims.js';

const SCHEMA = readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO users (id,student_id,name,email,email_verified_at,password_hash,phone,contact,role,status,created_at)
                          VALUES (?,?,?,?,?, 'x','','',?,'active',?)`);
  ins.run('usr_verified', '20230001', '已验证', 'a@demo.local', now, 'student', now);
  ins.run('usr_unverified', '20230002', '未验证', 'b@demo.local', null, 'student', now);
  ins.run('usr_admin', '90000001', '管理员', 'c@demo.local', now, 'admin', now);
  db.prepare(`INSERT INTO storage_points (id,name,type,address,hours,contact_name,contact_phone,note,enabled,sort_order,created_at)
              VALUES ('stp_x','测试点','normal','地址','08:00-22:00','','','',1,0,?)`).run(now);
  return db;
}

const admin = { id: 'usr_admin', role: 'admin', email_verified_at: new Date().toISOString(), name: '管理员' };
const verified = { id: 'usr_verified', role: 'student', email_verified_at: new Date().toISOString(), name: '已验证' };
const unverified = { id: 'usr_unverified', role: 'student', email_verified_at: null, name: '未验证' };

function makeClaimable(db) {
  // 物品由管理员发布，这样"已验证学生"去认领时不会撞到 own_item
  const created = createItem(db, {
    viewer: admin,
    body: {
      type: 'found', title: '可认领的雨伞', category: '其他',
      description: '这条用于验证未验证账号不能认领，描述需要够长。',
      location: '图书馆', valueLevel: 'normal', storagePointId: 'stp_x',
    },
  });
  const id = created.body.item.id;
  // 直接入库，省去走状态机
  db.prepare("UPDATE items SET status = 'stored' WHERE id = ?").run(id);
  return id;
}

test('未验证邮箱不能申请认领（403 email_unverified）', () => {
  const db = freshDb();
  const itemId = makeClaimable(db);
  const out = submitClaim(db, itemId, unverified, { note: '这是我的雨伞，特征是黑色伞柄和一道划痕。' });
  assert.equal(out.status, 403);
  assert.equal(out.body.error.code, 'email_unverified');
});

test('未验证账号被拒时不产生认领记录', () => {
  const db = freshDb();
  const itemId = makeClaimable(db);
  submitClaim(db, itemId, unverified, { note: '这是我的雨伞，特征是黑色伞柄和一道划痕。' });
  const n = db.prepare('SELECT COUNT(*) AS c FROM claims WHERE item_id = ?').get(itemId).c;
  assert.equal(n, 0, '被拒的请求不应留下 claims 行');
});

test('已验证账号可以正常申请认领（正例，防止拦过头）', () => {
  const db = freshDb();
  const itemId = makeClaimable(db);
  const out = submitClaim(db, itemId, verified, { note: '这是我的雨伞，特征是黑色伞柄和一道划痕。' });
  assert.equal(out.status, 201, JSON.stringify(out.body));
});
