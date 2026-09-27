import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, createRegistry } from '../src/registry.js';
import { createIdGenerator } from '../src/ids.js';

function makeRegistry() {
  return createRegistry({ nextId: createIdGenerator(), clock: () => '2026-09-27T00:00:00.000Z' });
}

test('名称规范化识别公司后缀、标点与全角字符', () => {
  assert.equal(normalizeName('广西明远电子有限公司'), '广西明远电子');
  assert.equal(normalizeName('广西明远电子（股份）有限公司'), '广西明远电子');
  assert.equal(normalizeName('ABC Trading Co., Ltd.'), 'abctrading');
  assert.equal(normalizeName('ＡＢＣ Ｔｒａｄｉｎｇ Ｌｉｍｉｔｅｄ'), 'abctrading');
});

test('注册号一致判定为重复主体（置信度 1）', () => {
  const reg = makeRegistry();
  reg.registerEnterprise({ legalName: '广西明远电子有限公司', registrationNo: '91450000MA5A000000' });
  const { duplicates } = reg.registerEnterprise({
    legalName: '广西明远电子（股份）有限公司',
    registrationNo: '91450000MA5A000000',
  });
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].confidence, 1);
  assert.ok(duplicates[0].reasons.includes('注册号一致'));
});

test('名称规范化后一致判定为疑似重复并给出理由', () => {
  const reg = makeRegistry();
  reg.registerEnterprise({ legalName: '广西明远电子有限公司' });
  const { duplicates } = reg.registerEnterprise({ legalName: '广西明远电子（股份）有限公司' });
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].confidence, 0.9);
  assert.ok(duplicates[0].reasons.includes('名称规范化后一致'));
});

test('合并主体吸收别名、迁移联系人并留痕', () => {
  const reg = makeRegistry();
  const { enterprise: master } = reg.registerEnterprise({ legalName: '广西明远电子有限公司', languages: ['中文'] });
  const { enterprise: dup } = reg.registerEnterprise({ legalName: '广西明远电子（股份）有限公司', languages: ['英语'] });
  const contact = reg.registerContact({ enterpriseId: dup.id, name: '示例联系人', scopes: ['confirm_meeting'] });

  reg.mergeEnterprises(master.id, dup.id, '秘书处核定同一主体');

  assert.ok(master.aliases.includes('广西明远电子（股份）有限公司'));
  assert.ok(master.languages.includes('英语'));
  assert.equal(reg.getContact(contact.id).enterpriseId, master.id);
  assert.equal(reg.getEnterprise(dup.id).status, 'merged');
  assert.equal(reg.getEnterprise(dup.id).mergedInto, master.id);
  assert.throws(() => reg.mergeEnterprises(master.id, dup.id), /已并入/);
});

test('授权联系人按范围行事：缺范围、授权过期、已被更换都不能操作', () => {
  const reg = makeRegistry();
  const { enterprise } = reg.registerEnterprise({ legalName: '示例企业有限公司' });
  const noScope = reg.registerContact({ enterpriseId: enterprise.id, name: '无授权联系人', scopes: [] });
  const expired = reg.registerContact({
    enterpriseId: enterprise.id,
    name: '授权过期联系人',
    scopes: ['confirm_meeting'],
    validUntil: '2026-01-01T00:00:00.000Z',
  });
  const normal = reg.registerContact({ enterpriseId: enterprise.id, name: '正常联系人', scopes: ['confirm_meeting'] });

  assert.throws(() => reg.assertContact(enterprise.id, noScope.id, 'confirm_meeting'), /缺少授权范围/);
  assert.throws(() => reg.assertContact(enterprise.id, expired.id, 'confirm_meeting'), /授权已过期/);
  assert.doesNotThrow(() => reg.assertContact(enterprise.id, normal.id, 'confirm_meeting'));

  reg.replaceContact(enterprise.id, normal.id, { name: '接任联系人', scopes: ['confirm_meeting'] });
  assert.throws(() => reg.assertContact(enterprise.id, normal.id, 'confirm_meeting'), /已被更换/);
});

test('代表更换：旧代表停用留痕，可接任者可以是本企业已有联系人', () => {
  const reg = makeRegistry();
  const { enterprise } = reg.registerEnterprise({ legalName: '示例企业有限公司' });
  const old = reg.registerContact({ enterpriseId: enterprise.id, name: '原代表', scopes: ['confirm_meeting'] });
  const colleague = reg.registerContact({ enterpriseId: enterprise.id, name: '同事', scopes: ['confirm_meeting'] });

  const { oldContact, newContact } = reg.replaceContact(enterprise.id, old.id, { existingContactId: colleague.id });
  assert.equal(oldContact.status, 'replaced');
  assert.equal(oldContact.replacedBy, colleague.id);
  assert.equal(newContact.id, colleague.id);
  assert.throws(() => reg.replaceContact(enterprise.id, old.id, { name: '再来一次' }), /不能更换/);
});
