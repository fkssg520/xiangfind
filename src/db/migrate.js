// 建库：可重复执行
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { nowIso } from '../lib/id.js';

const DB_PATH = resolve(process.env.DATABASE_PATH || './data/xiangfind.db');
const VERSION = '001_init';

mkdirSync(dirname(DB_PATH), { recursive: true });

const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const db = new DatabaseSync(DB_PATH);

db.exec(sql);
db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
  .run(VERSION, nowIso());

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

const indexes = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
  .all()
  .map((r) => r.name);

console.log(`数据库: ${DB_PATH}`);
console.log(`表 (${tables.length}): ${tables.join(', ')}`);
console.log(`索引 (${indexes.length}): ${indexes.join(', ')}`);
db.close();
