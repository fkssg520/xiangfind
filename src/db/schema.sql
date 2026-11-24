-- 湘寻 · 数据库结构（SQLite）
-- 约定：主键为带前缀的随机 ID（usr_/itm_/clm_/msg_/stp_/img_），时间为 UTC ISO 8601 文本
-- 迁移脚本可重复执行：全部 IF NOT EXISTS

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. 用户
CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,
  student_id         TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  email              TEXT NOT NULL UNIQUE,
  email_verified_at  TEXT,
  password_hash      TEXT NOT NULL,
  phone              TEXT NOT NULL DEFAULT '',
  contact            TEXT NOT NULL DEFAULT '',
  role               TEXT NOT NULL DEFAULT 'student'
                     CHECK (role IN ('student','volunteer','admin','security')),
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','disabled')),
  created_at         TEXT NOT NULL
);

-- 2. 邮箱验证码
-- 待注册：验证码通过后才写入 users（避免"未验证账号占住学号/邮箱"）
CREATE TABLE IF NOT EXISTS pending_registrations (
  id            TEXT PRIMARY KEY,
  student_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_student ON pending_registrations(student_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_email ON pending_registrations(email);

CREATE TABLE IF NOT EXISTS email_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'verify'
              CHECK (purpose IN ('verify','reset')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_email ON email_tokens(email, created_at);

-- 3. 会话
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  ip          TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);

-- 4. 存放点
CREATE TABLE IF NOT EXISTS storage_points (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('normal','security')),
  address        TEXT NOT NULL,
  hours          TEXT NOT NULL DEFAULT '',
  contact_name   TEXT NOT NULL DEFAULT '',
  contact_phone  TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

-- 5. 物品（失物 + 招领共用一表）
-- D-001：lost 用 open/reunited/archived；found 用 pending_storage/stored/claim_pending/ready_for_pickup/returned/archived
CREATE TABLE IF NOT EXISTS items (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('lost','found')),
  title             TEXT NOT NULL,
  category          TEXT NOT NULL,
  description       TEXT NOT NULL,
  event_at          TEXT,
  location          TEXT NOT NULL,
  value_level       TEXT NOT NULL DEFAULT 'normal' CHECK (value_level IN ('normal','valuable')),
  storage_point_id  TEXT,
  status            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  -- 归还与归档时间（计划书 §2.2 要求记录完成时间；OI-10 保留策略用）
  returned_at       TEXT,
  archived_at       TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (storage_point_id) REFERENCES storage_points(id),
  -- 招领必须有存放点；失物不得有
  CHECK (type = 'lost' OR storage_point_id IS NOT NULL),
  CHECK (type = 'found' OR storage_point_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_items_status_created ON items(status, created_at);
CREATE INDEX IF NOT EXISTS idx_items_type_category  ON items(type, category);
CREATE INDEX IF NOT EXISTS idx_items_user           ON items(user_id, created_at);

-- 6. 物品图片
CREATE TABLE IF NOT EXISTS item_images (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_item_images_item ON item_images(item_id, sort_order);

-- 7. 认领申请（含 D-005 的双签字段）
CREATE TABLE IF NOT EXISTS claims (
  id                    TEXT PRIMARY KEY,
  item_id               TEXT NOT NULL,
  applicant_id          TEXT NOT NULL,
  note                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','cancelled')),
  publisher_verdict     TEXT CHECK (publisher_verdict IN ('agree','reject')),
  publisher_verdict_at  TEXT,
  reviewed_by           TEXT,
  review_note           TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL,
  reviewed_at           TEXT,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (applicant_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_claims_item_status ON claims(item_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_applicant   ON claims(applicant_id, created_at);

-- 8. 相似匹配（D-004：唯一组合 + 通知去重）
CREATE TABLE IF NOT EXISTS matches (
  id            TEXT PRIMARY KEY,
  lost_item_id  TEXT NOT NULL,
  found_item_id TEXT NOT NULL,
  score         INTEGER NOT NULL,
  reasons_json  TEXT NOT NULL DEFAULT '[]',
  notified_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (lost_item_id, found_item_id),
  FOREIGN KEY (lost_item_id)  REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (found_item_id) REFERENCES items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_matches_score ON matches(score);

-- 9. 站内消息
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('claim','match','system','storage')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  related_type  TEXT,
  related_id    TEXT,
  important     INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0,1)),
  read_at       TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_user_read ON messages(user_id, read_at);

-- 10. 志愿者与存放点
CREATE TABLE IF NOT EXISTS volunteer_assignments (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  storage_point_id TEXT NOT NULL,
  assigned_by      TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (user_id, storage_point_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (storage_point_id) REFERENCES storage_points(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by) REFERENCES users(id)
);

-- 11. 管理审计（只追加）
CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT PRIMARY KEY,
  actor_id     TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL DEFAULT '',
  target_id    TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  FOREIGN KEY (actor_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- 12. 收藏（计划书功能要求，但第 8 章数据表遗漏，此处补上）
CREATE TABLE IF NOT EXISTS favorites (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, item_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, created_at);

-- 元信息：记录已应用的迁移，便于将来演进
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL
);
