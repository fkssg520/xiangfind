// 管理后台冒烟：概览、用户搜索、志愿者授权、存放点 CRUD、申请审核、恢复演示、审计
// 前置：db:migrate + db:seed（需要 90000001 管理员）
// 用法：node scripts/smoke-admin.mjs [baseUrl] [serverLogPath]
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3151';
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
async function loginAs(studentId, password = 'demo1234') {
  jar = {};
  await call('GET', '/');
  return call('POST', '/api/auth/login', { studentId, password });
}

let pass = 0; let fail = 0;
const check = (n, ok, d = '') => { ok ? (pass++, console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`)); };
const stamp = Date.now().toString().slice(-6);

console.log(`\n=== 管理后台冒烟 @ ${BASE} ===`);

// 0. 普通学生被拒
await loginAs('20230001');
check('学生访问概览被拒 403', (await call('GET', '/api/admin/overview')).status === 403);

// 1. 管理员登录
const admin = await loginAs('90000001');
check('管理员登录成功', admin.status === 200, admin.data?.error?.message);

// 2. 概览
const ov = await call('GET', '/api/admin/overview');
check('概览 200', ov.status === 200);
check('概览含关键计数', typeof ov.data?.users === 'number' && typeof ov.data?.items === 'number'
  && typeof ov.data?.pendingClaims === 'number' && typeof ov.data?.unreadMessages === 'number',
  JSON.stringify(ov.data));

// 3. 用户搜索
const users = await call('GET', '/api/admin/users?q=20230001');
check('按学号搜到用户', (users.data?.users || []).some((u) => u.studentId === '20230001'));
check('用户信息含志愿者与存放点', Array.isArray(users.data?.users?.[0]?.storagePoints));

// 4. 志愿者授权：把 20230001 设成志愿者并绑图书馆
const std = (await call('GET', '/api/admin/users?q=20230001')).data.users.find((u) => u.studentId === '20230001');
const grant = await call('POST', `/api/admin/users/${std.id}/volunteer`, { enabled: true, storagePointIds: ['stp_demo_lib'] });
check('授予志愿者 200', grant.status === 200, grant.data?.error?.message);
check('角色变为 volunteer', grant.data?.user?.role === 'volunteer');
check('绑定了存放点', (grant.data?.user?.storagePoints || []).length === 1);

// 6. 移除志愿者
const revoke = await call('POST', `/api/admin/users/${std.id}/volunteer`, { enabled: false });
check('移除志愿者 200', revoke.status === 200, revoke.data?.error?.message);
check('角色回到 student', revoke.data?.user?.role === 'student');
check('存放点绑定被清空', (revoke.data?.user?.storagePoints || []).length === 0);

// 7. 存放点 CRUD
const list = await call('GET', '/api/admin/storage-points');
check('存放点列表 200 且含停用项字段', list.status === 200 && Array.isArray(list.data?.storagePoints));
const before = list.data.storagePoints.length;

const created = await call('POST', '/api/admin/storage-points', {
  name: `测试点${stamp}`, type: 'normal', address: '示例地址 测试楼 101', hours: '08:00-18:00',
});
check('新增存放点 201', created.status === 201, created.data?.error?.message);
const spId = created.data?.storagePoint?.id;

const created2 = await call('POST', '/api/admin/storage-points', { name: '', address: '' });
check('缺名称/地址被拒 400', created2.status === 400, created2.data?.error?.message);

const patched = await call('PATCH', `/api/admin/storage-points/${spId}`, { enabled: false, hours: '09:00-17:00' });
check('修改存放点 200', patched.status === 200, patched.data?.error?.message);

const afterList = await call('GET', '/api/admin/storage-points');
const target = afterList.data.storagePoints.find((p) => p.id === spId);
check('停用后 enabled=false', target?.enabled === false);
check('营业时间已更新', target?.hours === '09:00-17:00');

// 8. 公开列表不返回停用点
const pub = await fetch(BASE + '/api/storage-points').then((r) => r.json());
check('公开列表不含停用点', !pub.storagePoints.some((p) => p.id === spId));

// 9. 申请审核列表
const claims = await call('GET', '/api/admin/claims?status=pending');
check('待审核申请 200', claims.status === 200 && Array.isArray(claims.data?.claims));
check('含物品标题与申请人', claims.data.claims.every((c) => c.itemTitle && c.applicantName));

// 10. 审计日志（前面的操作应已入库）
const logs = await call('GET', '/api/admin/audit-logs?limit=20');
check('审计日志 200', logs.status === 200);
const actions = (logs.data?.logs || []).map((l) => l.action);
check('记录了志愿者与存放点操作', actions.includes('volunteer.grant') && actions.includes('storage.create'),
  actions.join(','));

// 11. 恢复演示数据
const reset = await call('POST', '/api/admin/reset-demo');
check('恢复演示数据 200', reset.status === 200, reset.data?.error?.message);
check('恢复后有物品', (reset.data?.counts?.items || 0) >= 4, JSON.stringify(reset.data?.counts));
const afterReset = await call('GET', '/api/admin/audit-logs?limit=5');
check('恢复动作进入审计', (afterReset.data?.logs || []).some((l) => l.action === 'demo.reset'));

// 12. 用户停用 / 启用
const targetUser = (await call('GET', '/api/admin/users?q=20230001')).data.users.find((u) => u.studentId === '20230001');
const disable = await call('POST', `/api/admin/users/${targetUser.id}/status`, { status: 'disabled' });
check('停用账号 200', disable.status === 200, disable.data?.error?.message);
const disabledLogin = await (async () => {
  const save = { ...jar };
  const r = await loginAs('20230001');
  jar = save;
  return r;
})();
check('停用后无法登录 403', disabledLogin.status === 403, disabledLogin.data?.error?.message);
const enable = await call('POST', `/api/admin/users/${targetUser.id}/status`, { status: 'active' });
check('重新启用 200', enable.status === 200);

// 13. 管理员直接设置密码（2026-11-21 需求变更：不再只是发验证码）
// 为了不影响演示账号，这里注册一个一次性账号来改
const tmpSid = '25' + stamp;
const tmpEmail = `pw${stamp}@example.com`;
const tmpPwOld = 'OldPass123';
const tmpPwNew = 'NewPass456';
const regTmp = await call('POST', '/api/auth/register',
  { studentId: tmpSid, name: '改密测试', email: tmpEmail, password: tmpPwOld });
check('改密用的一次性账号已注册', regTmp.status === 201, String(regTmp.status));

const tmpUser = (await call('GET', `/api/admin/users?q=${tmpSid}`)).data.users.find((u) => u.studentId === tmpSid);
check('后台能搜到该账号', Boolean(tmpUser));

const setPw = await call('POST', `/api/admin/users/${tmpUser.id}/reset-password`,
  { password: tmpPwNew, confirmPassword: tmpPwNew });
check('管理员直接改密码 200', setPw.status === 200, setPw.data?.error?.message);
check('返回 mode=direct', setPw.data?.mode === 'direct', String(setPw.data?.mode));
check('说明里含"踢出会话"', /踢出|会话/.test(String(setPw.data?.note || '')), String(setPw.data?.note || ''));

// 新密码能登录，旧密码不能
const loginNew = await loginAs(tmpSid, tmpPwNew);
check('新密码可登录', loginNew.status === 200, String(loginNew.status));
await loginAs('90000001');
const loginOld = await call('POST', '/api/auth/login', { studentId: tmpSid, password: tmpPwOld });
check('旧密码已失效 401', loginOld.status === 401, String(loginOld.status));
await loginAs('90000001');

// 弱密码被拒
const weakPw = await call('POST', `/api/admin/users/${tmpUser.id}/reset-password`, { password: 'short' });
check('弱密码被拒 400', weakPw.status === 400, weakPw.data?.error?.message);
// 不给密码被拒（明确要求填新密码，而不是静默去发邮件）
const noPw = await call('POST', `/api/admin/users/${tmpUser.id}/reset-password`, {});
check('不给新密码被拒 400', noPw.status === 400, noPw.data?.error?.message);

// 审计只记行为，不记密码
const auditPw = await call('GET', '/api/admin/audit-logs?limit=10');
const pwAudit = (auditPw.data?.logs || []).find((l) => l.action === 'user.set_password');
check('改密码进审计', Boolean(pwAudit), pwAudit?.summary || '(无)');
check('审计里没有明文密码', !JSON.stringify(auditPw.data?.logs || []).includes(tmpPwNew));

// 14. 老能力保留：发验证码让用户自己改
const sendCode = await call('POST', `/api/admin/users/${targetUser.id}/send-reset-code`);
check('发送重置码仍可用 200', sendCode.status === 200, sendCode.data?.error?.message);
check('发码返回投递方式', ['email', 'log'].includes(sendCode.data?.delivery), String(sendCode.data?.delivery));

// 14. 管理视角物品列表（含归档筛选）
const adminItems = await call('GET', '/api/admin/items?pageSize=50');
check('管理物品列表 200', adminItems.status === 200 && Array.isArray(adminItems.data?.items));
check('含作者学号与存放点', adminItems.data.items.every((i) => i.author?.studentId && 'storagePointName' in i));

// 15. 群发系统消息
const broadcast = await call('POST', '/api/admin/messages', {
  role: 'all', title: '系统维护通知', body: '今晚 23:00 将进行例行维护，期间可能短暂无法访问。',
});
check('群发系统消息 201', broadcast.status === 201, broadcast.data?.error?.message);
check('收件人数 >= 3', (broadcast.data?.recipients || 0) >= 3, String(broadcast.data?.recipients));

// 16. 导出统计
const stats = await call('GET', '/api/admin/stats');
check('统计 200', stats.status === 200);
check('含物品状态分布', Array.isArray(stats.data?.items?.byStatus) && stats.data.items.byStatus.length > 0);
check('含近 7 日新增', Array.isArray(stats.data?.daily) && stats.data.daily.length > 0);

// 17. 重算全部匹配（需求基线 §7「管理员重新计算匹配」）
const recompute = await call('POST', '/api/admin/recompute-matches');
check('重算匹配 200', recompute.status === 200, recompute.data?.error?.message);
check('返回扫描数与重算数', typeof recompute.data?.scanned === 'number' && typeof recompute.data?.recomputed === 'number',
  `scanned=${recompute.data?.scanned} recomputed=${recompute.data?.recomputed}`);
check('无失败项', Array.isArray(recompute.data?.failures) && recompute.data.failures.length === 0);
const auditAfterRecompute = await call('GET', '/api/admin/audit-logs?limit=10');
check('重算动作进审计日志',
  (auditAfterRecompute.data?.logs || []).some((l) => l.action === 'matching.recompute'));

// 18. 学生调用重算应被拒
await loginAs('20230001');
const studentRecompute = await call('POST', '/api/admin/recompute-matches');
check('学生重算被拒 403', studentRecompute.status === 403, String(studentRecompute.status));

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
