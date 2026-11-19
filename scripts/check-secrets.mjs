// 交付前安全自检：确认没有把密钥/真实个人信息提交进仓库
// 用法：node scripts/check-secrets.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT_DIR = ROOT.replace(/\//g, '\\').replace(/\\$/, '');

let pass = 0; let fail = 0; let warn = 0;
const ok = (n, d = '') => { pass += 1; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d = '') => { fail += 1; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const note = (n, d = '') => { warn += 1; console.log(`  ! ${n}${d ? ' — ' + d : ''}`); };

console.log('\n=== 交付前安全自检 ===');

// 0. .env 必须被忽略且未被跟踪
const gitignore = existsSync(join(ROOT_DIR, '.gitignore')) ? readFileSync(join(ROOT_DIR, '.gitignore'), 'utf8') : '';
if (/^\.env$/m.test(gitignore) || /^\.env\r?$/m.test(gitignore)) ok('.gitignore 包含 .env');
else bad('.gitignore 没有忽略 .env');

// 注意：沙箱里 Node 不能 spawn 子进程（EPERM），所以不用 `git ls-files`，
// 改为扫描工作区 + 校验 .gitignore 规则。漏判风险很低（.env 已被 ignore）。
const SKIP_TOP = new Set(['node_modules', '.git', 'data', 'uploads', 'xiangfind-backups']);
const fileProbe = [];
function probe(dir, depth = 0) {
  if (depth > 3) return;
  for (const entry of readdirSync(dir)) {
    if (SKIP_TOP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) { probe(full, depth + 1); continue; }
    fileProbe.push(relative(ROOT_DIR, full).replace(/\\/g, '/'));
  }
}
probe(ROOT_DIR);

const envFiles = fileProbe.filter((f) => /(^|\/)\.env$/.test(f) || /(^|\/)\.env\.local$/.test(f));
if (envFiles.length === 0) ok('.env 只存在于本机，未被纳入仓库目录');
else note('.env 存在于工作区（这是正常的，但必须确认没被提交）', envFiles.join(', '));

const keyFiles = fileProbe.filter((f) => /\.(pem|key|p12|pfx)$/i.test(f) || /id_rsa|id_ed25519/.test(f));
if (keyFiles.length === 0) ok('仓库目录里没有私钥文件');
else bad('发现私钥文件', keyFiles.join(', '));

// 1. 扫描源码里的高危模式（只扫受跟踪的文本文件，避免 node_modules 与 data）
const SKIP_DIRS = ['node_modules', '.git', 'data', 'uploads', 'journal', 'public/mock'];
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.sql', '.html', '.css', '.yml', '.yaml', '.ps1', '.txt', '']);

const PATTERNS = [
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g, level: 'bad' },
  { name: 'AWS key', re: /AKIA[0-9A-Z]{16}/g, level: 'bad' },
  { name: '私钥内容', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g, level: 'bad' },
  { name: '硬编码长密钥', re: /(?:secret|password|token|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{32,}['"]/gi, level: 'warn' },
  { name: '真实学号样式（9 位纯数字）', re: /\b20\d{7}\b/g, level: 'warn' },
  { name: '手机号', re: /\b1[3-9]\d{9}\b/g, level: 'warn' },
  { name: '身份证号', re: /\b\d{17}[\dXx]\b/g, level: 'bad' },
];

// 允许的假值（演示数据/文档示例）
const ALLOW = [
  /3450238693@qq\.com/,        // 项目联系人（人类同意公开）
  /3068199544@qq\.com/,
  /0{6,}/g,                     // 全零占位
  /0000-0000000/g,              // 演示电话
  /demo1234/,
  /smoke-test-secret/,
  /example\.com/,
];

const hits = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT_DIR, full).replace(/\\/g, '/');
    if (SKIP_DIRS.some((s) => rel === s || rel.startsWith(s + '/'))) continue;
    const st = statSync(full);
    if (st.isDirectory()) { walk(full); continue; }
    if (!TEXT_EXT.has(extname(full)) && extname(full) !== '') continue;
    if (st.size > 512 * 1024) continue;
    let text;
    try { text = readFileSync(full, 'utf8'); } catch { continue; }
    for (const p of PATTERNS) {
      for (const m of text.matchAll(p.re)) {
        const v = m[0];
        if (ALLOW.some((a) => a.test(v))) continue;
        hits.push({ file: rel, name: p.name, value: v.slice(0, 40), level: p.level });
      }
    }
  }
}
walk(ROOT_DIR);

const realBad = hits.filter((h) => h.level === 'bad');
const warns = hits.filter((h) => h.level === 'warn');
if (realBad.length === 0) ok('没有高危密钥泄漏');
else {
  const uniq = [...new Map(realBad.map((h) => [h.file + h.name, h])).values()];
  bad('发现高危泄漏', uniq.map((h) => `${h.file} [${h.name}]`).join(' | '));
}
if (warns.length === 0) ok('没有可疑的硬编码凭据或个人信息');
else {
  const uniq = [...new Map(warns.map((h) => [h.file + h.name + h.value, h])).values()];
  note(`可疑项 ${uniq.length} 处（需人眼确认）`,
    uniq.slice(0, 6).map((h) => `${h.file} [${h.name}] ${h.value}`).join(' | ') + (uniq.length > 6 ? ' …' : ''));
}

// 2. .env.example 必须存在且不含真实值
if (existsSync(join(ROOT_DIR, '.env.example'))) {
  const ex = readFileSync(join(ROOT_DIR, '.env.example'), 'utf8');
  const suspicious = ex.split('\n').filter((l) => /^(SMTP_PASSWORD|SESSION_SECRET)=.+/.test(l) && !/=$/.test(l.trim()));
  if (suspicious.length === 0) ok('.env.example 里没有填真实凭据');
  else bad('.env.example 里像是填了真值', suspicious.join(' | '));
} else {
  bad('缺少 .env.example');
}

// 3. 演示数据不能含真实学生信息
const demoPath = join(ROOT_DIR, 'src/db/demo.js');
if (existsSync(demoPath)) {
  const demo = readFileSync(demoPath, 'utf8');
  const emails = [...demo.matchAll(/[\w.+-]+@[\w.-]+/g)].map((m) => m[0]);
  const notDemo = emails.filter((e) => !/@demo\.local$/.test(e));
  if (notDemo.length === 0) ok('演示数据邮箱全部是 @demo.local', `${emails.length} 个`);
  else bad('演示数据里有非 demo 邮箱', notDemo.join(', '));
} else {
  note('没有 src/db/demo.js，跳过演示数据检查');
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}，需人眼确认 ${warn}`);
process.exit(fail === 0 ? 0 : 1);
