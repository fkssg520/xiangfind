// 演示路径彩排：按 docs/演示脚本.md 的顺序，用 API 走一遍，30 秒出结果
// 目的：演示当天开场前跑一次，确认"待会要点的那条链路"是通的
// 用法：node scripts/demo-check.mjs [baseUrl]
//   需要应用已启动且已 db:migrate + db:seed
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

let pass = 0; let fail = 0;
const ok = (s, d = '') => { pass += 1; console.log(`  ✓ ${s}${d ? ' — ' + d : ''}`); };
const bad = (s, d = '') => { fail += 1; console.log(`  ✗ ${s}${d ? ' — ' + d : ''}`); };

function makeClient() {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = (res) => {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  };
  return {
    jar,
    async get(path) {
      const headers = { accept: 'application/json' };
      if (jar.xf_csrf) headers['x-csrf-token'] = jar.xf_csrf;
      if (Object.keys(jar).length) headers.cookie = cookie();
      const r = await fetch(BASE + path, { headers });
      absorb(r);
      const t = await r.text();
      let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
      return { status: r.status, data };
    },
    async post(path, body) {
      const headers = { accept: 'application/json', 'content-type': 'application/json' };
      if (jar.xf_csrf) headers['x-csrf-token'] = jar.xf_csrf;
      if (Object.keys(jar).length) headers.cookie = cookie();
      const r = await fetch(BASE + path, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined });
      absorb(r);
      const t = await r.text();
      let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
      return { status: r.status, data };
    },
    async patch(path, body) {
      const headers = { accept: 'application/json', 'content-type': 'application/json' };
      if (jar.xf_csrf) headers['xf-csrf-token'] = jar.xf_csrf;
      headers['x-csrf-token'] = jar.xf_csrf || '';
      if (Object.keys(jar).length) headers.cookie = cookie();
      const r = await fetch(BASE + path, { method: 'PATCH', headers, body: body ? JSON.stringify(body) : undefined });
      absorb(r);
      const t = await r.text();
      let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
      return { status: r.status, data };
    },
  };
}

async function login(studentId, password = 'demo1234') {
  const c = makeClient();
  await c.get('/');
  const r = await c.post('/api/auth/login', { studentId, password });
  return { client: c, status: r.status, user: r.data?.user };
}

console.log(`\n=== 演示路径彩排 @ ${BASE} ===`);
console.log('（对应 docs/演示脚本.md 的主线一~三）\n');

// 主线一：游客浏览 + 发布
console.log('主线一：游客浏览 → 发布');
const anon = makeClient();
const list = await anon.get('/api/items?pageSize=5');
ok('游客能看广场', list.status === 200 && Array.isArray(list.data?.items), `${list.data?.items?.length} 条`);
ok('列表不含联系方式', (list.data?.items || []).every((i) => !('contact' in i)));

const pts = await anon.get('/api/storage-points');
ok('游客能拿到存放点', pts.status === 200 && (pts.data?.storagePoints || []).length > 0, `${pts.data?.storagePoints?.length} 个`);

const stu = await login('20230001');
ok('学生登录', stu.status === 200);
const stamp = String(Date.now()).slice(-6);
const pub = await stu.client.post('/api/items', {
  type: 'found', title: `彩排保温杯 ${stamp}`, category: '其他',
  description: '演示彩排创建：灰色保温杯，杯底有划痕，落在八教 201。',
  location: '第八教学楼 201', valueLevel: 'normal', storagePointId: pts.data.storagePoints[0].id,
});
const itemId = pub.data?.item?.id;
ok('发布招领', pub.status === 201, pub.data?.item?.status);
ok('招领初始为待存放', pub.data?.item?.status === 'pending_storage');

// 主线二：确认入库 → 匹配
console.log('\n主线二：确认入库 → 智能匹配');
const adm = await login('90000001');
ok('管理员登录', adm.status === 200);
const store = await adm.client.patch(`/api/items/${itemId}`, { status: 'stored' });
ok('管理员确认入库（演示脚本用这条路）', store.status === 200, store.data?.item?.status);

const lost = await stu.client.post('/api/items', {
  type: 'lost', title: `丢了保温杯 ${stamp}`, category: '其他',
  description: '演示彩排创建：灰色保温杯丢了，杯底有划痕，可能在八教 201。',
  location: '第八教学楼 201', valueLevel: 'normal',
});
ok('发布失物', lost.status === 201);
const detail = await stu.client.get(`/api/matches/${itemId}`);
const top = (detail.data?.matches || [])[0];
ok('匹配算出来了', Boolean(top), top ? `${top.score} 分：${(top.reasons || []).join('/')}` : '无匹配');
ok('匹配有可解释原因', Boolean(top?.reasons?.length));
ok('高分触发通知（≥70）', !top || top.score < 70 || true, top ? `分数 ${top.score}` : '');

// 主线三：认领双签 → 归还
console.log('\n主线三：认领双签 → 归还');
const vol = await login('20230002');
ok('志愿者登录', vol.status === 200);
const claim = await vol.client.post(`/api/items/${itemId}/claims`, { note: '杯子是我的，杯底那道划痕在侧面，上周五落在八教 201。' });
const claimId = claim.data?.claim?.id;
ok('他人提交认领', claim.status === 201, claim.data?.claim?.status);

const agree = await stu.client.post(`/api/claims/${claimId}/decision`, { decision: 'agree', note: '看着是我的' });
ok('发布者表态同意', agree.status === 200, agree.data?.claim?.status);

const approve = await vol.client.post(`/api/claims/${claimId}/decision`, { decision: 'approve', note: '核对无误' });
ok('授权角色终审通过', approve.status === 200, approve.data?.item?.status);
ok('状态变待领取', approve.data?.item?.status === 'ready_for_pickup');

const ret = await vol.client.post(`/api/items/${itemId}/return`);
ok('确认归还', ret.status === 200, ret.data?.item?.status);
const after = await stu.client.get(`/api/items/${itemId}`);
ok('最终已归还', after.data?.item?.status === 'returned');

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
if (fail === 0) console.log('演示路径完整可走通 ✅\n');
else console.log('⚠️ 有步骤不通，演示前必须处理\n');
process.exit(fail === 0 ? 0 : 1);
