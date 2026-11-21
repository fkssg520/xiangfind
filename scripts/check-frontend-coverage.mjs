// 前端能力覆盖检查（反向）：需求里用户可见的能力，前端必须真的调用对应接口
//
// 为什么需要它：2026-11-21 发现「后端有接口 + 有测试」但「前端从未调用」的缺口——
//   图片上传 /api/uploads、收藏 /api/items/:id/favorite 都是这样漏的。
//   check-frontend-api.mjs 只校验「已存在的调用是否有效」，不校验「该有的调用在不在」。
//
// 用法：node scripts/check-frontend-coverage.mjs [publicDir]
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PUBLIC = resolve(process.argv[2] || './public');
const jsPath = join(PUBLIC, 'app.js');

let pass = 0; let fail = 0;
const ok = (n, d = '') => { pass += 1; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d = '') => { fail += 1; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

if (!existsSync(jsPath)) { bad('找不到 public/app.js'); process.exit(1); }
const js = readFileSync(jsPath, 'utf8');

// 收集调用路径片段：把每个 api(...) / fetch(...) 的**整段窗口**里的字符串字面量都收进来
// （路径常被拼接成 api('/items/' + id + '/favorite')，只取第一个字面量会漏掉 '/favorite'）
const callPaths = [];
function collectFromWindow(startIdx, len = 160) {
  const win = js.slice(startIdx, startIdx + len);
  for (const m of win.matchAll(/['"`]([^'"`\n]{1,80})['"`]/g)) callPaths.push(m[1]);
}
for (const m of js.matchAll(/\bapi\(/g)) collectFromWindow(m.index);
for (const m of js.matchAll(/\bfetch\(\s*['"`]\/api\//g)) collectFromWindow(m.index);
const paths = callPaths.join('\n');

const hasPath = (...frag) => frag.every((f) => paths.includes(f));
const hasCode = (re) => re.test(js);

// 需求基线里「用户能看见」的能力 → 判定方式
const REQUIRED = [
  ['注册', () => hasPath('/auth/register')],
  ['登录', () => hasPath('/auth/login')],
  ['邮箱验证', () => hasPath('/auth/verify-email')],
  ['退出登录', () => hasPath('/auth/logout')],
  ['广场列表', () => hasPath('/items')],
  ['物品详情', () => hasPath('/items/')],
  ['发布物品（POST /items）', () => hasCode(/api\(\s*['"`]\/items['"`]\s*,\s*\{[^}]*method:\s*['"]POST/)],
  ['图片上传（§4.2）', () => hasCode(/fetch\(\s*['"`]\/api\/uploads/)],
  ['收藏（§2.2）', () => hasPath('/favorite')],
  ['认领申请（§4.5）', () => hasPath('/claims')],
  ['认领审核决定（§4.5）', () => hasPath('/decision')],
  ['确认归还（§4.5）', () => hasPath('/return')],
  ['确认入库 / 下架（§4.6）', () => hasCode(/method:\s*['"]PATCH['"]/)],
  ['站内消息列表（§4.8）', () => hasPath('/messages')],
  ['标记已读（§4.8）', () => hasPath('/read')],
  ['我的认领（§4.9）', () => hasPath('/claims/mine')],
  ['我的发布（§4.9）', () => hasCode(/mine=1/)],
  ['我的收藏（§4.9）', () => hasCode(/fav=1/)],
  ['存放点下拉（§4.4）', () => hasPath('/storage-points')],
  ['后台概览（§4.10）', () => hasPath('/admin/overview')],
  ['后台审核列表（§4.10）', () => hasPath('/admin/claims')],
  ['后台物品管理（§4.10）', () => hasPath('/admin/items')],
  ['后台用户（§4.10）', () => hasPath('/admin/users')],
  ['后台志愿者授权（§4.10）', () => hasPath('/volunteer')],
  ['后台停用账号（§4.10）', () => hasPath('/status')],
  ['后台重置密码（§4.10）', () => hasPath('/reset-password')],
  ['后台存放点维护（§4.10）', () => hasPath('/admin/storage-points')],
  ['后台群发消息（§4.10）', () => hasPath('/admin/messages')],
  ['后台用户搜索（§4.10）', () => hasCode(/\/admin\/users\?(?:[^'"`]*\bq=|q=)/)],
  ['后台存放点排序（§4.10）', () => hasCode(/sortOrder|sort_order/)],
  ['后台恢复演示数据（§4.10）', () => hasPath('/admin/reset-demo')],
  ['后台导出统计（§4.10）', () => hasPath('/admin/stats')],
  ['联系方式渲染（§4.11）', () => hasCode(/contact/)],
];

console.log('\n=== 前端能力覆盖（需求 → 前端是否真的调用） ===');

const missing = [];
for (const [label, test] of REQUIRED) {
  let hit = false;
  try { hit = Boolean(test()); } catch { hit = false; }
  if (!hit) missing.push(label);
}

if (missing.length === 0) {
  ok('需求里用户可见的能力，前端都调用了', `${REQUIRED.length} 项`);
} else {
  bad('以下能力前端没有调用（后端有接口但用户看不到）', missing.join('、'));
}

console.log(`\n共检查 ${REQUIRED.length} 项能力`);
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
