import test from 'node:test';
import assert from 'node:assert/strict';
import { ContactBook } from '../src/identity.js';
import { FulfillmentLedger, RELATION_STATUS } from '../src/fulfillment.js';

function setup() {
  const contactBook = new ContactBook({ today: '2026-09-27' });
  const buyerRep = contactBook.authorize('buyer', { name: '买方履约人', scope: ['fulfillment'] });
  const supplierRep = contactBook.authorize('supplier', { name: '供方履约人', scope: ['fulfillment'] });
  const ledger = new FulfillmentLedger({ contactBook, clock: () => '2026-09-27T10:00:00Z' });
  const rel = ledger.openRelation({ buyerOrgId: 'buyer', supplierOrgId: 'supplier', meetingId: 'mtg-1' });
  return { ledger, contactBook, buyerRep, supplierRep, rel };
}

test('同一对企业只建一条合作关系，后续会谈并入', () => {
  const { ledger } = setup();
  const again = ledger.openRelation({ buyerOrgId: 'buyer', supplierOrgId: 'supplier', meetingId: 'mtg-2' });
  assert.equal(ledger.relations.size, 1);
  assert.deepEqual(again.meetingIds, ['mtg-1', 'mtg-2']);
});

test('纪要、意向金额、政策、法律、投融资事项沿同一关系推进', () => {
  const { ledger, buyerRep, supplierRep, rel } = setup();
  const minutes = ledger.addMatter(rel.id, {
    type: 'minutes', title: '首轮洽谈纪要', content: '双方确认产品规格与验厂安排',
    ownerContactId: buyerRep.id, nextAction: '供应方寄送样品', dueDate: '2026-10-10',
  }, buyerRep.id);
  const intent = ledger.addMatter(rel.id, {
    type: 'intent', title: '采购意向', amount: 500000, currency: 'CNY',
    ownerContactId: supplierRep.id, nextAction: '买方内部审批',
  }, supplierRep.id);
  ledger.addMatter(rel.id, { type: 'policy', title: 'RCEP 原产地规则咨询', ownerContactId: buyerRep.id }, buyerRep.id);
  ledger.addMatter(rel.id, { type: 'legal', title: '合同条款审查', ownerContactId: supplierRep.id }, supplierRep.id);
  ledger.addMatter(rel.id, { type: 'financing', title: '信用证安排', ownerContactId: buyerRep.id }, buyerRep.id);

  assert.equal(rel.matters.length, 5);
  assert.equal(minutes.relationId, rel.id);
  assert.equal(intent.amount, 500000);

  // 非双方成员不能登记事项
  const outsider = ledger.contactBook.authorize('other', { name: '无关企业', scope: ['fulfillment'] });
  assert.throws(
    () => ledger.addMatter(rel.id, { type: 'note', title: 'x', ownerContactId: outsider.id }, outsider.id),
    /未知事项类型|合作双方/,
  );
});

test('未经双方同意，事项内容不得扩散给第三方（含主办方）', () => {
  const { ledger, buyerRep, supplierRep, rel } = setup();
  const matter = ledger.addMatter(rel.id, {
    type: 'intent', title: '保密意向金额', amount: 800000, currency: 'CNY',
    content: '含价格底线等敏感条款', ownerContactId: buyerRep.id,
  }, buyerRep.id);

  // 第三方（含秘书处）直接读取被拒绝
  assert.throws(() => ledger.readMatter(rel.id, matter.id, 'secretariat'), /未经双方同意/);

  // 买方单方同意不够
  const consent = ledger.requestDisclosure(rel.id, matter.id, 'secretariat', buyerRep.id);
  assert.equal(consent.status, 'pending');
  assert.throws(() => ledger.readMatter(rel.id, matter.id, 'secretariat'), /未经双方同意/);

  // 供方同意后生效
  ledger.consentDisclosure(rel.id, consent.id, supplierRep.id);
  assert.equal(consent.status, 'granted');
  const readable = ledger.readMatter(rel.id, matter.id, 'secretariat');
  assert.equal(readable.amount, 800000);
});

test('主办方视图只见终态与原因，企业视图见下一行动与责任人', () => {
  const { ledger, buyerRep, supplierRep, rel } = setup();
  ledger.addMatter(rel.id, {
    type: 'intent', title: '意向金额', amount: 300000, currency: 'CNY',
    ownerContactId: supplierRep.id, nextAction: '买方确认最终订单量', dueDate: '2026-10-15',
  }, supplierRep.id);

  // 企业视图
  const view = ledger.enterpriseView(rel.id, 'buyer');
  assert.equal(view.matters.length, 1);
  assert.equal(view.matters[0].nextAction, '买方确认最终订单量');
  assert.equal(view.matters[0].owner.name, '供方履约人');
  assert.equal(view.matters[0].owner.orgId, 'supplier');

  // 进行中时主办方看不到金额
  let orgView = ledger.organizerView();
  assert.equal(orgView[0].status, 'active');
  assert.ok(!('amount' in orgView[0]));
  assert.ok(!('content' in orgView[0]));

  // 签约后主办方见签约
  ledger.sign(rel.id, buyerRep.id, { contractRef: 'HT-2026-001' });
  orgView = ledger.organizerView();
  assert.equal(orgView[0].status, RELATION_STATUS.SIGNED);
  assert.equal(orgView[0].contractRef, 'HT-2026-001');
  assert.equal(orgView[0].terminateReason, null);
});

test('终止必须填写原因，主办方可见原因', () => {
  const { ledger, buyerRep, rel } = setup();
  assert.throws(() => ledger.terminate(rel.id, buyerRep.id, ''), /原因/);
  ledger.terminate(rel.id, buyerRep.id, '样品两次未通过质检');
  const orgView = ledger.organizerView();
  assert.equal(orgView[0].status, RELATION_STATUS.TERMINATED);
  assert.equal(orgView[0].terminateReason, '样品两次未通过质检');

  // 关闭后不能再登记事项
  assert.throws(
    () => ledger.addMatter(rel.id, { type: 'minutes', title: 'x', ownerContactId: buyerRep.id }, buyerRep.id),
    /已关闭/,
  );
});

test('无履约授权的联系人不能登记或同意扩散', () => {
  const { ledger, contactBook, buyerRep, rel } = setup();
  const meetingOnly = contactBook.authorize('buyer', { name: '仅洽谈员', scope: ['meeting'] });
  assert.throws(
    () => ledger.addMatter(rel.id, { type: 'minutes', title: 'x', ownerContactId: buyerRep.id }, meetingOnly.id),
    /fulfillment 授权/,
  );
  const matter = ledger.addMatter(rel.id, { type: 'minutes', title: '纪要', ownerContactId: buyerRep.id }, buyerRep.id);
  assert.throws(
    () => ledger.requestDisclosure(rel.id, matter.id, 'secretariat', meetingOnly.id),
    /fulfillment 授权/,
  );
});
