import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlatform, addEnterprise } from './helpers.js';

// 建一对可匹配的供需双方：供应商与需求方各一名全授权联系人，记录有时段交集。
function setupPair(platform, { supplierSlots = ['T1'], demanderSlots = ['T1'], supplierName = '供方企业有限公司', demanderName = '需方企业有限公司' } = {}) {
  const supplier = addEnterprise(platform, { legalName: supplierName, languages: ['中文', '英语'] });
  const demander = addEnterprise(platform, { legalName: demanderName, languages: ['中文'] });
  const supplyRecord = platform.records.add({
    enterpriseId: supplier.enterprise.id,
    kind: 'supply',
    industry: '电子',
    capabilities: ['电子元器件'],
    attributes: { monthlyCapacity: 8000 },
    slots: supplierSlots,
  });
  const demandRecord = platform.records.add({
    enterpriseId: demander.enterprise.id,
    kind: 'demand',
    industry: '电子',
    needs: ['电子元器件'],
    conditions: { minMonthlyCapacity: 1000 },
    slots: demanderSlots,
  });
  platform.runMatching();
  const candidate = platform.getCandidate(`CAND-${supplyRecord.id}-${demandRecord.id}`);
  assert.ok(candidate, '应当生成候选');
  return { supplier, demander, supplyRecord, demandRecord, candidate };
}

function confirmBoth(platform, meeting, pair) {
  platform.confirmMeeting(meeting.id, pair.supplier.enterprise.id, pair.supplier.contact.id);
  platform.confirmMeeting(meeting.id, pair.demander.enterprise.id, pair.demander.contact.id);
  return platform.scheduler.getMeeting(meeting.id);
}

test('只有双方确认才占用一对一洽谈席位', () => {
  const platform = makePlatform();
  platform.scheduler.addSeat({ room: '洽谈室A', slots: ['T1'] });
  const pair = setupPair(platform);

  const meeting = platform.proposeMeeting(pair.candidate.id, 'T1', {
    supplierContactId: pair.supplier.contact.id,
    demanderContactId: pair.demander.contact.id,
  });
  assert.equal(meeting.status, 'pending');
  assert.equal(platform.scheduler.seatUtilization().booked, 0);

  platform.confirmMeeting(meeting.id, pair.supplier.enterprise.id, pair.supplier.contact.id);
  assert.equal(platform.scheduler.getMeeting(meeting.id).status, 'pending');
  assert.equal(platform.scheduler.seatUtilization().booked, 0);

  platform.confirmMeeting(meeting.id, pair.demander.enterprise.id, pair.demander.contact.id);
  const done = platform.scheduler.getMeeting(meeting.id);
  assert.equal(done.status, 'scheduled');
  assert.ok(done.seatId);
  assert.equal(platform.scheduler.seatUtilization().booked, 1);
});

test('未获 confirm_meeting 授权的联系人不能确认会谈', () => {
  const platform = makePlatform();
  platform.scheduler.addSeat({ room: '洽谈室A', slots: ['T1'] });
  const pair = setupPair(platform);
  const observer = platform.registry.registerContact({
    enterpriseId: pair.demander.enterprise.id,
    name: '观摩人员',
    scopes: [],
  });
  const meeting = platform.proposeMeeting(pair.candidate.id, 'T1', {
    supplierContactId: pair.supplier.contact.id,
    demanderContactId: pair.demander.contact.id,
  });
  assert.throws(
    () => platform.confirmMeeting(meeting.id, pair.demander.enterprise.id, observer.id),
    /缺少授权范围/,
  );
});

test('同一企业同时段被安排多场活动时，后来的会议被释放并通知相关方', () => {
  const platform = makePlatform();
  platform.scheduler.addSeat({ room: '洽谈室A', slots: ['T1'] });
  platform.scheduler.addSeat({ room: '洽谈室B', slots: ['T1'] });

  // 同一供应商与两家需求方在同一时段各有一场会谈。
  const supplier = addEnterprise(platform, { legalName: '共享供应商有限公司', languages: ['中文'] });
  const demander1 = addEnterprise(platform, { legalName: '需求方一有限公司', languages: ['中文'] });
  const demander2 = addEnterprise(platform, { legalName: '需求方二有限公司', languages: ['中文'] });
  const sRec = platform.records.add({
    enterpriseId: supplier.enterprise.id, kind: 'supply', industry: '电子',
    capabilities: ['电子元器件'], attributes: { monthlyCapacity: 8000 }, slots: ['T1'],
  });
  const dRec1 = platform.records.add({
    enterpriseId: demander1.enterprise.id, kind: 'demand', industry: '电子',
    needs: ['电子元器件'], slots: ['T1'],
  });
  const dRec2 = platform.records.add({
    enterpriseId: demander2.enterprise.id, kind: 'demand', industry: '电子',
    needs: ['电子元器件'], slots: ['T1'],
  });
  platform.runMatching();

  const m1 = platform.proposeMeeting(`CAND-${sRec.id}-${dRec1.id}`, 'T1', {
    supplierContactId: supplier.contact.id, demanderContactId: demander1.contact.id,
  });
  confirmBoth(platform, m1, { supplier, demander: demander1 });
  assert.equal(platform.scheduler.getMeeting(m1.id).status, 'scheduled');

  const m2 = platform.proposeMeeting(`CAND-${sRec.id}-${dRec2.id}`, 'T1', {
    supplierContactId: supplier.contact.id, demanderContactId: demander2.contact.id,
  });
  confirmBoth(platform, m2, { supplier, demander: demander2 });

  const released = platform.scheduler.getMeeting(m2.id);
  assert.equal(released.status, 'released');
  assert.equal(released.releaseReason, 'schedule_conflict');
  // 资源没有被重复占用：仍只有第一场会议占席。
  assert.equal(platform.scheduler.seatUtilization().booked, 1);
  // 相关方都收到了通知。
  const notices = platform.notify.listFor(`contact:${demander2.contact.id}`);
  assert.ok(notices.some((n) => n.type === 'meeting_released' && n.message.includes('时段冲突')));
  assert.ok(platform.notify.listFor('secretariat').some((n) => n.refs.meetingId === m2.id));
});

test('企业改需求：相关会议被释放、席位回收、双方收到通知、旧候选失效', () => {
  const platform = makePlatform();
  platform.scheduler.addSeat({ room: '洽谈室A', slots: ['T1'] });
  const pair = setupPair(platform);
  const meeting = platform.proposeMeeting(pair.candidate.id, 'T1', {
    supplierContactId: pair.supplier.contact.id,
    demanderContactId: pair.demander.contact.id,
  });
  confirmBoth(platform, meeting, pair);
  assert.equal(platform.scheduler.seatUtilization().booked, 1);

  const { released, newCandidates } = platform.updateDemand(
    pair.demandRecord.id,
    { conditions: { minMonthlyCapacity: 9000 } },
    pair.demander.contact.id,
  );

  assert.equal(released.length, 1);
  assert.equal(platform.scheduler.getMeeting(meeting.id).status, 'released');
  assert.equal(platform.scheduler.getMeeting(meeting.id).releaseReason, 'demand_changed');
  assert.equal(platform.scheduler.seatUtilization().booked, 0);
  // 供方联系人收到需求变更通知。
  assert.ok(
    platform.notify.listFor(`contact:${pair.supplier.contact.id}`).some((n) => n.message.includes('需求变更')),
  );
  // 新条件下供方产能不足，不再产生候选；旧候选已失效。
  assert.equal(newCandidates.length, 0);
  assert.equal(platform.getCandidate(pair.candidate.id), undefined);
  assert.throws(
    () =>
      platform.proposeMeeting(pair.candidate.id, 'T1', {
        supplierContactId: pair.supplier.contact.id,
        demanderContactId: pair.demander.contact.id,
      }),
    /不存在或已失效/,
  );
});

test('代表临时更换：新代表有权限则会议照常并通知双方', () => {
  const platform = makePlatform();
  platform.scheduler.addSeat({ room: '洽谈室A', slots: ['T1'] });
  const pair = setupPair(platform);
  const meeting = platform.proposeMeeting(pair.candidate.id, 'T1', {
    supplierContactId: pair.supplier.contact.id,
    demanderContactId: pair.demander.contact.id,
  });
  confirmBoth(platform, meeting, pair);

  const { newContact, affected } = platform.replaceContact(pair.supplier.enterprise.id, pair.supplier.contact.id, {
    name: '接替代表',
    scopes: ['confirm_meeting'],
  });

  assert.equal(affected.length, 1);
  assert.equal(affected[0].action, 'reassigned');
  const after = platform.scheduler.getMeeting(meeting.id);
  assert.equal(after.status, 'scheduled');
  assert.equal(after.parties.supplier.contactId, newContact.id);
  assert.ok(
    platform.notify.listFor(`contact:${pair.demander.contact.id}`).some((n) => n.message.includes('会议照常进行')),
  );
});

test('代表临时更换：接任者无确认权限则释放会议并通知相关方', () => {
  const platform = makePlatform();
  platform.scheduler.addSeat({ room: '洽谈室A', slots: ['T1'] });
  const pair = setupPair(platform);
  const meeting = platform.proposeMeeting(pair.candidate.id, 'T1', {
    supplierContactId: pair.supplier.contact.id,
    demanderContactId: pair.demander.contact.id,
  });
  confirmBoth(platform, meeting, pair);

  const { affected } = platform.replaceContact(pair.supplier.enterprise.id, pair.supplier.contact.id, {
    name: '未授权接替人',
    scopes: [],
  });

  assert.equal(affected[0].action, 'released');
  const after = platform.scheduler.getMeeting(meeting.id);
  assert.equal(after.status, 'released');
  assert.equal(after.releaseReason, 'representative_unavailable');
  assert.equal(platform.scheduler.seatUtilization().booked, 0);
  assert.ok(
    platform.notify.listFor(`contact:${pair.demander.contact.id}`).some((n) => n.message.includes('代表不可用')),
  );
});

test('代表临时更换：待确认会议重置该方确认，由新代表重新确认', () => {
  const platform = makePlatform();
  platform.scheduler.addSeat({ room: '洽谈室A', slots: ['T1'] });
  const pair = setupPair(platform);
  const meeting = platform.proposeMeeting(pair.candidate.id, 'T1', {
    supplierContactId: pair.supplier.contact.id,
    demanderContactId: pair.demander.contact.id,
  });
  platform.confirmMeeting(meeting.id, pair.supplier.enterprise.id, pair.supplier.contact.id);

  const { newContact, affected } = platform.replaceContact(pair.supplier.enterprise.id, pair.supplier.contact.id, {
    name: '接替代表',
    scopes: ['confirm_meeting'],
  });
  assert.equal(affected[0].action, 'reconfirm');
  assert.equal(platform.scheduler.getMeeting(meeting.id).confirmations.supplier, null);

  // 需求方确认后仍未排定，直到新代表重新确认。
  platform.confirmMeeting(meeting.id, pair.demander.enterprise.id, pair.demander.contact.id);
  assert.equal(platform.scheduler.getMeeting(meeting.id).status, 'pending');
  platform.confirmMeeting(meeting.id, pair.supplier.enterprise.id, newContact.id);
  assert.equal(platform.scheduler.getMeeting(meeting.id).status, 'scheduled');
});

test('席位不足时进入等待队列，空出席位自动补给并通知', () => {
  const platform = makePlatform();
  platform.scheduler.addSeat({ room: '洽谈室A', slots: ['T1'] });
  const pair1 = setupPair(platform, { supplierName: '供方一有限公司', demanderName: '需方一有限公司' });
  const pair2 = setupPair(platform, { supplierName: '供方二有限公司', demanderName: '需方二有限公司' });

  const m1 = platform.proposeMeeting(pair1.candidate.id, 'T1', {
    supplierContactId: pair1.supplier.contact.id,
    demanderContactId: pair1.demander.contact.id,
  });
  confirmBoth(platform, m1, pair1);
  assert.equal(platform.scheduler.getMeeting(m1.id).status, 'scheduled');

  const m2 = platform.proposeMeeting(pair2.candidate.id, 'T1', {
    supplierContactId: pair2.supplier.contact.id,
    demanderContactId: pair2.demander.contact.id,
  });
  confirmBoth(platform, m2, pair2);
  assert.equal(platform.scheduler.getMeeting(m2.id).status, 'awaiting_seat');

  // 第一场会议释放后，等待中的会议自动补位。
  platform.releaseMeeting(m1.id, 'cancelled', '企业临时行程调整');
  const after = platform.scheduler.getMeeting(m2.id);
  assert.equal(after.status, 'scheduled');
  assert.ok(after.seatId);
  assert.ok(
    platform.notify.listFor(`contact:${pair2.supplier.contact.id}`).some((n) => n.type === 'meeting_scheduled'),
  );
});
