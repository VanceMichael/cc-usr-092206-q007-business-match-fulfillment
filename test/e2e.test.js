import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlatform, addEnterprise } from './helpers.js';

// 端到端：走完峰会故事主线——
// 重复主体合并 → 可解释匹配 → 双方确认占席 → 代表更换与需求变更释放资源 →
// 会谈完成 → 纪要/意向金额/政策咨询沿同一关系推进 → 双方同意才扩散 → 签约/终止 → 双视图。
test('端到端：一场全年运营的撮合履约完整旅程', () => {
  const platform = makePlatform();
  for (const room of ['洽谈室A', '洽谈室B']) {
    platform.scheduler.addSeat({ room, slots: ['T1', 'T2'] });
  }

  // 1) 同一供应商以两种名称登记，平台提示重复并由秘书处核定合并。
  const { enterprise: supplier } = platform.registry.registerEnterprise({
    legalName: '广西明远电子有限公司',
    registrationNo: '91450000MA5A000000',
    country: '中国',
    industry: '电子',
    languages: ['中文', '英语'],
  });
  const supplierContact = platform.registry.registerContact({
    enterpriseId: supplier.id, name: '明远-林代表', role: '外贸经理',
    scopes: ['confirm_meeting', 'update_demand', 'sign_intent', 'share_confidential'],
  });
  const dupReg = platform.registry.registerEnterprise({
    legalName: 'Guangxi Mingyuan Electronics Co., Ltd.',
    registrationNo: '91450000MA5A000000',
    country: '中国',
    languages: ['英语'],
  });
  assert.equal(dupReg.duplicates[0].enterpriseId, supplier.id);
  const dupContact = platform.registry.registerContact({
    enterpriseId: dupReg.enterprise.id, name: '重复登记联系人', scopes: ['confirm_meeting'],
  });
  // 重复主体名下已有一条录入的供给记录与一名联系人，合并后都应迁到主主体。
  platform.records.add({
    enterpriseId: dupReg.enterprise.id, kind: 'supply', industry: '电子',
    capabilities: ['电子元器件'], attributes: { monthlyCapacity: 4000 }, slots: ['T1'],
  });
  platform.mergeEnterprises(supplier.id, dupReg.enterprise.id, '注册号一致，秘书处核定同一主体');
  assert.equal(platform.records.byEnterprise(supplier.id).length, 1);
  assert.equal(platform.registry.getContact(dupContact.id).enterpriseId, supplier.id);

  // 2) 需方企业（东盟）与一组被禁配的企业。
  const buyer = addEnterprise(platform, {
    legalName: 'Hanoi Smart Device JSC', country: '越南', industry: '电子', languages: ['中文', '越南语'],
  });
  const blacklisted = addEnterprise(platform, {
    legalName: '失信供应商有限公司', industry: '电子', languages: ['中文'],
  });
  platform.addExclusion(buyer.enterprise.id, blacklisted.enterprise.id, '买方风控禁配名单');

  const supplyRecord = platform.records.add({
    enterpriseId: supplier.id,
    kind: 'supply',
    industry: '电子',
    capabilities: ['电子元器件', '贴片加工'],
    attributes: { monthlyCapacity: 12000, certifications: ['ISO9001', 'IATF16949'] },
    slots: ['T1', 'T2'],
  });
  // 合并迁移的记录与主主体新录的记录都在主主体名下。
  assert.equal(platform.records.byEnterprise(supplier.id).length, 2);

  const demandRecord = platform.records.add({
    enterpriseId: buyer.enterprise.id,
    kind: 'demand',
    industry: '电子',
    needs: ['电子元器件'],
    conditions: { minMonthlyCapacity: 5000, certifications: ['ISO9001'] },
    slots: ['T1', 'T2'],
  });
  platform.records.add({
    enterpriseId: blacklisted.enterprise.id, kind: 'supply', industry: '电子',
    capabilities: ['电子元器件'], slots: ['T1'],
  });

  // 3) 匹配：命中的候选带理由；禁配组合被排除且可解释。
  const { candidates, rejectionSummary } = platform.runMatching({ collectRejections: true });
  const hit = platform.getCandidate(`CAND-${supplyRecord.id}-${demandRecord.id}`);
  assert.ok(hit);
  assert.ok(hit.reasons.some((r) => r.includes('共同语言')));
  assert.ok(candidates.every((c) => c.demanderEnterpriseId !== buyer.enterprise.id || c.supplierEnterpriseId !== blacklisted.enterprise.id));
  assert.ok(Object.keys(rejectionSummary).some((k) => k.includes('禁配关系')));

  // 4) 提议会议：单方可先确认，但不占席位。
  let meeting = platform.proposeMeeting(hit.id, 'T1', {
    supplierContactId: supplierContact.id,
    demanderContactId: buyer.contact.id,
  });
  platform.confirmMeeting(meeting.id, supplier.id, supplierContact.id);
  assert.equal(platform.scheduler.seatUtilization().booked, 0);

  // 5) 代表临时更换：待确认会议需新代表重新确认，需方同步收到通知。
  const replacement = platform.replaceContact(buyer.enterprise.id, buyer.contact.id, {
    name: '河内-陈代表', role: '采购总监', scopes: ['confirm_meeting', 'update_demand', 'sign_intent', 'share_confidential'],
  });
  meeting = platform.scheduler.getMeeting(meeting.id);
  assert.equal(meeting.confirmations.demander, null);
  platform.confirmMeeting(meeting.id, supplier.id, supplierContact.id);
  platform.confirmMeeting(meeting.id, buyer.enterprise.id, replacement.newContact.id);
  meeting = platform.scheduler.getMeeting(meeting.id);
  assert.equal(meeting.status, 'scheduled');

  // 6) 企业改需求：新条件不再满足，会议释放、席位回收、双方与秘书处均收到通知。
  const change = platform.updateDemand(
    demandRecord.id,
    { conditions: { minMonthlyCapacity: 20000 } },
    replacement.newContact.id,
  );
  assert.equal(change.record.version, 2);
  meeting = platform.scheduler.getMeeting(meeting.id);
  assert.equal(meeting.status, 'released');
  assert.equal(meeting.releaseReason, 'demand_changed');
  assert.equal(platform.scheduler.seatUtilization().booked, 0);
  assert.ok(platform.notify.listFor(`contact:${supplierContact.id}`).some((n) => n.type === 'meeting_released'));

  // 7) 需方恢复现实条件，重新匹配、确认，会谈完成并建立合作关系。
  platform.updateDemand(
    demandRecord.id,
    { conditions: { minMonthlyCapacity: 5000, certifications: ['ISO9001'] } },
    replacement.newContact.id,
  );
  const hit2 = platform.getCandidate(`CAND-${supplyRecord.id}-${demandRecord.id}`);
  assert.ok(hit2, '恢复条件后应重新产生候选');
  const meeting2 = platform.proposeMeeting(hit2.id, 'T2', {
    supplierContactId: supplierContact.id,
    demanderContactId: replacement.newContact.id,
  });
  platform.confirmMeeting(meeting2.id, supplier.id, supplierContact.id);
  platform.confirmMeeting(meeting2.id, buyer.enterprise.id, replacement.newContact.id);
  assert.equal(platform.scheduler.getMeeting(meeting2.id).status, 'scheduled');
  const { relationship } = platform.completeMeeting(meeting2.id);
  assert.equal(platform.scheduler.getMeeting(meeting2.id).status, 'completed');
  assert.equal(platform.scheduler.seatUtilization().booked, 0); // 会谈结束席位即时回收

  // 8) 会后事项沿同一合作关系推进：纪要、意向金额、政策咨询。
  platform.fulfillment.addItem(
    relationship.id,
    { kind: 'minutes', title: '一对一会谈保密纪要', content: '双方讨论了年采购量与付款方式（示例文本）' },
    supplierContact.id,
  );
  platform.fulfillment.addItem(
    relationship.id,
    { kind: 'intent_amount', title: '年度采购意向', amount: 3200000, currency: 'USD' },
    replacement.newContact.id,
  );
  const consult = platform.fulfillment.addItem(
    relationship.id,
    { kind: 'policy_consult', title: 'RCEP 原产地累积规则咨询', content: '希望秘书处转介政策服务（示例文本）' },
    replacement.newContact.id,
  );

  // 9) 政策咨询需要专业服务机构介入：未经双方同意，机构看不到内容。
  const policyDesk = 'svc：东盟政策服务台';
  const req = platform.fulfillment.requestDisclosure(relationship.id, consult.id, policyDesk, supplierContact.id);
  assert.equal(platform.fulfillment.recipientView(policyDesk).length, 0);
  platform.fulfillment.consentDisclosure(relationship.id, consult.id, req.id, supplier.id, supplierContact.id);
  assert.equal(platform.fulfillment.recipientView(policyDesk).length, 0);
  platform.fulfillment.consentDisclosure(
    relationship.id, consult.id, req.id, buyer.enterprise.id, replacement.newContact.id,
  );
  const handed = platform.fulfillment.recipientView(policyDesk);
  assert.equal(handed.length, 1);
  assert.equal(handed[0].item.title, 'RCEP 原产地累积规则咨询');

  // 10) 下一行动与责任人：企业视图清晰可见。
  platform.fulfillment.setNextAction(
    relationship.id,
    {
      description: '明远提供产能证明与样品，买方完成验厂排期',
      ownerEnterpriseId: supplier.id,
      ownerContactId: supplierContact.id,
      dueAt: '2026-11-15',
    },
    replacement.newContact.id,
  );
  const supplierView = platform.fulfillment.enterpriseView(supplier.id);
  assert.equal(supplierView[0].nextAction.description, '明远提供产能证明与样品，买方完成验厂排期');
  assert.equal(supplierView[0].nextAction.owner.contactId, supplierContact.id);

  // 11) 签约：主办方视图只见结果，不见保密内容与金额。
  platform.fulfillment.sign(relationship.id, supplierContact.id);
  const organizer = platform.fulfillment.organizerView();
  assert.equal(organizer.signed.length, 1);
  assert.equal(organizer.signed[0].id, relationship.id);
  const exposed = JSON.stringify(organizer);
  assert.ok(!exposed.includes('3200000'));
  assert.ok(!exposed.includes('付款方式'));

  // 另一段合作关系终止并填写原因。
  const other = addEnterprise(platform, { legalName: '另一家供方有限公司', languages: ['中文'] });
  const otherBuyer = addEnterprise(platform, { legalName: '另一家买方有限公司', languages: ['中文'] });
  const rel2 = platform.fulfillment.openRelationship({
    meetingId: 'MTG-OTHER',
    parties: [other.enterprise.id, otherBuyer.enterprise.id],
    owners: { [other.enterprise.id]: other.contact.id, [otherBuyer.enterprise.id]: otherBuyer.contact.id },
  });
  platform.fulfillment.terminate(rel2.id, '样品测试未通过，买方明确终止', otherBuyer.contact.id);
  const organizer2 = platform.fulfillment.organizerView();
  assert.equal(organizer2.terminated.length, 1);
  assert.equal(organizer2.terminated[0].reason, '样品测试未通过，买方明确终止');
  assert.equal(organizer2.signed.length, 1);
  assert.equal(organizer2.activeCount, 0);

  // 企业视图包含下一行动/责任人；终止原因对双方企业可见。
  const buyerView = platform.fulfillment.enterpriseView(buyer.enterprise.id);
  assert.equal(buyerView[0].status, 'signed');
  assert.ok(buyerView[0].nextAction);
  const terminatedView = platform.fulfillment.enterpriseView(other.enterprise.id);
  assert.equal(terminatedView[0].terminationReason, '样品测试未通过，买方明确终止');
});
