import test from 'node:test';
import assert from 'node:assert/strict';
import { OrganizationRegistry, ContactBook } from '../src/identity.js';
import { EmbargoRegistry, evaluateMatch, recommendForDemand } from '../src/matching.js';

function buyerFixture(overrides = {}) {
  return {
    id: 'buyer',
    name: '境内采购企业',
    region: '广西',
    languages: ['zh', 'en'],
    embargoRegions: [],
    availability: [
      { day: 1, start: 540, end: 720 }, // 周一 09:00-12:00
      { day: 3, start: 540, end: 660 },
    ],
    demands: [
      {
        id: 'd1',
        product: '榴莲',
        industry: '水果进口',
        targetRegions: ['泰国'],
        requiredCertifications: ['GACC'],
        minQuantity: 1000,
        maxUnitPrice: 50,
      },
    ],
    ...overrides,
  };
}

function supplierFixture(overrides = {}) {
  return {
    id: 'supplier',
    name: '泰国水果出口商',
    region: '泰国',
    languages: ['th', 'en'],
    embargoRegions: [],
    availability: [{ day: 1, start: 600, end: 780 }], // 周一 10:00-13:00 与买方有交集
    capabilities: [
      {
        product: '榴莲',
        industry: '水果进口',
        regions: ['泰国', '中国'],
        certifications: ['GACC'],
        annualCapacity: 2000,
        unitPrice: 42,
      },
    ],
    ...overrides,
  };
}

test('完全匹配的候选通过全部门槛并给出逐因素理由', () => {
  const buyer = buyerFixture();
  const supplier = supplierFixture();
  const result = evaluateMatch({ demand: buyer.demands[0], buyer, supplier, embargo: new EmbargoRegistry() });
  assert.equal(result.eligible, true);
  assert.ok(result.score >= 70, `分数应较高，实际 ${result.score}`);
  const factors = result.reasons.map((r) => r.factor);
  assert.ok(factors.includes('行业'));
  assert.ok(factors.includes('语言'));
  assert.ok(factors.includes('时段'));
  assert.ok(factors.includes('产能'));
  assert.ok(factors.includes('区域'));
  assert.deepEqual(result.commonLanguages, ['en']);
  assert.equal(result.overlaps.length, 1);
});

test('禁配主体对直接拒绝并给出原因', () => {
  const embargo = new EmbargoRegistry();
  embargo.forbidPair('buyer', 'supplier', '合规调查未结');
  const buyer = buyerFixture();
  const result = evaluateMatch({ demand: buyer.demands[0], buyer, supplier: supplierFixture(), embargo });
  assert.equal(result.eligible, false);
  assert.ok(result.rejections.some((r) => r.code === 'forbidden-pair' && r.detail.includes('合规调查未结')));
});

test('企业自报禁运区域生效', () => {
  const buyer = buyerFixture({ embargoRegions: ['泰国'] });
  const result = evaluateMatch({ demand: buyer.demands[0], buyer, supplier: supplierFixture(), embargo: new EmbargoRegistry() });
  assert.equal(result.eligible, false);
  assert.ok(result.rejections.some((r) => r.code === 'buyer-region-embargo'));
});

test('缺少资质、产能不足、超预算分别拒绝', () => {
  const buyer = buyerFixture();
  const noCert = supplierFixture({
    capabilities: [{ product: '榴莲', industry: '水果进口', regions: ['泰国'], certifications: [], annualCapacity: 2000, unitPrice: 42 }],
  });
  let r = evaluateMatch({ demand: buyer.demands[0], buyer, supplier: noCert, embargo: new EmbargoRegistry() });
  assert.ok(r.rejections.some((x) => x.code === 'missing-certification'));

  const lowCap = supplierFixture({
    capabilities: [{ product: '榴莲', industry: '水果进口', regions: ['泰国'], certifications: ['GACC'], annualCapacity: 500, unitPrice: 42 }],
  });
  r = evaluateMatch({ demand: buyer.demands[0], buyer, supplier: lowCap, embargo: new EmbargoRegistry() });
  assert.ok(r.rejections.some((x) => x.code === 'capacity-shortfall'));

  const pricey = supplierFixture({
    capabilities: [{ product: '榴莲', industry: '水果进口', regions: ['泰国'], certifications: ['GACC'], annualCapacity: 2000, unitPrice: 80 }],
  });
  r = evaluateMatch({ demand: buyer.demands[0], buyer, supplier: pricey, embargo: new EmbargoRegistry() });
  assert.ok(r.rejections.some((x) => x.code === 'price-exceeds-budget'));
});

test('无共同语言或无时段交集时拒绝并解释', () => {
  const buyer = buyerFixture();
  const noLang = supplierFixture({ languages: ['th', 'km'] });
  let r = evaluateMatch({ demand: buyer.demands[0], buyer, supplier: noLang, embargo: new EmbargoRegistry() });
  assert.ok(r.rejections.some((x) => x.code === 'no-common-language'));

  const noSlot = supplierFixture({ availability: [{ day: 2, start: 540, end: 660 }] });
  r = evaluateMatch({ demand: buyer.demands[0], buyer, supplier: noSlot, embargo: new EmbargoRegistry() });
  assert.ok(r.rejections.some((x) => x.code === 'no-overlapping-slot'));
});

test('推荐清单按分数降序，合格与拒绝分开返回', () => {
  const registry = new OrganizationRegistry();
  registry.register(supplierFixture());
  registry.register(supplierFixture({
    id: 'supplier2',
    name: '马来西亚水果商',
    region: '马来西亚',
    languages: ['zh', 'en'],
    availability: [{ day: 1, start: 540, end: 720 }],
    capabilities: [{ product: '榴莲', industry: '水果进口', regions: ['马来西亚', '泰国'], certifications: ['GACC'], annualCapacity: 5000, unitPrice: 40 }],
  }));
  // 一家完全不相关的供应商
  registry.register({
    id: 'supplier3',
    name: '机械配件厂',
    region: '越南',
    languages: ['vi'],
    availability: [{ day: 1, start: 540, end: 600 }],
    capabilities: [{ product: '轴承', industry: '机械', annualCapacity: 100 }],
  });
  const buyer = buyerFixture();
  const rec = recommendForDemand({
    demand: buyer.demands[0],
    buyer,
    registry,
    embargo: new EmbargoRegistry(),
    contactBook: new ContactBook(),
  });
  assert.ok(rec.eligible.length >= 2);
  assert.ok(rec.eligible[0].score >= rec.eligible[1].score);
  assert.ok(rec.rejectedCount >= 1);
  assert.ok(rec.rejectedSample.some((c) => c.rejections.some((x) => x.code === 'no-capability')));
});

test('授权联系人的语言优先于企业登记语言参与判断', () => {
  const book = new ContactBook();
  book.authorize('buyer', { name: '采购代表', scope: ['match'], languages: ['zh'] });
  const buyer = buyerFixture({ languages: ['en'] });
  // 企业层面有共同英语，但代表只会中文；供应商企业会英语不会中文 → 拒绝
  const r = evaluateMatch({
    demand: buyer.demands[0],
    buyer,
    supplier: supplierFixture(),
    embargo: new EmbargoRegistry(),
    contactBook: book,
  });
  assert.ok(r.rejections.some((x) => x.code === 'no-common-language'));
});
