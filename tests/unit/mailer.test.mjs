// 邮件正文与上传上限的单元测试（配置项是否真的生效）
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerificationText } from '../../src/lib/mailer.js';

test('验证码邮件包含验证码与有效期', () => {
  delete process.env.PUBLIC_BASE_URL;
  const { title, text } = buildVerificationText('123456', 'verify');
  assert.equal(title, '邮箱验证码');
  assert.match(text, /123456/);
  assert.match(text, /15 分钟/);
});

test('重置密码邮件标题不同', () => {
  const { title, text } = buildVerificationText('654321', 'reset');
  assert.equal(title, '重设密码验证码');
  assert.match(text, /654321/);
});

test('没配 PUBLIC_BASE_URL 时不带链接', () => {
  delete process.env.PUBLIC_BASE_URL;
  const { text } = buildVerificationText('111111');
  assert.ok(!text.includes('访问湘寻'), text);
  assert.ok(!/https?:\/\//.test(text), text);
});

test('配了 PUBLIC_BASE_URL 时正文带站点链接', () => {
  process.env.PUBLIC_BASE_URL = 'https://xiangfind.example.com';
  const { text } = buildVerificationText('222222');
  assert.match(text, /访问湘寻：https:\/\/xiangfind\.example\.com/, text);
});

test('PUBLIC_BASE_URL 末尾斜杠被去掉', () => {
  process.env.PUBLIC_BASE_URL = 'https://xiangfind.example.com/';
  const { text } = buildVerificationText('333333');
  assert.ok(text.includes('https://xiangfind.example.com\n') || text.endsWith('https://xiangfind.example.com'), text);
  assert.ok(!text.includes('example.com//'), text);
});

test('PUBLIC_BASE_URL 不是 http(s) 时不带链接（防止 localhost 之类写错）', () => {
  process.env.PUBLIC_BASE_URL = 'localhost:3000';
  const { text } = buildVerificationText('444444');
  assert.ok(!text.includes('访问湘寻'), text);
});
