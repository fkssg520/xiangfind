// 物品接口冒烟：发布 → 列表 → 详情 → 编辑 → 收藏 → 权限
// 用法：node scripts/smoke-items.mjs [baseUrl] [serverLogPath]
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3103';
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
async function call(method, path, body, useJar = true) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (useJar && jar.xf_csrf) headers['x-csrf-token'] = jar.xf_csrf;
  if (useJar && Object.keys(jar).length) headers.cookie = cookieHeader();
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (useJar) absorb(res);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

let pass = 0; let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function logCode(email) {
  const log = readFileSync(LOG, 'utf8');
  const re = new RegExp(`to=${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} code=(\\d{6})`, 'g');
  const all = [...log.matchAll(re)];
  return all.at(-1)?.[1];
}
async function newSession(email, studentId) {
  jar = {};
  await call('GET', '/');
  await call('POST', '/api/auth/register', {
    studentId, name: '冒烟用户', email, password: 'demo1234', confirmPassword: 'demo1234',
  });
  const code = logCode(email);
  const v = await call('POST', '/api/auth/verify-email', { email, code });
  if (v.status !== 200) throw new Error(`验证失败 ${v.status} ${JSON.stringify(v.data)}`);
  return jar;
}

const stamp = Date.now().toString().slice(-6);
console.log(`\n=== 物品冒烟 @ ${BASE} ===`);

const meEmail = `items${stamp}@demo.local`;
const otherEmail = `other${stamp}@demo.local`;
await newSession(meEmail, '2088' + stamp);
check('新用户登录并就绪', Boolean(jar.xf_sid));

// 取存放点（seed 提供）
const home = await call('GET', '/');

// 1. 发布普通招领
const p1 = await call('POST', '/api/items', {
  type: 'found', title: '黑色雨伞（自动伞）', category: '其他',
  description: '在第三教学楼门口捡到，黑色长柄自动伞，伞骨有一处弯。',
  location: '第三教学楼门口', eventAt: new Date(Date.now() - 3600e3).toISOString(),
  valueLevel: 'normal', storagePointId: 'stp_demo_lib',
});
check('发布普通招领 201', p1.status === 201, p1.data?.error?.message || '');
const itemId = p1.data?.item?.id;
check('招领初始状态为 pending_storage', p1.data?.item?.status === 'pending_storage', p1.data?.item?.status);

// 2. 贵重物品选普通存放点应被拒
const p2 = await call('POST', '/api/items', {
  type: 'found', title: '银色手链', category: '其他', description: '在操场看台捡到一条银色手链，有刻字。',
  location: '操场东看台', valueLevel: 'valuable', storagePointId: 'stp_demo_lib',
});
check('贵重物品选普通存放点被拒 400', p2.status === 400, p2.data?.error?.message);

// 3. 贵重物品选保卫处应通过
const p3 = await call('POST', '/api/items', {
  type: 'found', title: '银色手链', category: '其他', description: '在操场看台捡到一条银色手链，有刻字。',
  location: '操场东看台', valueLevel: 'valuable', storagePointId: 'stp_demo_guard',
});
check('贵重物品选保卫处存放点 201', p3.status === 201, p3.data?.error?.message);

// 4. 标题太笼统应被拒
const p4 = await call('POST', '/api/items', {
  type: 'lost', title: '东西', category: '其他', description: '丢了东西', location: '图书馆',
});
check('标题太笼统被拒 400', p4.status === 400, p4.data?.error?.message);

// 5. 招领缺存放点应被拒
const p5 = await call('POST', '/api/items', {
  type: 'found', title: '水杯', category: '其他', description: '捡到一个水杯', location: '食堂',
});
check('招领缺存放点被拒 400', p5.status === 400, p5.data?.error?.message);

// 6. 列表
const list = await call('GET', '/api/items?pageSize=50');
check('列表 200', list.status === 200);
const mine = (list.data?.items || []).filter((i) => i.id === itemId);
check('列表包含刚发布的物品', mine.length === 1);
check('列表项不含联系方式', mine[0] && !('contact' in mine[0]) && !mine[0].author?.email);
check('列表项含 storagePoint', Boolean(mine[0]?.storagePoint?.name));

// 7. 搜索与筛选
const q = await call('GET', '/api/items?q=雨伞');
check('关键词搜索命中', (q.data?.items || []).some((i) => i.id === itemId));
const byType = await call('GET', '/api/items?type=lost');
check('按类型筛选不含招领', (byType.data?.items || []).every((i) => i.type === 'lost'));

// 8. 详情
const detail = await call('GET', `/api/items/${itemId}`);
check('详情 200', detail.status === 200);
check('详情含 description', typeof detail.data?.item?.description === 'string');
check('详情含 matches 数组', Array.isArray(detail.data?.item?.matches));
check('未认领通过时 contact 为 null', detail.data?.item?.contact === null);
check('本人查看 isOwner=true', detail.data?.item?.isOwner === true);

// 9. 编辑（本人）
const edit = await call('PATCH', `/api/items/${itemId}`, { title: '黑色长柄雨伞' });
check('本人编辑标题 200', edit.status === 200, edit.data?.error?.message);
check('编辑后标题已更新', edit.data?.item?.title === '黑色长柄雨伞');

// 10. 学生不能确认入库
const confirm = await call('PATCH', `/api/items/${itemId}`, { status: 'stored' });
check('学生确认入库被拒 400', confirm.status === 400, confirm.data?.error?.message);

// 11. 收藏
const fav1 = await call('POST', `/api/items/${itemId}/favorite`);
check('收藏 200 且为 true', fav1.status === 200 && fav1.data?.isFavorited === true);
const fav2 = await call('POST', `/api/items/${itemId}/favorite`);
check('再次点击取消收藏', fav2.status === 200 && fav2.data?.isFavorited === false);

// 12. 他人不能编辑
await newSession(otherEmail, '2077' + stamp);
const otherEdit = await call('PATCH', `/api/items/${itemId}`, { title: '被别人改了' });
check('他人编辑被拒 403', otherEdit.status === 403, otherEdit.data?.error?.message);

// 13. 未登录访问（D-012：列表对游客只读开放）
const anon = await call('GET', '/api/items', null, false);
check('未登录可读列表 200（D-012）', anon.status === 200);
check('匿名列表不含联系方式', (anon.data?.items || []).every((i) => !('contact' in i)));
const anonWrite = await call('POST', '/api/items', { type: 'lost', title: 'x', category: '其他', description: 'x', location: 'x' }, false);
check('未登录写操作被拒（403/401）', anonWrite.status === 403 || anonWrite.status === 401, `实际 ${anonWrite.status}`);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
