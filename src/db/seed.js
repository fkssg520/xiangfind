// 演示数据：可重复执行（INSERT OR IGNORE，ID 固定）
// 禁止写入任何真实姓名、学号、手机号、邮箱
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { hashPassword } from '../lib/password.js';

const DB_PATH = resolve(process.env.DATABASE_PATH || './data/xiangfind.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const T0 = '2026-11-10T08:00:00.000Z';
const DEMO_PASSWORD = 'demo1234';

// ---------- 存放点 ----------
const points = [
  ['stp_demo_lib', '图书馆一楼服务台', 'normal', '示例地址：图书馆一层东侧', '08:00-22:00', '张老师', '0000-0000000'],
  ['stp_demo_dorm', '宿舍服务中心', 'normal', '示例地址：学生公寓 3 号楼一层', '08:00-20:00', '李老师', '0000-0000000'],
  ['stp_demo_guard', '保卫处失物招领点', 'security', '示例地址：行政楼一层保卫处', '09:00-17:00', '王老师', '0000-0000000'],
];
const insPoint = db.prepare(`INSERT OR IGNORE INTO storage_points
  (id,name,type,address,hours,contact_name,contact_phone,note,enabled,sort_order,created_at)
  VALUES (?,?,?,?,?,?,?,'',1,?,?)`);
points.forEach((p, i) => insPoint.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6], i, T0));

// ---------- 用户（密码统一 demo1234） ----------
const pwd = hashPassword(DEMO_PASSWORD);
const users = [
  ['usr_demo_admin', '90000001', '演示管理员', 'admin@demo.local', 'admin'],
  ['usr_demo_student', '20230001', '演示同学', 'student@demo.local', 'student'],
  ['usr_demo_vol', '20230002', '演示志愿者', 'volunteer@demo.local', 'volunteer'],
];
const insUser = db.prepare(`INSERT OR IGNORE INTO users
  (id,student_id,name,email,email_verified_at,password_hash,phone,contact,role,status,created_at)
  VALUES (?,?,?,?,?,?,'','',?,'active',?)`);
users.forEach((u) => insUser.run(u[0], u[1], u[2], u[3], T0, pwd, u[4], T0));

// 志愿者绑定图书馆存放点
db.prepare(`INSERT OR IGNORE INTO volunteer_assignments (id,user_id,storage_point_id,assigned_by,created_at)
            VALUES (?,?,?,?,?)`)
  .run('vst_demo_1', 'usr_demo_vol', 'stp_demo_lib', 'usr_demo_admin', T0);

// ---------- 物品 ----------
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

// ---------- 一条认领申请（演示 pending 状态） ----------
db.prepare(`INSERT OR IGNORE INTO claims
  (id,item_id,applicant_id,note,status,publisher_verdict,publisher_verdict_at,reviewed_by,review_note,created_at,reviewed_at)
  VALUES (?,?,?,?,'pending',NULL,NULL,NULL,'',?,NULL)`)
  .run('clm_demo_1', 'itm_demo_1', 'usr_demo_admin',
       '耳机是我的，盒盖右下角有一道划痕，我上周三丢在图书馆三楼。', T0);

// ---------- 一条站内消息 ----------
db.prepare(`INSERT OR IGNORE INTO messages
  (id,user_id,type,title,body,related_type,related_id,important,read_at,created_at)
  VALUES (?,?,'claim','有人申请认领你的物品','演示同学申请认领「白色蓝牙耳机」，请到详情页处理。','item',?,1,NULL,?)`)
  .run('msg_demo_1', 'usr_demo_student', 'itm_demo_1', T0);

// ---------- 汇总 ----------
const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
console.log('演示数据就绪：');
for (const t of ['users', 'storage_points', 'volunteer_assignments', 'items', 'claims', 'messages']) {
  console.log(`  ${t.padEnd(22)} ${count(t)}`);
}
console.log(`  演示账号：20230001 / demo1234（学生）、20230002（志愿者）、90000001（管理员）`);
db.close();
