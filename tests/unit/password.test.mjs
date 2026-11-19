// 密码与 ID 单元测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';
import { makeId, ID, nowIso } from '../../src/lib/id.js';

test('同一密码两次哈希结果不同（盐不同）', () => {
  const a = hashPassword('demo1234');
  const b = hashPassword('demo1234');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$/);
});

test('正确密码可通过校验', () => {
  const h = hashPassword('demo1234');
  assert.equal(verifyPassword('demo1234', h), true);
});

test('错误密码被拒', () => {
  const h = hashPassword('demo1234');
  assert.equal(verifyPassword('demo12345', h), false);
  assert.equal(verifyPassword('', h), false);
});

test('篡改过的哈希不会抛异常，只返回 false', () => {
  assert.equal(verifyPassword('demo1234', 'garbage'), false);
  assert.equal(verifyPassword('demo1234', ''), false);
  assert.equal(verifyPassword('demo1234', 'scrypt$1$2$3$bad$bad'), false);
});

test('哈希里不含明文密码', () => {
  const h = hashPassword('supersecret123');
  assert.ok(!h.includes('supersecret123'));
});

test('makeId 带前缀且足够随机', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(makeId('itm'));
  assert.equal(ids.size, 200, '200 次生成不应重复');
  const one = makeId('itm');
  assert.match(one, /^itm_[A-Za-z0-9_-]+$/);
});

test('各业务前缀正确', () => {
  assert.match(ID.user(), /^usr_/);
  assert.match(ID.item(), /^itm_/);
  assert.match(ID.claim(), /^clm_/);
  assert.match(ID.message(), /^msg_/);
  assert.match(ID.point(), /^stp_/);
  assert.match(ID.image(), /^img_/);
});

test('ID 可能包含 - 或 _（路由必须允许这两个字符）', () => {
  // base64url 字母表含 - 和 _，历史上曾因正则只允许 [A-Za-z0-9_] 导致 1/3 概率 404
  const sample = Array.from({ length: 500 }, () => ID.item());
  const hasUrlSafeChar = sample.some((s) => /[-_]/.test(s.slice(4)));
  assert.equal(hasUrlSafeChar, true, '500 个 ID 里应出现 - 或 _');
});

test('nowIso 返回 UTC ISO 8601', () => {
  const s = nowIso();
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(s) - Date.now()) < 5000);
});
