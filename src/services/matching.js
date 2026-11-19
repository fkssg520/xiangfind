// 智能匹配：可解释的规则评分（D-002 不建地点词典、D-003 时间缺失记 0、D-004 通知去重）
// 只在 lost ↔ found 之间匹配，双方状态必须是进行中或已存放
import { nowIso, ID } from '../lib/id.js';

export const THRESHOLD_CANDIDATE = 45; // 进候选
export const THRESHOLD_NOTIFY = 70;    // 发站内消息
export const MAX_CANDIDATES = 5;       // 每条物品最多保留 5 条

const STOP = new Set(['的了', '了一', '一个', '我的', '在了', '是的', '可能', '好像', '东西', '物品']);

// 中文用字符二元组，英文数字用整词
export function tokens(text) {
  const raw = String(text || '').toLowerCase();
  const set = new Set();
  const cjk = raw.replace(/[\s\p{P}\p{S}]+/gu, '');
  for (let i = 0; i < cjk.length - 1; i += 1) {
    const bg = cjk.slice(i, i + 2);
    if (!STOP.has(bg)) set.add(bg);
  }
  for (const w of raw.match(/[a-z0-9]{2,}/g) || []) set.add(w);
  return set;
}

function overlapRatio(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit += 1;
  return hit / Math.min(a.size, b.size);
}

// 地点：完全相同或互相包含 → 20；同一地点前缀或关键词重合 → 12；否则 0
function scoreLocation(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return { score: 0, reason: null };
  if (x === y) return { score: 20, reason: '地点相同' };
  if (x.includes(y) || y.includes(x)) return { score: 20, reason: '地点相同' };

  // 中文地名通常共享前缀（图书馆…、体育馆…），先用前两字判断
  const head = (s) => s.replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 2);
  const hx = head(x);
  const hy = head(y);
  if (hx.length === 2 && hx === hy) return { score: 12, reason: '地点相近' };

  const ta = tokens(x);
  const tb = tokens(y);
  if (overlapRatio(ta, tb) >= 0.3) return { score: 12, reason: '地点相近' };
  return { score: 0, reason: null };
}

// 时间：≤2h 20 / ≤24h 15 / ≤72h 8；任一方缺失记 0（D-003）
function scoreTime(a, b) {
  if (!a || !b) return { score: 0, reason: '时间未知，未计分' };
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return { score: 0, reason: '时间未知，未计分' };
  const diffH = Math.abs(ta - tb) / 3600_000;
  if (diffH <= 2) return { score: 20, reason: '时间接近' };
  if (diffH <= 24) return { score: 15, reason: '时间接近' };
  if (diffH <= 72) return { score: 8, reason: '时间接近' };
  return { score: 0, reason: null };
}

// 分类：相同 25；否则 0（计划书"同大类 10"没有大类表，按 D-002 简化）
function scoreCategory(a, b) {
  return a && b && a === b ? { score: 25, reason: '分类一致' } : { score: 0, reason: null };
}

function scoreKeywords(lost, found) {
  const a = tokens(`${lost.title || ''} ${lost.description || ''}`);
  const b = tokens(`${found.title || ''} ${found.description || ''}`);
  const r = overlapRatio(a, b);
  if (r >= 0.5) return { score: 25, reason: '描述关键词重合' };
  if (r >= 0.25) return { score: 15, reason: '描述关键词重合' };
  if (r >= 0.1) return { score: 8, reason: '描述关键词重合' };
  return { score: 0, reason: null };
}

function scoreValue(lost, found) {
  return lost.value_level === found.value_level
    ? { score: 10, reason: '保管等级一致' }
    : { score: 0, reason: null };
}

export function scorePair(lost, found) {
  const parts = [
    scoreCategory(lost.category, found.category),
    scoreLocation(lost.location, found.location),
    scoreTime(lost.event_at, found.event_at),
    scoreKeywords(lost, found),
    scoreValue(lost, found),
  ];
  const score = parts.reduce((s, p) => s + p.score, 0);
  const reasons = parts.map((p) => p.reason).filter(Boolean);
  return { score, reasons };
}

const LIVE_LOST = "i.type = 'lost' AND i.status IN ('open')";
const LIVE_FOUND = "i.type = 'found' AND i.status IN ('stored')";

// 给一条物品重算匹配（新增/编辑/确认存放后调用）
export function recomputeMatches(db, itemId) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) return { skipped: 'not_found' };

  const isLost = item.type === 'lost';
  const live = isLost ? item.status === 'open' : item.status === 'stored';
  if (!live) return { skipped: 'not_live' };

  const others = db
    .prepare(`SELECT * FROM items i WHERE ${isLost ? LIVE_FOUND : LIVE_LOST}`)
    .all();

  const upsert = db.prepare(
    `INSERT INTO matches (id, lost_item_id, found_item_id, score, reasons_json, notified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(lost_item_id, found_item_id)
     DO UPDATE SET score = excluded.score, reasons_json = excluded.reasons_json, updated_at = excluded.updated_at`
  );
  const existing = db.prepare('SELECT notified_at FROM matches WHERE lost_item_id = ? AND found_item_id = ?');

  let notified = 0;
  let candidateCount = 0;

  for (const other of others) {
    const lost = isLost ? item : other;
    const found = isLost ? other : item;
    const { score, reasons } = scorePair(lost, found);

    if (score < THRESHOLD_CANDIDATE) continue; // 低于阈值不入库
    candidateCount += 1;

    const prev = existing.get(lost.id, found.id);
    upsert.run(
      prev ? `mtc_${lost.id}_${found.id}`.slice(0, 64) : ID.match(),
      lost.id, found.id, score, JSON.stringify(reasons), nowIso(), nowIso()
    );

    // D-004：70 分只通知一次
    if (score >= THRESHOLD_NOTIFY && !prev?.notified_at) {
      const key = `mtc_${lost.id}_${found.id}`.slice(0, 64);
      db.prepare('UPDATE matches SET notified_at = ? WHERE lost_item_id = ? AND found_item_id = ?')
        .run(nowIso(), lost.id, found.id);
      notifyBoth(db, lost, found, score, reasons);
      notified += 1;
      void key;
    }
  }

  // 每条物品最多保留 5 条候选（按分数降序），多余的删掉
  db.prepare(
    `DELETE FROM matches WHERE id IN (
       SELECT id FROM matches
        WHERE lost_item_id = ? OR found_item_id = ?
        ORDER BY score DESC
        LIMIT -1 OFFSET ?)`
  ).run(itemId, itemId, MAX_CANDIDATES);

  return { matched: candidateCount, notified };
}

function notifyBoth(db, lost, found, score, reasons) {
  const text = `相似度 ${score} 分：${reasons.join('、')}`;
  const targets = new Map();
  targets.set(lost.user_id, { itemId: found.id, title: found.title, type: 'found' });
  if (!targets.has(found.user_id)) {
    targets.set(found.user_id, { itemId: lost.id, title: lost.title, type: 'lost' });
  }
  for (const [userId, info] of targets) {
    db.prepare(
      `INSERT INTO messages (id, user_id, type, title, body, related_type, related_id, important, read_at, created_at)
       VALUES (?, ?, 'match', '发现一条高相似度信息', ?, 'item', ?, 1, NULL, ?)`
    ).run(
      ID.message(), userId,
      `你发布的「${info.type === 'lost' ? lost.title : found.title}」可能与「${info.title}」是同一件物品。${text}`,
      info.itemId, nowIso()
    );
  }
}

// 读取某物品的候选匹配（含对方摘要）
export function listMatches(db, itemId, limit = 5) {
  return db
    .prepare(
      `SELECT m.score, m.reasons_json, m.notified_at, m.updated_at,
              i.id AS item_id, i.title, i.type, i.status, i.location, i.event_at
         FROM matches m
         JOIN items i ON i.id = CASE WHEN m.lost_item_id = ? THEN m.found_item_id ELSE m.lost_item_id END
        WHERE m.lost_item_id = ? OR m.found_item_id = ?
        ORDER BY m.score DESC LIMIT ?`
    )
    .all(itemId, itemId, itemId, limit)
    .map((r) => ({
      itemId: r.item_id,
      title: r.title,
      type: r.type,
      status: r.status,
      location: r.location,
      eventAt: r.event_at,
      score: r.score,
      reasons: JSON.parse(r.reasons_json || '[]'),
      notified: Boolean(r.notified_at),
      updatedAt: r.updated_at,
    }));
}
