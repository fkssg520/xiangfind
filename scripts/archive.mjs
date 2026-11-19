// 数据保留：把超期的已归还物品归档，把超期归档物品连同图片清除
// 用法：
//   node scripts/archive.mjs                  # 预演（默认，不改数据）
//   node scripts/archive.mjs --apply          # 真执行
//   node scripts/archive.mjs --apply --returned-days 30 --archived-days 180
// 建议放进 cron：每月 1 号凌晨跑一次 --apply
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runArchive, DEFAULTS } from '../src/services/archive.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const num = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};

const returnedKeepDays = num('--returned-days', DEFAULTS.returnedKeepDays);
const archivedKeepDays = num('--archived-days', DEFAULTS.archivedKeepDays);

const DB_PATH = resolve(process.env.DATABASE_PATH || './data/xiangfind.db');
const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || './uploads');

if (!existsSync(DB_PATH)) {
  console.error(`数据库不存在：${DB_PATH}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const out = runArchive(db, { returnedKeepDays, archivedKeepDays, dryRun: !apply });

console.log(`数据保留策略：已归还保留 ${out.returnedKeepDays} 天，归档保留 ${out.archivedKeepDays} 天`);
console.log(`  已归还截止：${out.returnedCutoff}`);
console.log(`  归档截止  ：${out.archivedCutoff}`);
console.log('');
console.log(`待归档（returned → archived）：${out.toArchive.length} 条`);
out.toArchive.slice(0, 10).forEach((i) => console.log(`  · ${i.id}  ${i.title}  (${i.returned_at || i.updated_at})`));
if (out.toArchive.length > 10) console.log(`  … 还有 ${out.toArchive.length - 10} 条`);

console.log(`待清除（archived → 删除）：${out.toPurge.length} 条`);
out.toPurge.slice(0, 10).forEach((i) => console.log(`  · ${i.id}  ${i.title}  (${i.archived_at || i.updated_at})`));
if (out.toPurge.length > 10) console.log(`  … 还有 ${out.toPurge.length - 10} 条`);

if (out.dryRun) {
  console.log('');
  console.log('这是预演，什么都没改。要真执行：node scripts/archive.mjs --apply');
  db.close();
  process.exit(0);
}

// 清除数据库记录后再删图片文件（先删库，避免留下"有记录没文件"的空壳）
let removedFiles = 0;
for (const f of out.purgedFiles) {
  const p = join(UPLOAD_DIR, f.replace(/[^A-Za-z0-9._-]/g, ''));
  if (existsSync(p)) {
    try { unlinkSync(p); removedFiles += 1; } catch { /* 忽略单个文件失败 */ }
  }
}

console.log('');
console.log(`已归档 ${out.archived} 条，已清除 ${out.purged} 条，删除图片 ${removedFiles} 个`);
console.log('ARCHIVE_OK');
db.close();
