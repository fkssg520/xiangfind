// 契约漂移检查：docs/API契约.md 里写的路径 vs src/api/index.js 里实现的路径
// 目的：防止文档烂掉（前端照文档写，文档错了比没文档更糟）
// 用法：node scripts/check-contract.mjs
import { readFileSync } from 'node:fs';

const doc = readFileSync(new URL('../docs/API契约.md', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8');

let pass = 0; let fail = 0;
const ok = (n, d = '') => { pass += 1; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d = '') => { fail += 1; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

// 文档里出现过的接口路径（去掉 query；保留 :param）
const docPaths = new Set();
for (const m of doc.matchAll(/\/api\/[A-Za-z0-9_\-/:.]+/g)) {
  const p = m[0].replace(/[.:]+$/, '').replace(/\/$/, '');
  docPaths.add(p);
}

// 实现里的路径来源：字面量比较 + 正则（带 :id 的路由）
const implemented = new Set();
for (const m of api.matchAll(/path === '(\/api\/[^']+)'/g)) implemented.add(m[1]);
for (const m of api.matchAll(/path\.match\(\/\^\\\/api\\\/([^$]+)\$?\/\)/g)) {
  const raw = ('/api/' + m[1]).replace(/\\\//g, '/').replace(/\(\[A-Za-z0-9_-\]\+\)/g, ':id');
  implemented.add(raw.replace(/\/\$.*$/, ''));
}

// 统一成"模板路径"：把 :id / :itemId 归一；去掉尾部标点
const norm = (p) => p
  .replace(/\?.*$/, '')
  .replace(/[.:]+$/, '')
  .replace(/\/:[A-Za-z]+/g, '/:id')
  .replace(/\/[A-Za-z0-9_-]{6,}(?=\/|$)/g, (s) => (/^\/(usr|itm|clm|msg|stp|img|mtc)_/.test(s) ? '/:id' : s))
  .replace(/\/$/, '');

const docNorm = new Set([...docPaths].map(norm));
const implNorm = new Set([...implemented].map(norm));

console.log('\n=== 契约漂移检查 ===');

// 1) 文档里写了、实现里没有
const missing = [...docNorm].filter((p) => !implNorm.has(p));
// 允许的情况：/api/items 与 /api/items/:id 前缀关系、/uploads 静态、/health
const ignorable = (p) => p === '/health' || p.startsWith('/uploads');
const realMissing = missing.filter((p) => !ignorable(p));
if (realMissing.length === 0) ok('文档里的接口都已实现', `${docNorm.size} 条`);
else bad('文档里有、实现里没有', realMissing.join(', '));

// 2) 实现里有、文档没写
const undocumented = [...implNorm].filter((p) => !docNorm.has(p) && !p.includes('*'));
if (undocumented.length === 0) ok('实现里的接口都写进了文档', `${implNorm.size} 条`);
else bad('实现里有、文档没写', undocumented.join(', '));

// 3) 关键规则必须出现在文档里
const rules = [
  ['CSRF 头名', 'x-csrf-token'],
  ['会话 Cookie', 'xf_sid'],
  ['ID 可能含横线', '可能含'],
  ['decision 四种取值', 'agree'],
  ['认领通过才有联系方式', 'contact'],
  ['必走 PR 之外的错误体格式', 'error'],
];
for (const [name, needle] of rules) {
  if (doc.includes(needle)) ok(`文档包含：${name}`);
  else bad(`文档缺少：${name}`);
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
