// 极简 .env 加载器（零依赖）
// 为什么需要：`npm start` 直接跑 node src/server.js，不会自动读 .env。
// 2026-11-21 发现：把 SMTP 配进 .env 后，服务端仍然走"验证码打日志"分支——
// 因为没人把 .env 读进 process.env。这类"配置写了但没生效"的问题极难在运行时发现。
//
// 规则：已存在的环境变量优先（允许命令行/容器覆盖 .env）；值两侧引号会被去掉。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadDotEnv(filePath = resolve('.env'), { override = false } = {}) {
  if (!existsSync(filePath)) return { loaded: false, count: 0 };

  let count = 0;
  const text = readFileSync(filePath, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].replace(/^["']|["']$/g, '').trim();
    if (!override && process.env[key] !== undefined && process.env[key] !== '') continue;
    process.env[key] = value;
    count += 1;
  }
  return { loaded: true, count };
}
