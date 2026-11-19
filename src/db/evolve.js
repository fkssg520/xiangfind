// 表结构演进：SQLite 没有 ADD COLUMN IF NOT EXISTS，这里按 pragma 检查后补列
// 每次新增字段都在这里登记一行，迁移脚本可重复执行
export function ensureColumns(db) {
  const wanted = [
    // 计划书 §2.2「归还记录」要求记录完成时间
    ['items', 'returned_at', 'TEXT'],
    // 审计与统计可能用到
    ['items', 'archived_at', 'TEXT'],
  ];

  const applied = [];
  for (const [table, column, type] of wanted) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      applied.push(`${table}.${column}`);
    }
  }
  return applied;
}
