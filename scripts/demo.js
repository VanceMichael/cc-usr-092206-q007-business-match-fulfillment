// 演示：从峰会闭幕后秘书处导入供需信息，到全年运营中的匹配、排程、履约与双视图。
// 运行：npm run demo
import { createPlatform } from '../src/platform.js';

let t = Date.parse('2026-10-12T08:00:00+08:00');
const clock = () => new Date((t += 60_000)).toISOString();
const platform = createPlatform({ clock });
const say = (step, msg) => console.log(`\n【${step}】${msg}`);

// ── 第一步：秘书处导入企业，平台提示重复主体 ─────────────────────────────
const { enterprise: supplier } = platform.registry.registerEnterprise({
  legalName: '广西明远电子有限公司',
  registrationNo: '91450000MA5A000000',
  industry: '电子',
  languages: ['中文', '英语'],
});
const supplierContact = platform.registry.registerContact({
  enterpriseId: supplier.id, name: '明远-林代表', role: '外贸经理',
  scopes: ['confirm_meeting', 'update_demand', 'sign_intent', 'share_confidential'],
});
const dup = platform.registry.registerEnterprise({
  legalName: 'Guangxi Mingyuan Electronics Co., Ltd.',
  registrationNo: '91450000MA5A000000',
  languages: ['英语'],
});
say('主体治理', `检测到疑似重复主体：${dup.enterprise.legalName} ↔ ${supplier.legalName}（${dup.duplicates[0].reasons.join('、')}）`);
platform.mergeEnterprises(supplier.id, dup.enterprise.id, '注册号一致，秘书处核定');
say('主体治理', `已合并，主主体 ${supplier.id}，别名：${platform.registry.getEnterprise(supplier.id).aliases.join(' / ')}`);

const { enterprise: buyer } = platform.registry.registerEnterprise({
  legalName: 'Hanoi Smart Device JSC', industry: '电子', languages: ['中文', '越南语'],
});
let buyerContact = platform.registry.registerContact({
  enterpriseId: buyer.id, name: '河内-阮代表', role: '采购经理',
  scopes: ['confirm_meeting', 'update_demand', 'sign_intent', 'share_confidential'],
});

// ── 第二步：导入供需并匹配，候选带理由 ───────────────────────────────────
const supplyRecord = platform.records.add({
  enterpriseId: supplier.id, kind: 'supply', industry: '电子',
  capabilities: ['电子元器件', '贴片加工'],
  attributes: { monthlyCapacity: 12000, certifications: ['ISO9001'] },
  slots: ['T1', 'T2'],
});
const demandRecord = platform.records.add({
  enterpriseId: buyer.id, kind: 'demand', industry: '电子',
  needs: ['电子元器件'],
  conditions: { minMonthlyCapacity: 5000, certifications: ['ISO9001'] },
  slots: ['T1', 'T2'],
});
platform.scheduler.addSeat({ room: '洽谈室A', slots: ['T1', 'T2'] });
platform.runMatching();
const hit = platform.getCandidate(`CAND-${supplyRecord.id}-${demandRecord.id}`);
say('可解释匹配', `候选 ${hit.id}（得分 ${hit.score}）：\n  - ${hit.reasons.join('\n  - ')}`);

// ── 第三步：双方确认才占席；代表临时更换 ─────────────────────────────────
let meeting = platform.proposeMeeting(hit.id, 'T1', {
  supplierContactId: supplierContact.id, demanderContactId: buyerContact.id,
});
platform.confirmMeeting(meeting.id, supplier.id, supplierContact.id);
say('洽谈排程', `仅供方确认，席位占用 ${platform.scheduler.seatUtilization().booked}（双方确认才占席）`);
const swap = platform.replaceContact(buyer.id, buyerContact.id, {
  name: '河内-陈代表', role: '采购总监',
  scopes: ['confirm_meeting', 'update_demand', 'sign_intent', 'share_confidential'],
});
buyerContact = swap.newContact;
platform.confirmMeeting(meeting.id, buyer.id, buyerContact.id);
meeting = platform.scheduler.getMeeting(meeting.id);
say('洽谈排程', `买方更换代表后由 ${buyerContact.name} 确认，会议排定：${meeting.seatId} @ ${meeting.slot}`);

// ── 第四步：企业改需求，资源回收并通知 ───────────────────────────────────
platform.updateDemand(demandRecord.id, { conditions: { minMonthlyCapacity: 20000 } }, buyerContact.id);
say('需求变更', `买方提高产能门槛，会议 ${meeting.id} 已释放，席位占用回到 ${platform.scheduler.seatUtilization().booked}`);
platform.updateDemand(demandRecord.id, { conditions: { minMonthlyCapacity: 5000, certifications: ['ISO9001'] } }, buyerContact.id);
const hit2 = platform.getCandidate(`CAND-${supplyRecord.id}-${demandRecord.id}`);
const meeting2 = platform.proposeMeeting(hit2.id, 'T2', {
  supplierContactId: supplierContact.id, demanderContactId: buyerContact.id,
});
platform.confirmMeeting(meeting2.id, supplier.id, supplierContact.id);
platform.confirmMeeting(meeting2.id, buyer.id, buyerContact.id);
say('洽谈排程', `条件恢复后重新匹配并确认，会议 ${meeting2.id} 排定`);

// ── 第五步：会谈完成，会后事项沿同一合作关系推进 ─────────────────────────
const { relationship } = platform.completeMeeting(meeting2.id);
platform.fulfillment.addItem(relationship.id, { kind: 'minutes', title: '一对一会谈保密纪要', content: '双方讨论了年采购量与付款方式（示例文本）' }, supplierContact.id);
platform.fulfillment.addItem(relationship.id, { kind: 'intent_amount', title: '年度采购意向', amount: 3200000, currency: 'USD' }, buyerContact.id);
const consult = platform.fulfillment.addItem(relationship.id, { kind: 'policy_consult', title: 'RCEP 原产地累积规则咨询', content: '希望秘书处转介政策服务（示例文本）' }, buyerContact.id);
say('会后履约', `合作关系 ${relationship.id} 已建立，累计 ${platform.fulfillment.getRelationship(relationship.id).items.length} 项事项（纪要/意向金额/政策咨询）`);

// ── 第六步：保密条目未经双方同意不得扩散 ─────────────────────────────────
const desk = 'svc：东盟政策服务台';
const req = platform.fulfillment.requestDisclosure(relationship.id, consult.id, desk, supplierContact.id);
platform.fulfillment.consentDisclosure(relationship.id, consult.id, req.id, supplier.id, supplierContact.id);
say('保密控制', `仅供方同意，${desk} 可见条目：${platform.fulfillment.recipientView(desk).length} 条`);
platform.fulfillment.consentDisclosure(relationship.id, consult.id, req.id, buyer.id, buyerContact.id);
say('保密控制', `双方同意后，${desk} 可见条目：${platform.fulfillment.recipientView(desk).length} 条`);

// ── 第七步：下一行动、签约与双视图 ───────────────────────────────────────
platform.fulfillment.setNextAction(relationship.id, {
  description: '明远提供产能证明与样品，买方完成验厂排期',
  ownerEnterpriseId: supplier.id, ownerContactId: supplierContact.id, dueAt: '2026-11-15',
}, buyerContact.id);
platform.fulfillment.sign(relationship.id, supplierContact.id);

const organizer = platform.fulfillment.organizerView();
say('主办方视图', `签约 ${organizer.signed.length} 项、终止 ${organizer.terminated.length} 项、推进中 ${organizer.activeCount} 项（不含保密内容与金额）`);
const supplierView = platform.fulfillment.enterpriseView(supplier.id)[0];
say('企业视图', `下一行动：${supplierView.nextAction.description}；当前责任人：${supplierView.nextAction.owner.name}（${supplierView.nextAction.dueAt} 前）`);

say('通知留痕', `平台共发出 ${platform.notify.all().length} 条通知，秘书处收件 ${platform.notify.listFor('secretariat').length} 条`);
