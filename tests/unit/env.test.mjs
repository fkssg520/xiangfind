// .env 加载器的行为（J-3：配置写了但没生效是最难查的一类问题）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDotEnv } from '../../src/lib/env.js';

function tempEnv(content) {
  const dir = mkdtempSync(join(tmpdir(), 'xf-env-'));
  const p = join(dir, '.env');
  writeFileSync(p, content, 'utf8');
  return p;
}

test('读取基本键值并去掉引号', () => {
  const p = tempEnv('FOO_XF=bar\nBAZ_XF="quoted value"\n');
  loadDotEnv(p, { override: true });
  assert.equal(process.env.FOO_XF, 'bar');
  assert.equal(process.env.BAZ_XF, 'quoted value');
});

test('跳过注释与空行', () => {
  const p = tempEnv('# 注释\n\nA_XF=1\n   \nB_XF=2\n');
  loadDotEnv(p, { override: true });
  assert.equal(process.env.A_XF, '1');
  assert.equal(process.env.B_XF, '2');
});

test('默认不覆盖已存在的环境变量（命令行优先）', () => {
  process.env.KEEP_XF = 'from-shell';
  const p = tempEnv('KEEP_XF=from-file\n');
  loadDotEnv(p);
  assert.equal(process.env.KEEP_XF, 'from-shell', '已有值不应被 .env 覆盖');
});

test('override 为 true 时覆盖', () => {
  process.env.OVR_XF = 'old';
  const p = tempEnv('OVR_XF=new\n');
  loadDotEnv(p, { override: true });
  assert.equal(process.env.OVR_XF, 'new');
});

test('文件不存在时安全返回', () => {
  const out = loadDotEnv(join(tmpdir(), 'xf-not-exists-' + Date.now() + '.env'));
  assert.equal(out.loaded, false);
  assert.equal(out.count, 0);
});

test('值里含等号时保留等号右侧全部内容', () => {
  const p = tempEnv('URL_XF=https://x.test/?a=1&b=2\n');
  loadDotEnv(p, { override: true });
  assert.equal(process.env.URL_XF, 'https://x.test/?a=1&b=2');
});
