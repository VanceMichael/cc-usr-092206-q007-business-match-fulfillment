import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchPlatform, MEETING_STATUS, RELATION_STATUS } from '../src/platform.js';

// 构造一个最小可用平台：两家企业 + 一场活动 + 一个席位。
function buildPlatform() {
  const platform = new MatchPlatform({ clock: () => '2026-09-27T08:00:00Z' });
  platform.ingestOrganizations([
    {
      id: 'buyer-cn',
      name: '广西示例果业有限公司',
      taxId: '91450100BUYER00001',
      region: '广西南宁',
      industry: '水果进口',
      languages: ['zh', 'en'],
      availability: [{ day: 1, start: 540, end: 720 }],
      demands: [{
        id: 'd-durian',
        product: '榴莲',
        industry: '水果进口',
        targetRegions: ['泰国'],
        requiredCertifications: ['GACC'],
        minQuantity: 1000,
        maxUnitPrice: 50,
      }],
    },
    {
      id: 'supplier-th',
      name: '曼谷示例果品出口公司',
      taxId: 'TH0105558SUPPLIER',
      region: '泰国曼谷',
      industry: '水果出口',
      languages: ['th', 'en'],
      availability: [{ day: 1, start: 600, end: 720 }],
      capabilities: [{
        product: '榴莲',
        industry: '水果进口',
        regions: ['泰国', '中国'],
        certifications: ['GACC'],
        annualCapacity: 3000,
        unitPrice: 45,
      }],
    },
  ]);
  platform.authorizeContact('buyer-cn', { id: 'rep-buyer', name: '黄采购', scope: ['match', 'meeting', 'fulfillment'], languages: ['zh', 'en'] });
  platform.authorizeContact('supplier-th', { id: 'rep-supplier', name: 'Somchai', scope: ['match', 'meeting', 'fulfillment'], languages: ['th', 'en'] });
  platform.createActivity({ id: 'act-fruit', name: '水果行业一对一洽谈' });
  platform.addSeat({ activityId: 'act-fruit', label: '洽谈桌 1', date: '2026-10-01', start: '09:00', end: '10:00' });
  return platform;
}

test('端到端：导入→推荐→双方确认占座→会谈→履约→签约，主办方只见终态', () => {
  const platform = buildPlatform();

  // 1. 推荐：候选带理由
  const rec = platform.recommend('buyer-cn', 'd-durian');
  assert.equal(rec.eligible.length, 1);
  const top = rec.eligible[0];
  assert.equal(top.supplierId, 'supplier-th');
  assert.ok(top.score > 60);
  assert.ok(top.reasons.some((r) => r.factor === '语言'));
  assert.ok(top.reasons.some((r) => r.factor === '时段'));

  // 2. 提议：不占座
  const meeting = platform.proposeMeeting({
    activityId: 'act-fruit',
    buyerOrgId: 'buyer-cn',
    supplierOrgId: 'supplier-th',
    demandId: 'd-durian',
    date: '2026-10-01', start: '09:00', end: '09:30',
  });
  assert.equal(meeting.status, MEETING_STATUS.AWAITING);
  assert.equal(meeting.seatId, null);

  // 3. 单方确认仍不占座
  platform.confirmMeeting(meeting.id, 'rep-buyer');
  assert.equal(platform.scheduler.get(meeting.id).seatId, null);

  // 4. 双方确认 → 占座
  platform.confirmMeeting(meeting.id, 'rep-supplier');
  const confirmed = platform.scheduler.get(meeting.id);
  assert.equal(confirmed.status, MEETING_STATUS.CONFIRMED);
  assert.ok(confirmed.seatId);

  // 5. 会谈举行 → 自动建立合作关系
  const { relation } = platform.markMeetingHeld(meeting.id);
  assert.equal(relation.status, RELATION_STATUS.ACTIVE);

  // 6. 会后事项沿同一关系推进
  const minutes = platform.ledgerApi.addMatter(relation.id, {
    type: 'minutes', title: '洽谈纪要', content: '确认首批 1000 件试单',
    ownerContactId: 'rep-supplier', nextAction: '供方提供 GACC 证书扫描件', dueDate: '2026-10-08',
  }, 'rep-buyer');
  platform.ledgerApi.addMatter(relation.id, {
    type: 'intent', title: '采购意向', amount: 450000, currency: 'CNY',
    ownerContactId: 'rep-buyer', nextAction: '买方财务复核付款条款',
  }, 'rep-supplier');
  platform.ledgerApi.addMatter(relation.id, {
    type: 'policy', title: 'RCEP 关税减让咨询', ownerContactId: 'rep-buyer',
  }, 'rep-buyer');

  // 7. 企业视图：下一行动与责任人
  const entView = platform.enterpriseDashboard(relation.id, 'buyer-cn');
  assert.equal(entView.matters.length, 3);
  const minutesView = entView.matters.find((m) => m.id === minutes.id);
  assert.equal(minutesView.nextAction, '供方提供 GACC 证书扫描件');
  assert.equal(minutesView.owner.name, 'Somchai');

  // 8. 主办方视图：进行中看不到金额；签约后只见签约
  let orgView = platform.organizerDashboard();
  assert.equal(orgView[0].status, 'active');
  assert.ok(!('amount' in orgView[0]));

  platform.ledgerApi.sign(relation.id, 'rep-buyer', { contractRef: 'HT-2026-0901' });
  orgView = platform.organizerDashboard();
  assert.equal(orgView[0].status, 'signed');
  assert.equal(orgView[0].contractRef, 'HT-2026-0901');
});

test('端到端：代表临时更换触发资源恢复与重新确认', () => {
  const platform = buildPlatform();
  const meeting = platform.proposeMeeting({
    activityId: 'act-fruit', buyerOrgId: 'buyer-cn', supplierOrgId: 'supplier-th',
    demandId: 'd-durian', date: '2026-10-01', start: '09:00', end: '09:30',
  });
  platform.confirmMeeting(meeting.id, 'rep-buyer');
  platform.confirmMeeting(meeting.id, 'rep-supplier');
  assert.equal(platform.scheduler.get(meeting.id).status, MEETING_STATUS.CONFIRMED);
  platform.drainNotifications();

  // 买方代表临时更换
  const { successor, affectedMeetings } = platform.replaceRepresentative('buyer-cn', 'rep-buyer', {
    id: 'rep-buyer-2', name: '李接任', languages: ['zh', 'en'],
  });
  assert.deepEqual(affectedMeetings, [meeting.id]);
  const after = platform.scheduler.get(meeting.id);
  assert.equal(after.status, MEETING_STATUS.AWAITING);
  assert.equal(after.seatId, null); // 席位已释放
  assert.equal(after.buyer.contactId, successor.id);

  const notes = platform.drainNotifications();
  assert.ok(notes.some((n) => n.template === 'meeting_rep_changed'));

  // 新代表与对方重新确认后恢复占座
  platform.confirmMeeting(meeting.id, successor.id);
  platform.confirmMeeting(meeting.id, 'rep-supplier');
  assert.equal(platform.scheduler.get(meeting.id).status, MEETING_STATUS.CONFIRMED);
});

test('端到端：企业改需求使会谈失效并通知，主办方记录终止原因', () => {
  const platform = buildPlatform();
  const meeting = platform.proposeMeeting({
    activityId: 'act-fruit', buyerOrgId: 'buyer-cn', supplierOrgId: 'supplier-th',
    demandId: 'd-durian', date: '2026-10-01', start: '09:00', end: '09:30',
  });
  platform.confirmMeeting(meeting.id, 'rep-buyer');
  platform.confirmMeeting(meeting.id, 'rep-supplier');
  platform.drainNotifications();

  // 买方把最小采购量提高到超过供方产能 → 会谈失效、席位释放
  const { invalidatedMeetings } = platform.changeDemand('buyer-cn', 'd-durian', { minQuantity: 9000 }, '采购量上调至 9000，原配对产能不足');
  assert.deepEqual(invalidatedMeetings, [meeting.id]);
  assert.equal(platform.scheduler.get(meeting.id).status, MEETING_STATUS.INVALIDATED);
  assert.equal(platform.scheduler.get(meeting.id).seatId, null);

  const notes = platform.drainNotifications();
  assert.ok(notes.some((n) => n.template === 'meeting_ended' && n.vars.reason.includes('产能不足')));

  // 重新推荐时该供方因产能不足被拒绝，且理由可查
  const rec = platform.recommend('buyer-cn', 'd-durian');
  assert.equal(rec.eligible.length, 0);
  assert.ok(rec.rejectedSample[0].rejections.some((r) => r.code === 'capacity-shortfall'));
});

test('规模场景：4700 条供需记录导入去重，重复主体被识别', () => {
  const platform = new MatchPlatform({ clock: () => '2026-09-27T08:00:00Z' });
  const records = [];
  for (let i = 0; i < 4700; i++) {
    // 每 50 条重复一次同一税号（模拟多渠道重复录入）
    const taxSeq = Math.floor(i / 50);
    records.push({
      name: `示例企业${taxSeq}号`,
      taxId: `TAX${String(taxSeq).padStart(6, '0')}`,
      region: i % 2 ? '广西' : '泰国',
      sourceRef: `导入批次-${i}`,
      capabilities: [{ product: `产品${taxSeq % 20}`, industry: '综合' }],
      demands: [{ id: `d-${i}`, product: `产品${(taxSeq + 1) % 20}`, industry: '综合' }],
    });
  }
  const { organizations, merged } = platform.ingestOrganizations(records);
  assert.equal(organizations.length, 4700);
  // 4700 条记录 → 94 个唯一主体（4700/50）
  assert.equal(platform.registry.stats.organizationCount, 94);
  assert.equal(merged.length, 4700 - 94);
});

test('禁配关系在平台层面生效', () => {
  const platform = buildPlatform();
  platform.embargo.forbidPair('buyer-cn', 'supplier-th', '历史合同纠纷未决');
  const rec = platform.recommend('buyer-cn', 'd-durian');
  assert.equal(rec.eligible.length, 0);
  assert.ok(rec.rejectedSample[0].rejections.some((r) => r.code === 'forbidden-pair'));
});
