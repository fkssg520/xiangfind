// 会话：Cookie 只放随机 token，数据库只存哈希
import { createHash, randomBytes } from 'node:crypto';
import { nowIso } from './id.js';

export const SESSION_COOKIE = 'xf_sid';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db, userId, ip, userAgent) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(hashToken(token), userId, expiresAt, ip || '', (userAgent || '').slice(0, 255), nowIso());
  return { token, expiresAt };
}

export function getSessionUser(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.expires_at, u.id, u.student_id, u.name, u.email, u.email_verified_at,
              u.role, u.status
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .get(hashToken(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  if (row.status !== 'active') return null;
  return row;
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function purgeExpiredSessions(db) {
  return db
    .prepare('DELETE FROM sessions WHERE expires_at <= ?')
    .run(nowIso()).changes;
}
