import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatform } from '../src/platform.js';

// 规模测试：峰会沉淀 4700+ 供需信息后，匹配、排程与视图仍可在合理时间内运营。
// 数据按 20 个行业对接会分布，贴近真实峰会的行业分场。
test('规模：4700+ 供需信息的匹配与排程可快速完成', () => {
  let t = Date.parse('2026-10-12T08:00:00+08:00');
  const platform = createPlatform({ clock: () => new Date((t += 1000)).toISOString() });

  const INDUSTRIES = Array.from({ length: 20 }, (_, i) => `行业${i}`);
  const capsOf = (industry) => [`${industry}-能力A`, `${industry}-能力B`, `${industry}-能力C`, `${industry}-能力D`];

  for (let i = 0; i < 2400; i += 1) {
    const industry = INDUSTRIES[i % INDUSTRIES.length];
    const caps = capsOf(industry);
    const { enterprise } = platform.registry.registerEnterprise({
      legalName: `示例供方企业${String(i).padStart(4, '0')}有限公司`,
      industry,
      languages: i % 7 === 0 ? ['英语'] : ['中文', '英语'],
    });
    platform.registry.registerContact({
      enterpriseId: enterprise.id, name: `代表${i}`,
      scopes: ['confirm_meeting', 'update_demand', 'sign_intent', 'share_confidential'],
    });
    platform.records.add({
      enterpriseId: enterprise.id,
      kind: 'supply',
      industry,
      capabilities: [caps[i % 4], caps[(i + 1) % 4]],
      attributes: { monthlyCapacity: 3000 + (i % 10) * 1000 },
      slots: [`T${(i % 6) + 1}`],
    });
  }

  for (let i = 0; i < 2300; i += 1) {
    const industry = INDUSTRIES[i % INDUSTRIES.length];
    const caps = capsOf(industry);
    const { enterprise } = platform.registry.registerEnterprise({
      legalName: `示例需方企业${String(i).padStart(4, '0')}有限公司`,
      industry,
      languages: ['中文'],
    });
    platform.registry.registerContact({
      enterpriseId: enterprise.id, name: `买手${i}`,
      scopes: ['confirm_meeting', 'update_demand', 'sign_intent', 'share_confidential'],
    });
    platform.records.add({
      enterpriseId: enterprise.id,
      kind: 'demand',
      industry,
      needs: [caps[i % 4]],
      conditions: { minMonthlyCapacity: 5000 },
      slots: [`T${(i % 4) + 1}`],
    });
  }

  assert.ok(platform.records.list().length >= 4700);

  const started = Date.now();
  const { candidates, rejectionSummary } = platform.runMatching();
  const elapsed = Date.now() - started;

  assert.ok(candidates.length > 0, '应产生大量候选');
  assert.ok(elapsed < 2000, `匹配应在 2 秒内完成，实际 ${elapsed}ms`);
  for (const c of candidates) {
    assert.ok(c.reasons.length >= 3, '每个候选都带理由');
    assert.ok(c.commonSlots.length >= 1);
    assert.ok(c.commonLanguages.includes('中文'));
  }
  assert.ok(Object.keys(rejectionSummary).some((k) => k.includes('无共同语言')));

  // 取前 100 条候选走双方确认排程，席位占用数等于成功排定数。
  for (let i = 0; i < 6; i += 1) platform.scheduler.addSeat({ room: `洽谈室${i + 1}`, slots: ['T1', 'T2', 'T3', 'T4'] });
  let scheduled = 0;
  for (const c of candidates.slice(0, 100)) {
    const supplierContact = platform.registry.listContacts(c.supplierEnterpriseId)[0];
    const demanderContact = platform.registry.listContacts(c.demanderEnterpriseId)[0];
    const slot = c.commonSlots[0];
    try {
      const m = platform.proposeMeeting(c.id, slot, {
        supplierContactId: supplierContact.id,
        demanderContactId: demanderContact.id,
      });
      platform.confirmMeeting(m.id, c.supplierEnterpriseId, supplierContact.id);
      platform.confirmMeeting(m.id, c.demanderEnterpriseId, demanderContact.id);
      if (platform.scheduler.getMeeting(m.id).status === 'scheduled') scheduled += 1;
    } catch {
      // 同企业同时段冲突导致的释放属于预期，跳过继续。
    }
  }
  assert.equal(platform.scheduler.seatUtilization().booked, scheduled);
  assert.ok(scheduled > 0);
});
