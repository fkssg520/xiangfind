// 数据库一致性快照：VACUUM INTO（不需要停服务，WAL 也安全）
// 用法：node scripts/db-snapshot.mjs <源库路径> <目标文件路径>
import { DatabaseSync } from 'node:sqlite';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('用法: node scripts/db-snapshot.mjs <源库> <目标文件>');
  process.exit(2);
}

try {
  const db = new DatabaseSync(src, { readOnly: true });
  // 目标路径里的单引号要转义，否则 SQL 注入式的语法错误
  const escaped = dst.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  db.close();
  console.log('SNAPSHOT_OK');
} catch (err) {
  console.error('SNAPSHOT_FAILED:', err.message);
  process.exit(1);
}
