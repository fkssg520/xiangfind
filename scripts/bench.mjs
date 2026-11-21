// 容量基线：灌 N 条物品后测列表/详情接口延迟，回答"能撑多少数据"
// 用法：
//   node scripts/bench.mjs                     # 用当前库直接测
//   node scripts/bench.mjs --seed 2000         # 先灌 2000 条再测（会写入 items 表）
//   node scripts/bench.mjs --base http://127.0.0.1:3000 --rounds 50
// 说明：只读测试，不改数据（--seed 除外）。测的是单进程 + SQLite 的实际表现。
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const num = (flag, fb) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : fb; };
const BASE = (args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://127.0.0.1:3000').replace(/\/$/, '');
const ROUNDS = num('--rounds', 50);
const SEED = num('--seed', 0);

const DB_PATH = resolve(process.env.DATABASE_PATH || './data/xiangfind.db');

// 1) 可选：灌数据
if (SEED > 0) {
  if (!existsSync(DB_PATH)) { console.error(`数据库不存在：${DB_PATH}`); process.exit(1); }
  const db = new DatabaseSync(DB_PATH);
  const user = db.prepare("SELECT id FROM users LIMIT 1").get();
  const point = db.prepare("SELECT id FROM storage_points WHERE type = 'normal' LIMIT 1").get();
  if (!user || !point) { console.error('库里没有用户或存放点，先 npm run db:seed'); process.exit(1); }
  const now = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO items (id,user_id,type,title,category,description,event_at,location,value_level,storage_point_id,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const cats = ['证件', '电子产品', '钥匙', '书籍', '衣物', '其他'];
  db.exec('BEGIN');
  try {
    for (let i = 0; i < SEED; i += 1) {
      const id = 'itm_bench_' + i.toString(36).padStart(6, '0');
      ins.run(id, user.id, i % 2 ? 'found' : 'lost', `压测物品 ${i}`, cats[i % cats.length],
        `压测数据 ${i}：这是一条用于测量列表接口性能的记录，描述长度接近真实。`,
        now, `第${(i % 9) + 1}教学楼`, 'normal', i % 2 ? point.id : null, i % 2 ? 'stored' : 'open', now, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(`  ✗ 灌数据失败（已回滚）：${err.message}`);
    console.error(`    user=${user.id} point=${point.id}`);
    process.exit(1);
  }
  const total = db.prepare('SELECT COUNT(*) AS c FROM items').get().c;
  console.log(`  已灌 ${SEED} 条，当前共 ${total} 条\n`);
  db.close();
}

// 2) 登录（已登录请求不受匿名限流 60/min 限制，否则测到一半全是 429）
let sessionCookie = '';
let csrf = '';
try {
  const jar = {};
  const absorb = (res) => {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  };
  const hdr = () => {
    const h = { accept: 'application/json' };
    if (csrf) h['x-csrf-token'] = csrf;
    if (Object.keys(jar).length) h.cookie = Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
    return h;
  };
  const g = await fetch(BASE + '/', { headers: hdr() });
  absorb(g);
  csrf = jar.xf_csrf || '';   // ← 必须在校验前拿到，否则登录会 403 CSRF
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { ...hdr(), 'content-type': 'application/json' },
    body: JSON.stringify({ studentId: '20230001', password: 'demo1234' }),
  });
  absorb(r);
  if (r.status === 200) {
    sessionCookie = jar.xf_sid || '';
    csrf = jar.xf_csrf || '';
    console.log('  已登录为演示学生（避免撞匿名限流）\n');
  } else {
    console.log(`  未登录（${r.status}），将以匿名身份测，注意 60/min 限流\n`);
  }
} catch { console.log('  登录失败，按匿名测\n'); }

async function timeOnce(path) {
  const headers = { accept: 'application/json' };
  if (csrf) headers['x-csrf-token'] = csrf;
  if (sessionCookie) headers.cookie = `xf_sid=${sessionCookie}; xf_csrf=${csrf}`;
  const t0 = performance.now();
  const r = await fetch(BASE + path, { headers });
  await r.text();
  return { ms: performance.now() - t0, status: r.status };
}

function stats(list) {
  const s = [...list].sort((a, b) => a - b);
  const pick = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { avg, p50: pick(0.5), p95: pick(0.95), max: s[s.length - 1] };
}

async function run(name, path, rounds = ROUNDS) {
  const times = [];
  let statuses = new Set();
  for (let i = 0; i < rounds; i += 1) {
    const { ms, status } = await timeOnce(path);
    times.push(ms); statuses.add(status);
  }
  const st = stats(times);
  const flag = st.p95 < 100 ? '✓' : st.p95 < 300 ? '·' : '✗';
  console.log(`  ${flag} ${name.padEnd(26)} avg ${st.avg.toFixed(1)}ms  p50 ${st.p50.toFixed(1)}ms  p95 ${st.p95.toFixed(1)}ms  max ${st.max.toFixed(0)}ms  [${[...statuses].join(',')}]`);
  return st;
}

console.log(`=== 容量基线 @ ${BASE}（每项 ${ROUNDS} 次）===\n`);

const health = await fetch(BASE + '/health').then((r) => r.json()).catch(() => null);
if (!health) { console.error('服务没起来'); process.exit(1); }
const itemCount = health.items ?? '?';
console.log(`  物品总数：${itemCount}\n`);

await run('匿名列表（首页 20 条）', '/api/items?pageSize=20');
await run('匿名列表（50 条）', '/api/items?pageSize=50');
await run('搜索（关键词）', '/api/items?q=' + encodeURIComponent('压测') + '&pageSize=20');
await run('详情', '/api/items/' + encodeURIComponent((await fetch(BASE + '/api/items?pageSize=1').then((r) => r.json())).items[0].id));
await run('存放点列表', '/api/storage-points');

// 3) 并发
console.log('\n  并发 20 个列表请求：');
const t0 = performance.now();
const results = await Promise.all(Array.from({ length: 20 }, () => timeOnce('/api/items?pageSize=20')));
const wall = performance.now() - t0;
const okCount = results.filter((r) => r.status === 200).length;
console.log(`    全部完成耗时 ${wall.toFixed(0)}ms，成功 ${okCount}/20，单请求均值 ${(results.reduce((a, b) => a + b.ms, 0) / 20).toFixed(1)}ms`);

console.log('\n判据：p95 < 100ms 视为良好（✓），100-300ms 可用（·），>300ms 需优化（✗）');
console.log('注意：单机 SQLite + 单进程 Node，数据量再大要换 PostgreSQL（数据层已隔离在 src/services）\n');
