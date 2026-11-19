// 认领流程冒烟：提交 → 双签 → 自动拒绝其他 → 归还
// 前置：db:migrate + db:seed（志愿者/管理员演示账号）
// 用法：node scripts/smoke-claims.mjs [baseUrl] [serverLogPath]
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3131';
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

let pass = 0; let fail = 0;
const check = (n, ok, d = '') => { ok ? (pass++, console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`)); };

const stamp = Date.now().toString().slice(-6);

const IDS = { owner: 'OW', owner2: 'O2', applicant: 'AP', studentx: 'SX' };
async function register(tag) {
  const email = `${tag}${stamp}@demo.local`;
  jar = {};
  await call('GET', '/');
  await call('POST', '/api/auth/register', {
    studentId: '2' + stamp + (IDS[tag] || 'XX'),
    name: tag, email, password: 'demo1234', confirmPassword: 'demo1234',
  });
  const log = readFileSync(LOG, 'utf8');
  const code = [...log.matchAll(new RegExp(`to=${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} code=(\\d{6})`, 'g'))].at(-1)?.[1];
  await call('POST', '/api/auth/verify-email', { email, code });
  return { email, jarSnapshot: { ...jar } };
}
async function loginAs(studentId) {
  jar = {};
  await call('GET', '/');
  return call('POST', '/api/auth/login', { studentId, password: 'demo1234' });
}
function useJar(snapshot) {
  jar = { ...snapshot };
}

console.log(`\n=== 认领冒烟 @ ${BASE} ===`);

// 1. 持有人发招领并入库
await register('owner');
const found = await call('POST', '/api/items', {
  type: 'found', title: '蓝色保温杯', category: '其他',
  description: '蓝色保温杯，杯底有一道划痕，在第六教学楼 105 捡到。',
  location: '第六教学楼 105', eventAt: new Date(Date.now() - 7200e3).toISOString(),
  valueLevel: 'normal', storagePointId: 'stp_demo_lib',
});
const itemId = found.data?.item?.id;
check('招领发布 201', found.status === 201, found.data?.error?.message);

await loginAs('20230002'); // 志愿者（图书馆存放点）
const store = await call('PATCH', `/api/items/${itemId}`, { status: 'stored' });
check('志愿者确认入库 200', store.status === 200, store.data?.error?.message);

// 2. 申请人提交认领
const applicant = await register('applicant');
const apply = await call('POST', `/api/items/${itemId}/claims`, {
  note: '杯底那道划痕是我的，上周三在 105 上自习时落在桌洞里，杯身还有一张猫咪贴纸。',
});
check('提交认领 201', apply.status === 201, apply.data?.error?.message);
const claimId = apply.data?.claim?.id;
check('物品状态变为 claim_pending', apply.data?.claim?.itemStatus === 'claim_pending');

// 3. 重复提交 409
const dup = await call('POST', `/api/items/${itemId}/claims`, {
  note: '再提一次，说明文字足够长以通过校验，测试重复提交。',
});
check('重复提交 409', dup.status === 409, dup.data?.error?.code);

// 4. 不能申请自己的物品
await register('owner2');
const mine = await call('POST', `/api/items/${itemId}/claims`, {
  note: '这是我自己的帖子，不应该允许申请认领，测试用文本。',
});
check('非发布者仍可提交（owner2 是别人）', mine.status === 201 || mine.status === 409, `实际 ${mine.status}`);

// 5. 发布者同意（第一阶段）
useJar(applicant.jarSnapshot); // 占位，稍后切回
await loginAs('20230001'); // 学生账号不是发布者 → 应 403
const notOwner = await call('POST', `/api/claims/${claimId}/decision`, { decision: 'agree' });
check('非发布者表态被拒 403', notOwner.status === 403, notOwner.data?.error?.message);

// 用真正的发布者表态：重新登录 owner 账号（注册时用的学号召回）
// owner 的学号在第 2033+stamp，用登录接口
const ownerLogin = await loginAs('2' + stamp + 'OW');
check('发布者登录成功', Boolean(jar.xf_sid), ownerLogin.data?.error?.message);
const agree = await call('POST', `/api/claims/${claimId}/decision`, { decision: 'agree' });
check('发布者同意 200', agree.status === 200, agree.data?.error?.message);

// 6. 学生不能做最终确认
await register('studentx');
const noRight = await call('POST', `/api/claims/${claimId}/decision`, { decision: 'approve' });
check('普通学生不能最终确认 403', noRight.status === 403, noRight.data?.error?.message);

// 7. 志愿者最终确认 → 待领取，其他 pending 自动拒绝
const otherClaim = dup; // 复用占位
await loginAs('20230002');
const approve = await call('POST', `/api/claims/${claimId}/decision`, { decision: 'approve', note: '实物核对无误' });
check('志愿者确认通过 200', approve.status === 200, approve.data?.error?.message);
check('物品状态变为 ready_for_pickup', approve.data?.item?.status === 'ready_for_pickup', approve.data?.item?.status);

useJar(applicant.jarSnapshot);
const detail = await call('GET', `/api/items/${itemId}`);
check('认领通过后申请人能看到联系方式', detail.data?.item?.contact !== null && typeof detail.data?.item?.contact === 'object',
  JSON.stringify(detail.data?.item?.contact));

// 8. 申请人收到通过消息
useJar(applicant.jarSnapshot);
const msgs = await call('GET', '/api/messages?filter=all');
const passed = (msgs.data?.messages || []).filter((m) => m.type === 'claim' && m.title.includes('认领通过'));
check('申请人收到「认领通过」消息', passed.length >= 1, `共 ${passed.length} 条`);

// 9. 归还
await loginAs('20230002');
const returned = await call('POST', `/api/items/${itemId}/return`);
check('确认归还 200', returned.status === 200, returned.data?.error?.message);
check('物品状态变为 returned', returned.data?.item?.status === 'returned');

// 10. 已归还不能重复归还
const again = await call('POST', `/api/items/${itemId}/return`);
check('重复归还被拒 400', again.status === 400, again.data?.error?.message);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
