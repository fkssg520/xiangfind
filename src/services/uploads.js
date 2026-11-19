// 图片上传：真实类型校验（magic bytes）、大小与数量限制、随机文件名
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { randomBytes } from 'node:crypto';

// 5MB 默认；可用 MAX_UPLOAD_MB 覆盖（.env.example 里一直写着，之前没接线）
export const MAX_MB = Number(process.env.MAX_UPLOAD_MB) > 0 ? Number(process.env.MAX_UPLOAD_MB) : 5;
export const MAX_BYTES = MAX_MB * 1024 * 1024;
export const MAX_FILES = 3;
export const MAX_PER_ITEM = 3;

const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || './uploads');

// 只认这三种，且以文件头为准，不看扩展名与 Content-Type
export function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: '.png' };
  }
  // WebP: 'RIFF' .... 'WEBP'
  if (
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: '.webp' };
  }
  return null;
}

export function ensureUploadDir() {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

export function uploadsDir() {
  return UPLOAD_DIR;
}

// 校验并落盘，返回 { fileName, mimeType, size }
export function saveUpload(buffer, declaredName = '') {
  if (!buffer || buffer.length === 0) {
    return { error: { code: 'empty', message: '文件为空' } };
  }
  if (buffer.length > MAX_BYTES) {
    return { error: { code: 'too_large', message: `单张图片不能超过 ${MAX_BYTES / 1024 / 1024}MB` } };
  }

  const type = detectImageType(buffer);
  if (!type) {
    return { error: { code: 'bad_type', message: '只允许 JPEG、PNG、WebP 图片（按文件头判断）' } };
  }

  // 扩展名可以骗人，最终用检测出的类型决定落盘扩展名
  const declaredExt = extname(String(declaredName || '')).toLowerCase();
  if (declaredExt && ['.jpg', '.jpeg', '.png', '.webp'].includes(declaredExt)) {
    const ok = (declaredExt === '.png' && type.ext === '.png')
      || (declaredExt === '.webp' && type.ext === '.webp')
      || ((declaredExt === '.jpg' || declaredExt === '.jpeg') && type.ext === '.jpg');
    if (!ok) {
      return { error: { code: 'ext_mismatch', message: '文件扩展名与实际格式不一致' } };
    }
  }

  ensureUploadDir();
  const fileName = `${randomBytes(12).toString('hex')}${type.ext}`;
  writeFileSync(join(UPLOAD_DIR, fileName), buffer);
  return { fileName, mimeType: type.mime, size: buffer.length };
}

// 预校验：在插入物品之前就确认图片都存在，避免留下"无图孤儿记录"
export function assertImagesExist(fileNames) {
  const list = Array.isArray(fileNames) ? fileNames : [];
  if (list.length > MAX_PER_ITEM) {
    return { error: { code: 'too_many', message: `最多 ${MAX_PER_ITEM} 张图片` } };
  }
  for (const name of list) {
    const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '');
    if (!safe || !existsSync(join(UPLOAD_DIR, safe))) {
      return { error: { code: 'image_missing', message: `图片不存在：${safe || name}` } };
    }
  }
  return { ok: true };
}

// 把已上传的文件挂到物品上（创建/编辑物品时调用）
export function attachImages(db, itemId, fileNames, idFactory) {
  const list = Array.isArray(fileNames) ? fileNames.slice(0, MAX_PER_ITEM) : [];
  if (list.length > MAX_PER_ITEM) {
    return { error: { code: 'too_many', message: `最多 ${MAX_PER_ITEM} 张图片` } };
  }
  for (const name of list) {
    const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '');
    const full = join(UPLOAD_DIR, safe);
    if (!existsSync(full)) {
      return { error: { code: 'image_missing', message: `图片不存在：${safe}` } };
    }
    const info = statSync(full);
    const ext = extname(safe).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    db.prepare(
      `INSERT INTO item_images (id, item_id, file_name, mime_type, size, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(idFactory(), itemId, safe, mime, info.size, list.indexOf(name), new Date().toISOString());
  }
  return { ok: true, count: list.length };
}
