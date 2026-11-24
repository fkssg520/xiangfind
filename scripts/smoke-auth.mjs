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

// 1. 注册：只创建"待注册"记录，不建账号
const reg = await call('POST', '/api/auth/register', account);
check('注册返回 201 且 pending=true', reg.status === 201 && reg.data?.pending === true, JSON.stringify(reg.data));
check('注册响应里不含 user（账号还没建）', reg.data?.user === undefined);

// 2. 此时登录应失败（账号还不存在）
const earlyLogin = await call('POST', '/api/auth/login', { studentId: account.studentId, password: account.password });
check('未验证前无法登录', earlyLogin.status === 401, earlyLogin.data?.error?.code);

// 3. 重复提交注册：覆盖待注册记录，仍不建账号
const dup = await call('POST', '/api/auth/register', account);
check('重复注册仍是 201 pending（覆盖待注册）', dup.status === 201 && dup.data?.pending === true, String(dup.status));

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

// 账号已存在，再次注册应 409
const dup2 = await call('POST', '/api/auth/register', account);
check('账号已存在时注册返回 409', dup2.status === 409, dup2.data?.error?.code);

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

// 11. 忘记密码：防枚举（不存在的邮箱也返回 200）
const forgotUnknown = await call('POST', '/api/auth/forgot-password', { email: 'nobody-xyz@example.com' });
check('忘记密码：不存在邮箱也 200（防枚举）', forgotUnknown.status === 200,
  String(forgotUnknown.status));

// 12. 忘记密码：格式错误 400
const forgotBadEmail = await call('POST', '/api/auth/forgot-password', { email: 'not-an-email' });
check('忘记密码：邮箱格式错 400', forgotBadEmail.status === 400);

// 13. 忘记密码：真实账号返回 200，且响应体与"不存在邮箱"**完全一致**（防枚举）
const forgotReal = await call('POST', '/api/auth/forgot-password', { email: account.email });
check('忘记密码：真实邮箱 200', forgotReal.status === 200, String(forgotReal.status));
{
  const a = JSON.stringify(forgotUnknown.data ?? {});
  const b = JSON.stringify(forgotReal.data ?? {});
  check('忘记密码：响应体不泄露邮箱是否存在', a === b, a === b ? '两者一致' : `${a} ≠ ${b}`);
  check('忘记密码：文案不承诺"一定已发送"',
    /如果该邮箱已注册/.test(String(forgotReal.data?.message || '')),
    String(forgotReal.data?.message || '(无 message)'));
}

// 14. 重置密码：验证码格式错 400
const resetBadCode = await call('POST', '/api/auth/reset-password',
  { email: account.email, code: 'abc', password: 'NewPass123', confirmPassword: 'NewPass123' });
check('重置密码：验证码非 6 位 400', resetBadCode.status === 400);

// 15. 重置密码：弱密码 400
const resetWeak = await call('POST', '/api/auth/reset-password',
  { email: account.email, code: '123456', password: 'short', confirmPassword: 'short' });
check('重置密码：弱密码 400', resetWeak.status === 400);

// 16. 重置密码：两次不一致 400
const resetMismatch = await call('POST', '/api/auth/reset-password',
  { email: account.email, code: '123456', password: 'NewPass123', confirmPassword: 'Other123' });
check('重置密码：两次不一致 400', resetMismatch.status === 400);

// 17. 重置密码：错误验证码 400/401（不能真的改掉密码）
const resetWrongCode = await call('POST', '/api/auth/reset-password',
  { email: account.email, code: '000000', password: 'NewPass123', confirmPassword: 'NewPass123' });
check('重置密码：验证码错误被拒', resetWrongCode.status === 400 || resetWrongCode.status === 401,
  String(resetWrongCode.status));

// 18. 关键：错误验证码不能真的改掉密码——原密码必须仍然可登录
const stillOld = await call('POST', '/api/auth/login',
  { studentId: account.studentId, password: account.password });
check('错误验证码后原密码仍可用', stillOld.status === 200, String(stillOld.status));

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
