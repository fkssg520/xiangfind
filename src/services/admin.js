// 管理后台：概览、用户、志愿者授权、存放点、申请审核、恢复演示数据
// 所有写操作都写 audit_logs（只追加）
import { nowIso, ID } from '../lib/id.js';
import { resetDemo } from '../db/demo.js';

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

export function listAudit(db, viewer, limit = 50) {
  if (!requireAdmin(viewer)) return { status: 403, body: { error: { code: 'forbidden', message: '需要管理员权限' } } };
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
