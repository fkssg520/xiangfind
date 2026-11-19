// 匹配评分单元测试（纯函数，不需要数据库）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokens, scorePair, THRESHOLD_CANDIDATE, THRESHOLD_NOTIFY,
} from '../../src/services/matching.js';

const base = {
  type: 'lost', category: '电子产品', title: '白色蓝牙耳机', description: '充电盒有划痕',
  location: '图书馆三楼自习区', event_at: '2026-11-16T02:00:00.000Z', value_level: 'normal',
};

test('tokens：中文切二元组并去停用词', () => {
  const t = tokens('白色耳机');
  assert.ok(t.has('白色'));
  assert.ok(t.has('色耳'));
  assert.ok(t.has('耳机'));
});

test('tokens：英文与数字按整词', () => {
  const t = tokens('iPhone 15 充电盒');
  assert.ok(t.has('iphone'));
  assert.ok(t.has('15'));
});

test('tokens：停用二元组被过滤', () => {
  const t = tokens('东西');
  assert.equal(t.size, 0, '「东西」属于停用词');
});

test('完全一致的两条得满分', () => {
  const found = { ...base, type: 'found' };
  const { score, reasons } = scorePair(base, found);
  assert.equal(score, 100);
  assert.deepEqual(reasons, ['分类一致', '地点相同', '时间接近', '描述关键词重合', '保管等级一致']);
});

test('分类不同只丢 25 分', () => {
  const found = { ...base, type: 'found', category: '其他' };
  const { score, reasons } = scorePair(base, found);
  assert.equal(score, 75);
  assert.ok(!reasons.includes('分类一致'));
});

test('地点相近（关键词重合）得 12 分', () => {
  const found = { ...base, type: 'found', location: '图书馆一楼大厅' };
  const { reasons } = scorePair(base, found);
  assert.ok(reasons.includes('地点相近'), JSON.stringify(reasons));
});

test('地点完全不同不给地点分', () => {
  const found = { ...base, type: 'found', location: '体育馆南门' };
  const { reasons } = scorePair(base, found);
  assert.ok(!reasons.includes('地点相同'));
  assert.ok(!reasons.includes('地点相近'));
});

test('时间缺失记 0 分并标注（D-003）', () => {
  const found = { ...base, type: 'found', event_at: null };
  const { score, reasons } = scorePair(base, found);
  assert.equal(score, 80);
  assert.ok(reasons.some((r) => r.includes('时间未知')));
});

test('时间差 2 小时内给 20，24 小时内给 15，72 小时内给 8', () => {
  const mk = (h) => ({ ...base, type: 'found', event_at: new Date(Date.parse(base.event_at) + h * 3600e3).toISOString() });
  assert.equal(scorePair(base, mk(1)).score, 100);
  assert.equal(scorePair(base, mk(10)).score, 95);
  assert.equal(scorePair(base, mk(50)).score, 88);
  assert.equal(scorePair(base, mk(100)).score, 80);
});

test('贵重等级不一致丢 10 分', () => {
  const found = { ...base, type: 'found', value_level: 'valuable' };
  const { score, reasons } = scorePair(base, found);
  assert.equal(score, 90);
  assert.ok(!reasons.includes('保管等级一致'));
});

test('阈值常量符合计划书', () => {
  assert.equal(THRESHOLD_CANDIDATE, 45);
  assert.equal(THRESHOLD_NOTIFY, 70);
});
