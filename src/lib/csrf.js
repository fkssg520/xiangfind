// CSRF：双提交（double submit），Cookie 与请求头必须一致
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { addCookie, parseCookies } from './http.js';

export const CSRF_COOKIE = 'xf_csrf';
export const CSRF_HEADER = 'x-csrf-token';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// 每个请求都确保有 CSRF Cookie（前端从 document.cookie 读出来放进请求头）
export function ensureCsrf(req, res) {
  const cookies = parseCookies(req);
  if (cookies[CSRF_COOKIE]) return cookies[CSRF_COOKIE];
  const token = randomBytes(24).toString('base64url');
  addCookie(res, CSRF_COOKIE, token, { httpOnly: false, maxAge: 7 * 24 * 3600, sameSite: 'Lax' });
  return token;
}

export function verifyCsrf(req) {
  const cookies = parseCookies(req);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];
  if (!cookieToken || !headerToken) return false;
  return safeEqual(cookieToken, headerToken);
}
