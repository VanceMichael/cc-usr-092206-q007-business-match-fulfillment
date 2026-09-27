import test from 'node:test';
import assert from 'node:assert/strict';
import { ContactBook } from '../src/identity.js';
import { Scheduler, MEETING_STATUS } from '../src/scheduling.js';

function setupHarness(now = '2026-09-27T08:00:00Z') {
  const contactBook = new ContactBook({ today: '2026-09-27' });
  const clock = (() => now)();
  const scheduler = new Scheduler({ contactBook, clock: () => now });
  const buyerRep = contactBook.authorize('buyer', { name: '采购代表', scope: ['meeting', 'match'] });
  const supplierRep = contactBook.authorize('supplier', { name: '供应代表', scope: ['meeting', 'match'] });
  const activity = scheduler.createActivity({ id: 'act-1', name: '水果行业对接会' });
  return { scheduler, contactBook, buyerRep, supplierRep, activity };
}

function proposeAndConfirm(scheduler, buyerRep, supplierRep, overrides = {}) {
  const meeting = scheduler.proposeMeeting({
    activityId: 'act-1',
    buyer: { orgId: 'buyer', orgName: '采购企业' },
    supplier: { orgId: 'supplier', orgName: '供应企业' },
    demandId: 'd1',
    date: '2026-10-01',
    start: '09:00',
    end: '09:30',
    ...overrides,
  });
  scheduler.confirm(meeting.id, buyerRep.id);
  scheduler.confirm(meeting.id, supplierRep.id);
  return scheduler.get(meeting.id);
}

test('提议不占座；只有双方确认后才锁定席位', () => {
  const { scheduler, buyerRep, supplierRep } = setupHarness();
  scheduler.addSeat({ activityId: 'act-1', label: 'A1', date: '2026-10-01', start: '09:00', end: '10:00' });

  const meeting = scheduler.proposeMeeting({
    activityId: 'act-1',
    buyer: { orgId: 'buyer', orgName: '采购企业' },
    supplier: { orgId: 'supplier', orgName: '供应企业' },
    date: '2026-10-01', start: '09:00', end: '09:30',
  });
  assert.equal(meeting.status, MEETING_STATUS.AWAITING);
  assert.equal(meeting.seatId, null);

  scheduler.confirm(meeting.id, buyerRep.id);
  assert.equal(scheduler.get(meeting.id).status, MEETING_STATUS.AWAITING);
  assert.equal(scheduler.get(meeting.id).seatId, null);

  scheduler.confirm(meeting.id, supplierRep.id);
  const held = scheduler.get(meeting.id);
  assert.equal(held.status, MEETING_STATUS.CONFIRMED);
  assert.ok(held.seatId);

  const notes = scheduler.drainNotifications();
  assert.ok(notes.some((n) => n.template === 'meeting_confirmed'));
});

test('无洽谈授权的联系人不能确认', () => {
  const { scheduler, contactBook } = setupHarness();
  scheduler.addSeat({ activityId: 'act-1', label: 'A1', date: '2026-10-01', start: '09:00', end: '10:00' });
  const limited = contactBook.authorize('buyer', { name: '仅配对员', scope: ['match'] });
  const meeting = scheduler.proposeMeeting({
    activityId: 'act-1',
    buyer: { orgId: 'buyer', orgName: '采购企业' },
    supplier: { orgId: 'supplier', orgName: '供应企业' },
    date: '2026-10-01', start: '09:00', end: '09:30',
  });
  assert.throws(() => scheduler.confirm(meeting.id, limited.id), /洽谈授权/);
});

test('席位满时候补；释放后按顺序自动补位并通知', () => {
  const { scheduler, contactBook, buyerRep, supplierRep } = setupHarness();
  scheduler.addSeat({ activityId: 'act-1', label: 'A1', date: '2026-10-01', start: '09:00', end: '10:00' });

  // 第二对企业占用唯一席位
  const rep2b = contactBook.authorize('b2', { name: '买方2', scope: ['meeting'] });
  const rep2s = contactBook.authorize('s2', { name: '供方2', scope: ['meeting'] });
  const first = proposeAndConfirm(scheduler, rep2b, rep2s, {
    buyer: { orgId: 'b2', orgName: '买方2企业' },
    supplier: { orgId: 's2', orgName: '供方2企业' },
  });
  assert.equal(first.status, MEETING_STATUS.CONFIRMED);
  const firstSeatId = first.seatId;

  // 本对进入候补
  const waiting = proposeAndConfirm(scheduler, buyerRep, supplierRep);
  assert.equal(waiting.status, MEETING_STATUS.AWAITING_SEAT);

  scheduler.drainNotifications();
  scheduler.adminCancel(first.id, '活动调整');
  const promoted = scheduler.get(waiting.id);
  assert.equal(promoted.status, MEETING_STATUS.CONFIRMED);
  assert.equal(promoted.seatId, firstSeatId);
  const notes = scheduler.drainNotifications();
  assert.ok(notes.some((n) => n.template === 'meeting_confirmed' && n.relatedMeetingId === waiting.id));
});

test('代表临时更换：已占席位立即释放、确认作废、需新代表重认', () => {
  const { scheduler, contactBook, buyerRep, supplierRep } = setupHarness();
  scheduler.addSeat({ activityId: 'act-1', label: 'A1', date: '2026-10-01', start: '09:00', end: '10:00' });
  const meeting = proposeAndConfirm(scheduler, buyerRep, supplierRep);
  assert.equal(meeting.status, MEETING_STATUS.CONFIRMED);
  scheduler.drainNotifications();

  const successor = contactBook.replace('buyer', buyerRep.id, { name: '新任采购代表' });
  scheduler.onContactReplaced('buyer', buyerRep.id, successor.id);

  const updated = scheduler.get(meeting.id);
  assert.equal(updated.status, MEETING_STATUS.AWAITING);
  assert.equal(updated.seatId, null);
  assert.equal(updated.buyer.contactId, successor.id);
  assert.deepEqual(Object.keys(updated.confirmedBy), []);
  // 席位空出，可被新的会谈使用
  const seatIds = [...scheduler.seats.values()].map((s) => s.id);
  assert.ok(seatIds.every((id) => scheduler.seats.get(id).booking === null));

  const notes = scheduler.drainNotifications();
  assert.ok(notes.some((n) => n.template === 'meeting_rep_changed'));

  // 旧代表确认应被拒绝
  assert.throws(() => scheduler.confirm(meeting.id, buyerRep.id), /授权已失效/);

  // 新代表与对方重新确认后再次占座
  scheduler.confirm(meeting.id, successor.id);
  scheduler.confirm(meeting.id, supplierRep.id);
  assert.equal(scheduler.get(meeting.id).status, MEETING_STATUS.CONFIRMED);
});

test('企业改需求：关联未举行会谈失效、释放席位并通知', () => {
  const { scheduler, buyerRep, supplierRep } = setupHarness();
  scheduler.addSeat({ activityId: 'act-1', label: 'A1', date: '2026-10-01', start: '09:00', end: '10:00' });
  const meeting = proposeAndConfirm(scheduler, buyerRep, supplierRep);
  scheduler.drainNotifications();

  const affected = scheduler.invalidateByDemand('buyer', 'd1', '采购数量翻倍，重新匹配');
  assert.deepEqual(affected, [meeting.id]);
  assert.equal(scheduler.get(meeting.id).status, MEETING_STATUS.INVALIDATED);
  assert.equal(scheduler.get(meeting.id).seatId, null);
  assert.equal(scheduler.get(meeting.id).declineReason, '采购数量翻倍，重新匹配');
  const notes = scheduler.drainNotifications();
  assert.ok(notes.some((n) => n.template === 'meeting_ended'));
});

test('同一代表被排进时间重叠的两场活动时，确认阶段即被阻止', () => {
  const { scheduler, contactBook, buyerRep, supplierRep } = setupHarness();
  scheduler.addSeat({ activityId: 'act-1', label: 'A1', date: '2026-10-01', start: '09:00', end: '10:00' });
  scheduler.createActivity({ id: 'act-2', name: '投资对接会' });
  scheduler.addSeat({ activityId: 'act-2', label: 'B1', date: '2026-10-01', start: '09:00', end: '10:00' });

  const m1 = proposeAndConfirm(scheduler, buyerRep, supplierRep);
  assert.equal(m1.status, MEETING_STATUS.CONFIRMED);

  // 同一供应代表与另一家买方的重叠会谈
  const otherBuyer = contactBook.authorize('b3', { name: '另一家买方', scope: ['meeting'] });
  const m2 = scheduler.proposeMeeting({
    activityId: 'act-2',
    buyer: { orgId: 'b3', orgName: '另一家' },
    supplier: { orgId: 'supplier', orgName: '供应企业' },
    date: '2026-10-01', start: '09:00', end: '09:30',
  });
  scheduler.confirm(m2.id, otherBuyer.id);
  scheduler.confirm(m2.id, supplierRep.id);
  // 第二场不应占座
  assert.equal(scheduler.get(m2.id).status, MEETING_STATUS.AWAITING);
  assert.equal(scheduler.get(m2.id).seatId, null);
});

test('冲突会谈结束后，被双重预订挡下的会谈自动恢复占座', () => {
  const { scheduler, contactBook, buyerRep, supplierRep } = setupHarness();
  scheduler.addSeat({ activityId: 'act-1', label: 'A1', date: '2026-10-01', start: '09:00', end: '10:00' });
  scheduler.createActivity({ id: 'act-2', name: '投资对接会' });
  scheduler.addSeat({ activityId: 'act-2', label: 'B1', date: '2026-10-01', start: '09:00', end: '10:00' });

  const m1 = proposeAndConfirm(scheduler, buyerRep, supplierRep);
  assert.equal(m1.status, MEETING_STATUS.CONFIRMED);

  const otherBuyer = contactBook.authorize('b3', { name: '另一家买方', scope: ['meeting'] });
  const m2 = scheduler.proposeMeeting({
    activityId: 'act-2',
    buyer: { orgId: 'b3', orgName: '另一家' },
    supplier: { orgId: 'supplier', orgName: '供应企业' },
    date: '2026-10-01', start: '09:00', end: '09:30',
  });
  scheduler.confirm(m2.id, otherBuyer.id);
  scheduler.confirm(m2.id, supplierRep.id);
  assert.equal(scheduler.get(m2.id).status, MEETING_STATUS.AWAITING);

  // 第一场取消后，第二场自动补位到 B1
  scheduler.drainNotifications();
  scheduler.adminCancel(m1.id, '买方行程取消');
  const recovered = scheduler.get(m2.id);
  assert.equal(recovered.status, MEETING_STATUS.CONFIRMED);
  assert.ok(recovered.seatId);
  const notes = scheduler.drainNotifications();
  assert.ok(notes.some((n) => n.template === 'meeting_confirmed' && n.relatedMeetingId === m2.id));
});

test('谢绝会谈释放席位并通知双方', () => {
  const { scheduler, buyerRep, supplierRep } = setupHarness();
  scheduler.addSeat({ activityId: 'act-1', label: 'A1', date: '2026-10-01', start: '09:00', end: '10:00' });
  const meeting = scheduler.proposeMeeting({
    activityId: 'act-1',
    buyer: { orgId: 'buyer', orgName: '采购企业' },
    supplier: { orgId: 'supplier', orgName: '供应企业' },
    date: '2026-10-01', start: '09:00', end: '09:30',
  });
  scheduler.confirm(meeting.id, buyerRep.id);
  scheduler.decline(meeting.id, supplierRep.id, '报价暂不合适');
  assert.equal(scheduler.get(meeting.id).status, MEETING_STATUS.DECLINED);
  const notes = scheduler.drainNotifications();
  // 双方都应收到终态通知
  const orgs = notes.filter((n) => n.template === 'meeting_ended').map((n) => n.to.orgId);
  assert.deepEqual(orgs.sort(), ['buyer', 'supplier']);
});
