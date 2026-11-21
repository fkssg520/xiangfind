// 邮件：配了 SMTP 就真发，没配就打到日志（开发环境）
// 计划书 OI-01：SMTP 服务商待定，开发期允许写日志，生产必须真实发送
import { recordAttempt } from './mail-state.js';

let nodemailer = null;
let transporter = null;

export function isSmtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

async function getTransporter() {
  if (transporter) return transporter;
  if (!nodemailer) {
    try {
      nodemailer = await import('nodemailer');
    } catch {
      return null;
    }
  }
  const port = Number(process.env.SMTP_PORT || 465);
  transporter = nodemailer.default.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
  return transporter;
}

// 通用发信：返回 { delivered, reason, messageId? }
export async function sendMail({ to, subject, text, html }) {
  if (!isSmtpConfigured()) {
    console.log(`[mail:dev] to=${to} subject=${subject}（未配置 SMTP，仅打日志）`);
    recordAttempt({ configured: false, delivered: false, reason: 'smtp_not_configured' });
    return { delivered: false, reason: 'smtp_not_configured' };
  }

  const tx = await getTransporter();
  if (!tx) {
    console.warn('[mail] nodemailer 未安装，降级为日志输出');
    recordAttempt({ configured: true, delivered: false, reason: 'nodemailer_missing' });
    return { delivered: false, reason: 'nodemailer_missing' };
  }

  try {
    const info = await tx.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      ...(html ? { html } : {}),
    });
    console.log(`[mail] sent to=${to} messageId=${info?.messageId || '-'} subject=${subject}`);
    recordAttempt({ configured: true, delivered: true, reason: 'delivered' });
    return { delivered: true, messageId: info?.messageId };
  } catch (err) {
    console.error('[mail] 发送失败：', err.message);
    recordAttempt({ configured: true, delivered: false, reason: 'send_failed', error: err.message });
    return { delivered: false, reason: 'send_failed', error: err.message };
  }
}

// 验证码邮件正文（抽出来便于单元测试；PUBLIC_BASE_URL 决定是否带站点链接）
export function buildVerificationText(code, purpose = 'verify') {
  const title = purpose === 'reset' ? '重设密码验证码' : '邮箱验证码';
  const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const link = /^https?:\/\//.test(base) ? `\n\n访问湘寻：${base}` : '';
  return { title, text: `你的${title}是 ${code}，15 分钟内有效。如非本人操作请忽略本邮件。${link}` };
}

export async function sendVerificationCode(email, code, purpose = 'verify') {
  const { title, text } = buildVerificationText(code, purpose);

  if (!isSmtpConfigured()) {
    console.log(`[mail:dev] to=${email} code=${code} purpose=${purpose}（未配置 SMTP，仅打日志）`);
    return { delivered: false, reason: 'smtp_not_configured' };
  }

  const out = await sendMail({ to: email, subject: `【湘寻】${title}`, text });
  // 发信失败时把验证码打到日志，避免用户彻底收不到（生产应接监控告警）
  if (!out.delivered) {
    console.log(`[mail:fallback] to=${email} code=${code} purpose=${purpose} reason=${out.reason}`);
  }
  return out;
}
