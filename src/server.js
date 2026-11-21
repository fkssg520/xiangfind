// 湘寻 · 服务入口
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, statfsSync } from 'node:fs';
import { loadDotEnv } from './lib/env.js';
// 测试/冒烟场景用 XF_NO_DOTENV=1 跳过 .env：
// 否则本地配好 SMTP 后，验证码会真发邮件而不是打在日志里，冒烟脚本就读不到码了。
if (!process.env.XF_NO_DOTENV) loadDotEnv();
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { handleApi } from './api/index.js';
import { ensureCsrf } from './lib/csrf.js';
import { uploadsDir, ensureUploadDir } from './services/uploads.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = resolve(process.env.DATABASE_PATH || './data/xiangfind.db');

// ---------- 数据库：启动时自动建表（可重复执行） ----------
mkdirSync(resolve(DB_PATH, '..'), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8'));
// 补列（与 migrate.js 保持一致，保证直接 npm start 也能拿到新字段）
try {
  const { ensureColumns } = await import('./db/evolve.js');
  ensureColumns(db);
} catch (err) {
  console.error('[db] 补列失败：', err.message);
}
const ctx = { db };
ensureUploadDir();

// 直接服务一个绝对路径文件（用于 uploads 目录）
async function serveFile(res, filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'public, max-age=86400',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function serveStatic(res, urlPath) {
  // 路径穿越防护：规范化后必须仍在 public 目录内
  // 注意：Windows 上 normalize('/') 返回 '\\'，不能只比较 '/'
  let rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  if (rel === '' || rel === '.' || rel === '/' || rel === '\\') {
    rel = 'index.html';
  }
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return json(res, 403, { error: 'forbidden' });
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      // 目录请求退回到该目录下的 index.html
      return serveStatic(res, urlPath.replace(/\/?$/, '/index.html'));
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    // 任何未预期异常都不能让进程退出
    console.error('[server] 未捕获异常：', err?.stack || err?.message || err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'internal', message: '服务端错误' } }));
    } else {
      res.end();
    }
  }
});

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (path === '/health') {
    // 只返回服务/数据库/磁盘状态，不暴露任何敏感信息
    let dbStatus = 'ok';
    let itemCount = null;
    try {
      itemCount = db.prepare('SELECT COUNT(*) AS c FROM items').get().c;
    } catch {
      dbStatus = 'error';
    }
    let diskFreeMB = null;
    try {
      const st = statfsSync(DB_PATH);
      diskFreeMB = Math.round((st.bavail * st.bsize) / 1024 / 1024);
    } catch {
      diskFreeMB = null;
    }
    return json(res, dbStatus === 'ok' ? 200 : 503, {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      service: 'xiangfind',
      version: '0.1.0',
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
      database: dbStatus,
      items: itemCount,
      diskFreeMB,
      uploads: existsSync(uploadsDir()) ? 'ok' : 'missing',
    });
  }

  // 业务接口
  if (path.startsWith('/api/')) {
    return handleApi(req, res, ctx);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'method_not_allowed' });
  }

  // 上传的图片：直接从 uploads 目录读（文件名已做白名单过滤）
  if (path.startsWith('/uploads/')) {
    const name = path.slice('/uploads/'.length).replace(/[^A-Za-z0-9._-]/g, '');
    if (!name) return json(res, 404, { error: 'not_found' });
    return serveFile(res, join(uploadsDir(), name));
  }

  // 每个页面请求都确保存在 CSRF Cookie，前端从 document.cookie 读出放进请求头
  ensureCsrf(req, res);
  return serveStatic(res, path);
}

server.listen(PORT, () => {
  console.log(`湘寻已启动 → http://localhost:${PORT}`);
  console.log(`健康检查   → http://localhost:${PORT}/health`);
  console.log(`数据库     → ${DB_PATH}`);
  if (!existsSync(join(PUBLIC_DIR, 'index.html'))) {
    console.log('提示：public/index.html 尚未创建（由 agent-b 负责前端）。');
  }
});
