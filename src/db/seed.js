// 演示数据初始化（幂等）
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { seedDemo, DEMO_PASSWORD } from './demo.js';

const DB_PATH = resolve(process.env.DATABASE_PATH || './data/xiangfind.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const counts = seedDemo(db);

console.log('演示数据就绪：');
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(10)} ${v}`);
console.log(`  演示账号：20230001 / ${DEMO_PASSWORD}（学生）、20230002（志愿者）、90000001（管理员）`);
db.close();