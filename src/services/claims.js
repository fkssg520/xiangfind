// 认领流程：提交申请 → 发布者表态（D-005 双签）→ 授权角色确认 → 待领取 → 归还
import { nowIso, ID } from '../lib/id.js';

const STATUS_AFTER_SUBMIT = 'claim_pending';
const STATUS_AFTER_APPROVE = 'ready_for_pickup';
const STATUS_AFTER_RETURN = 'returned';

function pointOf(db, item) {
  return item.storage_point_id
    ? db.prepare('SELECT * FROM storage_points WHERE id = ?').get(item.storage_point_id)
    : null;
}

function roleScope(db, viewer, item) {
  const isOwner = viewer.id === item.user_id;
  const isAdmin = viewer.role === 'admin';
  const assigned = item.storage_point_id
    ? db.prepare('SELECT 1 AS x FROM volunteer_assignments WHERE user_id = ? AND storage_point_id = ?')
        .get(viewer.id, item.storage_point_id)
    : null;
  const point = pointOf(db, item);
  const isVolunteerHere = viewer.role === 'volunteer' && Boolean(assigned);
  const isSecurityHere = viewer.role === 'security' && point?.type === 'security';
  return {
    isOwner,
    isAdmin,
    isReviewer: isAdmin || isVolunteerHere || isSecurityHere,
    canSeeContact: isOwner || isAdmin || isVolunteerHere || isSecurityHere,
  };
}

function notify(db, userId, title, body, relatedId) {
  db.prepare(
    `INSERT INTO messages (id, user_id, type, title, body, related_type, related_id, important, read_at, created_at)
     VALUES (?, ?, 'claim', ?, ?, 'item', ?, 1, NULL, ?)`
  ).run(ID.message(), userId, title, body, relatedId, nowIso());
}

// 提交认领
export function submitClaim(db, itemId, viewer, body) {
  // 需求基线 §2.2：未验证邮箱不能认领
  if (viewer && !viewer.email_verified_at && !viewer.emailVerified) {
    return { status: 403, body: { error: { code: 'email_unverified', message: '请先完成邮箱验证再申请认领' } } };
  }

  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) return { status: 404, body: { error: { code: 'not_found', message: '物品不存在' } } };
  if (item.type !== 'found') {
    return { status: 400, body: { error: { code: 'type', message: '只有招领物品可以申请认领' } } };
  }
  if (item.user_id === viewer.id) {
    return { status: 400, body: { error: { code: 'own_item', message: '不能申请认领自己发布的物品' } } };
  }
  if (item.status !== 'stored' && item.status !== 'claim_pending') {
    return { status: 400, body: { error: { code: 'status', message: '该物品当前不接受认领申请' } } };
  }

  const note = String(body.note || '').trim();
  if (note.length < 10 || note.length > 500) {
    return { status: 400, body: { error: { code: 'note', message: '请填写 10-500 字的认领说明（特征、经过、可核对信息）' } } };
  }

  const dup = db
    .prepare("SELECT id FROM claims WHERE item_id = ? AND applicant_id = ? AND status = 'pending'")
    .get(itemId, viewer.id);
  if (dup) {
    return { status: 409, body: { error: { code: 'duplicate', message: '你已经提交过认领申请，等待处理中' } } };
  }

  const id = ID.claim();
  const now = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO claims (id, item_id, applicant_id, note, status, publisher_verdict, publisher_verdict_at,
                           reviewed_by, review_note, created_at, reviewed_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, '', ?, NULL)`
    ).run(id, itemId, viewer.id, note, now);

    db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').run(STATUS_AFTER_SUBMIT, now, itemId);

    // 通知：发布者 + 该存放点志愿者 + 管理员
    const targets = new Set([item.user_id]);
    db.prepare('SELECT user_id FROM volunteer_assignments WHERE storage_point_id = ?')
      .all(item.storage_point_id).forEach((r) => targets.add(r.user_id));
    db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'")
      .all().forEach((r) => targets.add(r.id));
    targets.delete(viewer.id);

    for (const uid of targets) {
      notify(db, uid, '有人申请认领你的物品',
        `${viewer.name} 申请认领「${item.title}」，请到详情页处理。`, itemId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { status: 400, body: { error: { code: 'failed', message: `提交失败：${err.message}` } } };
  }

  return {
    status: 201,
    body: { claim: { id, itemId, status: 'pending', itemStatus: STATUS_AFTER_SUBMIT } },
  };
}

// 审核：agree/reject（发布者表态）｜approve/reject（授权角色最终确认）
export function decideClaim(db, claimId, viewer, body) {
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!claim) return { status: 404, body: { error: { code: 'not_found', message: '申请不存在' } } };

  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(claim.item_id);
  const scope = roleScope(db, viewer, item);
  const decision = String(body.decision || '');
  const note = String(body.note || '').trim();

  if (claim.status !== 'pending') {
    return { status: 409, body: { error: { code: 'closed', message: '该申请已处理过' } } };
  }

  // 第一阶段：发布者表态
  if (decision === 'agree' || (decision === 'reject' && !scope.isReviewer)) {
    if (!scope.isOwner) {
      return { status: 403, body: { error: { code: 'forbidden', message: '只有发布者可以表态' } } };
    }
    if (decision === 'reject') {
      db.prepare('UPDATE claims SET status = ?, review_note = ?, reviewed_at = ? WHERE id = ?')
        .run('rejected', note || '发布者已拒绝', nowIso(), claimId);
      releaseItemIfIdle(db, item);
      notify(db, claim.applicant_id, '认领未通过', `你申请认领的「${item.title}」被发布者拒绝。${note}`, item.id);
      return { status: 200, body: { claim: { id: claimId, status: 'rejected' } } };
    }
    db.prepare('UPDATE claims SET publisher_verdict = ?, publisher_verdict_at = ? WHERE id = ?')
      .run('agree', nowIso(), claimId);
    return {
      status: 200,
      body: { claim: { id: claimId, status: 'pending', publisherVerdict: 'agree' } },
    };
  }

  // 第二阶段：授权角色最终确认
  if (decision === 'approve' || decision === 'reject') {
    if (!scope.isReviewer) {
      return { status: 403, body: { error: { code: 'forbidden', message: '只有所属存放点志愿者或管理员可以审核' } } };
    }
    if (decision === 'reject') {
      db.prepare(`UPDATE claims SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = ? WHERE id = ?`)
        .run(viewer.id, note || '审核未通过', nowIso(), claimId);
      releaseItemIfIdle(db, item);
      notify(db, claim.applicant_id, '认领未通过', `你申请认领的「${item.title}」未通过审核。${note}`, item.id);
      return { status: 200, body: { claim: { id: claimId, status: 'rejected' } } };
    }

    // 发布者已明确拒绝 → 不能强行通过（D-005）
    if (claim.publisher_verdict === 'reject') {
      return { status: 409, body: { error: { code: 'publisher_rejected', message: '发布者已拒绝，不能通过' } } };
    }

    const now = nowIso();
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE claims SET status = 'approved', reviewed_by = ?, review_note = ?, reviewed_at = ? WHERE id = ?`)
        .run(viewer.id, note || '审核通过', now, claimId);
      db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').run(STATUS_AFTER_APPROVE, now, item.id);

      // 其余待处理申请自动拒绝（计划书 §4.5 第 5 条）
      const others = db
        .prepare("SELECT id, applicant_id FROM claims WHERE item_id = ? AND status = 'pending' AND id <> ?")
        .all(item.id, claimId);
      for (const o of others) {
        db.prepare(`UPDATE claims SET status = 'rejected', review_note = ?, reviewed_at = ? WHERE id = ?`)
          .run('物品已归他人', now, o.id);
        notify(db, o.applicant_id, '认领未通过', `「${item.title}」已由他人认领。`, item.id);
      }

      const point = pointOf(db, item);
      const where = point ? `${point.name}（${point.address}，${point.hours}）` : '请与发布者约定';
      notify(db, claim.applicant_id, '认领通过，请按地址领取',
        `你申请认领的「${item.title}」已通过审核。领取地点：${where}。请携带可证明归属的材料。`, item.id);
      notify(db, item.user_id, '你的物品已确认认领',
        `「${item.title}」的认领申请已通过，等待现场领取。`, item.id);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      return { status: 400, body: { error: { code: 'failed', message: `审核失败：${err.message}` } } };
    }

    return {
      status: 200,
      body: {
        claim: { id: claimId, status: 'approved' },
        item: { id: item.id, status: STATUS_AFTER_APPROVE },
        rejectedOthers: db.prepare("SELECT COUNT(*) AS c FROM claims WHERE item_id = ? AND status = 'rejected'").get(item.id).c,
      },
    };
  }

  return { status: 400, body: { error: { code: 'decision', message: 'decision 必须是 agree / reject / approve' } } };
}

// 没有任何待处理申请时，物品退回"已存放"
function releaseItemIfIdle(db, item) {
  const pending = db
    .prepare("SELECT COUNT(*) AS c FROM claims WHERE item_id = ? AND status = 'pending'")
    .get(item.id).c;
  if (pending === 0 && item.status === STATUS_AFTER_SUBMIT) {
    db.prepare('UPDATE items SET status = ?, updated_at = ? WHERE id = ?').run('stored', nowIso(), item.id);
  }
}

// 现场归还：志愿者 / 管理员 / 保卫处确认
export function confirmReturn(db, itemId, viewer, ) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) return { status: 404, body: { error: { code: 'not_found', message: '物品不存在' } } };
  if (item.status !== STATUS_AFTER_APPROVE) {
    return { status: 400, body: { error: { code: 'status', message: '只有待领取的物品可以确认归还' } } };
  }
  const scope = roleScope(db, viewer, item);
  if (!scope.isReviewer) {
    return { status: 403, body: { error: { code: 'forbidden', message: '只有所属存放点志愿者或管理员可以确认归还' } } };
  }

  const now = nowIso();
  // 计划书 §2.2：归还记录要记录完成时间
  db.prepare('UPDATE items SET status = ?, returned_at = ?, updated_at = ? WHERE id = ?')
    .run(STATUS_AFTER_RETURN, now, now, itemId);
  const approved = db.prepare("SELECT applicant_id FROM claims WHERE item_id = ? AND status = 'approved'").get(itemId);
  if (approved) notify(db, approved.applicant_id, '物品已归还', `「${item.title}」已完成归还，感谢使用湘寻。`, itemId);

  return { status: 200, body: { item: { id: itemId, status: STATUS_AFTER_RETURN } } };
}

// 我的认领申请（跨物品，个人中心用）
export function myClaims(db, viewer, query) {
  const status = String(query.status || 'all');
  const rows = db
    .prepare(
      `SELECT c.*, i.title AS item_title, i.status AS item_status, i.type AS item_type,
              i.location AS item_location, i.storage_point_id
         FROM claims c JOIN items i ON i.id = c.item_id
        WHERE c.applicant_id = ? ${status === 'all' ? '' : 'AND c.status = ?'}
        ORDER BY c.created_at DESC LIMIT 100`
    )
    .all(...(status === 'all' ? [viewer.id] : [viewer.id, status]));

  const points = db.prepare('SELECT id, name, address, hours FROM storage_points').all();
  const pointMap = new Map(points.map((p) => [p.id, p]));

  return {
    status: 200,
    body: {
      claims: rows.map((r) => ({
        id: r.id,
        itemId: r.item_id,
        itemTitle: r.item_title,
        itemStatus: r.item_status,
        itemType: r.item_type,
        itemLocation: r.item_location,
        status: r.status,
        note: r.note,
        reviewNote: r.review_note,
        createdAt: r.created_at,
        reviewedAt: r.reviewed_at,
        // 通过后给出领取地点，和消息里的口径一致
        storagePoint: r.status === 'approved' && r.storage_point_id
          ? (pointMap.get(r.storage_point_id) || null)
          : null,
      })),
    },
  };
}

// 读取某物品的申请列表（发布者 / 授权角色 / 申请人本人）
export function listClaims(db, itemId, viewer) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) return { status: 404, body: { error: { code: 'not_found', message: '物品不存在' } } };
  const scope = roleScope(db, viewer, item);

  const rows = db
    .prepare(
      `SELECT c.*, u.name AS applicant_name FROM claims c JOIN users u ON u.id = c.applicant_id
        WHERE c.item_id = ? ORDER BY c.created_at DESC`
    )
    .all(itemId);

  const visible = rows.filter((r) => scope.isOwner || scope.isAdmin || scope.isReviewer || r.applicant_id === viewer.id);
  return {
    status: 200,
    body: {
      claims: visible.map((r) => ({
        id: r.id,
        status: r.status,
        note: r.note,
        applicantName: r.applicant_name,
        isMine: r.applicant_id === viewer.id,
        publisherVerdict: r.publisher_verdict,
        reviewNote: r.review_note,
        createdAt: r.created_at,
        reviewedAt: r.reviewed_at,
      })),
      canReview: scope.isReviewer,
      isOwner: scope.isOwner,
    },
  };
}
