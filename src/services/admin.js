// 管理后台：概览、用户、志愿者授权、存放点、申请审核、恢复演示数据
// 所有写操作都写 audit_logs（只追加）
import { nowIso, ID } from '../lib/id.js';
import { resetDemo } from '../db/demo.js';
import { issuePasswordResetCode } from './auth.js';

function audit(db, actorId, action, targetType, targetId, summary) {
  db.prepare(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(ID.audit(), actorId, action, targetType || '', targetId || '', summary || '', nowIso());
}

function requireAdmin(viewer) {
  return viewer && viewer.role === 'admin';
}

export function overview(db) {
  const one = (sql, ...p) => db.prepare(sql).get(...p).c;
  return {
    status: 200,
    body: {
      users: one('SELECT COUNT(*) AS c FROM users'),
      volunteers: one("SELECT COUNT(*) AS c FROM users WHERE role = 'volunteer'"),
      items: one('SELECT COUNT(*) AS c FROM items'),
      inProgress: one("SELECT COUNT(*) AS c FROM items WHERE status IN ('open','stored','pending_storage','claim_pending','ready_for_pickup')"),
      pendingStorage: one("SELECT COUNT(*) AS c FROM items WHERE status = 'pending_storage'"),
      pendingClaims: one("SELECT COUNT(*) AS c FROM claims WHERE status = 'pending'"),
      returned: one("SELECT COUNT(*) AS c FROM items WHERE status = 'returned'"),
      archived: one("SELECT COUNT(*) AS c FROM items WHERE status = 'archived'"),
      unreadMessages: one('SELECT COUNT(*) AS c FROM messages WHERE read_at IS NULL'),
    },
  };
}

export function searchUsers(db, query, viewer) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };
  const q = String(query.q || '').trim();
  const where = q ? 'WHERE u.student_id LIKE ? OR u.email LIKE ? OR u.name LIKE ?' : '';
  const params = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
  const rows = db
    .prepare(
      `SELECT u.id, u.student_id, u.name, u.email, u.role, u.status, u.created_at,
              (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id) AS item_count
         FROM users u ${where} ORDER BY u.created_at DESC LIMIT 50`
    )
    .all(...params);

  const assigns = db
    .prepare('SELECT va.user_id, sp.id, sp.name FROM volunteer_assignments va JOIN storage_points sp ON sp.id = va.storage_point_id')
    .all();

  return {
    status: 200,
    body: {
      users: rows.map((r) => ({
        id: r.id,
        studentId: r.student_id,
        name: r.name,
        email: r.email,
        role: r.role,
        status: r.status,
        itemCount: r.item_count,
        isVolunteer: r.role === 'volunteer',
        storagePoints: assigns.filter((a) => a.user_id === r.id).map((a) => ({ id: a.id, name: a.name })),
        createdAt: r.created_at,
      })),
    },
  };
}

// 添加 / 移除志愿者；可同时指定所属存放点
export function setVolunteer(db, userId, viewer, body) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return { status: 404, body: { error: { code: 'not_found', message: '用户不存在' } } };
  if (user.role === 'admin') return { status: 400, body: { error: { code: 'is_admin', message: '管理员不需要志愿者身份' } } };

  const enabled = body.enabled !== false;
  const pointIds = Array.isArray(body.storagePointIds) ? body.storagePointIds : [];

  db.exec('BEGIN');
  try {
    if (enabled) {
      for (const pid of pointIds) {
        const p = db.prepare('SELECT id FROM storage_points WHERE id = ?').get(pid);
        if (!p) throw new Error(`存放点不存在：${pid}`);
        db.prepare('INSERT OR IGNORE INTO volunteer_assignments (id, user_id, storage_point_id, assigned_by, created_at) VALUES (?,?,?,?,?)')
          .run(ID.audit().replace('aud', 'vas'), userId, pid, viewer.id, nowIso());
      }
      db.prepare("UPDATE users SET role = 'volunteer' WHERE id = ?").run(userId);
      audit(db, viewer.id, enabled ? 'volunteer.grant' : 'volunteer.revoke', 'user', userId,
        `${enabled ? '授予' : '移除'}志愿者：${user.name}${pointIds.length ? '，存放点 ' + pointIds.join(',') : ''}`);
    } else {
      db.prepare('DELETE FROM volunteer_assignments WHERE user_id = ?').run(userId);
      db.prepare("UPDATE users SET role = 'student' WHERE id = ?").run(userId);
      audit(db, viewer.id, 'volunteer.revoke', 'user', userId, `移除志愿者：${user.name}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { status: 400, body: { error: { code: 'failed', message: err.message } } };
  }

  const fresh = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  const points = db.prepare('SELECT sp.id, sp.name FROM volunteer_assignments va JOIN storage_points sp ON sp.id = va.storage_point_id WHERE va.user_id = ?')
    .all(userId);
  return { status: 200, body: { user: { id: fresh.id, role: fresh.role, isVolunteer: fresh.role === 'volunteer', storagePoints: points } } };
}

export function listStoragePoints(db, viewer, includeDisabled = true) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };
  const rows = db
    .prepare(`SELECT sp.*, (SELECT COUNT(*) FROM items i WHERE i.storage_point_id = sp.id) AS item_count
                FROM storage_points sp ${includeDisabled ? '' : 'WHERE sp.enabled = 1'} ORDER BY sp.sort_order, sp.name`)
    .all();
  return {
    status: 200,
    body: {
      storagePoints: rows.map((r) => ({
        id: r.id, name: r.name, type: r.type, address: r.address, hours: r.hours,
        contactName: r.contact_name, contactPhone: r.contact_phone, note: r.note,
        enabled: Boolean(r.enabled), sortOrder: r.sort_order, itemCount: r.item_count,
      })),
    },
  };
}

export function createStoragePoint(db, viewer, body) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };
  const name = String(body.name || '').trim();
  const type = body.type === 'security' ? 'security' : 'normal';
  const address = String(body.address || '').trim();
  if (!name || !address) {
    return { status: 400, body: { error: { code: 'name', message: '名称和地址必填' } } };
  }
  const id = ID.point();
  db.prepare(`INSERT INTO storage_points (id,name,type,address,hours,contact_name,contact_phone,note,enabled,sort_order,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, type, address, String(body.hours || ''), String(body.contactName || ''),
         String(body.contactPhone || ''), String(body.note || ''), body.enabled === false ? 0 : 1,
         Number(body.sortOrder) || 0, nowIso());
  audit(db, viewer.id, 'storage.create', 'storage_point', id, `新增存放点：${name}（${type}）`);
  return { status: 201, body: { storagePoint: { id, name, type, address } } };
}

export function updateStoragePoint(db, pointId, viewer, body) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };
  const p = db.prepare('SELECT * FROM storage_points WHERE id = ?').get(pointId);
  if (!p) return { status: 404, body: { error: { code: 'not_found', message: '存放点不存在' } } };

  const sets = [];
  const params = [];
  const map = {
    name: 'name', address: 'address', hours: 'hours', note: 'note',
    contactName: 'contact_name', contactPhone: 'contact_phone',
  };
  for (const [k, col] of Object.entries(map)) {
    if (body[k] === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(String(body[k]).trim());
  }
  if (body.type !== undefined) {
    if (body.type !== 'normal' && body.type !== 'security') {
      return { status: 400, body: { error: { code: 'type', message: 'type 只能是 normal 或 security' } } };
    }
    sets.push('type = ?');
    params.push(body.type);
  }
  if (body.enabled !== undefined) { sets.push('enabled = ?'); params.push(body.enabled ? 1 : 0); }
  if (body.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(Number(body.sortOrder) || 0); }

  if (!sets.length) return { status: 400, body: { error: { code: 'noop', message: '没有可更新的字段' } } };
  params.push(pointId);
  db.prepare(`UPDATE storage_points SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  audit(db, viewer.id, 'storage.update', 'storage_point', pointId, `修改存放点：${p.name}`);
  return { status: 200, body: { ok: true } };
}

// 后台的申请审核列表（管理员视角，跨物品）
export function listClaims(db, viewer, query) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };
  const status = String(query.status || 'pending');
  const rows = db
    .prepare(
      `SELECT c.*, i.title, i.status AS item_status, u.name AS applicant_name, i.user_id AS publisher_id
         FROM claims c JOIN items i ON i.id = c.item_id JOIN users u ON u.id = c.applicant_id
        ${status === 'all' ? '' : 'WHERE c.status = ?'}
        ORDER BY c.created_at DESC LIMIT 100`
    )
    .all(...(status === 'all' ? [] : [status]));

  return {
    status: 200,
    body: {
      claims: rows.map((r) => ({
        id: r.id, itemId: r.item_id, itemTitle: r.title, itemStatus: r.item_status,
        applicantName: r.applicant_name, note: r.note, status: r.status,
        publisherVerdict: r.publisher_verdict, reviewNote: r.review_note, createdAt: r.created_at,
      })),
    },
  };
}

export function resetDemoData(db, viewer) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };
  try {
    const counts = resetDemo(db);
    audit(db, viewer.id, 'demo.reset', 'system', '', '恢复演示数据');
    return { status: 200, body: { ok: true, counts } };
  } catch (err) {
    return { status: 400, body: { error: { code: 'failed', message: err.message } } };
  }
}

// 停用 / 启用账号（停用会立即踢掉该用户所有会话）
export function setUserStatus(db, userId, viewer, body) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return { status: 404, body: { error: { code: 'not_found', message: '用户不存在' } } };
  if (user.id === viewer.id) return { status: 400, body: { error: { code: 'self', message: '不能停用自己' } } };
  if (user.role === 'admin') return { status: 400, body: { error: { code: 'is_admin', message: '不能停用管理员账号' } } };

  const status = body.status === 'disabled' ? 'disabled' : 'active';
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
  if (status === 'disabled') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  audit(db, viewer.id, status === 'disabled' ? 'user.disable' : 'user.enable', 'user', userId, `${status === 'disabled' ? '停用' : '启用'}账号：${user.name}`);
  return { status: 200, body: { user: { id: userId, status } } };
}

// 替用户发一封重置密码验证码
export async function sendPasswordReset(db, userId, viewer) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(userId);
  if (!user) return { status: 404, body: { error: { code: 'not_found', message: '用户不存在' } } };
  if (!user.email) return { status: 400, body: { error: { code: 'no_email', message: '该用户没有绑定邮箱' } } };

  const r = await issuePasswordResetCode(db, user.email);
  audit(db, viewer.id, 'user.send_reset', 'user', userId, `为用户 ${user.name} 发送重置密码邮件`);
  if (!r.ok) return { status: 429, body: { error: { code: r.reason, message: '发送受限（今日次数已达上限）' } } };
  return {
    status: 200,
    body: {
      ok: true,
      delivery: r.delivered ? 'email' : 'log',
      cooldown: r.reason === 'cooldown' ? r.cooldownSeconds : 0,
      note: '验证码 15 分钟内有效；开发环境打在服务端日志',
    },
  };
}

// 管理视角的物品列表（含归档，比公开列表多 author/point 明细）
export function listItemsAdmin(db, viewer, query) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };
  const where = [];
  const params = [];
  if (query.status && query.status !== 'all') { where.push('i.status = ?'); params.push(query.status); }
  if (query.type === 'lost' || query.type === 'found') { where.push('i.type = ?'); params.push(query.type); }
  if (query.valueLevel === 'normal' || query.valueLevel === 'valuable') { where.push('i.value_level = ?'); params.push(query.valueLevel); }
  const q = String(query.q || '').trim();
  if (q) {
    where.push('(i.title LIKE ? OR i.description LIKE ? OR u.name LIKE ? OR i.location LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (query.includeArchived !== '1') where.push("i.status <> 'archived'");

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT i.id, i.type, i.title, i.category, i.status, i.value_level, i.location,
              i.event_at, i.created_at, i.updated_at, i.returned_at,
              u.id AS author_id, u.name AS author_name, u.student_id,
              sp.name AS point_name
         FROM items i JOIN users u ON u.id = i.user_id
         LEFT JOIN storage_points sp ON sp.id = i.storage_point_id
         ${whereSql}
        ORDER BY i.created_at DESC LIMIT 200`
    )
    .all(...params);

  return {
    status: 200,
    body: {
      items: rows.map((r) => ({
        id: r.id, type: r.type, title: r.title, category: r.category, status: r.status,
        valueLevel: r.value_level, location: r.location, eventAt: r.event_at,
        createdAt: r.created_at, updatedAt: r.updated_at, returnedAt: r.returned_at,
        author: { id: r.author_id, name: r.author_name, studentId: r.student_id },
        storagePointName: r.point_name,
      })),
      total: rows.length,
    },
  };
}

// 发送系统消息：按角色群发，或指定若干用户
export function sendSystemMessage(db, viewer, body) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };
  const title = String(body.title || '').trim();
  const text = String(body.body || '').trim();
  if (title.length < 1 || title.length > 60) return { status: 400, body: { error: { code: 'title', message: '标题需 1-60 字' } } };
  if (text.length < 1 || text.length > 1000) return { status: 400, body: { error: { code: 'body', message: '正文需 1-1000 字' } } };

  let targets = [];
  if (Array.isArray(body.userIds) && body.userIds.length) {
    const inList = body.userIds.map(() => '?').join(',');
    targets = db.prepare(`SELECT id FROM users WHERE status = 'active' AND id IN (${inList})`).all(...body.userIds).map((r) => r.id);
  } else {
    const role = String(body.role || 'all');
    targets = role === 'all'
      ? db.prepare("SELECT id FROM users WHERE status = 'active'").all().map((r) => r.id)
      : db.prepare("SELECT id FROM users WHERE status = 'active' AND role = ?").all(role).map((r) => r.id);
  }

  if (!targets.length) return { status: 400, body: { error: { code: 'no_target', message: '没有匹配的收件人' } } };

  const now = nowIso();
  db.exec('BEGIN');
  try {
    const ins = db.prepare(
      `INSERT INTO messages (id, user_id, type, title, body, related_type, related_id, important, read_at, created_at)
       VALUES (?, ?, 'system', ?, ?, NULL, NULL, 1, NULL, ?)`
    );
    for (const uid of targets) ins.run(ID.message(), uid, title, text, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { status: 400, body: { error: { code: 'failed', message: err.message } } };
  }

  audit(db, viewer.id, 'message.broadcast', 'system', '', `群发系统消息「${title}」给 ${targets.length} 人`);
  return { status: 201, body: { ok: true, recipients: targets.length } };
}

// 导出统计（JSON，前端可自行转 CSV）
export function exportStats(db, viewer) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };

  const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM items GROUP BY status ORDER BY c DESC').all();
  const byCategory = db.prepare('SELECT category, COUNT(*) AS c FROM items GROUP BY category ORDER BY c DESC').all();
  const byType = db.prepare('SELECT type, COUNT(*) AS c FROM items GROUP BY type').all();
  const claimsByStatus = db.prepare('SELECT status, COUNT(*) AS c FROM claims GROUP BY status').all();
  const daily = db
    .prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS c FROM items
              GROUP BY day ORDER BY day DESC LIMIT 7`)
    .all();
  const users = db.prepare('SELECT role, COUNT(*) AS c FROM users GROUP BY role').all();

  return {
    status: 200,
    body: {
      generatedAt: nowIso(),
      users,
      items: { byStatus, byCategory, byType },
      claims: claimsByStatus,
      daily,
    },
  };
}

export function listAudit(db, viewer, limit = 50) {  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };
  const rows = db
    .prepare(`SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
              ORDER BY a.created_at DESC LIMIT ?`)
    .all(Number(limit) || 50);
  return {
    status: 200,
    body: {
      logs: rows.map((r) => ({
        id: r.id, actor: r.actor_name || r.actor_id, action: r.action,
        targetType: r.target_type, targetId: r.target_id, summary: r.summary, createdAt: r.created_at,
      })),
    },
  };
}
