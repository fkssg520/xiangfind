// 前端 DOM 契约检查：app.js 里引用的元素 id，必须在 index.html 里存在
// 目的：不用浏览器就能抓到「小冯改了 id、JS 静默失效」这类问题
// 用法：node scripts/check-dom.mjs [publicDir]
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';

const PUBLIC = resolve(process.argv[2] || './public');
const htmlPath = join(PUBLIC, 'index.html');
const jsPath = join(PUBLIC, 'app.js');

let pass = 0; let fail = 0;
const ok = (n, d = '') => { pass += 1; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d = '') => { fail += 1; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };

console.log('\n=== 前端 DOM 契约检查 ===');

if (!existsSync(htmlPath) || !existsSync(jsPath)) {
  bad('public/index.html 与 public/app.js 都存在', `${htmlPath} / ${jsPath}`);
  process.exit(1);
}
ok('文件齐全');

const html = readFileSync(htmlPath, 'utf8');
const js = readFileSync(jsPath, 'utf8');

// 0) 语法检查：2026-11-19 一次重复声明让全站 JS 静默失效（页面骨架正常但所有交互死）
//    vm.Script 在进程内解析，不需要 spawn（沙箱里 Node 不能起子进程）
try {
  new Script(js, { filename: 'public/app.js' });
  ok('app.js 语法通过');
} catch (err) {
  bad('app.js 语法错误（会让全站交互失效）', err.message);
}

// 0.1) 顶层重复声明：function 重复是合法 JS 但几乎总是合并事故
const topLevelNames = new Map();
for (const m of js.matchAll(/^(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
  const name = m[1];
  topLevelNames.set(name, (topLevelNames.get(name) || 0) + 1);
}
// const/let/var 同名会直接语法错误，能走到这里的只有 function 重复
const dups = [...topLevelNames.entries()].filter(([, n]) => n > 1).map(([n, c]) => `${n}×${c}`);
if (dups.length === 0) ok('没有顶层重复声明', `${topLevelNames.size} 个顶层标识符`);
else bad('发现顶层重复声明（多半是合并事故）', dups.join(', '));

// 0.2) 冲突标记残留：合并冲突没解干净
if (/^(<<<<<<<|=======|>>>>>>>)/m.test(js) || /^(<<<<<<<|=======|>>>>>>>)/m.test(html)) {
  bad('文件里有冲突标记残留');
} else {
  ok('没有冲突标记残留');
}

// 1) 收集 html 里定义的 id
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
ok('index.html 里的 id 数量', String(htmlIds.size));

// 2) 收集 app.js 里按 id 取元素的地方
const jsIds = new Set([
  ...[...js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)['"]\s*\)/g)].map((m) => m[1]),
]);

// 排除明显是可选的（可选链 ?. 调用视为可选元素，缺失不算错，只做提示）
const optionalPattern = (id) => new RegExp(`getElementById\\(\\s*['"]${id}['"]\\s*\\)\\s*\\?\\.`);

const missing = [];
const optionalMissing = [];
for (const id of jsIds) {
  if (htmlIds.has(id)) continue;
  if (optionalPattern(id).test(js)) optionalMissing.push(id);
  else missing.push(id);
}

if (missing.length === 0) {
  ok('app.js 引用的必需 id 全部存在', `${jsIds.size} 个`);
} else {
  bad('存在 app.js 引用但 index.html 里没有的必需 id', missing.join(', '));
}

if (optionalMissing.length) {
  console.log(`  · 可选元素缺失（有 ?. 保护）：${optionalMissing.join(', ')}`);
}

// 3) 反向检查：html 里带 data-nav 的链接，必须有对应的视图容器
const navs = [...html.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1]);
const views = new Set([...html.matchAll(/id="view-([^"]+)"/g)].map((m) => m[1]));
const orphanNav = navs.filter((n) => !views.has(n));
if (orphanNav.length === 0) ok('导航项都有对应视图容器', `${navs.length} 项`);
else bad('导航项没有对应视图', orphanNav.join(', '));

// 4) app.js 的 VIEWS 列表与视图容器要一致
const viewsMatch = js.match(/const VIEWS\s*=\s*\[([^\]]+)\]/);
if (viewsMatch) {
  const declared = [...viewsMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const notInHtml = declared.filter((v) => !views.has(v));
  const notInJs = [...views].filter((v) => !declared.includes(v));
  if (!notInHtml.length && !notInJs.length) ok('app.js 的 VIEWS 与视图容器一致', declared.join(','));
  else bad('VIEWS 与视图容器不一致', `JS 多: ${notInHtml.join(',') || '无'} | HTML 多: ${notInJs.join(',') || '无'}`);
}

// 5) 表单字段：app.js 用 form.elements.X 取的，html 里要有 name="X"
const elemFields = new Set([...js.matchAll(/form\.elements\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
const formNames = new Set([...html.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]));
const missingFields = [...elemFields].filter((f) => !formNames.has(f));
if (missingFields.length === 0) ok('表单字段全部存在', `${elemFields.size} 个`);
else bad('表单字段缺失（会导致提交时报 TypeError）', missingFields.join(', '));

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
