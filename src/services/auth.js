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

const PEPPER = process.env.SESSION_SECRET || 'dev-pepper-change-me';

function codeHash(email, code) {
  return createHash('sha256').update(`${email}|${code}|${PEPPER}`).digest('hex');
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

  const limited = hit(`register:${ip}`, 5, 60 * 60 * 1000);
  if (!limited.ok) return { status: 429, body: { error: { code: 'rate_limited', message: '注册过于频繁，请稍后再试' } } };

  const exists = db
    .prepare('SELECT student_id, email FROM users WHERE student_id = ? OR email = ?')
    .all(data.studentId, data.email);
  if (exists.length) {
    const dup = exists[0].student_id === data.studentId ? 'studentId' : 'email';
    return { status: 409, body: { error: { code: dup, message: dup === 'studentId' ? '该学号已注册' : '该邮箱已注册' } } };
  }

  const userId = ID.user();
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, student_id, name, email, email_verified_at, password_hash, phone, contact, role, status, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, '', '', 'student', 'active', ?)`
  ).run(userId, data.studentId, data.name, data.email, hashPassword(data.password), now);

  const mail = await issueCode(db, userId, data.email, 'verify');
  return {
    status: 201,
    body: {
      user: { id: userId, studentId: data.studentId, name: data.name, email: data.email, role: 'student', emailVerified: false },
      codeSent: true,
      delivery: mail.delivered ? 'email' : mail.reason,
    },
  };
}

async function issueCode(db, userId, email, purpose) {
  // 冷却：同一邮箱 60 秒内不能重发
  const last = db
    .prepare("SELECT created_at FROM email_tokens WHERE email = ? ORDER BY created_at DESC LIMIT 1")
    .get(email);
  if (last) {
    const wait = RESEND_COOLDOWN_MS - (Date.now() - new Date(last.created_at).getTime());
    if (wait > 0) return { delivered: false, reason: 'cooldown', cooldownSeconds: Math.ceil(wait / 1000) };
  }

  // 每日上限
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
  if (!user) {
    // 防枚举：不透露邮箱是否存在
    return { status: 200, body: { ok: true, delivery: 'email' } };
  }
  const result = await issueCode(db, user.id, email, 'verify');
  if (result.reason === 'cooldown') {
    return { status: 429, body: { error: { code: 'cooldown', message: `请 ${result.cooldownSeconds} 秒后再试`, retryAfter: result.cooldownSeconds } } };
  }
  if (result.reason === 'daily_limit') {
    return { status: 429, body: { error: { code: 'daily_limit', message: '今天发送次数已达上限' } } };
  }
  return { status: 200, body: { ok: true, delivery: result.delivered ? 'email' : result.reason } };
}

export function verifyEmail(db, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();

  if (!/^\d{6}$/.test(code)) return { status: 400, body: { error: { code: 'code', message: '验证码为 6 位数字' } } };

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
      },
    },
    userId: user.id,
  };
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
