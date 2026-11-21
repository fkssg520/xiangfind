// /api 路由分发
import { json, fail, readJson, addCookie, clearCookie, clientIp } from '../lib/http.js';
import { Readable } from 'node:stream';
import { saveUpload, MAX_FILES } from '../services/uploads.js';
import { hit } from '../lib/ratelimit.js';
import { submitClaim, decideClaim, confirmReturn, listClaims, myClaims } from '../services/claims.js';
import { listMatches } from '../services/matching.js';
import {
  overview as adminOverview, searchUsers as adminSearchUsers, setVolunteer,
  listStoragePoints, createStoragePoint, updateStoragePoint,
  listClaims as adminListClaims, resetDemoData, listAudit,
  setUserStatus, sendPasswordReset, listItemsAdmin, sendSystemMessage, exportStats,
} from '../services/admin.js';
import { verifyCsrf } from '../lib/csrf.js';
import {
  SESSION_COOKIE, SESSION_TTL_MS, createSession, destroySession, getSessionUser,
} from '../lib/session.js';
import { register, resendCode, verifyEmail, login, publicUser, forgotPassword, resetPassword, volunteerPoints } from '../services/auth.js';
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

// ---------- 图片上传（multipart/form-data） ----------
async function handleUpload(req, res, ctx) {
  const viewer = currentUser(req, ctx.db);
  if (!viewer) {
    fail(res, 401, 'unauthenticated', '请先登录');
    return;
  }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    fail(res, 400, 'bad_content_type', '请用 multipart/form-data 上传');
    return;
  }

  let form;
  try {
    const request = new Request('http://localhost/api/uploads', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: Readable.toWeb(req),
      duplex: 'half',
    });
    form = await request.formData();
  } catch {
    fail(res, 400, 'bad_form', '表单解析失败');
    return;
  }

  const files = form.getAll('files').filter((f) => typeof f === 'object' && 'arrayBuffer' in f);
  if (files.length === 0) {
    fail(res, 400, 'no_file', '没有收到文件，字段名应为 files');
    return;
  }
  if (files.length > MAX_FILES) {
    fail(res, 400, 'too_many', `一次最多上传 ${MAX_FILES} 张`);
    return;
  }

  const saved = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const out = saveUpload(buffer, file.name);
    if (out.error) {
      fail(res, 400, out.error.code, out.error.message);
      return;
    }
    saved.push({
      fileName: out.fileName,
      url: `/uploads/${out.fileName}`,
      mimeType: out.mimeType,
      size: out.size,
    });
  }

  json(res, 201, { files: saved });
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

  // 图片上传是 multipart，不能走下面的 JSON 解析
  if (path === '/api/uploads' && req.method === 'POST') {
    await handleUpload(req, res, ctx);
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

  // POST /api/auth/forgot-password
  if (path === '/api/auth/forgot-password' && req.method === 'POST') {
    const out = await forgotPassword(db, body, ip);
    json(res, out.status, out.body);
    return true;
  }

  // POST /api/auth/reset-password
  if (path === '/api/auth/reset-password' && req.method === 'POST') {
    const out = resetPassword(db, body);
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
    json(res, 200, { user: { ...publicUser(user), storagePoints: volunteerPoints(db, user.id, user.role) } });
    return true;
  }

  // ---------- 物品 ----------
  // D-012：广场对游客只读开放（人类 2026-11-19 拍板），写操作仍要求登录
  const viewer = currentUser(req, db);
  const anonLimit = () => {
    if (viewer) return true;
    const r = hit(`anon:read:${ip}`, 60, 60 * 1000);
    if (!r.ok) {
      fail(res, 429, 'rate_limited', '访问过于频繁，请稍后再试');
      return false;
    }
    return true;
  };

  // GET /api/items（匿名可读）
  if (path === '/api/items' && req.method === 'GET') {
    if (!anonLimit()) return true;
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
  const itemMatch = path.match(/^\/api\/items\/([A-Za-z0-9_-]+)$/);
  if (itemMatch) {
    const id = itemMatch[1];

    if (req.method === 'GET') {
      // 详情同样对游客只读开放（D-012）
      if (!anonLimit()) return true;
      const item = getItem(db, id, viewer);
      if (!item) return fail(res, 404, 'not_found', '物品不存在'), true;
      json(res, 200, { item });
      return true;
    }

    if (!requireUser(res, viewer)) return true;
    if (req.method === 'PATCH') {
      const out = patchItem(db, id, { viewer, body });
      json(res, out.status, out.body);
      return true;
    }
  }

  // POST /api/items/:id/favorite
  const favMatch = path.match(/^\/api\/items\/([A-Za-z0-9_-]+)\/favorite$/);
  if (favMatch && req.method === 'POST') {
    if (!requireUser(res, viewer)) return true;
    const out = toggleFavorite(db, favMatch[1], viewer);
    json(res, out.status, out.body);
    return true;
  }

  // GET /api/storage-points（公开：发布页要用，不登录也能拿到选项）
  if (path === '/api/storage-points' && req.method === 'GET') {
    if (!anonLimit()) return true;
    const list = db
      .prepare('SELECT id, name, type, address, hours, note FROM storage_points WHERE enabled = 1 ORDER BY sort_order, name')
      .all();
    json(res, 200, { storagePoints: list });
    return true;
  }

  // GET /api/matches/:itemId（匹配摘要，登录可看）
  const matchList = path.match(/^\/api\/matches\/([A-Za-z0-9_-]+)$/);
  if (matchList && req.method === 'GET') {
    if (!requireUser(res, viewer)) return true;
    const item = db.prepare('SELECT id, user_id FROM items WHERE id = ?').get(matchList[1]);
    if (!item) return fail(res, 404, 'not_found', '物品不存在'), true;
    json(res, 200, { matches: listMatches(db, matchList[1], 5) });
    return true;
  }

  // POST /api/items/:id/storage-confirm（契约里的专用端点，等价于 PATCH status=stored）
  const storageConfirmMatch = path.match(/^\/api\/items\/([A-Za-z0-9_-]+)\/storage-confirm$/);
  if (storageConfirmMatch && req.method === 'POST') {
    if (!requireUser(res, viewer)) return true;
    const out = patchItem(db, storageConfirmMatch[1], { viewer, body: { status: 'stored' } });
    json(res, out.status, out.body);
    return true;
  }

  // ---------- 认领 ----------
  // POST /api/items/:id/claims
  const claimSubmitMatch = path.match(/^\/api\/items\/([A-Za-z0-9_-]+)\/claims$/);
  if (claimSubmitMatch && req.method === 'POST') {
    if (!requireUser(res, viewer)) return true;
    const out = submitClaim(db, claimSubmitMatch[1], viewer, body);
    json(res, out.status, out.body);
    return true;
  }

  // GET /api/items/:id/claims
  if (claimSubmitMatch && req.method === 'GET') {
    if (!requireUser(res, viewer)) return true;
    const out = listClaims(db, claimSubmitMatch[1], viewer);
    json(res, out.status, out.body);
    return true;
  }

  // POST /api/claims/:id/decision
  const decisionMatch = path.match(/^\/api\/claims\/([A-Za-z0-9_-]+)\/decision$/);
  if (decisionMatch && req.method === 'POST') {
    if (!requireUser(res, viewer)) return true;
    const out = decideClaim(db, decisionMatch[1], viewer, body);
    json(res, out.status, out.body);
    return true;
  }

  // POST /api/items/:id/return
  const returnMatch = path.match(/^\/api\/items\/([A-Za-z0-9_-]+)\/return$/);
  if (returnMatch && req.method === 'POST') {
    if (!requireUser(res, viewer)) return true;
    const out = confirmReturn(db, returnMatch[1], viewer);
    json(res, out.status, out.body);
    return true;
  }

  // GET /api/claims/mine（我的认领申请，个人中心用）
  if (path === '/api/claims/mine' && req.method === 'GET') {
    if (!requireUser(res, viewer)) return true;
    const out = myClaims(db, viewer, Object.fromEntries(url.searchParams));
    json(res, out.status, out.body);
    return true;
  }

  // ---------- 管理后台 ----------
  if (path.startsWith('/api/admin/')) {
    if (!requireUser(res, viewer)) return true;
    if (viewer.role !== 'admin') return fail(res, 403, 'forbidden', '需要管理员权限'), true;

    if (path === '/api/admin/overview' && req.method === 'GET') {
      const out = adminOverview(db); json(res, out.status, out.body); return true;
    }
    if (path === '/api/admin/users' && req.method === 'GET') {
      const out = adminSearchUsers(db, Object.fromEntries(url.searchParams), viewer); json(res, out.status, out.body); return true;
    }
    const volMatch = path.match(/^\/api\/admin\/users\/([A-Za-z0-9_-]+)\/volunteer$/);
    if (volMatch && (req.method === 'POST' || req.method === 'PATCH')) {
      const out = setVolunteer(db, volMatch[1], viewer, body); json(res, out.status, out.body); return true;
    }
    const statusMatch = path.match(/^\/api\/admin\/users\/([A-Za-z0-9_-]+)\/status$/);
    if (statusMatch && (req.method === 'POST' || req.method === 'PATCH')) {
      const out = setUserStatus(db, statusMatch[1], viewer, body); json(res, out.status, out.body); return true;
    }
    const resetPwMatch = path.match(/^\/api\/admin\/users\/([A-Za-z0-9_-]+)\/reset-password$/);
    if (resetPwMatch && req.method === 'POST') {
      const out = await sendPasswordReset(db, resetPwMatch[1], viewer); json(res, out.status, out.body); return true;
    }
    if (path === '/api/admin/items' && req.method === 'GET') {
      const out = listItemsAdmin(db, viewer, Object.fromEntries(url.searchParams)); json(res, out.status, out.body); return true;
    }
    if (path === '/api/admin/messages' && req.method === 'POST') {
      const out = sendSystemMessage(db, viewer, body); json(res, out.status, out.body); return true;
    }
    if (path === '/api/admin/stats' && req.method === 'GET') {
      const out = exportStats(db, viewer); json(res, out.status, out.body); return true;
    }
    if (path === '/api/admin/storage-points' && req.method === 'GET') {
      const out = listStoragePoints(db, viewer); json(res, out.status, out.body); return true;
    }
    if (path === '/api/admin/storage-points' && req.method === 'POST') {
      const out = createStoragePoint(db, viewer, body); json(res, out.status, out.body); return true;
    }
    const spMatch = path.match(/^\/api\/admin\/storage-points\/([A-Za-z0-9_-]+)$/);
    if (spMatch && req.method === 'PATCH') {
      const out = updateStoragePoint(db, spMatch[1], viewer, body); json(res, out.status, out.body); return true;
    }
    if (path === '/api/admin/claims' && req.method === 'GET') {
      const out = adminListClaims(db, viewer, Object.fromEntries(url.searchParams)); json(res, out.status, out.body); return true;
    }
    if (path === '/api/admin/reset-demo' && req.method === 'POST') {
      const out = resetDemoData(db, viewer); json(res, out.status, out.body); return true;
    }
    if (path === '/api/admin/audit-logs' && req.method === 'GET') {
      const out = listAudit(db, viewer, url.searchParams.get('limit')); json(res, out.status, out.body); return true;
    }
    return fail(res, 404, 'not_found', `管理接口不存在：${req.method} ${path}`), true;
  }

  // ---------- 站内消息 ----------
  if (path === '/api/messages' && req.method === 'GET') {
    if (!requireUser(res, viewer)) return true;
    const filter = url.searchParams.get('filter') || 'all';
    const rows = db
      .prepare(
        `SELECT id, type, title, body, related_type, related_id, important, read_at, created_at
           FROM messages WHERE user_id = ? ${filter === 'unread' ? 'AND read_at IS NULL' : ''}
          ORDER BY created_at DESC LIMIT 50`
      )
      .all(viewer.id);
    const unreadCount = db
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND read_at IS NULL')
      .get(viewer.id).c;
    json(res, 200, {
      messages: rows.map((r) => ({
        id: r.id, type: r.type, title: r.title, body: r.body,
        relatedType: r.related_type, relatedId: r.related_id,
        important: Boolean(r.important), readAt: r.read_at, createdAt: r.created_at,
      })),
      unreadCount,
    });
    return true;
  }

  const readMatch = path.match(/^\/api\/messages\/([A-Za-z0-9_-]+)\/read$/);
  if (readMatch && req.method === 'POST') {
    if (!requireUser(res, viewer)) return true;
    const row = db.prepare('SELECT user_id FROM messages WHERE id = ?').get(readMatch[1]);
    if (!row) return fail(res, 404, 'not_found', '消息不存在'), true;
    if (row.user_id !== viewer.id) return fail(res, 403, 'forbidden', '无权操作他人消息'), true;
    db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), readMatch[1]);
    res.writeHead(204, { 'set-cookie': res._cookies || [] });
    res.end();
    return true;
  }

  fail(res, 404, 'not_found', `接口不存在：${req.method} ${path}`);
  return true;
}
