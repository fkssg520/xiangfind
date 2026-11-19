// 邮件通道自检：用 .env 里的 SMTP 配置发一封测试信
// 拿到邮箱授权码后先跑这个，别等到演示当天才发现发不出信（验收 A-02）
// 用法：node scripts/mail-check.mjs [收件邮箱]
//   不带参数 = 只校验配置完整性，不真发
import { config } from 'node:process';
import { readFileSync, existsSync } from 'node:fs';
import { sendMail, isSmtpConfigured } from '../src/lib/mailer.js';

// 手动加载 .env（不引第三方依赖）
const envPath = new URL('../.env', import.meta.url);
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !config[m[1]]) config[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}

const to = process.argv[2];
const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'];
const missing = required.filter((k) => !process.env[k]);

console.log('\n=== 邮件通道自检 ===');
console.log('  SMTP_HOST  :', process.env.SMTP_HOST || '(未配置)');
console.log('  SMTP_PORT  :', process.env.SMTP_PORT || '(未配置)');
console.log('  SMTP_USER  :', process.env.SMTP_USER || '(未配置)');
console.log('  SMTP_PASSWORD:', process.env.SMTP_PASSWORD ? `已配置（${process.env.SMTP_PASSWORD.length} 位）` : '(未配置)');
console.log('  MAIL_FROM  :', process.env.MAIL_FROM || '(未配置)');

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
  console.log(`  ✓ 发送成功（${ms} ms）`, out && out.messageId ? `messageId=${out.messageId}` : '');
  console.log(`  请到 ${to} 查收，主题「湘寻 · 邮件通道自检」，验证码 ${code}`);
  console.log('  没收到：先看垃圾箱，再看服务商是否拦截，最后查 SMTP_PORT（465 用 SSL，587 用 STARTTLS）');
  process.exit(0);
} catch (err) {
  console.log(`  ✗ 发送失败：${err.message}`);
  if (/auth|535|534/i.test(err.message)) {
    console.log('  这是认证失败——八成是填了登录密码而不是授权码。');
  } else if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(err.message)) {
    console.log('  连不上服务器——检查 SMTP_HOST / SMTP_PORT，或服务器屏蔽了 465/587 出站。');
  }
  process.exit(1);
}
