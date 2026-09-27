import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlatform, addEnterprise, FULL_SCOPES } from './helpers.js';

// 建一段合作关系：两家企业各一名全授权联系人。
function setupRelationship(platform) {
  const a = addEnterprise(platform, { legalName: '甲方企业有限公司' });
  const b = addEnterprise(platform, { legalName: '乙方企业有限公司' });
  const rel = platform.fulfillment.openRelationship({
    meetingId: 'MTG-TEST',
    parties: [a.enterprise.id, b.enterprise.id],
    owners: { [a.enterprise.id]: a.contact.id, [b.enterprise.id]: b.contact.id },
  });
  return { a, b, rel };
}

test('保密纪要、意向金额等事项沿同一合作关系推进且默认保密', () => {
  const platform = makePlatform();
  const { a, rel } = setupRelationship(platform);

  const minutes = platform.fulfillment.addItem(rel.id, { kind: 'minutes', title: '首轮洽谈纪要', content: '示例纪要内容' }, a.contact.id);
  const intent = platform.fulfillment.addItem(rel.id, { kind: 'intent_amount', title: '采购意向', amount: 5000000, currency: 'CNY' }, a.contact.id);

  const stored = platform.fulfillment.getRelationship(rel.id);
  assert.equal(stored.items.length, 2);
  assert.equal(minutes.confidential, true);
  assert.equal(intent.amount, 5000000);
  assert.equal(intent.currency, 'CNY');
});

test('意向金额需要 sign_intent 授权且必须含金额与币种', () => {
  const platform = makePlatform();
  const { a, b, rel } = setupRelationship(platform);
  const noScope = platform.registry.registerContact({
    enterpriseId: a.enterprise.id,
    name: '无签约权联系人',
    scopes: ['confirm_meeting'],
  });
  assert.throws(
    () => platform.fulfillment.addItem(rel.id, { kind: 'intent_amount', amount: 100, currency: 'CNY' }, noScope.id),
    /缺少授权范围/,
  );
  assert.throws(
    () => platform.fulfillment.addItem(rel.id, { kind: 'intent_amount', amount: 100 }, b.contact.id),
    /金额与币种/,
  );
});

test('合作关系之外的联系人不能登记事项', () => {
  const platform = makePlatform();
  const { rel } = setupRelationship(platform);
  const outsider = addEnterprise(platform, { legalName: '局外企业有限公司' });
  assert.throws(
    () => platform.fulfillment.addItem(rel.id, { kind: 'minutes', content: 'x' }, outsider.contact.id),
    /不属于合作关系双方/,
  );
});

test('保密条目未经双方同意不得扩散：一方同意不够，双方同意才可见', () => {
  const platform = makePlatform();
  const { a, b, rel } = setupRelationship(platform);
  const item = platform.fulfillment.addItem(rel.id, { kind: 'policy_consult', title: '原产地规则咨询', content: '示例咨询内容' }, a.contact.id);

  const disc = platform.fulfillment.requestDisclosure(rel.id, item.id, 'svc：律师事务所-01', a.contact.id);
  assert.equal(platform.fulfillment.recipientView('svc：律师事务所-01').length, 0);

  platform.fulfillment.consentDisclosure(rel.id, item.id, disc.id, a.enterprise.id, a.contact.id);
  assert.equal(platform.fulfillment.getRelationship(rel.id).items[0].disclosures[0].status, 'pending');
  assert.equal(platform.fulfillment.recipientView('svc：律师事务所-01').length, 0);

  platform.fulfillment.consentDisclosure(rel.id, item.id, disc.id, b.enterprise.id, b.contact.id);
  assert.equal(platform.fulfillment.getRelationship(rel.id).items[0].disclosures[0].status, 'granted');
  const visible = platform.fulfillment.recipientView('svc：律师事务所-01');
  assert.equal(visible.length, 1);
  assert.equal(visible[0].item.title, '原产地规则咨询');
  // 未被披露的对象仍然不可见。
  assert.equal(platform.fulfillment.recipientView('svc：其他机构').length, 0);
});

test('同意扩散需要 share_confidential 授权', () => {
  const platform = makePlatform();
  const { a, b, rel } = setupRelationship(platform);
  const item = platform.fulfillment.addItem(rel.id, { kind: 'minutes', content: '示例' }, a.contact.id);
  const disc = platform.fulfillment.requestDisclosure(rel.id, item.id, 'svc：某机构', a.contact.id);
  const noScope = platform.registry.registerContact({
    enterpriseId: b.enterprise.id,
    name: '无扩散授权联系人',
    scopes: ['confirm_meeting'],
  });
  assert.throws(
    () => platform.fulfillment.consentDisclosure(rel.id, item.id, disc.id, b.enterprise.id, noScope.id),
    /缺少授权范围/,
  );
});

test('主办方只看到签约、终止及其原因，看不到保密内容与意向金额', () => {
  const platform = makePlatform();
  const { a, b, rel } = setupRelationship(platform);
  platform.fulfillment.addItem(rel.id, { kind: 'minutes', title: '保密纪要', content: '绝密示例内容' }, a.contact.id);
  platform.fulfillment.addItem(rel.id, { kind: 'intent_amount', amount: 8800000, currency: 'CNY' }, a.contact.id);

  const pair2 = setupRelationship(platform);
  platform.fulfillment.sign(rel.id, a.contact.id);
  platform.fulfillment.terminate(pair2.rel.id, '双方评估后认为产能不匹配', pair2.a.contact.id);

  const view = platform.fulfillment.organizerView();
  assert.equal(view.signed.length, 1);
  assert.equal(view.terminated.length, 1);
  assert.equal(view.terminated[0].reason, '双方评估后认为产能不匹配');
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('绝密示例内容'));
  assert.ok(!serialized.includes('8800000'));
});

test('终止必须填写原因；企业视图呈现下一行动与当前责任人', () => {
  const platform = makePlatform();
  const { a, b, rel } = setupRelationship(platform);
  assert.throws(() => platform.fulfillment.terminate(rel.id, '', a.contact.id), /必须填写原因/);

  platform.fulfillment.setNextAction(
    rel.id,
    { description: '提交保密协议草案', ownerEnterpriseId: b.enterprise.id, ownerContactId: b.contact.id, dueAt: '2026-10-20' },
    a.contact.id,
  );
  const [view] = platform.fulfillment.enterpriseView(b.enterprise.id);
  assert.equal(view.nextAction.description, '提交保密协议草案');
  assert.equal(view.nextAction.owner.name, b.contact.name);
  assert.equal(view.nextAction.owner.contactId, b.contact.id);
  // 责任人收到通知。
  assert.ok(platform.notify.listFor(`contact:${b.contact.id}`).some((n) => n.type === 'next_action_set'));
});

test('签约或终止后不能再追加事项', () => {
  const platform = makePlatform();
  const { a, rel } = setupRelationship(platform);
  platform.fulfillment.terminate(rel.id, '需求取消', a.contact.id);
  assert.throws(
    () => platform.fulfillment.addItem(rel.id, { kind: 'minutes', content: 'x' }, a.contact.id),
    /已终止/,
  );
});

test('全授权联系人才可执行全部履约动作（授权范围常量完整）', () => {
  assert.deepEqual(FULL_SCOPES, ['confirm_meeting', 'update_demand', 'sign_intent', 'share_confidential']);
});
