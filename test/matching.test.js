import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidates, checkConditions } from '../src/matching.js';

const ent = (id, over = {}) => ({
  id,
  legalName: id,
  groupId: '',
  languages: ['中文'],
  capabilities: [],
  status: 'active',
  ...over,
});

const supply = (over = {}) => ({
  id: 'SD-S1',
  enterpriseId: 'E-S',
  kind: 'supply',
  industry: '电子',
  capabilities: ['电子元器件'],
  needs: [],
  conditions: {},
  attributes: { monthlyCapacity: 8000, certifications: ['ISO9001'] },
  languages: null,
  slots: ['T1', 'T2'],
  version: 1,
  ...over,
});

const demand = (over = {}) => ({
  id: 'SD-D1',
  enterpriseId: 'E-D',
  kind: 'demand',
  industry: '电子',
  capabilities: [],
  needs: ['电子元器件'],
  conditions: { minMonthlyCapacity: 5000, certifications: ['ISO9001'] },
  attributes: {},
  languages: null,
  slots: ['T2', 'T3'],
  version: 1,
  ...over,
});

function run({ supplies, demands, enterprises, exclusions = [], collectRejections = true }) {
  return generateCandidates({
    supplies,
    demands,
    enterprisesById: new Map(enterprises.map((e) => [e.id, e])),
    exclusions,
    collectRejections,
  });
}

test('需求条件支持数值下限、数组具备与标量相等', () => {
  const attrs = { monthlyCapacity: 8000, certifications: ['ISO9001', 'ISO14001'], deliveryRegion: '华南' };
  const { satisfied, failures } = checkConditions(
    { minMonthlyCapacity: 5000, certifications: ['ISO9001'], deliveryRegion: '华南' },
    attrs,
  );
  assert.equal(failures.length, 0);
  assert.equal(satisfied.length, 3);

  const bad = checkConditions(
    { minMonthlyCapacity: 9000, certifications: ['ISO9001', 'IATF16949'], deliveryRegion: '华北' },
    attrs,
  );
  assert.equal(bad.failures.length, 3);
});

test('命中的候选附带行业、能力、条件、语言、时段五类理由', () => {
  const { candidates } = run({
    supplies: [supply()],
    demands: [demand()],
    enterprises: [ent('E-S', { languages: ['中文', '英语'] }), ent('E-D', { languages: ['中文'] })],
  });
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.deepEqual(c.commonSlots, ['T2']);
  assert.deepEqual(c.commonLanguages, ['中文']);
  assert.ok(c.reasons.some((r) => r.startsWith('同行业')));
  assert.ok(c.reasons.some((r) => r.includes('供应能力')));
  assert.ok(c.reasons.some((r) => r.startsWith('需求条件满足')));
  assert.ok(c.reasons.some((r) => r.startsWith('共同语言')));
  assert.ok(c.reasons.some((r) => r.startsWith('共同可用时段')));
  assert.ok(c.score > 0);
});

test('禁配关系与同一集团被排除并记录原因', () => {
  const base = {
    supplies: [supply()],
    demands: [demand()],
    collectRejections: true,
  };
  const byExclusion = run({
    ...base,
    enterprises: [ent('E-S'), ent('E-D')],
    exclusions: [{ a: 'E-S', b: 'E-D', reason: '历史纠纷未决' }],
  });
  assert.equal(byExclusion.candidates.length, 0);
  assert.equal(byExclusion.rejectionSummary['禁配关系：历史纠纷未决'], 1);

  const byGroup = run({
    ...base,
    enterprises: [ent('E-S', { groupId: 'G1' }), ent('E-D', { groupId: 'G1' })],
  });
  assert.equal(byGroup.candidates.length, 0);
  assert.equal(byGroup.rejectionSummary['同一集团'], 1);
});

test('无共同语言、无共同时段、条件不满足分别给出排除原因', () => {
  const noLang = run({
    supplies: [supply()],
    demands: [demand()],
    enterprises: [ent('E-S', { languages: ['英语'] }), ent('E-D', { languages: ['越南语'] })],
  });
  assert.equal(noLang.rejectionSummary['无共同语言'], 1);

  const noSlot = run({
    supplies: [supply({ slots: ['T1'] })],
    demands: [demand({ slots: ['T9'] })],
    enterprises: [ent('E-S'), ent('E-D')],
  });
  assert.equal(noSlot.rejectionSummary['无共同可用时段'], 1);

  const badCond = run({
    supplies: [supply({ attributes: { monthlyCapacity: 3000, certifications: ['ISO9001'] } })],
    demands: [demand()],
    enterprises: [ent('E-S'), ent('E-D')],
  });
  assert.equal(Object.keys(badCond.rejectionSummary).filter((k) => k.startsWith('需求条件不满足')).length, 1);
});

test('候选按得分降序排列，能力重合度高者靠前', () => {
  const { candidates } = run({
    supplies: [supply()],
    demands: [
      demand({ id: 'SD-D-LOW', enterpriseId: 'E-D1', needs: ['电子元器件', '贴片加工', '注塑'] }),
      demand({ id: 'SD-D-HIGH', enterpriseId: 'E-D2', needs: ['电子元器件'] }),
    ],
    enterprises: [ent('E-S'), ent('E-D1'), ent('E-D2')],
  });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].demandRecordId, 'SD-D-HIGH');
  assert.ok(candidates[0].score > candidates[1].score);
});
