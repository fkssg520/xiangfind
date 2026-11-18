// 认证链路冒烟测试：注册 → 取码 → 验证 → 登录 → 登出
// 用法：node scripts/smoke-auth.mjs [baseUrl] [serverLogPath]
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3101';
const LOG = process.argv[3] || 'server.log';

const jar = {};
function cookieHeader() {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorb(res) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
async function call(method, path, body) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (jar.xf_csrf) headers['x-csrf-token'] = jar.xf_csrf;
  if (Object.keys(jar).length) headers.cookie = cookieHeader();
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  absorb(res);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const stamp = Date.now().toString().slice(-6);
const account = {
  studentId: '2099' + stamp,
  name: '冒烟测试',
  email: `smoke${stamp}@demo.local`,
  password: 'demo1234',
  confirmPassword: 'demo1234',
};

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log(`\n=== 认证冒烟 @ ${BASE} ===`);

// 0. 拿 CSRF
const home = await call('GET', '/');
check('GET / 返回 200 且下发 CSRF Cookie', home.status === 200 && Boolean(jar.xf_csrf), `csrf=${jar.xf_csrf?.slice(0, 8)}…`);

// 1. 注册
const reg = await call('POST', '/api/auth/register', account);
check('注册成功 201', reg.status === 201, JSON.stringify(reg.data?.user?.studentId || reg.data));
check('注册后 emailVerified=false', reg.data?.user?.emailVerified === false);

// 2. 重复注册应 409
const dup = await call('POST', '/api/auth/register', account);
check('重复学号/邮箱返回 409', dup.status === 409, dup.data?.error?.code);

// 3. 从服务端日志里取验证码
const log = readFileSync(LOG, 'utf8');
const matches = [...log.matchAll(/to=\S+ code=(\d{6})/g)];
const code = matches.at(-1)?.[1];
check('日志里拿到 6 位验证码', Boolean(code), code ? `code=${code}` : '未找到');

// 4. 错误验证码
const bad = await call('POST', '/api/auth/verify-email', { email: account.email, code: code === '000000' ? '111111' : '000000' });
check('错误验证码被拒 400', bad.status === 400, bad.data?.error?.message);

// 5. 正确验证码
const ok = await call('POST', '/api/auth/verify-email', { email: account.email, code });
check('正确验证码通过 200', ok.status === 200);
check('验证后 emailVerified=true', ok.data?.user?.emailVerified === true);
check('验证后拿到会话 Cookie', Boolean(jar.xf_sid));

// 6. /api/me
const me = await call('GET', '/api/me');
check('GET /api/me 返回当前用户', me.status === 200 && me.data?.user?.email === account.email);

// 7. 登出
const out = await call('POST', '/api/auth/logout');
check('登出 204', out.status === 204);

const meAfter = await call('GET', '/api/me');
check('登出后 /api/me 返回 401', meAfter.status === 401);

// 8. 登录
const login1 = await call('POST', '/api/auth/login', { studentId: account.studentId, password: account.password });
check('登录成功 200', login1.status === 200);
check('登录返回 isVolunteer 字段', typeof login1.data?.user?.isVolunteer === 'boolean');

// 9. 错误密码
const badLogin = await call('POST', '/api/auth/login', { studentId: account.studentId, password: 'wrongpass1' });
check('错误密码 401', badLogin.status === 401);

// 10. 无 CSRF 的写操作
const noCsrfRes = await fetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ studentId: account.studentId, password: account.password }),
});
check('缺少 CSRF 被拒 403', noCsrfRes.status === 403);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
