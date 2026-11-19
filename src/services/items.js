// 物品服务：列表、详情、发布、编辑、收藏
// 契约：docs/API契约.md §2-§4；状态机：D-001；通知去重：D-004
import { nowIso, ID } from '../lib/id.js';
import { attachImages } from './uploads.js';

export const CATEGORIES = ['证件', '电子产品', '钥匙', '书籍', '衣物', '其他'];

// D-001：两套状态
const LOST_STATUS = ['open', 'reunited', 'archived'];
const FOUND_STATUS = ['pending_storage', 'stored', 'claim_pending', 'ready_for_pickup', 'returned', 'archived'];

// 进行中优先，然后按发布时间倒序
const ORDER = `ORDER BY
  CASE i.status
    WHEN 'open' THEN 0 WHEN 'pending_storage' THEN 1 WHEN 'stored' THEN 1
    WHEN 'claim_pending' THEN 2 WHEN 'ready_for_pickup' THEN 3
    WHEN 'reunited' THEN 4 WHEN 'returned' THEN 4
    ELSE 5 END,
  created_at DESC`;

function rowToCard(row, isFavorited) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    category: row.category,
    summary: row.summary || '',
    location: row.location,
    eventAt: row.event_at,
    valueLevel: row.value_level,
    status: row.status,
    images: (row.images || '').split('|').filter(Boolean).map((u, i) => ({ url: u, sortOrder: i })),
    author: { id: row.author_id, name: row.author_name, isVolunteer: row.author_role === 'volunteer' },
    storagePoint: row.point_id
      ? { id: row.point_id, name: row.point_name, type: row.point_type }
      : null,
    createdAt: row.created_at,
    isFavorited: Boolean(isFavorited),
  };
}

const LIST_SQL = `
  SELECT i.*,
         substr(i.description, 1, 60) AS summary,
         u.id AS author_id, u.name AS author_name, u.role AS author_role,
         sp.id AS point_id, sp.name AS point_name, sp.type AS point_type,
         (SELECT group_concat('/uploads/' || file_name, '|') FROM item_images
           WHERE item_id = i.id) AS images
    FROM items i
    JOIN users u ON u.id = i.user_id
    LEFT JOIN storage_points sp ON sp.id = i.storage_point_id
   WHERE 1 = 1`;

export function listItems(db, { viewer, query }) {
  const where = [];
  const params = [];

  const type = query.type;
  if (type && (type === 'lost' || type === 'found')) { where.push('i.type = ?'); params.push(type); }

  const category = query.category;
  if (category && category !== 'all') { where.push('i.category = ?'); params.push(category); }

  const status = query.status;
  if (status && status !== 'all') { where.push('i.status = ?'); params.push(status); }

  const valueLevel = query.valueLevel;
  if (valueLevel === 'normal' || valueLevel === 'valuable') { where.push('i.value_level = ?'); params.push(valueLevel); }

  const pointId = query.storagePointId;
  if (pointId) { where.push('i.storage_point_id = ?'); params.push(pointId); }

  const q = String(query.q || '').trim();
  if (q) {
    where.push('(i.title LIKE ? OR i.description LIKE ? OR i.location LIKE ? OR i.category LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  // 默认只看未归档
  if (!status) { where.push("i.status <> 'archived'"); }

  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const whereSql = where.length ? ` AND ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM items i WHERE 1=1${whereSql}`).get(...params).c;
  const rows = db
    .prepare(`${LIST_SQL}${whereSql} ${ORDER} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset);

  const favIds = viewer
    ? new Set(
        db.prepare('SELECT item_id FROM favorites WHERE user_id = ?').all(viewer.id).map((r) => r.item_id)
      )
    : new Set();

  return {
    items: rows.map((r) => rowToCard(r, viewer && favIds.has(r.id))),
    total,
    page,
    pageSize,
  };
}

export function getItem(db, id, viewer) {
  const row = db
    .prepare(
      `SELECT i.*, u.id AS author_id, u.name AS author_name, u.role AS author_role,
              u.email AS author_email, u.phone AS author_phone,
              sp.id AS point_id, sp.name AS point_name, sp.type AS point_type,
              sp.address AS point_address, sp.hours AS point_hours,
              (SELECT group_concat('/uploads/' || file_name, '|') FROM item_images
                WHERE item_id = i.id) AS images
         FROM items i
         JOIN users u ON u.id = i.user_id
         LEFT JOIN storage_points sp ON sp.id = i.storage_point_id
        WHERE i.id = ?`
    )
    .get(id);

  if (!row) return null;

  const isOwner = viewer && viewer.id === row.user_id;
  const isStaff = viewer && (viewer.role === 'admin' || viewer.role === 'volunteer');

  // 匹配结果（只给摘要）
  const matches = db
    .prepare(
      `SELECT m.score, m.reasons_json, i.id AS item_id, i.title, i.type, i.status
         FROM matches m
         JOIN items i ON i.id = CASE WHEN m.lost_item_id = ? THEN m.found_item_id ELSE m.lost_item_id END
        WHERE m.lost_item_id = ? OR m.found_item_id = ?
        ORDER BY m.score DESC LIMIT 5`
    )
    .all(id, id, id)
    .map((m) => ({
      itemId: m.item_id,
      title: m.title,
      score: m.score,
      reasons: JSON.parse(m.reasons_json || '[]'),
    }));

  // 认领：优先给本人相关的申请；staff/owner 看到最新一条
  let claim = null;
  const claimRow = db
    .prepare(
      `SELECT c.*, u.name AS applicant_name FROM claims c JOIN users u ON u.id = c.applicant_id
        WHERE c.item_id = ? ORDER BY c.created_at DESC LIMIT 1`
    )
    .get(id);
  const myClaim = viewer
    ? db.prepare('SELECT * FROM claims WHERE item_id = ? AND applicant_id = ?').get(id, viewer.id)
    : null;

  const shown = myClaim || (isOwner || isStaff ? claimRow : null);
  if (shown) {
    claim = {
      id: shown.id,
      status: shown.status,
      canReview: Boolean(isOwner || isStaff),
      publisherVerdict: shown.publisher_verdict || null,
      applicantName: claimRow?.applicant_name || '',
      note: shown.note,
    };
  }

  // 联系方式：仅认领通过（待领取/已归还）且请求者是双方之一
  let contact = null;
  const passed = row.status === 'ready_for_pickup' || row.status === 'returned';
  if (passed && viewer) {
    const isApprovedApplicant = db
      .prepare("SELECT 1 AS x FROM claims WHERE item_id = ? AND applicant_id = ? AND status = 'approved'")
      .get(id, viewer.id);
    if (isOwner || isApprovedApplicant) {
      const u = db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(row.user_id);
      contact = { name: u.name, email: u.email, phone: u.phone };
    }
  }

  const fav = viewer
    ? db.prepare('SELECT 1 AS x FROM favorites WHERE user_id = ? AND item_id = ?').get(viewer.id, id)
    : null;

  return {
    ...rowToCard(row, Boolean(fav)),
    description: row.description,
    images: (row.images || '').split('|').filter(Boolean).map((u, i) => ({ url: u, sortOrder: i })),
    storagePoint: row.point_id
      ? {
          id: row.point_id, name: row.point_name, type: row.point_type,
          address: row.point_address, hours: row.point_hours,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isOwner: Boolean(isOwner),
    matches,
    claim,
    contact,
  };
}

function validateCreate(db, body) {
  const errors = [];
  const type = body.type;
  const title = String(body.title || '').trim();
  const category = String(body.category || '').trim();
  const description = String(body.description || '').trim();
  const location = String(body.location || '').trim();
  const eventAt = body.eventAt ? String(body.eventAt) : null;
  const valueLevel = body.valueLevel === 'valuable' ? 'valuable' : 'normal';
  const storagePointId = body.storagePointId ? String(body.storagePointId) : null;

  if (type !== 'lost' && type !== 'found') errors.push(['type', 'type 必须是 lost 或 found']);
  if (title.length < 1 || title.length > 60) errors.push(['title', '标题需 1-60 字']);
  if (/^(东西|物品|失物|招领)$/.test(title)) errors.push(['title', '标题太笼统，写清是什么物品']);
  if (!CATEGORIES.includes(category)) errors.push(['category', `分类必须是：${CATEGORIES.join('、')}`]);
  if (description.length < 1 || description.length > 500) errors.push(['description', '描述需 1-500 字']);
  if (location.length < 1 || location.length > 80) errors.push(['location', '地点需 1-80 字']);
  if (eventAt) {
    const t = new Date(eventAt);
    if (Number.isNaN(t.getTime())) errors.push(['eventAt', '时间格式不正确']);
    else if (t.getTime() > Date.now() + 60_000) errors.push(['eventAt', '发生时间不能晚于当前时间']);
  }

  let point = null;
  if (type === 'found') {
    if (!storagePointId) errors.push(['storagePointId', '招领必须选择存放点']);
    else {
      point = db.prepare('SELECT * FROM storage_points WHERE id = ?').get(storagePointId);
      if (!point) errors.push(['storagePointId', '存放点不存在']);
      else if (!point.enabled) errors.push(['storagePointId', '该存放点已停用']);
      else if (valueLevel === 'valuable' && point.type !== 'security') {
        errors.push(['storagePointId', '贵重物品只能存放在保卫处类型的存放点']);
      }
    }
  }

  return {
    errors,
    data: { type, title, category, description, location, eventAt, valueLevel, storagePointId },
  };
}

export function createItem(db, { viewer, body }) {
  const { errors, data } = validateCreate(db, body);
  if (errors.length) {
    return { status: 400, body: { error: { code: errors[0][0], message: errors[0][1], details: errors } } };
  }

  const id = ID.item();
  const now = nowIso();
  // D-001：招领从"待存放"开始，失物从"进行中"开始
  const status = data.type === 'found' ? 'pending_storage' : 'open';

  db.prepare(
    `INSERT INTO items (id, user_id, type, title, category, description, event_at, location,
                        value_level, storage_point_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, viewer.id, data.type, data.title, data.category, data.description, data.eventAt,
    data.location, data.valueLevel, data.storagePointId, status, now, now
  );

  // 图片（可选）：先上传拿到 fileName，再随发布一起挂上
  if (Array.isArray(body.images) && body.images.length) {
    if (body.images.length > 3) {
      return { status: 400, body: { error: { code: 'too_many', message: '最多 3 张图片' } } };
    }
    const attached = attachImages(db, id, body.images, () => ID.image());
    if (attached.error) {
      return { status: 400, body: { error: attached.error } };
    }
  }

  return { status: 201, body: { item: getItem(db, id, viewer) } };
}

export function patchItem(db, id, { viewer, body }) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!item) return { status: 404, body: { error: { code: 'not_found', message: '物品不存在' } } };

  const isOwner = viewer.id === item.user_id;
  const isAdmin = viewer.role === 'admin';
  if (!isOwner && !isAdmin) return { status: 403, body: { error: { code: 'forbidden', message: '无权修改他人发布的信息' } } };

  const sets = [];
  const params = [];
  const errors = [];

  // 状态流转（D-001）
  if (body.status && body.status !== item.status) {
    const allowed = item.type === 'lost' ? LOST_STATUS : FOUND_STATUS;
    if (!allowed.includes(body.status)) {
      errors.push(['status', `该类型不允许状态 ${body.status}`]);
    } else if (body.status === 'stored') {
      // 确认入库只能由志愿者/管理员/保卫处做
      if (!(isAdmin || viewer.role === 'volunteer' || viewer.role === 'security')) {
        errors.push(['status', '只有志愿者或管理员可以确认入库']);
      }
    } else if (item.status === 'returned' || item.status === 'archived') {
      errors.push(['status', '已结束的物品不能再改状态']);
    } else {
      sets.push('status = ?');
      params.push(body.status);
    }
  }

  // 内容字段：已入库的招领不允许改关键信息
  const locked = item.status !== 'pending_storage' && item.status !== 'open';
  for (const [field, column] of [
    ['title', 'title'], ['category', 'category'], ['description', 'description'],
    ['location', 'location'], ['eventAt', 'event_at'],
  ]) {
    if (body[field] === undefined) continue;
    if (locked && !isAdmin) { errors.push([field, '物品已入库，关键信息不能修改']); continue; }
    const value = field === 'eventAt' ? (body[field] ? String(body[field]) : null) : String(body[field]).trim();
    sets.push(`${column} = ?`);
    params.push(value);
  }

  // 管理员可纠正贵重等级；贵重必须指向保卫处
  if (body.valueLevel && body.valueLevel !== item.value_level) {
    if (!isAdmin && !isOwner) errors.push(['valueLevel', '无权修改贵重等级']);
    else if (body.valueLevel === 'valuable') {
      const p = item.storage_point_id
        ? db.prepare('SELECT type FROM storage_points WHERE id = ?').get(item.storage_point_id)
        : null;
      if (!p || p.type !== 'security') errors.push(['valueLevel', '贵重物品必须存放在保卫处类型的存放点']);
      else { sets.push('value_level = ?'); params.push('valuable'); }
    } else {
      sets.push('value_level = ?'); params.push('normal');
    }
  }

  if (errors.length) return { status: 400, body: { error: { code: errors[0][0], message: errors[0][1], details: errors } } };
  if (!sets.length) return { status: 400, body: { error: { code: 'noop', message: '没有可更新的字段' } } };

  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  return { status: 200, body: { item: getItem(db, id, viewer) } };
}

export function toggleFavorite(db, id, viewer) {
  const item = db.prepare('SELECT id FROM items WHERE id = ?').get(id);
  if (!item) return { status: 404, body: { error: { code: 'not_found', message: '物品不存在' } } };

  const existing = db
    .prepare('SELECT id FROM favorites WHERE user_id = ? AND item_id = ?')
    .get(viewer.id, id);

  if (existing) {
    db.prepare('DELETE FROM favorites WHERE id = ?').run(existing.id);
    return { status: 200, body: { isFavorited: false } };
  }
  db.prepare('INSERT INTO favorites (id, user_id, item_id, created_at) VALUES (?, ?, ?, ?)')
    .run(ID.audit().replace('aud', 'fav'), viewer.id, id, nowIso());
  return { status: 200, body: { isFavorited: true } };
}
