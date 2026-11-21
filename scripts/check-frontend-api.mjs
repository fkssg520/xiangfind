// 前端 → 后端 接口一致性检查
// 目的：app.js 里 api('/xxx') 打错一个字（如 /claim vs /claims），运行时才炸；
//       这个检查在提交前就发现。
// 用法：node scripts/check-frontend-api.mjs [publicDir]
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PUBLIC = resolve(process.argv[2] || './public');
const appJs = join(PUBLIC, 'app.js');
const contract = resolve('./docs/API契约.md');
const router = resolve('./src/api/index.js');

let pass = 0; let fail = 0;
const ok = (n, d = '') => { pass += 1; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d = '') => { fail += 1; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const note = (n, d = '') => { console.log(`  · ${n}${d ? ' — ' + d : ''}`); };

if (!existsSync(appJs)) { bad('找不到 public/app.js'); process.exit(1); }

const js = readFileSync(appJs, 'utf8');
const doc = readFileSync(contract, 'utf8');
const apiSrc = readFileSync(router, 'utf8');

// 1) 抓 app.js 里所有 api(...) 的实参文本，保留拼接结构
//    例：api('/claims/' + encodeURIComponent(c.id) + '/decision', {...})
//        模板：api(`/items/${id}`)
const rawArgs = [];
for (const m of js.matchAll(/\bapi\(([^;]*?)\)\s*(?:\.|;|,|\n|\}|$)/g)) {
  const arg = m[1];
  // 只保留第一个参数（遇到顶层逗号就截断，避免把 body 一起吞进来）
  let depth = 0; let cut = arg.length;
  for (let i = 0; i < arg.length; i += 1) {
    const ch = arg[i];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) { cut = i; break; }
  }
  rawArgs.push(arg.slice(0, cut).trim());
}

// 把实参表达式归一成路径：引号外的代码记成 code 记号，引号内的字面量原样保留。
// 规则要点：查询串不属于路径。若某个 code 记号后面紧跟的字面量以 '?' 开头
// （例如 api('/admin/users' + (q ? '?q=' + f(q) : ''))），那段 code 只是三目条件，
// 不是路径段——必须丢掉，否则会误报成 /api/admin/users:id。
function argToPath(arg) {
  const segs = []; // { type: 'lit' | 'code', v?: string }
  let i = 0;
  while (i < arg.length) {
    const ch = arg[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let lit = '';
      while (j < arg.length) {
        if (arg[j] === '\\') { lit += arg[j + 1] ?? ''; j += 2; continue; }
        if (arg[j] === quote) break;
        if (quote === '`' && arg[j] === '$' && arg[j + 1] === '{') {
          let depth = 1; let k = j + 2;
          while (k < arg.length && depth > 0) {
            if (arg[k] === '{') depth += 1;
            else if (arg[k] === '}') depth -= 1;
            k += 1;
          }
          segs.push({ type: 'code' });
          j = k;
          continue;
        }
        lit += arg[j];
        j += 1;
      }
      segs.push({ type: 'lit', v: lit });
      i = j + 1;
    } else {
      let j = i; let sawCode = false;
      while (j < arg.length && arg[j] !== "'" && arg[j] !== '"' && arg[j] !== '`') {
        if (/[A-Za-z_$]/.test(arg[j])) sawCode = true;
        j += 1;
      }
      if (sawCode) segs.push({ type: 'code' });
      i = j;
    }
  }

  let out = '';
  for (let s = 0; s < segs.length; s += 1) {
    const seg = segs[s];
    if (seg.type === 'code') {
      const next = segs[s + 1];
      // 后面紧跟的是查询串 → 这段 code 是条件表达式，不是路径段
      if (next && next.type === 'lit' && next.v.startsWith('?')) continue;
      out += '§';
    } else {
      const q = seg.v.indexOf('?');
      out += q >= 0 ? seg.v.slice(0, q) : seg.v;
      if (q >= 0) break; // 查询串之后都不是路径
    }
  }
  return out.replace(/§+/g, ':id');
}

const calls = new Set();
for (const arg of rawArgs) calls.add(argToPath(arg));

// 归一化：去掉 query、把动态段统一成 :id
function normPath(p) {
  let s = p.split('?')[0];
  s = s.replace(/\/:\w+/g, '/:id');
  s = s.replace(/\/$/, '');
  return '/api' + (s.startsWith('/') ? s : '/' + s);
}

const called = [...calls].map(normPath).filter((p) => p.length > 4);
const calledSet = [...new Set(called)];

// 2) 从契约里抽出所有已文档化的路径
const docPaths = new Set();
for (const m of doc.matchAll(/\/api\/[A-Za-z0-9_\-/:.]+/g)) {
  let p = m[0].replace(/[.:]+$/, '').replace(/\/$/, '');
  p = p.replace(/\/:[A-Za-z]+/g, '/:id');
  docPaths.add(p);
}

// 3) 从路由实现里抽出所有路径（字面量 + 正则）
const implPaths = new Set();
for (const m of apiSrc.matchAll(/path === '(\/api\/[^']+)'/g)) implPaths.add(m[1].replace(/\/$/, ''));
for (const m of apiSrc.matchAll(/path\.match\(\/\^\\\/api\\\/([^$]+)\$?\/\)/g)) {
  const raw = ('/api/' + m[1]).replace(/\\\//g, '/').replace(/\(\[A-Za-z0-9_-\]\+\)/g, ':id');
  implPaths.add(raw.replace(/\/\$.*$/, '').replace(/\/$/, ''));
}

console.log('\n=== 前端调用的接口一致性 ===');

if (calledSet.length === 0) {
  bad('没从 app.js 里找到任何接口调用（解析可能失效）');
} else {
  ok('从 app.js 抽到接口调用', `${calledSet.length} 个`);
}

// 4) 每个前端调用，必须在实现里存在
const missingInImpl = calledSet.filter((p) => !implPaths.has(p));
if (missingInImpl.length === 0) {
  ok('所有前端调用都有对应后端实现');
} else {
  bad('前端调用了后端没有的接口', missingInImpl.join(', '));
}

// 5) 每个前端调用，应能在契约里找到（文档完整性）
const missingInDoc = calledSet.filter((p) => !docPaths.has(p));
if (missingInDoc.length === 0) {
  ok('所有前端调用都写在契约里');
} else {
  note('以下调用未写进契约（不致命，但文档会漂移）', missingInDoc.join(', '));
}

// 6) 前端不该硬编码的路径（小冯踩过的坑）
const hardcoded = [];
if (/['"]\/mock\//.test(js)) hardcoded.push('/mock/ 还在用');
if (/127\.0\.0\.1:3000|localhost:3000/.test(js)) hardcoded.push('硬编码了 3000 端口');
if (hardcoded.length === 0) ok('没有 mock 残留与硬编码地址');
else bad('前端有不该出现的硬编码', hardcoded.join(', '));

// 7) 列出覆盖率，便于人工扫一眼
note('前端涉及的接口', calledSet.sort().join(' '));

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
