// 前端引用检查：app.js 里调用的函数，是否都定义过
// 目的：打错函数名（loadDetial vs loadDetail）在浏览器里才炸，所有现有测试都过
// 与 check-dom（id/表单）和 check-frontend-api（接口路径）互补
// 用法：node scripts/check-frontend-refs.mjs [publicDir]
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PUBLIC = resolve(process.argv[2] || './public');
const jsPath = join(PUBLIC, 'app.js');

let pass = 0; let fail = 0;
const ok = (n, d = '') => { pass += 1; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d = '') => { fail += 1; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const note = (n, d = '') => { console.log(`  · ${n}${d ? ' — ' + d : ''}`); };

if (!existsSync(jsPath)) { bad('找不到 public/app.js'); process.exit(1); }
const js = readFileSync(jsPath, 'utf8');

console.log('\n=== 前端函数引用检查 ===');

// 1) 收集声明：function / const / let / var / class
const declared = new Set();
const fnNames = new Set();
for (const m of js.matchAll(/^[ \t]*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) { declared.add(m[1]); fnNames.add(m[1]); }
for (const m of js.matchAll(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) declared.add(m[1]);
// 解构声明：const { a, b } = ...
for (const m of js.matchAll(/^[ \t]*(?:const|let|var)\s*\{([^}]+)\}\s*=/gm)) {
  for (const part of m[1].split(',')) {
    const name = part.split(':').pop().trim().split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
  }
}
// 函数参数、箭头函数参数里出现的内层标识符（用宽松方式收集，避免误报）
for (const m of js.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
  for (const part of m[1].split(',')) {
    const name = part.trim().split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
  }
}
for (const m of js.matchAll(/\(?\s*([A-Za-z_$\w,\s]*?)\s*\)?\s*=>/g)) {
  for (const part of m[1].split(',')) {
    const name = part.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
  }
}

// 2) 浏览器全局与语言内置（调用它们不算错）
const BUILTINS = new Set([
  'document', 'window', 'globalThis', 'fetch', 'console', 'JSON', 'Object', 'Array', 'Math',
  'Date', 'Number', 'String', 'Boolean', 'Promise', 'Set', 'Map', 'WeakMap', 'Error', 'RegExp',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'alert', 'confirm', 'prompt',
  'URLSearchParams', 'URL', 'FormData', 'Blob', 'File', 'FileReader', 'Image', 'Event',
  'CustomEvent', 'localStorage', 'sessionStorage', 'location', 'history', 'navigator',
  'addEventListener', 'removeEventListener', 'getComputedStyle', 'structuredClone',
  'queueMicrotask', 'Intl', 'Symbol', 'BigInt', 'Proxy', 'Reflect', 'Response', 'Request',
  'Headers', 'AbortController', 'atob', 'btoa', 'escape', 'unescape', 'void', 'typeof',
]);

// 3) 关键字与语法结构，后面跟括号但不是函数调用
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'do', 'else', 'new',
  'typeof', 'instanceof', 'in', 'of', 'case', 'delete', 'throw', 'await', 'yield',
  'super', 'this', 'import', 'export', 'constructor', 'async',
]);

// 4) 抓所有「裸标识符 + (」的调用，排除 xxx.yyy( 这种方法调用
const called = new Map();
for (const m of js.matchAll(/(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g)) {
  const name = m[2];
  if (KEYWORDS.has(name) || BUILTINS.has(name)) continue;
  if (!called.has(name)) called.set(name, 0);
  called.set(name, called.get(name) + 1);
}

// 5) 未声明的调用
const unresolved = [...called.keys()].filter((n) => !declared.has(n) && !BUILTINS.has(n));

if (unresolved.length === 0) {
  ok('所有函数调用都有定义', `声明 ${declared.size} 个，调用 ${called.size} 个`);
} else {
  bad('调用了未定义的函数（浏览器里会 ReferenceError）', unresolved.map((n) => `${n}(${called.get(n)})`).join(', '));
}

// 6) 定义了但从未使用的函数（多半是改名后遗留，不致命但要提示）
const unused = [...fnNames].filter((n) =>
  /^[a-z][A-Za-z0-9_$]*$/.test(n) && !called.has(n) && !BUILTINS.has(n)
  // 只看"动词开头"的函数名，变量名不算
  && /^(load|render|build|fetch|show|open|close|submit|handle|decide|patch|toggle|refresh|apply|init|set|get|make|format|bind|attach|run|start|stop|clear|fill|paint|draw|update|create|remove|add|on|do|check|play|mark|resolve|ensure|emit|notify|read|write|parse|sync|open|close)[A-Z_]/.test(n));
if (unused.length === 0) ok('没有明显改名遗留的死函数');
else note('定义了但没调用（可能是改名遗留）', unused.join(', '));

// 7) 事件处理器里常见拼写错误关键字
const typo = [];
if (/\baddEventListner\b/.test(js)) typo.push('addEventListner → addEventListener');
if (/\bquerySelctor\b|\bquerySelecter\b/.test(js)) typo.push('querySelector 拼写');
if (/\btextConent\b/.test(js)) typo.push('textConent → textContent');
if (/\binnerHtml\b/.test(js)) typo.push('innerHtml → innerHTML（大小写）');
if (typo.length === 0) ok('没有常见的 API 拼写错误');
else bad('发现拼写错误', typo.join(', '));

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
