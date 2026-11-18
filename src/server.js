// 湘寻 · 服务入口（零依赖）
// 当前仅提供静态文件与 /health，用于验证环境；业务接口在后续阶段加入 src/routes/。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);

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
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (path === '/health') {
    return json(res, 200, {
      status: 'ok',
      service: 'xiangfind',
      version: '0.1.0',
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
  }

  if (path.startsWith('/api/')) {
    return json(res, 404, { error: 'not_implemented', path });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'method_not_allowed' });
  }

  return serveStatic(res, path);
});

server.listen(PORT, () => {
  console.log(`湘寻已启动 → http://localhost:${PORT}`);
  console.log(`健康检查   → http://localhost:${PORT}/health`);
  if (!existsSync(join(PUBLIC_DIR, 'index.html'))) {
    console.log('提示：public/index.html 尚未创建（由 agent-b 负责前端）。');
  }
});
