// /api 路由分发
import { json, fail, readJson, addCookie, clearCookie, clientIp } from '../lib/http.js';
import { verifyCsrf } from '../lib/csrf.js';
import {
  SESSION_COOKIE, SESSION_TTL_MS, createSession, destroySession, getSessionUser,
} from '../lib/session.js';
import { register, resendCode, verifyEmail, login, publicUser } from '../services/auth.js';
import { listItems, getItem, createItem, patchItem, toggleFavorite } from '../services/items.js';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function sessionToken(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

function currentUser(req, db) {
  return getSessionUser(db, sessionToken(req));
}

function requireUser(res, user) {
  if (!user) {
    fail(res, 401, 'unauthenticated', '请先登录');
    return false;
  }
  return true;
}

function setSessionCookie(res, token) {
  addCookie(res, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: SESSION_TTL_MS / 1000,
    secure: process.env.NODE_ENV === 'production',
  });
}

export async function handleApi(req, res, ctx) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  if (!path.startsWith('/api/')) return false;

  // 所有写操作先过 CSRF
  if (WRITE_METHODS.has(req.method) && !verifyCsrf(req)) {
    fail(res, 403, 'csrf', 'CSRF 校验失败，请刷新页面重试');
    return true;
  }

  let body = {};
  if (WRITE_METHODS.has(req.method)) {
    try {
      body = await readJson(req);
    } catch (err) {
      fail(res, err.status || 400, err.message, '请求体解析失败');
      return true;
    }
  }

  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  const { db } = ctx;

  // POST /api/auth/register
  if (path === '/api/auth/register' && req.method === 'POST') {
    const out = await register(db, body, ip);
    json(res, out.status, out.body);
    return true;
  }

  // POST /api/auth/verify-email
  if (path === '/api/auth/verify-email' && req.method === 'POST') {
    const out = verifyEmail(db, body);
    if (out.status === 200) {
      const { token } = createSession(db, out.body.user.id, ip, ua);
      setSessionCookie(res, token);
    }
    json(res, out.status, out.body);
    return true;
  }

  // POST /api/auth/resend-code
  if (path === '/api/auth/resend-code' && req.method === 'POST') {
    const out = await resendCode(db, body, ip);
    json(res, out.status, out.body);
    return true;
  }

  // POST /api/auth/login
  if (path === '/api/auth/login' && req.method === 'POST') {
    const out = login(db, body, ip);
    if (out.status === 200) {
      const { token } = createSession(db, out.userId, ip, ua);
      setSessionCookie(res, token);
    }
    json(res, out.status, out.body);
    return true;
  }

  // POST /api/auth/logout
  if (path === '/api/auth/logout' && req.method === 'POST') {
    const cookies = (req.headers.cookie || '').match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    if (cookies) destroySession(db, decodeURIComponent(cookies[1]));
    clearCookie(res, SESSION_COOKIE);
    res.writeHead(204, { 'set-cookie': res._cookies || [] });
    res.end();
    return true;
  }

  // GET /api/me
  if (path === '/api/me' && req.method === 'GET') {
    const cookies = (req.headers.cookie || '').match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    const user = cookies ? getSessionUser(db, decodeURIComponent(cookies[1])) : null;
    if (!user) {
      fail(res, 401, 'unauthenticated', '请先登录');
      return true;
    }
    json(res, 200, { user: publicUser(user) });
    return true;
  }

  // ---------- 物品 ----------
  const viewer = currentUser(req, db);

  // GET /api/items
  if (path === '/api/items' && req.method === 'GET') {
    if (!requireUser(res, viewer)) return true;
    json(res, 200, listItems(db, { viewer, query: Object.fromEntries(url.searchParams) }));
    return true;
  }

  // POST /api/items
  if (path === '/api/items' && req.method === 'POST') {
    if (!requireUser(res, viewer)) return true;
    const out = createItem(db, { viewer, body });
    json(res, out.status, out.body);
    return true;
  }

  // /api/items/:id
  const itemMatch = path.match(/^\/api\/items\/([A-Za-z0-9_]+)$/);
  if (itemMatch) {
    if (!requireUser(res, viewer)) return true;
    const id = itemMatch[1];

    if (req.method === 'GET') {
      const item = getItem(db, id, viewer);
      if (!item) return fail(res, 404, 'not_found', '物品不存在'), true;
      json(res, 200, { item });
      return true;
    }
    if (req.method === 'PATCH') {
      const out = patchItem(db, id, { viewer, body });
      json(res, out.status, out.body);
      return true;
    }
  }

  // POST /api/items/:id/favorite
  const favMatch = path.match(/^\/api\/items\/([A-Za-z0-9_]+)\/favorite$/);
  if (favMatch && req.method === 'POST') {
    if (!requireUser(res, viewer)) return true;
    const out = toggleFavorite(db, favMatch[1], viewer);
    json(res, out.status, out.body);
    return true;
  }

  fail(res, 404, 'not_found', `接口不存在：${req.method} ${path}`);
  return true;
}
