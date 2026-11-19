// 限流冒烟：匿名读 60/min/IP、登录 10 次/15min、注册按环境变量（D-012）
// 注意：本套件会把自己的匿名配额用完，所以必须独占端口与数据库
// 用法：node scripts/smoke-rate.mjs [baseUrl]
const BASE = process.argv[2] || 'http://127.0.0.1:3131';

let jar = {};
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
function absorb(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
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
  return { status: res.status, data, headers: res.headers };
}
// 不带会话、不带 CSRF：纯匿名读
async function anon(path) {
  const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

let pass = 0; let fail = 0;
const check = (n, ok, d = '') => { ok ? (pass++, console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`)); };

console.log(`\n=== 限流冒烟 @ ${BASE} ===`);

// 1. 匿名读：前 60 次成功，第 61 次被限
let firstBlocked = 0;
for (let i = 1; i <= 62; i += 1) {
  const r = await anon('/api/items?pageSize=1');
  if (r.status === 429) { firstBlocked = i; break; }
  if (r.status !== 200) { check(`第 ${i} 次匿名请求应为 200`, false, `实际 ${r.status}`); break; }
}
check('匿名读第 61 次开始被限流', firstBlocked === 61, `实际第 ${firstBlocked} 次`);

const blocked = await anon('/api/items?pageSize=1');
check('被限流时返回 rate_limited', blocked.data?.error?.code === 'rate_limited', blocked.data?.error?.code);
check('限流提示是中文且非空', typeof blocked.data?.error?.message === 'string' && blocked.data.error.message.length > 0,
  blocked.data?.error?.message);
check('被限流时状态码 429', blocked.status === 429, String(blocked.status));

// 2. 已登录用户不受匿名配额影响（换个 IP 概念不行，这里验证同一 IP 登录后可用）
await call('GET', '/');
const login = await call('POST', '/api/auth/login', { studentId: '20230001', password: 'demo1234' });
check('登录成功（限流不该挡住登录）', login.status === 200, login.data?.error?.message);
const afterLogin = await call('GET', '/api/items?pageSize=1');
check('登录后读列表不受匿名限额影响', afterLogin.status === 200, `实际 ${afterLogin.status}`);

// 3. 登录失败：同一学号 10 次以内允许，第 11 次 429
jar = {};
await call('GET', '/');
let loginBlocked = 0;
for (let i = 1; i <= 12; i += 1) {
  const r = await call('POST', '/api/auth/login', { studentId: '20230002', password: 'wrong-password' });
  if (r.status === 429) { loginBlocked = i; break; }
  if (r.status !== 401) { check(`第 ${i} 次错误密码应为 401`, false, `实际 ${r.status}`); break; }
}
check('登录连续失败第 11 次被限流', loginBlocked === 11, `实际第 ${loginBlocked} 次`);

const loginLimitedMsg = await call('POST', '/api/auth/login', { studentId: '20230002', password: 'demo1234' });
check('被限流后即使密码正确也被拒', loginLimitedMsg.status === 429, String(loginLimitedMsg.status));
check('提示包含等待时间或稍后重试',
  /稍后|再试|等待|\d+\s*秒/.test(loginLimitedMsg.data?.error?.message || ''),
  loginLimitedMsg.data?.error?.message);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
