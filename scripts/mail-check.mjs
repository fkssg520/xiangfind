// 邮件通道自检：用 .env 里的 SMTP 配置发一封测试信
// 拿到邮箱授权码后先跑这个，别等到演示当天才发现发不出信（验收 A-02）
// 用法：node scripts/mail-check.mjs [收件邮箱]
//   不带参数 = 只校验配置完整性，不真发
import { readFileSync, existsSync } from 'node:fs';
import { sendMail, isSmtpConfigured } from '../src/lib/mailer.js';

// 手动加载 .env（不引第三方依赖，与 src/lib/env.js 同一套规则）
// 注意两个坑（小冯 2026-11-21 报的，都是真的）：
//   ① 不能写 process.config（Node 26 里它不可扩展），要写 process.env
//   ② 必须容忍 CRLF：Windows 下 .env 行尾是 \r\n，正则 (.*)$ 匹配不到 \r → 一行都读不出来
const envPath = new URL('../.env', import.meta.url);
let parsedKeys = 0;
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim(); // 先 trim：既去掉 \r，也去掉首尾空白
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    parsedKeys += 1;
  }
}

// .env 存在却一行都没解析出来 → 是解析问题，不是"没配置"。两者输出必须能区分。
if (existsSync(envPath) && parsedKeys === 0) {
  console.log('\n  ✗ .env 存在，但一行配置都没解析出来（格式问题，不是没配置）');
  console.log('    常见原因：文件是 UTF-16 编码、或每行前面有 BOM/不可见字符');
  console.log('    期望格式：KEY=VALUE，一行一个，不带引号也能识别');
  process.exit(1);
}

const to = process.argv[2];
// MAIL_FROM 可留空：mailer 会自动回退到 SMTP_USER（QQ/163 要求发件人与登录邮箱一致）
const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD'];
const missing = required.filter((k) => !process.env[k]);

console.log('\n=== 邮件通道自检 ===');
console.log('  SMTP_HOST  :', process.env.SMTP_HOST || '(未配置)');
console.log('  SMTP_PORT  :', process.env.SMTP_PORT || '(未配置)');
console.log('  SMTP_USER  :', process.env.SMTP_USER || '(未配置)');
console.log('  SMTP_PASSWORD:', process.env.SMTP_PASSWORD ? `已配置（${process.env.SMTP_PASSWORD.length} 位）` : '(未配置)');
console.log('  MAIL_FROM  :', process.env.MAIL_FROM || (process.env.SMTP_USER ? process.env.SMTP_USER + '（未配置，自动用 SMTP_USER）' : '(未配置)'));

if (missing.length) {
  console.log('');
  console.log(`  ✗ 配置不完整，缺少：${missing.join(', ')}`);
  console.log('  提示：QQ 邮箱要在「设置 → 账户 → POP3/SMTP 服务」开启后生成**授权码**，');
  console.log('        填授权码而不是登录密码。');
  console.log('  当前未配置时，验证码会打在服务端日志：[mail:dev] to=... code=123456');
  process.exit(1);
}

if (!isSmtpConfigured()) {
  console.log('');
  console.log('  ✗ mailer 报告未启用 SMTP（检查 SMTP_* 是否被正确加载）');
  process.exit(1);
}

console.log('');
if (!to) {
  console.log('  ✓ 配置完整。要真发一封测试信：node scripts/mail-check.mjs 你的邮箱@example.com');
  process.exit(0);
}

const code = String(Math.floor(100000 + Math.random() * 900000));
const started = Date.now();
try {
  const out = await sendMail({
    to,
    subject: '湘寻 · 邮件通道自检',
    text: `这是一封自动测试邮件。\n\n验证码：${code}\n\n收到说明 SMTP 配置正确，验收项 A-02（真实邮箱收验证码）可以通过。\n\n— 湘寻`,
  });
  const ms = Date.now() - started;

  // 关键：sendMail 不抛异常不代表发出去了。必须看 delivered。
  // 2026-11-21 修：nodemailer 没装时它会返回 {delivered:false, reason:'nodemailer_missing'}，
  // 而这里原来无条件打「✓ 发送成功」——验证码只打进了日志，自检却是绿的（假绿）。
  if (!out || !out.delivered) {
    console.log(`  ✗ 没有真正发出（${ms} ms）reason=${out?.reason || 'unknown'}`);
    if (out?.reason === 'nodemailer_missing') {
      console.log('  nodemailer 未安装：SMTP 已配置但没有发信库，验证码只会打到服务端日志。');
      console.log('  解决：npm install（依赖在 package.json 的 dependencies 里）');
    } else if (out?.reason === 'smtp_not_configured') {
      console.log('  SMTP 未配置：检查 .env 里 SMTP_HOST/PORT/USER/PASSWORD 是否被加载。');
    } else if (out?.reason === 'send_failed') {
      console.log('  发送失败：' + (out.error || ''));
    }
    process.exit(1);
  }

  console.log(`  ✓ 发送成功（${ms} ms）`, out.messageId ? `messageId=${out.messageId}` : '');
  console.log(`  请到 ${to} 查收，主题「湘寻 · 邮件通道自检」，验证码 ${code}`);
  console.log('  没收到：先看垃圾箱，再看服务商是否拦截，最后查 SMTP_PORT（465 用 SSL，587 用 STARTTLS）');
  process.exit(0);
} catch (err) {
  console.log(`  ✗ 发送失败：${err.message}`);
  if (/535|534/i.test(err.message)) {
    console.log('  这是 SMTP 认证被拒。QQ 返回 535 有四种含义，按可能性排：');
    console.log('    ① 填了登录密码而不是授权码（最常见）');
    console.log('    ② 授权码已被重置/停用（设置 → 账户 → POP3/SMTP 服务）');
    console.log('    ③ 短时间发信太频繁，被临时频控（等 10-30 分钟再试，别连发）');
    console.log('    ④ 账号异常被限制（需去 QQ 邮箱网页版按提示解除）');
    console.log('  原始响应：' + err.message);
  } else if (/auth/i.test(err.message)) {
    console.log('  这是认证失败——八成是填了登录密码而不是授权码。');
  } else if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(err.message)) {
    console.log('  连不上服务器——检查 SMTP_HOST / SMTP_PORT，或服务器屏蔽了 465/587 出站。');
  }
  process.exit(1);
}
