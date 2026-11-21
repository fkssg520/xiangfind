// 演示数据（可复用）：seed.js 与「管理员恢复演示数据」共用
// 所有写入都是 INSERT OR IGNORE + 固定 ID，可重复执行
import { existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hashPassword } from '../lib/password.js';

// 与 uploads.js 用同一套规则解析上传目录（resetDemo 清理孤儿文件用）
const UPLOAD_DIR = () => resolve(process.env.UPLOAD_DIR || './uploads');

const T0 = '2026-11-10T08:00:00.000Z';
export const DEMO_PASSWORD = 'demo1234';

export const DEMO_USER_IDS = ['usr_demo_admin', 'usr_demo_student', 'usr_demo_vol'];
export const DEMO_ITEM_IDS = ['itm_demo_1', 'itm_demo_2', 'itm_demo_3', 'itm_demo_4'];
export const DEMO_POINT_IDS = ['stp_demo_lib', 'stp_demo_dorm', 'stp_demo_guard'];

export function seedDemo(db) {
  const pwd = hashPassword(DEMO_PASSWORD);

  // 存放点
  const insPoint = db.prepare(`INSERT OR IGNORE INTO storage_points
    (id,name,type,address,hours,contact_name,contact_phone,note,enabled,sort_order,created_at)
    VALUES (?,?,?,?,?,?,?,'',1,?,?)`);
  const points = [
    ['stp_demo_lib', '图书馆一楼服务台', 'normal', '示例地址：图书馆一层东侧', '08:00-22:00', '张老师', '0000-0000000'],
    ['stp_demo_dorm', '宿舍服务中心', 'normal', '示例地址：学生公寓 3 号楼一层', '08:00-20:00', '李老师', '0000-0000000'],
    ['stp_demo_guard', '保卫处失物招领点', 'security', '示例地址：行政楼一层保卫处', '09:00-17:00', '王老师', '0000-0000000'],
  ];
  points.forEach((p, i) => insPoint.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6], i, T0));

  // 用户
  const insUser = db.prepare(`INSERT OR IGNORE INTO users
    (id,student_id,name,email,email_verified_at,password_hash,phone,contact,role,status,created_at)
    VALUES (?,?,?,?,?,?,'','',?,'active',?)`);
  const users = [
    ['usr_demo_admin', '90000001', '演示管理员', 'admin@demo.local', 'admin'],
    ['usr_demo_student', '20230001', '演示同学', 'student@demo.local', 'student'],
    ['usr_demo_vol', '20230002', '演示志愿者', 'volunteer@demo.local', 'volunteer'],
  ];
  users.forEach((u) => insUser.run(u[0], u[1], u[2], u[3], T0, pwd, u[4], T0));

  // 志愿者绑定
  db.prepare(`INSERT OR IGNORE INTO volunteer_assignments (id,user_id,storage_point_id,assigned_by,created_at)
              VALUES (?,?,?,?,?)`)
    .run('vst_demo_1', 'usr_demo_vol', 'stp_demo_lib', 'usr_demo_admin', T0);

  // 物品
  const insItem = db.prepare(`INSERT OR IGNORE INTO items
    (id,user_id,type,title,category,description,event_at,location,value_level,storage_point_id,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const items = [
    ['itm_demo_1', 'usr_demo_student', 'found', '白色蓝牙耳机', '电子产品',
      '在图书馆三楼自习区捡到，白色充电盒，盒盖有轻微划痕。', '2026-11-16T02:30:00.000Z',
      '图书馆三楼自习区', 'normal', 'stp_demo_lib', 'stored'],
    ['itm_demo_2', 'usr_demo_student', 'lost', '图书馆丢了一张校园卡', '证件',
      '姓名尾字是“雨”，卡面贴了蓝色贴纸，可能是 16 号下午在二楼借阅区丢的。',
      '2026-11-16T06:00:00.000Z', '图书馆二楼借阅区', 'normal', null, 'open'],
    ['itm_demo_3', 'usr_demo_vol', 'found', '黑色钱包（内有现金）', '其他',
      '在体育馆门口捡到，黑色短款钱包，内有少量现金和一张门禁卡。', '2026-11-17T01:00:00.000Z',
      '体育馆南门', 'valuable', 'stp_demo_guard', 'pending_storage'],
    ['itm_demo_4', 'usr_demo_student', 'found', '一串宿舍钥匙', '钥匙',
      '三把钥匙加一个卡通挂件，在第二教学楼 302 教室捡到。', '2026-11-17T09:15:00.000Z',
      '第二教学楼 302', 'normal', 'stp_demo_dorm', 'stored'],
  ];
  items.forEach((it) => insItem.run(it[0], it[1], it[2], it[3], it[4], it[5], it[6], it[7], it[8], it[9], it[10], T0, T0));

  // 认领 + 消息
  db.prepare(`INSERT OR IGNORE INTO claims
    (id,item_id,applicant_id,note,status,publisher_verdict,publisher_verdict_at,reviewed_by,review_note,created_at,reviewed_at)
    VALUES (?,?,?,?,'pending',NULL,NULL,NULL,'',?,NULL)`)
    .run('clm_demo_1', 'itm_demo_1', 'usr_demo_admin',
         '耳机是我的，盒盖右下角有一道划痕，我上周三丢在图书馆三楼。', T0);

  db.prepare(`INSERT OR IGNORE INTO messages
    (id,user_id,type,title,body,related_type,related_id,important,read_at,created_at)
    VALUES (?,?,'claim','有人申请认领你的物品','演示同学申请认领「白色蓝牙耳机」，请到详情页处理。','item',?,1,NULL,?)`)
    .run('msg_demo_1', 'usr_demo_student', 'itm_demo_1', T0);

  return {
    points: db.prepare('SELECT COUNT(*) AS c FROM storage_points').get().c,
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    items: db.prepare('SELECT COUNT(*) AS c FROM items').get().c,
  };
}

// 恢复演示数据：只清演示账号名下/演示 ID 的数据，再重新灌一遍
export function resetDemo(db) {
  // 「恢复演示数据」= 回到已知的干净状态，不是只删几个固定 ID。
  //
  // 2026-11-21 修正：原实现只删 DEMO_ITEM_IDS，而演示账号（20230001 等）在测试时
  // 新建的物品不会被删——公网实例上因此残留了 20 多条「按钮条件失物进行中」这类测试数据，
  // 点「恢复演示数据」也清不掉，演示当天会很脏。
  //
  // 现在的语义：清空所有业务数据（物品/认领/消息/匹配/收藏/图片），然后重新播种。
  // 保留：users（真实注册的账号）、storage_points（播种会 UPDATE/INSERT）、audit_logs（审计不可删）。
  const imageFiles = db.prepare('SELECT file_name FROM item_images').all().map((r) => r.file_name);

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM messages');
    db.exec('DELETE FROM claims');
    db.exec('DELETE FROM matches');
    db.exec('DELETE FROM favorites');
    db.exec('DELETE FROM item_images');
    db.exec('DELETE FROM items');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // 尽力删除已不再被引用的上传文件（失败不影响数据一致性）
  for (const name of imageFiles) {
    try {
      const p = join(UPLOAD_DIR(), name);
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* 留一个孤儿文件比中断恢复更安全 */
    }
  }

  return seedDemo(db);
}
