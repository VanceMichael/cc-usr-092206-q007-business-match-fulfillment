import test from 'node:test';
import assert from 'node:assert/strict';
import { OrganizationRegistry, ContactBook, normalizeName, nameSimilarity } from '../src/identity.js';

test('同一税号的不同录入合并为一个主体', () => {
  const reg = new OrganizationRegistry();
  const first = reg.register({
    name: '广西示例机械有限公司',
    taxId: '91450100MA5KEXAMPLE1',
    region: '广西南宁',
    capabilities: [{ product: '液压件', industry: '机械制造' }],
    sourceRef: '报名表A',
  });
  const second = reg.register({
    name: '广西示例机械有限公司（南宁）',
    taxId: '91450100ma5kexample1', // 大小写差异
    region: '广西南宁',
    capabilities: [{ product: '密封件', industry: '机械制造' }],
    sourceRef: '供需表B',
  });
  assert.equal(second.merged, true);
  assert.equal(second.org.id, first.org.id);
  assert.deepEqual(
    second.org.capabilities.map((c) => c.product).sort(),
    ['密封件', '液压件'],
  );
  assert.deepEqual(second.org.sourceRefs, ['报名表A', '供需表B']);
});

test('规范化名称一致视为同一主体', () => {
  const reg = new OrganizationRegistry();
  const a = reg.register({ name: '河内 示例 贸易 公司', region: '河内' });
  const b = reg.register({ name: '河内示例贸易公司', region: '河内' });
  assert.equal(b.merged, true);
  assert.equal(reg.stats.organizationCount, 1);
});

test('高相似度同地区名称挂起人工确认而不自动合并', () => {
  const reg = new OrganizationRegistry();
  const a = reg.register({ name: '示例食品加工厂', region: '曼谷' });
  const b = reg.register({ name: '示例食品加工公司', region: '曼谷' });
  assert.equal(b.merged, false);
  assert.ok(b.pending);
  assert.equal(reg.stats.pendingMergeCount, 1);

  // 秘书处确认后合并
  const keeper = reg.confirmMerge(b.org.id, a.org.id);
  assert.equal(keeper.id, a.org.id);
  assert.equal(reg.stats.organizationCount, 1);
  assert.equal(reg.stats.pendingMergeCount, 0);
});

test('名称相似度函数行为', () => {
  assert.equal(normalizeName('ＡＢＣ （中国） 公司'), 'abc(中国)公司');
  assert.ok(nameSimilarity('示例食品加工厂', '示例食品加工公司') > 0.8);
  assert.ok(nameSimilarity('东盟水果进出口', '北欧机械设备') < 0.3);
});

test('授权联系人：范围、有效期与更换', () => {
  const book = new ContactBook({ today: '2026-01-15' });
  const c1 = book.authorize('org-1', {
    name: '陈示例',
    scope: ['meeting'],
    languages: ['zh', 'en'],
    validUntil: '2026-12-31',
  });
  assert.ok(book.hasAuthorized('org-1', 'meeting'));
  assert.ok(!book.hasAuthorized('org-1', 'fulfillment'));

  // 查询时点晚于授权截止日 → 找不到；有效期内 admin 授权者优先
  const short = book.authorize('org-1', {
    name: '短期代表',
    scope: ['meeting', 'admin'],
    validFrom: '2026-01-01',
    validUntil: '2026-06-30',
  });
  assert.equal(book.findAuthorized('org-1', 'meeting', { at: '2026-08-01' }).id, c1.id);
  assert.equal(book.findAuthorized('org-1', 'meeting', { at: '2026-03-01' }).id, short.id);

  // 代表更换：旧代表失效，新代表继承授权范围
  const successor = book.replace('org-1', c1.id, { name: '林替任' });
  assert.equal(book.get(c1.id).active, false);
  assert.equal(book.get(c1.id).replacedBy, successor.id);
  assert.deepEqual(successor.scope, ['meeting']);
  assert.deepEqual(successor.languages, ['zh', 'en']);
  // 在短期代表已过期、原代表已更换的时点，只有继任者可用
  assert.equal(book.findAuthorized('org-1', 'meeting', { at: '2026-09-27' }).id, successor.id);

  // 过期授权不能新增
  assert.throws(
    () => book.authorize('org-1', { name: '无效', validUntil: '2020-01-01' }),
    /有效期已过/,
  );
});
