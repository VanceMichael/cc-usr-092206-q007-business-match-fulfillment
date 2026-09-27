// 洽谈排程：一对一席位只在双方确认后占用；
// 代表更换、需求变更、时段冲突时及时释放资源并通知相关方，空出席位自动补给等待中的会议。

const RELEASE_REASON_TEXT = {
  schedule_conflict: '时段冲突',
  demand_changed: '需求变更',
  representative_unavailable: '代表不可用',
  cancelled: '主动取消',
};

export function createScheduler({ nextId, clock, notify, registry, records }) {
  const seats = new Map();
  const meetings = new Map();
  const waitingQueue = [];

  const reasonText = (reason) => RELEASE_REASON_TEXT[reason] ?? reason;
  const partyContacts = (m) => [`contact:${m.parties.supplier.contactId}`, `contact:${m.parties.demander.contactId}`];
  const partyContactsAndSecretariat = (m) => [...partyContacts(m), 'secretariat'];

  function removeFromQueue(id) {
    const i = waitingQueue.indexOf(id);
    if (i >= 0) waitingQueue.splice(i, 1);
  }

  function addSeat({ room, slots }) {
    if (!room || !Array.isArray(slots) || slots.length === 0) throw new Error('席位需要会议室与时段列表');
    const seat = { id: nextId('SEAT'), room, slots: [...slots], bookings: {} };
    seats.set(seat.id, seat);
    promoteWaiting();
    return seat;
  }

  function mustMeeting(id) {
    const m = meetings.get(id);
    if (!m) throw new Error(`会议不存在：${id}`);
    return m;
  }

  function assertCandidateFresh(candidate) {
    const supply = records.get(candidate.supplyRecordId);
    const demand = records.get(candidate.demandRecordId);
    if (supply.status !== 'open' || demand.status !== 'open') throw new Error('候选已失效：相关供需记录已关闭');
    if (supply.version !== candidate.versions.supply || demand.version !== candidate.versions.demand) {
      throw new Error('候选已失效：需求已变更，请重新匹配');
    }
  }

  function sideOf(m, enterpriseId) {
    if (m.parties.supplier.enterpriseId === enterpriseId) return 'supplier';
    if (m.parties.demander.enterpriseId === enterpriseId) return 'demander';
    return null;
  }

  function proposeMeeting({ candidate, slot, contacts }) {
    assertCandidateFresh(candidate);
    if (!candidate.commonSlots.includes(slot)) throw new Error(`时段 ${slot} 不在双方共同可用时段内`);
    registry.assertContact(candidate.supplierEnterpriseId, contacts.supplierContactId, 'confirm_meeting');
    registry.assertContact(candidate.demanderEnterpriseId, contacts.demanderContactId, 'confirm_meeting');
    const meeting = {
      id: nextId('MTG'),
      candidateId: candidate.id,
      supplyRecordId: candidate.supplyRecordId,
      demandRecordId: candidate.demandRecordId,
      versions: { ...candidate.versions },
      slot,
      seatId: null,
      parties: {
        supplier: { enterpriseId: candidate.supplierEnterpriseId, contactId: contacts.supplierContactId },
        demander: { enterpriseId: candidate.demanderEnterpriseId, contactId: contacts.demanderContactId },
      },
      confirmations: { supplier: null, demander: null },
      status: 'pending',
      releaseReason: null,
      createdAt: clock(),
      updatedAt: clock(),
    };
    meetings.set(meeting.id, meeting);
    notify.send({
      to: partyContacts(meeting),
      type: 'meeting_proposed',
      message: `一对一会谈 ${meeting.id} 已提议（时段 ${slot}），等待双方确认；双方确认后才会占用洽谈席位`,
      refs: { meetingId: meeting.id, candidateId: candidate.id },
    });
    return meeting;
  }

  function confirmMeeting(meetingId, enterpriseId, contactId) {
    const m = mustMeeting(meetingId);
    if (m.status !== 'pending') throw new Error(`会议 ${meetingId} 当前状态为 ${m.status}，不能确认`);
    const side = sideOf(m, enterpriseId);
    if (!side) throw new Error(`企业 ${enterpriseId} 不是会议 ${meetingId} 的参与方`);
    registry.assertContact(enterpriseId, contactId, 'confirm_meeting');
    // 确认前再校验需求版本；若已变更则自动释放并告知。
    try {
      assertCandidateFresh({ supplyRecordId: m.supplyRecordId, demandRecordId: m.demandRecordId, versions: m.versions });
    } catch (err) {
      releaseMeeting(meetingId, 'demand_changed', '确认时检测到需求已变更');
      throw err;
    }
    m.confirmations[side] = { contactId, at: clock() };
    m.parties[side].contactId = contactId; // 最新确认人即出席代表
    m.updatedAt = clock();
    if (m.confirmations.supplier && m.confirmations.demander) allocate(m);
    return m;
  }

  // 双方确认后才尝试占用席位。
  function allocate(m) {
    const conflict = [...meetings.values()].find(
      (o) =>
        o.id !== m.id &&
        o.status === 'scheduled' &&
        o.slot === m.slot &&
        [o.parties.supplier.enterpriseId, o.parties.demander.enterpriseId].some(
          (id) => id === m.parties.supplier.enterpriseId || id === m.parties.demander.enterpriseId,
        ),
    );
    if (conflict) {
      releaseMeeting(m.id, 'schedule_conflict', `企业同时段已安排会议 ${conflict.id}，不能重复占用`);
      return;
    }
    const seat = [...seats.values()].find((s) => s.slots.includes(m.slot) && !s.bookings[m.slot]);
    if (!seat) {
      m.status = 'awaiting_seat';
      if (!waitingQueue.includes(m.id)) waitingQueue.push(m.id);
      notify.send({
        to: partyContactsAndSecretariat(m),
        type: 'meeting_awaiting_seat',
        message: `会议 ${m.id} 双方已确认，时段 ${m.slot} 暂无空闲席位，已进入等待队列`,
        refs: { meetingId: m.id },
      });
      return;
    }
    seat.bookings[m.slot] = m.id;
    m.seatId = seat.id;
    m.status = 'scheduled';
    m.updatedAt = clock();
    notify.send({
      to: partyContactsAndSecretariat(m),
      type: 'meeting_scheduled',
      message: `会议 ${m.id} 已排定：${seat.room}，时段 ${m.slot}`,
      refs: { meetingId: m.id, seatId: seat.id },
    });
  }

  function releaseMeeting(meetingId, reason, detail = '') {
    const m = mustMeeting(meetingId);
    if (m.status === 'released' || m.status === 'completed') return m;
    if (m.seatId) {
      const seat = seats.get(m.seatId);
      if (seat) delete seat.bookings[m.slot];
      m.seatId = null;
    }
    removeFromQueue(m.id);
    m.status = 'released';
    m.releaseReason = reason;
    m.updatedAt = clock();
    notify.send({
      to: partyContactsAndSecretariat(m),
      type: 'meeting_released',
      message: `会议 ${m.id} 已释放（${reasonText(reason)}）${detail ? `：${detail}` : ''}，所占资源已回收`,
      refs: { meetingId: m.id, reason },
    });
    promoteWaiting();
    return m;
  }

  function completeMeeting(meetingId) {
    const m = mustMeeting(meetingId);
    if (m.status !== 'scheduled') throw new Error(`会议 ${meetingId} 未排定，不能标记完成`);
    if (m.seatId) {
      const seat = seats.get(m.seatId);
      if (seat) delete seat.bookings[m.slot];
      m.seatId = null;
    }
    m.status = 'completed';
    m.updatedAt = clock();
    notify.send({
      to: partyContactsAndSecretariat(m),
      type: 'meeting_completed',
      message: `会议 ${m.id} 已完成，会后事项将沿同一合作关系继续推进`,
      refs: { meetingId: m.id },
    });
    promoteWaiting();
    return m;
  }

  // 空出席位时，按等待顺序补给已确认的会议。
  function promoteWaiting() {
    for (const id of [...waitingQueue]) {
      const m = meetings.get(id);
      if (!m || m.status !== 'awaiting_seat') {
        removeFromQueue(id);
        continue;
      }
      allocate(m);
      if (m.status !== 'awaiting_seat') removeFromQueue(id);
    }
  }

  // 需求变更：释放所有引用该记录的未完结会议，资源回收并通知双方。
  function handleRecordUpdated(recordId, byEnterpriseId) {
    const released = [];
    for (const m of meetings.values()) {
      if (
        (m.supplyRecordId === recordId || m.demandRecordId === recordId) &&
        ['pending', 'awaiting_seat', 'scheduled'].includes(m.status)
      ) {
        releaseMeeting(m.id, 'demand_changed', `企业 ${byEnterpriseId} 更新了供需记录 ${recordId}`);
        released.push(m);
      }
    }
    return released;
  }

  // 代表临时更换：待确认的会议重置该方确认；已排定的会议由新代表接续，
  // 新代表无确认权限或授权已失效时释放会议并通知相关方。
  function handleContactReplaced(enterpriseId, oldContactId, newContactId) {
    const affected = [];
    for (const m of meetings.values()) {
      if (!['pending', 'awaiting_seat', 'scheduled'].includes(m.status)) continue;
      const side = sideOf(m, enterpriseId);
      if (!side) continue;
      const involved =
        m.parties[side].contactId === oldContactId || m.confirmations[side]?.contactId === oldContactId;
      if (!involved) continue;

      if (m.status === 'pending') {
        m.confirmations[side] = null;
        m.parties[side].contactId = newContactId;
        m.updatedAt = clock();
        notify.send({
          to: partyContactsAndSecretariat(m),
          type: 'representative_replaced',
          message: `会议 ${m.id} 一方代表已更换（${oldContactId} → ${newContactId}），该方需重新确认`,
          refs: { meetingId: m.id },
        });
        affected.push({ meeting: m, action: 'reconfirm' });
        continue;
      }

      if (registry.isContactUsable(newContactId, 'confirm_meeting')) {
        m.parties[side].contactId = newContactId;
        m.updatedAt = clock();
        notify.send({
          to: partyContactsAndSecretariat(m),
          type: 'representative_replaced',
          message: `会议 ${m.id} 出席代表已更换为 ${newContactId}，会议照常进行`,
          refs: { meetingId: m.id },
        });
        affected.push({ meeting: m, action: 'reassigned' });
      } else {
        releaseMeeting(m.id, 'representative_unavailable', `新代表 ${newContactId} 无确认权限或授权已失效`);
        affected.push({ meeting: m, action: 'released' });
      }
    }
    return affected;
  }

  function seatUtilization() {
    let total = 0;
    let booked = 0;
    for (const s of seats.values()) {
      total += s.slots.length;
      booked += Object.keys(s.bookings).length;
    }
    return { total, booked, free: total - booked };
  }

  return {
    addSeat,
    proposeMeeting,
    confirmMeeting,
    releaseMeeting,
    completeMeeting,
    handleRecordUpdated,
    handleContactReplaced,
    getMeeting: mustMeeting,
    listMeetings: () => [...meetings.values()],
    getSeat: (id) => seats.get(id),
    seatUtilization,
  };
}
