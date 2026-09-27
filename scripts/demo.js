// 端到端演示：`node scripts/demo.js`
// 用不含真实个人信息的示例数据，走完「导入去重 → 授权联系人 → 带理由推荐 →
// 双方确认占座 → 变更释放资源 → 会谈 → 保密履约 → 终态视图」全流程。

import { MatchPlatform } from '../src/platform.js';

const line = (title) => console.log(`\n=== ${title} ===`);

const platform = new MatchPlatform({ clock: () => '2026-09-27T08:00:00Z' });

line('1. 批量导入 5 条记录，其中 2 条是同一家企业的重复录入');
const ingest = platform.ingestOrganizations([
  {
    id: 'org-fruit-cn',
    name: '广西示例果业有限公司',
    taxId: '91450100BUYER00001',
    region: '广西南宁',
    languages: ['zh', 'en'],
    availability: [{ day: 1, start: 540, end: 720 }],
    demands: [{
      id: 'd-durian', product: '榴莲', industry: '水果进口',
      targetRegions: ['泰国'], requiredCertifications: ['GACC'],
      minQuantity: 1000, maxUnitPrice: 50,
    }],
    sourceRef: '峰会报名表',
  },
  {
    // 重复主体：同税号、名称写法不同
    name: '广西示例果业有限公司（南宁）',
    taxId: '91450100buyer00001',
    region: '广西南宁',
    sourceRef: '现场名片登记',
  },
  {
    id: 'org-fruit-th',
    name: '曼谷示例果品出口公司',
    taxId: 'TH0105558000001',
    region: '泰国曼谷',
    languages: ['th', 'en'],
    availability: [{ day: 1, start: 600, end: 780 }],
    capabilities: [{
      product: '榴莲', industry: '水果进口',
      regions: ['泰国', '中国'], certifications: ['GACC'],
      annualCapacity: 3000, unitPrice: 45,
    }],
  },
  {
    id: 'org-fruit-my',
    name: '槟城示例果业',
    taxId: 'MY202001000001',
    region: '马来西亚槟城',
    languages: ['zh', 'en'],
    availability: [{ day: 1, start: 540, end: 720 }],
    capabilities: [{
      product: '榴莲', industry: '水果进口',
      regions: ['马来西亚', '泰国'], certifications: ['GACC'],
      annualCapacity: 5000, unitPrice: 40,
    }],
  },
  {
    id: 'org-machinery-vn',
    name: '河内示例机械公司',
    taxId: 'VN0101000001',
    region: '越南河内',
    languages: ['vi'],
    availability: [{ day: 2, start: 540, end: 600 }],
    capabilities: [{ product: '轴承', industry: '机械制造', annualCapacity: 100 }],
  },
]);
console.log(`录入 5 条 → 识别主体 ${platform.registry.stats.organizationCount} 个，自动合并 ${ingest.merged.length} 条`);

line('2. 登记双方授权联系人（授权范围：配对/洽谈/履约）');
platform.authorizeContact('org-fruit-cn', { id: 'rep-huang', name: '黄经理', scope: ['match', 'meeting', 'fulfillment'], languages: ['zh', 'en'] });
platform.authorizeContact('org-fruit-th', { id: 'rep-somchai', name: 'Somchai', scope: ['match', 'meeting', 'fulfillment'], languages: ['th', 'en'] });
platform.authorizeContact('org-fruit-my', { id: 'rep-tan', name: 'Tan', scope: ['match', 'meeting', 'fulfillment'], languages: ['zh', 'en'] });

line('3. 为榴莲采购需求生成带理由的候选');
const rec = platform.recommend('org-fruit-cn', 'd-durian');
for (const c of rec.eligible) {
  console.log(`\n候选：${c.supplierName}（适配分 ${c.score}）`);
  for (const r of c.reasons) console.log(`  + [${r.factor} +${r.score}] ${r.text}`);
}
console.log(`\n被拒绝主体 ${rec.rejectedCount} 家，例如：`);
for (const c of rec.rejectedSample) {
  console.log(`  - ${c.supplierName}：${c.rejections.map((r) => r.detail).join('；')}`);
}

line('4. 发起一对一会谈提议——此时不占席位');
platform.createActivity({ id: 'act-fruit', name: '水果行业一对一洽谈' });
platform.addSeat({ activityId: 'act-fruit', label: '洽谈桌 1', date: '2026-10-01', start: '09:00', end: '10:00' });
const meeting = platform.proposeMeeting({
  activityId: 'act-fruit',
  buyerOrgId: 'org-fruit-cn', supplierOrgId: 'org-fruit-th',
  demandId: 'd-durian',
  date: '2026-10-01', start: '09:00', end: '09:30',
});
console.log(`会谈 ${meeting.id} 状态：${meeting.status}，席位：${meeting.seatId ?? '未占用'}`);

line('5. 单方确认仍不占座，双方确认后才锁定席位');
platform.confirmMeeting(meeting.id, 'rep-huang');
console.log(`买方确认后：${platform.scheduler.get(meeting.id).status}`);
platform.confirmMeeting(meeting.id, 'rep-somchai');
const confirmed = platform.scheduler.get(meeting.id);
console.log(`双方确认后：${confirmed.status}，席位 ${confirmed.seatId} 已锁定`);

line('6. 买方代表临时更换：席位立即释放、通知双方、需重新确认');
const { successor } = platform.replaceRepresentative('org-fruit-cn', 'rep-huang', {
  id: 'rep-li', name: '李经理', languages: ['zh', 'en'],
});
console.log(`更换后会谈状态：${platform.scheduler.get(meeting.id).status}，席位：${platform.scheduler.get(meeting.id).seatId ?? '已释放'}`);
platform.confirmMeeting(meeting.id, successor.id);
platform.confirmMeeting(meeting.id, 'rep-somchai');
console.log(`新代表重新确认后：${platform.scheduler.get(meeting.id).status}`);

line('7. 会谈举行，建立同一条合作关系');
const { relation } = platform.markMeetingHeld(meeting.id);
console.log(`合作关系 ${relation.id} 建立，关联会谈：${relation.meetingIds.join(', ')}`);

line('8. 保密纪要、意向金额、政策/法律/投融资事项沿同一关系推进');
platform.ledgerApi.addMatter(relation.id, {
  type: 'minutes', title: '首轮洽谈纪要', content: '首批 1000 件试单，供方两周内寄样',
  ownerContactId: 'rep-somchai', nextAction: '供方寄送样品与 GACC 扫描件', dueDate: '2026-10-08',
}, 'rep-li');
const intent = platform.ledgerApi.addMatter(relation.id, {
  type: 'intent', title: '采购意向', amount: 450000, currency: 'CNY',
  ownerContactId: 'rep-li', nextAction: '买方财务复核信用证条款',
}, 'rep-somchai');
platform.ledgerApi.addMatter(relation.id, {
  type: 'policy', title: 'RCEP 原产地证咨询', ownerContactId: 'rep-li',
  nextAction: '秘书处转介海关专员',
}, 'rep-li');
console.log('已登记 3 个事项');

line('9. 未经双方同意，主办方无法看到保密内容');
try {
  platform.ledgerApi.readMatter(relation.id, intent.id, 'secretariat');
} catch (err) {
  console.log(`主办方直接读取被拒：${err.message}`);
}
const consent = platform.ledgerApi.requestDisclosure(relation.id, intent.id, 'secretariat', 'rep-li');
platform.ledgerApi.consentDisclosure(relation.id, consent.id, 'rep-somchai');
console.log('双方分别同意后，该意向事项对秘书处可见（其他事项仍不可见）');

line('10. 企业视图：下一行动与当前责任人');
const entView = platform.enterpriseDashboard(relation.id, 'org-fruit-cn');
for (const m of entView.matters) {
  console.log(`- [${m.type}] ${m.title} → 下一行动：${m.nextAction ?? '（待排）'}；责任人：${m.owner?.name ?? '未知'}`);
}

line('11. 签约后主办方视图：只见签约终态，不显示金额与纪要');
platform.ledgerApi.sign(relation.id, 'rep-li', { contractRef: 'HT-2026-0901' });
console.log(JSON.stringify(platform.organizerDashboard(), null, 2));

line('通知样例（平台全程留痕，可对接短信/邮件/站内信）');
const notes = platform.drainNotifications();
console.log(`本次流程共产生 ${notes.length} 条通知，模板包括：${[...new Set(notes.map((n) => n.template))].join('、')}`);
