// 邮件：配了 SMTP 就真发，没配就打到日志（开发环境）
// 计划书 OI-01：SMTP 服务商待定，开发期允许写日志，生产必须真实发送
let nodemailer = null;
let transporter = null;

function smtpConfigured() {
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
  transporter = nodemailer.default.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
  return transporter;
}

export async function sendVerificationCode(email, code, purpose = 'verify') {
  const title = purpose === 'reset' ? '重设密码验证码' : '邮箱验证码';
  const text = `你的${title}是 ${code}，15 分钟内有效。如非本人操作请忽略本邮件。`;

  if (!smtpConfigured()) {
    console.log(`[mail:dev] to=${email} code=${code} purpose=${purpose}（未配置 SMTP，仅打日志）`);
    return { delivered: false, reason: 'smtp_not_configured' };
  }

  const tx = await getTransporter();
  if (!tx) {
    console.warn('[mail] nodemailer 未安装，降级为日志输出');
    console.log(`[mail:dev] to=${email} code=${code}`);
    return { delivered: false, reason: 'nodemailer_missing' };
  }

  try {
    await tx.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: email,
      subject: `【湘寻】${title}`,
      text,
    });
    return { delivered: true };
  } catch (err) {
    console.error('[mail] 发送失败：', err.message);
    return { delivered: false, reason: 'send_failed' };
  }
}
