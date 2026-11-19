// 匹配冒烟：评分、候选、70 分通知、去重、状态门槛
// 前置：先跑 db:migrate + db:seed（需要志愿者/管理员演示账号）
// 用法：node scripts/smoke-matching.mjs [baseUrl] [serverLogPath]
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3109';
const LOG = process.argv[3] || 'server.log';

let jar = {};
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
function absorb(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
async function call(method, path, body, withJar = true) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (withJar && jar.xf_csrf) headers['x-csrf-token'] = jar.xf_csrf;
  if (withJar && Object.keys(jar).length) headers.cookie = cookieHeader();
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (withJar) absorb(res);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

let pass = 0; let fail = 0;
const check = (n, ok, d = '') => { ok ? (pass++, console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`)); };

const stamp = Date.now().toString().slice(-6);

async function register(email, studentId) {
  jar = {};
  await call('GET', '/');
  await call('POST', '/api/auth/register', {
    studentId, name: '匹配测试', email, password: 'demo1234', confirmPassword: 'demo1234',
  });
  const log = readFileSync(LOG, 'utf8');
  const code = [...log.matchAll(new RegExp(`to=${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} code=(\\d{6})`, 'g'))].at(-1)?.[1];
  await call('POST', '/api/auth/verify-email', { email, code });
}
async function loginAs(studentId, password = 'demo1234') {
  jar = {};
  await call('GET', '/');
  const r = await call('POST', '/api/auth/login', { studentId, password });
  return r;
}

const email = `mt${stamp}@demo.local`;
console.log(`\n=== 匹配冒烟 @ ${BASE} ===`);

// 1. 失主发失物
await register(email, '2055' + stamp);
check('失主登录就绪', Boolean(jar.xf_sid));

const lost = await call('POST', '/api/items', {
  type: 'lost', title: '深灰色保温杯丢了', category: '电子产品',
  description: '深灰色保温杯，杯身有贴纸，第五教学楼 201 教室丢的。',
  location: '第五教学楼 201', eventAt: new Date(Date.now() - 3600e3).toISOString(),
});
const lostId = lost.data?.item?.id;
check('失物发布 201 且状态 open', lost.status === 201 && lost.data?.item?.status === 'open');
check('此时无匹配', (lost.data?.item?.matches || []).length === 0);

// 2. 另一人发高度相似的招领 → 未入库不匹配
await register(`m2${stamp}@demo.local`, '2044' + stamp);
const found = await call('POST', '/api/items', {
  type: 'found', title: '捡到深灰色保温杯', category: '电子产品',
  description: '深灰色保温杯，杯身有贴纸，在第五教学楼 201 教室捡到。',
  location: '第五教学楼 201', eventAt: new Date(Date.now() - 3500e3).toISOString(),
  valueLevel: 'normal', storagePointId: 'stp_demo_lib',
});
const foundId = found.data?.item?.id;
check('招领发布 201 且 pending_storage', found.status === 201 && found.data?.item?.status === 'pending_storage');
check('未存放时双方都没有匹配', (found.data?.item?.matches || []).length === 0);

const lostBefore = await call('GET', `/api/items/${lostId}`);
check('确认入库前失物仍无匹配', (lostBefore.data?.item?.matches || []).length === 0);

// 3. 志愿者确认入库 → 触发匹配
await loginAs('20230002');
check('志愿者登录成功', Boolean(jar.xf_sid));
const confirm = await call('PATCH', `/api/items/${foundId}`, { status: 'stored' });
check('志愿者确认入库 200', confirm.status === 200, confirm.data?.error?.message);
check('入库后状态 stored', confirm.data?.item?.status === 'stored');

const m = confirm.data?.item?.matches || [];
check('入库后立刻产生了匹配', m.length >= 1, `候选 ${m.length} 条`);
const hit = m.find((x) => x.itemId === lostId);
check('匹配到了那条失物', Boolean(hit));
check('分数 ≥ 45（进候选阈值）', (hit?.score || 0) >= 45, `score=${hit?.score}`);
check('有可解释的原因', Array.isArray(hit?.reasons) && hit.reasons.length > 0, (hit?.reasons || []).join('、'));

// 4. 失物侧也能看到这条匹配
await loginAs('2055' + stamp);
const lostAfter = await call('GET', `/api/items/${lostId}`);
const back = (lostAfter.data?.item?.matches || []).find((x) => x.itemId === foundId);
check('失物侧也能看到匹配', Boolean(back), `score=${back?.score}`);

// 5. 70 分以上发站内消息（双方）
const msgs = await call('GET', '/api/messages?filter=all');
const matchMsgs = (msgs.data?.messages || []).filter((x) => x.type === 'match');
check('失主收到匹配消息', matchMsgs.length >= 1, `共 ${matchMsgs.length} 条`);

// 6. 去重：再次触发重算，消息数不变
const before = matchMsgs.length;
const again = await loginAs('20230002');
void again;
await call('PATCH', `/api/items/${foundId}`, { location: '图书馆三楼自习区' });
await loginAs('2055' + stamp);
const msgs2 = await call('GET', '/api/messages?filter=all');
const matchMsgs2 = (msgs2.data?.messages || []).filter((x) => x.type === 'match');
check('重复重算不重复发消息（D-004）', matchMsgs2.length === before, `重算后 ${matchMsgs2.length} 条`);

// 7. 不相干的物品不应匹配
const unrelated = await call('POST', '/api/items', {
  type: 'found', title: '一串宿舍钥匙', category: '钥匙',
  description: '在第二教学楼捡到三把钥匙加卡通挂件。',
  location: '第二教学楼 302', eventAt: new Date(Date.now() - 90 * 3600e3).toISOString(),
  valueLevel: 'normal', storagePointId: 'stp_demo_dorm',
});
check('无关招领发布成功', unrelated.status === 201);
const rel = (unrelated.data?.item?.matches || []).filter((x) => x.itemId === lostId);
check('无关物品没有和失物配对', rel.length === 0);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
