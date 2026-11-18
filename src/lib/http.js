// HTTP 小工具：JSON 响应、请求体解析、Cookie
const MAX_BODY = 1024 * 1024; // 1 MB

export function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

export function fail(res, status, code, message) {
  return json(res, status, { error: { code, message } });
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const err = new Error('body_too_large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('invalid_json');
    err.status = 400;
    throw err;
  }
}

export function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// 收集 Set-Cookie，调用方最后用 flushCookies 一次性写出
export function addCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) parts.push('Secure');

  res._cookies = res._cookies || [];
  res._cookies.push(parts.join('; '));

  // 同一请求里写多个 Cookie 时合并成一个头
  if (!res._cookiesFlushed) {
    res._cookiesFlushed = true;
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, headers) => {
      const merged = { ...(headers || {}) };
      merged['set-cookie'] = res._cookies;
      return origWriteHead(status, merged);
    };
  }
}

export function clearCookie(res, name) {
  addCookie(res, name, '', { maxAge: 0 });
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || '0.0.0.0';
}
