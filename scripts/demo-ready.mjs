// 演示前体检：一条命令查完「演示当天会不会翻车」的关键点
//
// 与 demo-check.mjs 的分工：
//   demo-check  = 数据链路能不能走通（会创建/修改数据）
//   demo-ready  = 环境与配置是否就绪（只读，不产生数据）
//
// 用法：
//   node scripts/demo-ready.mjs                     # 查本机 http://localhost:3000
//   node scripts/demo-ready.mjs https://xxx.trycloudflare.com   # 查公网地址
import { readFileSync, existsSync } from 'node:fs';

const arg = process.argv[2] || 'http://127.0.0.1:3000';
const BASE = arg.replace(/\/$/, '');

let pass = 0;
let warn = 0;
let fail = 0;
const ok = (t, d) => { pass += 1; console.log(`  ✓ ${t}${d ? ' — ' + d : ''}`); };
const wa = (t, d, fix) => { warn += 1; console.log(`  ! ${t}${d ? ' — ' + d : ''}${fix ? '\n      处理：' + fix : ''}`); };
const no = (t, d, fix) => { fail += 1; console.log(`  ✗ ${t}${d ? ' — ' + d : ''}${fix ? '\n      处理：' + fix : ''}`); };

async function req(path, opts = {}) {
  try {
    const r = await fetch(BASE + path, { ...opts, headers: { accept: 'application/json', ...(opts.headers || {}) } });
    let data = null;
    try { data = await r.json(); } catch { /* 非 JSON */ }
    return { ok: r.ok, status: r.status, data, headers: r.headers };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

console.log(`\n=== 演示前体检 @ ${BASE} ===\n`);

// 1. 服务活着 + 数据库 + 上传目录 + 磁盘
console.log('① 服务健康');
const health = await req('/health');
if (health.status === 0) {
  no('服务无响应', health.error, '先 npm start，再跑本脚本');
  console.log(`\n结果：通过 ${pass}，警告 ${warn}，失败 ${fail}`);
  process.exit(1);
}
if (health.ok) ok('HTTP 200', `${BASE}/health`);
else no('健康检查未通过', `HTTP ${health.status}`, '看服务端日志里的启动错误');

const h = health.data || {};
if (h.database === 'ok') ok('数据库可读');
else no('数据库异常', String(h.database), 'SQLite 文件损坏或路径不对，跑 npm run db:migrate');
if (h.uploads === 'ok') ok('上传目录存在');
else no('上传目录缺失', String(h.uploads), '创建 uploads 目录或检查 UPLOAD_DIR');
if (typeof h.items === 'number' && h.items > 0) ok('有演示数据', `${h.items} 条物品`);
else wa('物品为 0', '演示时会看到空广场', 'npm run db:seed');
if (typeof h.diskFreeMB === 'number') {
  if (h.diskFreeMB > 200) ok('磁盘余量充足', `${h.diskFreeMB} MB`);
  else wa('磁盘余量偏低', `${h.diskFreeMB} MB`, '清一下 uploads 或临时文件');
}

// 2. 邮件通道（A-02）
console.log('\n② 邮件通道');
const mail = h.mail || {};
if (!mail.configured) {
  wa('SMTP 未配置', '验证码只会打在服务端日志', '见 docs/A-02-邮件配置.md');
} else if (mail.lastResult === 'delivered') {
  ok('最近一次发信成功', mail.lastAt || '');
} else if (mail.lastResult) {
  wa('最近一次发信失败', `${mail.lastResult}${mail.lastError ? ' — ' + mail.lastError.slice(0, 80) : ''}`,
    '看 docs/A-02-邮件配置.md 的故障对照表；现场可从日志 [mail:fallback] 取码');
} else {
  ok('SMTP 已配置', '还没发过信，跑 node scripts/mail-check.mjs 你的邮箱 验证');
}

// 3. 演示账号能不能登录
console.log('\n③ 演示账号');
async function loginAs(studentId, label) {
  const jar = {};
  const absorb = (r) => {
    for (const c of r.headers.getSetCookie?.() || []) {
      const [p] = c.split(';');
      const i = p.indexOf('=');
      if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    }
  };
  const headers = () => {
    const x = { accept: 'application/json' };
    if (jar.xf_csrf) x['x-csrf-token'] = jar.xf_csrf;
    if (Object.keys(jar).length) x.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    return x;
  };
  try {
    await fetch(BASE + '/', { headers: headers() }).then(absorb);
    const r = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ studentId, password: 'demo1234' }),
    });
    absorb(r);
    const d = await r.json().catch(() => ({}));
    return { status: r.status, user: d.user, headers: headers, jar };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

const stu = await loginAs('20230001', '学生');
if (stu.status === 200) ok('学生 20230001 可登录', `角色 ${stu.user?.role}`);
else no('学生登录失败', `HTTP ${stu.status}`, '确认已 npm run db:seed，密码 demo1234');

const vol = await loginAs('20230002', '志愿者');
if (vol.status === 200) {
  const pts = vol.user?.storagePoints || [];
  if (pts.length) ok('志愿者 20230002 已绑定存放点', pts.map((p) => p.name).join('、'));
  else wa('志愿者未绑定存放点', '演示时无法确认入库', '后台 → 用户 → 授予志愿者并勾选存放点');
} else no('志愿者登录失败', `HTTP ${vol.status}`, 'npm run db:seed');

const adm = await loginAs('90000001', '管理员');
if (adm.status === 200) ok('管理员 90000001 可登录');
else wa('管理员登录失败', `HTTP ${adm.status}`, '演示主线不需要管理员，但建议能登');

// 4. 公开数据
console.log('\n④ 公开接口');
const items = await req('/api/items?pageSize=5');
if (items.ok) ok('匿名可看广场', `共 ${items.data?.total} 条`);
else no('广场打不开', `HTTP ${items.status}`, '检查服务日志');
const first = items.data?.items?.[0];
if (first) {
  if (!('contact' in (first || {}))) ok('列表不含联系方式');
  else wa('列表里出现了 contact 字段', '隐私问题', '检查 items 列表序列化');
}
const points = await req('/api/storage-points');
if (points.ok && (points.data?.storagePoints || []).length >= 2) {
  ok('存放点可用', `${points.data.storagePoints.length} 个`);
} else {
  wa('存放点不足 2 个', '发布招领时选择太少', '后台 → 存放点 → 新增');
}

// 5. 公网地址（如果查的是隧道）
console.log('\n⑤ 外网可达性');
if (/^https?:\/\/(127\.|localhost)/.test(BASE)) {
  wa('当前查的是本机地址', '老师用手机打不开', '改成隧道地址：node scripts/demo-ready.mjs https://xxx.trycloudflare.com');
} else {
  ok('公网地址可访问', '本次体检就是经公网请求成功的');
  const cfg = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
  const m = /^PUBLIC_BASE_URL\s*=\s*(.+)$/m.exec(cfg);
  const pub = m ? m[1].trim() : '';
  if (!pub) wa('PUBLIC_BASE_URL 未设置', '邮件里不会带站点链接');
  else if (pub.replace(/\/$/, '') === BASE) ok('PUBLIC_BASE_URL 与当前地址一致');
  else wa('PUBLIC_BASE_URL 与当前地址不一致', `配置的是 ${pub}`, '改 .env 后重启服务，否则邮件链接指向旧地址');
}

console.log(`\n结果：通过 ${pass}，警告 ${warn}，失败 ${fail}`);
if (fail === 0 && warn === 0) console.log('演示环境就绪 ✅\n');
else if (fail === 0) console.log('基本可用，但有警告——建议按上面的"处理"逐条过一遍 ⚠️\n');
else console.log('有阻塞项，先修再演示 ⛔\n');
process.exit(fail === 0 ? 0 : 1);
