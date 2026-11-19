// 图片上传冒烟：类型校验、大小上限、数量上限、发布挂图、静态访问
// 用法：node scripts/smoke-uploads.mjs [baseUrl] [serverLogPath]
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3105';
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
async function upload(formData) {
  const res = await fetch(BASE + '/api/uploads', {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'x-csrf-token': jar.xf_csrf },
    body: formData,
  });
  absorb(res);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

// 真实文件头，不依赖图片库
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x00),
]);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 0x00),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.alloc(64, 0x00),
]);
const FAKE = Buffer.from('<!DOCTYPE html><html>not an image</html>', 'utf8');

let pass = 0; let fail = 0;
const check = (n, ok, d = '') => { ok ? (pass++, console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`)); };

const stamp = Date.now().toString().slice(-6);
const email = `up${stamp}@demo.local`;

console.log(`\n=== 图片上传冒烟 @ ${BASE} ===`);

// 登录
await call('GET', '/');
await call('POST', '/api/auth/register', {
  studentId: '2066' + stamp, name: '上传测试', email, password: 'demo1234', confirmPassword: 'demo1234',
});
const log = readFileSync(LOG, 'utf8');
const code = [...log.matchAll(new RegExp(`to=${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} code=(\\d{6})`, 'g'))].at(-1)?.[1];
const v = await call('POST', '/api/auth/verify-email', { email, code });
check('登录就绪', v.status === 200);

// 1. PNG
let fd = new FormData();
fd.append('files', new Blob([PNG], { type: 'image/png' }), 'a.png');
let r = await upload(fd);
check('PNG 上传 201', r.status === 201, r.data?.error?.message || '');
const png = r.data?.files?.[0];
check('返回 fileName 与 url', Boolean(png?.fileName && png?.url === `/uploads/${png.fileName}`));
check('识别为 image/png', png?.mimeType === 'image/png');

// 2. 伪装成 png 的 HTML
fd = new FormData();
fd.append('files', new Blob([FAKE], { type: 'image/png' }), 'evil.png');
r = await upload(fd);
check('伪造 PNG 被拒 400', r.status === 400, r.data?.error?.message);

// 3. 扩展名与实际不符
fd = new FormData();
fd.append('files', new Blob([JPEG], { type: 'image/jpeg' }), 'photo.png');
r = await upload(fd);
check('扩展名不符被拒 400', r.status === 400, r.data?.error?.message);

// 4. JPEG 正常
fd = new FormData();
fd.append('files', new Blob([JPEG], { type: 'image/jpeg' }), 'b.jpg');
r = await upload(fd);
check('JPEG 上传 201', r.status === 201, r.data?.error?.message);
const jpg = r.data?.files?.[0];

// 5. WebP 正常
fd = new FormData();
fd.append('files', new Blob([WEBP], { type: 'image/webp' }), 'c.webp');
r = await upload(fd);
check('WebP 上传 201', r.status === 201, r.data?.error?.message);

// 6. 超过 5MB
fd = new FormData();
fd.append('files', new Blob([Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])], { type: 'image/png' }), 'big.png');
r = await upload(fd);
check('超过 5MB 被拒 400', r.status === 400, r.data?.error?.message);

// 7. 一次超过 3 张
fd = new FormData();
for (let i = 0; i < 4; i++) fd.append('files', new Blob([PNG], { type: 'image/png' }), `p${i}.png`);
r = await upload(fd);
check('超过 3 张被拒 400', r.status === 400, r.data?.error?.message);

// 8. 发布时挂图
const created = await call('POST', '/api/items', {
  type: 'lost', title: '带图的失物帖', category: '其他',
  description: '这张帖挂了图片，用来验证 item_images 关联。',
  location: '测试地点', images: [png.fileName, jpg.fileName],
});
check('发布带图 201', created.status === 201, created.data?.error?.message);
check('详情返回 2 张图', created.data?.item?.images?.length === 2, JSON.stringify(created.data?.item?.images));

// 9. 静态访问图片
const imgRes = await fetch(BASE + png.url);
check('图片可通过 /uploads 访问', imgRes.status === 200, `content-type=${imgRes.headers.get('content-type')}`);

// 10. 引用不存在的图片
const bad = await call('POST', '/api/items', {
  type: 'lost', title: '坏图帖', category: '其他',
  description: '引用了不存在的图片名，应该被拒。', location: '测试地点', images: ['not-exist.png'],
});
check('引用不存在的图片被拒 400', bad.status === 400, bad.data?.error?.message);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
