// harness.html 内联脚本语法自检
//
// 为什么需要：2026-11-21 改 harness 时用行号删代码多删两行，留下一个孤立的 `},`，
// 整个内联脚本语法错误 → 页面白屏、title 一直是 "harness" → E2E 报「没有拿到结果」。
// 这种失败不响亮，很难查。所以在开浏览器之前先把语法验掉。
//
// 用法：node tests/e2e/verify/check-harness.mjs [harness路径]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || join(HERE, '..', 'harness.html');

let html;
try {
  html = readFileSync(target, 'utf8');
} catch (err) {
  console.error('读不到 harness：' + err.message);
  process.exit(2);
}

const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
  console.error('harness 里找不到内联 <script>');
  process.exit(1);
}

try {
  // 只编译不执行：语法错会在这里抛
  new Function(m[1]);
  console.log('harness 内联脚本语法 OK');
} catch (err) {
  console.error('harness 内联脚本语法错误：' + err.message);
  process.exit(1);
}
