// 补齐漏做项冒烟：存放点公开列表、匹配端点、入库专用端点、找回密码、归还时间
// 用法：node scripts/smoke-gaps.mjs [baseUrl] [serverLogPath]
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3141';
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

let anonCsrf = '';
async function ensureAnonCsrf() {
  if (anonCsrf) return anonCsrf;
  const res = await fetch(BASE + '/', { headers: { accept: 'text/html' } });
  for (const c of res.headers.getSetCookie?.() || []) {
    const m = /(?:^|;\s*)xf_csrf=([^;]+)/.exec(c);
    if (m) anonCsrf = m[1];
  }
  return anonCsrf;
}

async function callAnon(method, path, body) {
  // 不登录，但用独立的 CSRF 令牌（只发 xf_csrf cookie，不带会话）
  const token = await ensureAnonCsrf();
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (token) {
    headers['x-csrf-token'] = token;
    headers.cookie = `xf_csrf=${token}`;
  }
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  absorb(res);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function loginJar(studentId, password) {
  jar = {};
  await call('GET', '/');
  return call('POST', '/api/auth/login', { studentId, password });
}
let pass = 0; let fail = 0;
const check = (n, ok, d = '') => { ok ? (pass++, console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`)); };
const stamp = Date.now().toString().slice(-6);
const email = `gap${stamp}@demo.local`;
const studentId = `2${stamp}GAP`;

console.log(`\n=== 补齐项冒烟 @ ${BASE} ===`);

// 1. 存放点公开列表（前端不该再硬编码）
const pts = await call('GET', '/api/storage-points', null, false);
check('匿名可读存放点列表 200', pts.status === 200, `实际 ${pts.status}`);
const list = pts.data?.storagePoints || [];
check('返回了存放点', list.length >= 3, `${list.length} 个`);
check('含 security 类型', list.some((p) => p.type === 'security'));
check('字段够前端用（id/name/type/address/hours）',
  list.every((p) => p.id && p.name && p.type && 'address' in p && 'hours' in p));

// 2. 注册 + 发物品
jar = {};
await call('GET', '/');
await call('POST', '/api/auth/register', {
  studentId, name: '补齐测试', email, password: 'demo1234', confirmPassword: 'demo1234',
});
const log = readFileSync(LOG, 'utf8');
const verifyCode = [...log.matchAll(new RegExp(`to=${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} code=(\\d{6})`, 'g'))].at(-1)?.[1];
const verified = await call('POST', '/api/auth/verify-email', { email, code: verifyCode });
check('注册并验证 200', verified.status === 200, verified.data?.error?.message);

const item = await call('POST', '/api/items', {
  type: 'found', title: '灰色双肩包', category: '其他',
  description: '灰色双肩包，侧袋有一个水壶，在第七教学楼门口捡到。',
  location: '第七教学楼门口', eventAt: new Date(Date.now() - 5400e3).toISOString(),
  valueLevel: 'normal', storagePointId: list[0].id,
});
const itemId = item.data?.item?.id;
check('发布招领 201', item.status === 201, item.data?.error?.message);

// 3. 匹配端点（未入库时为空）
const m1 = await call('GET', `/api/matches/${itemId}`);
check('GET /api/matches/:id 200', m1.status === 200, `实际 ${m1.status}`);
check('未入库时匹配为空', Array.isArray(m1.data?.matches));

// 4. 入库专用端点（学生 → 403/400；志愿者 → 200）
const studentConfirm = await call('POST', `/api/items/${itemId}/storage-confirm`);
check('学生调用入库端点被拒', studentConfirm.status === 400 || studentConfirm.status === 403,
  studentConfirm.data?.error?.message);

jar = {};
await call('GET', '/');
await call('POST', '/api/auth/login', { studentId: '20230002', password: 'demo1234' });
const volConfirm = await call('POST', `/api/items/${itemId}/storage-confirm`);
check('志愿者调用入库端点 200', volConfirm.status === 200, volConfirm.data?.error?.message);
check('状态变为 stored', volConfirm.data?.item?.status === 'stored', volConfirm.data?.item?.status);

// 5. 找回密码
const forgot = await callAnon('POST', '/api/auth/forgot-password', { email });
check('找回密码接口 200（不透露邮箱存在）', forgot.status === 200, forgot.data?.error?.message);

const resetCode = [...readFileSync(LOG, 'utf8').matchAll(new RegExp(`to=${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} code=(\\d{6})`, 'g'))].at(-1)?.[1];
const badReset = await callAnon('POST', '/api/auth/reset-password', {
  email, code: resetCode === '000000' ? '111111' : '000000', password: 'newpass123', confirmPassword: 'newpass123',
}, false);
check('错误验证码被拒 400', badReset.status === 400, badReset.data?.error?.message);

const weak = await callAnon('POST', '/api/auth/reset-password', { email, code: resetCode, password: 'abc', confirmPassword: 'abc' });
check('弱密码被拒 400', weak.status === 400, weak.data?.error?.message);

const reset = await callAnon('POST', '/api/auth/reset-password', {
  email, code: resetCode, password: 'newpass123', confirmPassword: 'newpass123',
});
check('重置成功 200', reset.status === 200, reset.data?.error?.message);

const oldLogin = jar;
const loginNew = await loginJar(studentId, 'newpass123');
check('新密码可登录', loginNew.status === 200, loginNew.data?.error?.message);
const loginOld = await callAnon('POST', '/api/auth/login', { studentId, password: 'demo1234' });
check('旧密码失效 401', loginOld.status === 401);
void oldLogin;

// 6. 归还记录时间（用志愿者走完认领）
// 认领人必须是另一个人（不能认领自己发布的）
const claimantEmail = `gapc${stamp}@demo.local`;
jar = {};
await call('GET', '/');
await call('POST', '/api/auth/register', {
  studentId: `3${stamp}C`, name: '认领人', email: claimantEmail,
  password: 'demo1234', confirmPassword: 'demo1234',
});
const claimCode = [...readFileSync(LOG, 'utf8')
  .matchAll(new RegExp(`to=${claimantEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} code=(\\d{6})`, 'g'))].at(-1)?.[1];
await call('POST', '/api/auth/verify-email', { email: claimantEmail, code: claimCode });
const applicantJar = { ...jar };
const claim = await call('POST', `/api/items/${itemId}/claims`, {
  note: '这个双肩包是我的，侧袋水壶是蓝色运动水壶，上周五落在七教门口。',
});
check('提交认领 201', claim.status === 201, claim.data?.error?.message);
const claimId = claim.data?.claim?.id;

jar = {};
await call('GET', '/');
await call('POST', '/api/auth/login', { studentId: '20230002', password: 'demo1234' });
const approve = await call('POST', `/api/claims/${claimId}/decision`, { decision: 'approve', note: '核对无误' });
check('审核通过 200', approve.status === 200, approve.data?.error?.message);
const ret = await call('POST', `/api/items/${itemId}/return`);
check('归还成功 200', ret.status === 200, ret.data?.error?.message);
const after = await call('GET', `/api/items/${itemId}`);
check('归还后状态 returned', after.data?.item?.status === 'returned', after.data?.item?.status);
void applicantJar;

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
