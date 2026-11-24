// 认证服务：注册、邮箱验证码、登录、会话
import { createHash, randomInt } from 'node:crypto';
import { nowIso, ID } from '../lib/id.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { hashToken } from '../lib/session.js';
import { sendVerificationCode } from '../lib/mailer.js';
import { hit } from '../lib/ratelimit.js';

const CODE_TTL_MS = 15 * 60 * 1000;   // 验证码 15 分钟
const RESEND_COOLDOWN_MS = 60 * 1000; // 同邮箱 60 秒冷却
const DAILY_MAX = 10;                 // 每邮箱每天最多 10 次
const MAX_ATTEMPTS = 5;               // 单个验证码最多试 5 次

// 注意：不能用模块级常量——server.js 的 loadDotEnv() 在本模块之后执行，
// 常量会在 .env 生效前就固定成默认值（实测验证码 hash 用的是默认 pepper）。
function pepper() {
  return process.env.SESSION_SECRET || 'dev-pepper-change-me';
}

function codeHash(email, code) {
  return createHash('sha256').update(`${email}|${code}|${pepper()}`).digest('hex');
}

function sixDigits() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function validateRegister(body) {
  const errors = [];
  const studentId = String(body.studentId || '').trim();
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const confirm = String(body.confirmPassword ?? body.confirm ?? '');

  if (!/^[A-Za-z0-9]{6,20}$/.test(studentId)) errors.push(['studentId', '学号需为 6-20 位字母或数字']);
  if (name.length < 1 || name.length > 20) errors.push(['name', '姓名需 1-20 字']);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(['email', '邮箱格式不正确']);
  if (password.length < 8 || password.length > 64) errors.push(['password', '密码需 8-64 位']);
  else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) errors.push(['password', '密码需同时包含字母和数字']);
  if (confirm && confirm !== password) errors.push(['confirmPassword', '两次输入的密码不一致']);

  return { errors, data: { studentId, name, email, password } };
}

export async function register(db, body, ip) {
  const { errors, data } = validateRegister(body);
  if (errors.length) return { status: 400, body: { error: { code: errors[0][0], message: errors[0][1], details: errors } } };

  // 生产默认 5 次/小时；测试可用 REGISTER_LIMIT_PER_HOUR 调高
  const REGISTER_LIMIT = Number(process.env.REGISTER_LIMIT_PER_HOUR || 5);
  const limited = hit(`register:${ip}`, REGISTER_LIMIT, 60 * 60 * 1000);
  if (!limited.ok) return { status: 429, body: { error: { code: 'rate_limited', message: '注册过于频繁，请稍后再试' } } };

  // 已经是正式账号就不能再注册
  const exists = db
    .prepare('SELECT student_id, email FROM users WHERE student_id = ? OR email = ?')
    .all(data.studentId, data.email);
  if (exists.length) {
    const dup = exists[0].student_id === data.studentId ? 'studentId' : 'email';
    return { status: 409, body: { error: { code: dup, message: dup === 'studentId' ? '该学号已注册' : '该邮箱已注册' } } };
  }

  // 同一学号/邮箱重复提交：覆盖上一条待注册记录（允许用户重来）
  db.prepare('DELETE FROM pending_registrations WHERE student_id = ? OR email = ?')
    .run(data.studentId, data.email);

  const code = sixDigits();
  const now = nowIso();
  db.prepare(
    `INSERT INTO pending_registrations
       (id, student_id, name, email, password_hash, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    ID.token(), data.studentId, data.name, data.email,
    hashPassword(data.password), codeHash(data.email, code),
    new Date(Date.now() + CODE_TTL_MS).toISOString(), now,
  );

  const mail = await sendVerificationCode(data.email, code, 'verify');
  return {
    status: 201,
    body: {
      // 账号还没有创建：验证码通过后才建
      pending: true,
      email: data.email,
      studentId: data.studentId,
      expiresInMinutes: Math.round(CODE_TTL_MS / 60000),
      codeSent: Boolean(mail.delivered),
      delivery: mail.delivered ? 'email' : mail.reason,
      fallback: mail.delivered ? null : 'log',
    },
  };
}

async function issueCode(db, userId, email, purpose) {
  // 冷却按「邮箱 + 用途」计：刚注册完不该挡住找回密码
  const last = db
    .prepare("SELECT created_at FROM email_tokens WHERE email = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1")
    .get(email, purpose);
  if (last) {
    const wait = RESEND_COOLDOWN_MS - (Date.now() - new Date(last.created_at).getTime());
    if (wait > 0) return { delivered: false, reason: 'cooldown', cooldownSeconds: Math.ceil(wait / 1000) };
  }

  // 每日上限仍按邮箱总量算（防止被当短信炮）
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = db
    .prepare('SELECT COUNT(*) AS c FROM email_tokens WHERE email = ? AND created_at >= ?')
    .get(email, todayStart.toISOString()).c;
  if (todayCount >= DAILY_MAX) return { delivered: false, reason: 'daily_limit' };

  const code = sixDigits();
  const now = nowIso();
  db.prepare(
    `INSERT INTO email_tokens (id, user_id, email, code_hash, purpose, expires_at, used_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`
  ).run(ID.token(), userId, email, codeHash(email, code), purpose, new Date(Date.now() + CODE_TTL_MS).toISOString(), now);

  const mail = await sendVerificationCode(email, code, purpose);
  return { delivered: mail.delivered, reason: mail.reason, code };
}

export async function resendCode(db, body, ip) {
  const email = String(body.email || '').trim().toLowerCase();
  const limited = hit(`resend:${email}:${ip}`, 5, 10 * 60 * 1000);
  if (!limited.ok) return { status: 429, body: { error: { code: 'rate_limited', message: '请求过于频繁' } } };

  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (user) {
    const result = await issueCode(db, user.id, email, 'verify');
    if (result.reason === 'cooldown') {
      return { status: 429, body: { error: { code: 'cooldown', message: `请 ${result.cooldownSeconds} 秒后再试`, retryAfter: result.cooldownSeconds } } };
    }
    if (result.reason === 'daily_limit') {
      return { status: 429, body: { error: { code: 'daily_limit', message: '今天发送次数已达上限' } } };
    }
    return { status: 200, body: { ok: true, codeSent: Boolean(result.delivered), delivery: result.delivered ? 'email' : result.reason, fallback: result.delivered ? null : 'log' } };
  }

  // 待注册：账号还没建，验证码存在 pending_registrations
  const pending = db.prepare('SELECT * FROM pending_registrations WHERE email = ?').get(email);
  if (pending) {
    const wait = RESEND_COOLDOWN_MS - (Date.now() - new Date(pending.created_at).getTime());
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      return { status: 429, body: { error: { code: 'cooldown', message: `请 ${seconds} 秒后再试`, retryAfter: seconds } } };
    }
    const code = sixDigits();
    db.prepare('UPDATE pending_registrations SET code_hash = ?, expires_at = ?, attempts = 0, created_at = ? WHERE id = ?')
      .run(codeHash(email, code), new Date(Date.now() + CODE_TTL_MS).toISOString(), nowIso(), pending.id);
    const mail = await sendVerificationCode(email, code, 'verify');
    return { status: 200, body: { ok: true, codeSent: Boolean(mail.delivered), delivery: mail.delivered ? 'email' : mail.reason, fallback: mail.delivered ? null : 'log' } };
  }

  // 防枚举：不透露邮箱是否存在
  return { status: 200, body: { ok: true, delivery: 'email' } };
}

export function verifyEmail(db, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();

  if (!/^\d{6}$/.test(code)) return { status: 400, body: { error: { code: 'code', message: '验证码为 6 位数字' } } };

  // ① 优先按「待注册」处理：验证通过才建账号
  const pending = db
    .prepare('SELECT * FROM pending_registrations WHERE email = ?')
    .get(email);

  if (pending) {
    if (new Date(pending.expires_at).getTime() <= Date.now()) {
      return { status: 400, body: { error: { code: 'expired', message: '验证码已过期，请重新发送' } } };
    }
    if (pending.attempts >= MAX_ATTEMPTS) {
      return { status: 429, body: { error: { code: 'attempts', message: '错误次数过多，请重新获取验证码' } } };
    }
    if (pending.code_hash !== codeHash(email, code)) {
      db.prepare('UPDATE pending_registrations SET attempts = attempts + 1 WHERE id = ?').run(pending.id);
      const left = MAX_ATTEMPTS - (pending.attempts + 1);
      return { status: 400, body: { error: { code: 'code', message: left > 0 ? `验证码不正确，还可尝试 ${left} 次` : '错误次数过多，请重新获取验证码' } } };
    }

    // 并发保护：这段时间里可能已经有人用同样学号/邮箱注册成功
    const conflict = db
      .prepare('SELECT student_id, email FROM users WHERE student_id = ? OR email = ?')
      .all(pending.student_id, pending.email);
    if (conflict.length) {
      db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pending.id);
      const dup = conflict[0].student_id === pending.student_id ? 'studentId' : 'email';
      return { status: 409, body: { error: { code: dup, message: dup === 'studentId' ? '该学号刚刚被注册，请重新填写' : '该邮箱刚刚被注册，请重新填写' } } };
    }

    const now = nowIso();
    const userId = ID.user();
    db.prepare(
      `INSERT INTO users (id, student_id, name, email, email_verified_at, password_hash, phone, contact, role, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '', '', 'student', 'active', ?)`
    ).run(userId, pending.student_id, pending.name, pending.email, now, pending.password_hash, now);
    db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pending.id);

    return {
      status: 200,
      body: {
        user: {
          id: userId, studentId: pending.student_id, name: pending.name,
          email: pending.email, role: 'student', emailVerified: true,
        },
      },
    };
  }

  // ② 兜底：历史上已创建但未验证的账号，仍走 email_tokens
  const token = db
    .prepare(
      `SELECT * FROM email_tokens
        WHERE email = ? AND purpose = 'verify' AND used_at IS NULL
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(email);

  if (!token) return { status: 400, body: { error: { code: 'code', message: '验证码不存在或已使用' } } };
  if (new Date(token.expires_at).getTime() <= Date.now()) {
    return { status: 400, body: { error: { code: 'expired', message: '验证码已过期，请重新获取' } } };
  }
  if (token.attempts >= MAX_ATTEMPTS) {
    return { status: 429, body: { error: { code: 'attempts', message: '错误次数过多，请重新获取验证码' } } };
  }
  if (token.code_hash !== codeHash(email, code)) {
    db.prepare('UPDATE email_tokens SET attempts = attempts + 1 WHERE id = ?').run(token.id);
    const left = MAX_ATTEMPTS - (token.attempts + 1);
    return { status: 400, body: { error: { code: 'code', message: left > 0 ? `验证码不正确，还可尝试 ${left} 次` : '错误次数过多，请重新获取验证码' } } };
  }

  const now = nowIso();
  db.prepare('UPDATE email_tokens SET used_at = ? WHERE id = ?').run(now, token.id);
  db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now, token.user_id);

  const user = db
    .prepare('SELECT id, student_id, name, email, role FROM users WHERE id = ?')
    .get(token.user_id);
  return {
    status: 200,
    body: {
      user: {
        id: user.id, studentId: user.student_id, name: user.name,
        email: user.email, role: user.role, emailVerified: true,
      },
    },
  };
}

export function login(db, body, ip) {
  const studentId = String(body.studentId || '').trim();
  const password = String(body.password || '');

  const limited = hit(`login:${ip}:${studentId}`, 10, 15 * 60 * 1000);
  if (!limited.ok) {
    return { status: 429, body: { error: { code: 'rate_limited', message: '尝试过于频繁，请 15 分钟后再试' } } };
  }

  const user = db.prepare('SELECT * FROM users WHERE student_id = ? OR email = ?').get(studentId, studentId.toLowerCase());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return { status: 401, body: { error: { code: 'credentials', message: '学号或密码不正确' } } };
  }
  if (user.status !== 'active') {
    return { status: 403, body: { error: { code: 'disabled', message: '账号已被停用，请联系管理员' } } };
  }

  return {
    status: 200,
    body: {
      user: {
        id: user.id, studentId: user.student_id, name: user.name, email: user.email,
        role: user.role, isVolunteer: user.role === 'volunteer',
        emailVerified: Boolean(user.email_verified_at),
        // 与 /api/me 保持一致：登录后首屏就能准确判断能确认哪些存放点的入库
        storagePoints: volunteerPoints(db, user.id, user.role),
      },
    },
    userId: user.id,
  };
}

// 找回密码：发一次性 reset 验证码（不透露邮箱是否存在，防枚举）
export async function forgotPassword(db, body, ip) {
  const email = String(body.email || '').trim().toLowerCase();
  const limited = hit(`forgot:${email}:${ip}`, 5, 30 * 60 * 1000);
  if (!limited.ok) {
    return { status: 429, body: { error: { code: 'rate_limited', message: '请求过于频繁，请稍后再试' } } };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: 400, body: { error: { code: 'email', message: '邮箱格式不正确' } } };
  }

  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  // 无论存在与否都返回 200 同样文案
  if (user) {
    const r = await issueCode(db, user.id, email, 'reset');
    if (r.reason === 'cooldown') {
      return { status: 429, body: { error: { code: 'cooldown', message: `请 ${r.cooldownSeconds} 秒后再试`, retryAfter: r.cooldownSeconds } } };
    }
    if (r.reason === 'daily_limit') {
      return { status: 429, body: { error: { code: 'daily_limit', message: '今天发送次数已达上限' } } };
    }
  }
  return { status: 200, body: { ok: true, message: '如果该邮箱已注册，验证码已发送' } };
}

// 重置密码：校验 reset 验证码 → 改密码 → 踢掉所有旧会话
export function resetPassword(db, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const password = String(body.password || '');
  const confirm = String(body.confirmPassword ?? body.confirm ?? '');

  if (!/^\d{6}$/.test(code)) {
    return { status: 400, body: { error: { code: 'code', message: '验证码为 6 位数字' } } };
  }
  if (password.length < 8 || password.length > 64 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return { status: 400, body: { error: { code: 'password', message: '密码需 8-64 位，且同时包含字母和数字' } } };
  }
  if (confirm && confirm !== password) {
    return { status: 400, body: { error: { code: 'confirmPassword', message: '两次输入的密码不一致' } } };
  }

  const token = db
    .prepare(
      `SELECT * FROM email_tokens
        WHERE email = ? AND purpose = 'reset' AND used_at IS NULL
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(email);

  if (!token) return { status: 400, body: { error: { code: 'code', message: '验证码不存在或已使用' } } };
  if (new Date(token.expires_at).getTime() <= Date.now()) {
    return { status: 400, body: { error: { code: 'expired', message: '验证码已过期，请重新获取' } } };
  }
  if (token.attempts >= MAX_ATTEMPTS) {
    return { status: 429, body: { error: { code: 'attempts', message: '错误次数过多，请重新获取验证码' } } };
  }
  if (token.code_hash !== codeHash(email, code)) {
    db.prepare('UPDATE email_tokens SET attempts = attempts + 1 WHERE id = ?').run(token.id);
    return { status: 400, body: { error: { code: 'code', message: '验证码不正确' } } };
  }

  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return { status: 400, body: { error: { code: 'code', message: '验证码不存在或已使用' } } };

  const now = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE email_tokens SET used_at = ? WHERE id = ?').run(now, token.id);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    // 安全问题：改密码后所有旧会话失效
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { status: 500, body: { error: { code: 'failed', message: '重置失败，请稍后再试' } } };
  }

  return { status: 200, body: { ok: true, message: '密码已重置，请用新密码登录' } };
}

// 供管理后台使用：替某个用户发一封重置密码验证码（不透露给调用方）
export async function issuePasswordResetCode(db, email) {
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return { ok: false, reason: 'not_found' };
  const r = await issueCode(db, user.id, email, 'reset');
  if (r.reason === 'cooldown') return { ok: true, reason: 'cooldown', cooldownSeconds: r.cooldownSeconds };
  if (r.reason === 'daily_limit') return { ok: false, reason: 'daily_limit' };
  return { ok: true, delivered: r.delivered };
}

// 志愿者绑定的存放点（供前端提前判断能确认哪些点的物品，避免点一次 403）
export function volunteerPoints(db, userId, role) {
  if (role !== 'volunteer') return [];
  return db
    .prepare(
      `SELECT sp.id, sp.name, sp.type FROM volunteer_assignments va
         JOIN storage_points sp ON sp.id = va.storage_point_id
        WHERE va.user_id = ?
        ORDER BY sp.sort_order, sp.name`
    )
    .all(userId)
    .map((p) => ({ id: p.id, name: p.name, type: p.type }));
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    studentId: user.student_id ?? user.studentId,
    name: user.name,
    email: user.email,
    role: user.role,
    isVolunteer: user.role === 'volunteer',
    emailVerified: Boolean(user.email_verified_at ?? user.emailVerified),
  };
}
