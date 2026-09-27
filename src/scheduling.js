// 洽谈资源排程。
//
// 核心规则：
//   - 配对提议不占任何资源；只有双方授权联系人都确认后，才分配一对一洽谈席位。
//   - 席位满时进入该席位的候补队列；已占席位释放后，按候补顺序自动补位并通知。
//   - 同一代表不得在时间重叠的两场活动中同时占座（跨活动防冲突）。
//   - 代表更换、企业改需求、任何一方取消：立即释放席位、通知相关方并尝试候补补位。
//   - 代表一旦被更换，其此前的确认作废，需新代表重新确认（避免「替别人答应」）。

import { dayFromISO } from './util-time.js';

export const MEETING_STATUS = {
  AWAITING: 'awaiting_confirmations', // 已提议，等待双方确认
  AWAITING_SEAT: 'awaiting_seat',     // 双方已确认，但席位已满，候补中
  CONFIRMED: 'confirmed',             // 双方确认且席位已锁定
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
  INVALIDATED: 'invalidated',         // 需求变更等导致配对失效
  HELD: 'held',                       // 会谈已举行
};

export class Scheduler {
  constructor({ contactBook, clock = () => new Date().toISOString() } = {}) {
    if (!contactBook) throw new Error('排程必须接入授权联系人簿');
    this.contactBook = contactBook;
    this.clock = clock;
    this.activities = new Map(); // activityId -> { id, name, kind, seats: [seatId] }
    this.seats = new Map();      // seatId -> { ...seat, booking: meetingId|null }
    this.meetings = new Map();   // meetingId -> meeting
    this.waitlists = new Map();  // seatId -> [meetingId]
    this.notifications = [];
    this._seq = 0;
    this._noteSeq = 0;
  }

  // ---------- 活动与席位 ----------

  createActivity({ id, name, kind = 'one_on_one' }) {
    const activity = { id, name, kind, seats: [] };
    this.activities.set(id, activity);
    return activity;
  }

  addSeat({ activityId, label, date, start, end }) {
    if (!this.activities.has(activityId)) throw new Error(`活动不存在：${activityId}`);
    dayFromISO(date); // 校验日期格式
    if (!start || !end || start >= end) throw new Error(`席位时段无效：${start}-${end}`);
    const id = `seat-${String(++this._seq).padStart(5, '0')}`;
    const seat = { id, activityId, label: label ?? id, date, start, end, booking: null };
    this.seats.set(id, seat);
    this.activities.get(activityId).seats.push(id);
    this.waitlists.set(id, []);
    return seat;
  }

  // ---------- 通知 ----------

  notify(to, template, vars, meetingId = null) {
    const note = {
      id: `note-${String(++this._noteSeq).padStart(6, '0')}`,
      at: this.clock(),
      to, // { orgId, contactId? }
      template,
      vars,
      relatedMeetingId: meetingId,
    };
    this.notifications.push(note);
    return note;
  }

  notifyParties(meeting, template, vars = {}) {
    for (const side of ['buyer', 'supplier']) {
      const p = meeting[side];
      this.notify({ orgId: p.orgId, contactId: p.contactId ?? null }, template, {
        ...vars,
        counterpart: meeting[side === 'buyer' ? 'supplier' : 'buyer'].orgName,
        meetingId: meeting.id,
      }, meeting.id);
    }
  }

  drainNotifications() {
    const out = this.notifications;
    this.notifications = [];
    return out;
  }

  // ---------- 配对提议与确认 ----------

  // 发起一对一会谈提议。此时不占席位。
  proposeMeeting({ activityId, buyer, supplier, demandId, date, start, end, seats }) {
    if (!this.activities.has(activityId)) throw new Error(`活动不存在：${activityId}`);
    const buyerContact = this.contactBook.findAuthorized(buyer.orgId, 'meeting');
    const supplierContact = this.contactBook.findAuthorized(supplier.orgId, 'meeting');
    if (!buyerContact) throw new Error(`${buyer.orgName} 没有具备洽谈授权的有效联系人`);
    if (!supplierContact) throw new Error(`${supplier.orgName} 没有具备洽谈授权的有效联系人`);

    const id = `mtg-${String(++this._seq).padStart(5, '0')}`;
    const meeting = {
      id,
      activityId,
      demandId: demandId ?? null,
      buyer: { orgId: buyer.orgId, orgName: buyer.orgName, contactId: buyerContact.id },
      supplier: { orgId: supplier.orgId, orgName: supplier.orgName, contactId: supplierContact.id },
      window: { date, start, end },
      status: MEETING_STATUS.AWAITING,
      confirmedBy: {}, // contactId -> 确认时间
      seatId: null,
      history: [{ at: this.clock(), event: 'proposed' }],
      declineReason: null,
    };
    this.meetings.set(id, meeting);
    this.notifyParties(meeting, 'meeting_proposed', {
      activity: this.activities.get(activityId).name,
      window: `${date} ${start}-${end}`,
    });
    // 允许提议时直接指定候选席位偏好（用于候补排队）
    meeting.preferredSeatIds = seats ?? this._candidateSeats(meeting).map((s) => s.id);
    return meeting;
  }

  // 一方授权联系人确认。双方都确认时才尝试占座。
  confirm(meetingId, contactId) {
    const meeting = this._requireMeeting(meetingId);
    const contact = this.contactBook.get(contactId);
    if (!contact) throw new Error('联系人不存在');
    const side = this._sideOf(meeting, contact);
    if (!side) throw new Error('该联系人不属于本会谈的任何一方');
    if (!contact.active) throw new Error('该联系人授权已失效（可能已被更换）');
    if (!contact.scope.includes('meeting')) throw new Error('该联系人无洽谈授权');

    if (meeting.status === MEETING_STATUS.DECLINED || meeting.status === MEETING_STATUS.CANCELLED
      || meeting.status === MEETING_STATUS.INVALIDATED || meeting.status === MEETING_STATUS.HELD) {
      throw new Error(`会谈已处于终态 ${meeting.status}，不能确认`);
    }

    meeting.confirmedBy[contactId] = this.clock();
    meeting.history.push({ at: this.clock(), event: 'confirmed', by: contactId });
    this.notifyParties(meeting, 'meeting_party_confirmed', { who: contact.name });

    const both = this._bothConfirmed(meeting);
    if (!both) return meeting;

    return this._tryAssign(meeting);
  }

  // 联系人若已被接替，确认自动转到继任者并保留（继任者需在自己确认时重新表达）。
  _bothConfirmed(meeting) {
    const required = [meeting.buyer.contactId, meeting.supplier.contactId];
    return required.every((cid) => {
      const c = this.contactBook.get(cid);
      return c && c.active && meeting.confirmedBy[cid];
    });
  }

  _tryAssign(meeting) {
    // 二次授权校验：双方当前代表仍有效。
    for (const side of ['buyer', 'supplier']) {
      const c = this.contactBook.get(meeting[side].contactId);
      if (!c || !c.active || !c.scope.includes('meeting')) {
        // 代表中途失效：回到等待确认状态并通知。
        this._resetConfirmation(meeting, `${side} 方代表授权已失效，请由新代表确认`);
        return meeting;
      }
    }

    const conflict = this._findDoubleBooking(meeting);
    if (conflict) {
      // 同一冲突只记录并通知一次，避免恢复重试时重复打扰。
      const alreadyBlocked = meeting.history.some(
        (h) => h.event === 'double_booking_blocked' && h.conflict === conflict.id,
      );
      meeting.status = MEETING_STATUS.AWAITING;
      if (!alreadyBlocked) {
        meeting.history.push({ at: this.clock(), event: 'double_booking_blocked', conflict: conflict.id });
        this.notifyParties(meeting, 'meeting_double_booking', {
          other: conflict.id,
          otherWindow: `${conflict.window.date} ${conflict.window.start}-${conflict.window.end}`,
        });
      }
      return meeting;
    }

    const seat = this._findFreeSeat(meeting);
    if (!seat) {
      const wasWaiting = meeting.status === MEETING_STATUS.AWAITING_SEAT;
      meeting.status = MEETING_STATUS.AWAITING_SEAT;
      for (const seatId of meeting.preferredSeatIds ?? []) {
        const q = this.waitlists.get(seatId);
        if (q && !q.includes(meeting.id)) q.push(meeting.id);
      }
      if (!wasWaiting) {
        meeting.history.push({ at: this.clock(), event: 'waitlisted' });
        this.notifyParties(meeting, 'meeting_waitlisted');
      }
      return meeting;
    }

    this._occupy(meeting, seat);
    return meeting;
  }

  _occupy(meeting, seat) {
    seat.booking = meeting.id;
    meeting.seatId = seat.id;
    meeting.status = MEETING_STATUS.CONFIRMED;
    meeting.history.push({ at: this.clock(), event: 'seat_assigned', seatId: seat.id });
    this.notifyParties(meeting, 'meeting_confirmed', {
      seat: seat.label,
      window: `${meeting.window.date} ${meeting.window.start}-${meeting.window.end}`,
    });
  }

  // 一方谢绝 / 取消（终态前均可）。
  decline(meetingId, contactId, reason = '') {
    const meeting = this._requireMeeting(meetingId);
    const contact = this.contactBook.get(contactId);
    if (!contact || !this._sideOf(meeting, contact)) throw new Error('非会谈方不能谢绝');
    this._terminate(meeting, MEETING_STATUS.DECLINED, reason || '一方谢绝', 'declined');
    return meeting;
  }

  // 秘书处因特殊原因取消。
  adminCancel(meetingId, reason) {
    const meeting = this._requireMeeting(meetingId);
    this._terminate(meeting, MEETING_STATUS.CANCELLED, reason, 'admin_cancelled');
    return meeting;
  }

  _terminate(meeting, status, reason, event) {
    meeting.status = status;
    meeting.declineReason = reason;
    meeting.history.push({ at: this.clock(), event, reason });
    this._releaseSeat(meeting);
    this._removeFromWaitlists(meeting);
    this.notifyParties(meeting, 'meeting_ended', { status, reason });
    // 资源恢复后，此前被双重预订挡下的会谈可以重试。
    this._retryBlockedMeetings();
  }

  // ---------- 变更：代表更换 / 需求变更 / 多活动冲突 ----------

  // 代表更换后由平台调用：该代表此前的确认全部作废；已占席位立即释放。
  onContactReplaced(orgId, oldContactId, newContactId) {
    const affected = [];
    for (const meeting of this.meetings.values()) {
      if (meeting.status === MEETING_STATUS.HELD) continue;
      const sides = [meeting.buyer, meeting.supplier];
      const side = sides.find((s) => s.orgId === orgId && s.contactId === oldContactId);
      if (!side) continue;

      side.contactId = newContactId;
      for (const key of Object.keys(meeting.confirmedBy)) delete meeting.confirmedBy[key];

      if (meeting.status === MEETING_STATUS.CONFIRMED) {
        this._releaseSeat(meeting);
        meeting.status = MEETING_STATUS.AWAITING;
        meeting.history.push({ at: this.clock(), event: 'rep_changed_seat_released', oldContactId, newContactId });
        this.notifyParties(meeting, 'meeting_rep_changed', {
          reason: '原代表被更换，席位已释放，需双方新代表重新确认',
        });
      } else if (meeting.status === MEETING_STATUS.AWAITING_SEAT) {
        this._removeFromWaitlists(meeting);
        meeting.status = MEETING_STATUS.AWAITING;
        meeting.history.push({ at: this.clock(), event: 'rep_changed_waitlist_removed' });
        this.notifyParties(meeting, 'meeting_rep_changed', { reason: '代表更换，需重新确认' });
      }
      affected.push(meeting.id);
    }
    return affected;
  }

  // 企业修改/撤销某条需求：关联的未举行会谈全部失效并释放资源。
  // 也可指定 buyerOrgId + supplierOrgId 范围。
  invalidateByDemand(orgId, demandId, reason = '需求条件已变更，原配对失效') {
    const affected = [];
    for (const meeting of this.meetings.values()) {
      if (meeting.demandId !== demandId) continue;
      if (meeting.buyer.orgId !== orgId && meeting.supplier.orgId !== orgId) continue;
      if ([MEETING_STATUS.HELD, MEETING_STATUS.INVALIDATED, MEETING_STATUS.DECLINED, MEETING_STATUS.CANCELLED].includes(meeting.status)) continue;
      this._terminate(meeting, MEETING_STATUS.INVALIDATED, reason, 'demand_changed');
      affected.push(meeting.id);
    }
    return affected;
  }

  // 检查某企业（代表）当前是否已在重叠活动占座；如有则释放较晚提议的一场并通知。
  resolveDoubleBookings(orgId, { keep } = {}) {
    const confirmed = [...this.meetings.values()].filter(
      (m) => m.status === MEETING_STATUS.CONFIRMED && (m.buyer.orgId === orgId || m.supplier.orgId === orgId),
    );
    const released = [];
    for (let i = 0; i < confirmed.length; i++) {
      for (let j = i + 1; j < confirmed.length; j++) {
        if (!this._windowsOverlap(confirmed[i].window, confirmed[j].window)) continue;
        const victim = keep && confirmed.some((m) => m.id === keep)
          ? (confirmed[i].id === keep ? confirmed[j] : confirmed[i])
          : confirmed[j];
        if (![MEETING_STATUS.CONFIRMED].includes(victim.status)) continue;
        this._terminate(victim, MEETING_STATUS.CANCELLED, '与另一场活动时间冲突，席位已自动释放', 'double_booking_resolved');
        released.push(victim.id);
      }
    }
    return released;
  }

  // ---------- 席位查询与候补补位 ----------

  _candidateSeats(meeting) {
    return [...this.seats.values()].filter(
      (s) => s.activityId === meeting.activityId
        && s.date === meeting.window.date
        && s.start <= meeting.window.start && s.end >= meeting.window.end,
    );
  }

  _findFreeSeat(meeting) {
    const candidates = meeting.preferredSeatIds
      ? meeting.preferredSeatIds.map((id) => this.seats.get(id)).filter(Boolean)
      : this._candidateSeats(meeting);
    return candidates.find((s) => s.booking === null) ?? null;
  }

  // 同一代表在重叠窗口已有确认占座 → 返回冲突会谈。
  _findDoubleBooking(meeting) {
    for (const other of this.meetings.values()) {
      if (other.id === meeting.id || other.status !== MEETING_STATUS.CONFIRMED) continue;
      if (!this._windowsOverlap(other.window, meeting.window)) continue;
      const people = [meeting.buyer.contactId, meeting.supplier.contactId];
      if (people.includes(other.buyer.contactId) || people.includes(other.supplier.contactId)) {
        return other;
      }
    }
    return null;
  }

  _windowsOverlap(a, b) {
    return a.date === b.date && a.start < b.end && b.start < a.end;
  }

  _releaseSeat(meeting) {
    if (!meeting.seatId) return;
    const seat = this.seats.get(meeting.seatId);
    if (seat && seat.booking === meeting.id) {
      seat.booking = null;
      meeting.seatId = null;
      this._promoteWaitlist(seat);
    }
  }

  // 任何会谈结束后调用：让此前因双重预订被挡下的、双方已确认的会谈重试占座。
  _retryBlockedMeetings() {
    for (const meeting of this.meetings.values()) {
      if (meeting.status !== MEETING_STATUS.AWAITING) continue;
      if (!this._bothConfirmed(meeting)) continue;
      if (!meeting.history.some((h) => h.event === 'double_booking_blocked')) continue;
      this._tryAssign(meeting);
    }
  }

  _promoteWaitlist(seat) {
    const q = this.waitlists.get(seat.id);
    while (q?.length) {
      const meetingId = q.shift();
      const meeting = this.meetings.get(meetingId);
      if (!meeting) continue;
      if (meeting.status !== MEETING_STATUS.AWAITING_SEAT) continue;
      if (!this._bothConfirmed(meeting)) {
        meeting.status = MEETING_STATUS.AWAITING;
        meeting.history.push({ at: this.clock(), event: 'waitlist_expired_confirmation' });
        continue;
      }
      const conflict = this._findDoubleBooking(meeting);
      if (conflict) continue; // 跳过，仍可被后续释放事件重试
      this._occupy(meeting, seat);
      return;
    }
  }

  _removeFromWaitlists(meeting) {
    for (const [seatId, q] of this.waitlists) {
      this.waitlists.set(seatId, q.filter((id) => id !== meeting.id));
    }
  }

  _resetConfirmation(meeting, reason) {
    meeting.confirmedBy = {};
    meeting.status = MEETING_STATUS.AWAITING;
    if (meeting.seatId) this._releaseSeat(meeting);
    meeting.history.push({ at: this.clock(), event: 'confirmation_reset', reason });
    this.notifyParties(meeting, 'meeting_reconfirm_needed', { reason });
  }

  // ---------- 会谈举行与查询 ----------

  markHeld(meetingId) {
    const meeting = this._requireMeeting(meetingId);
    if (meeting.status !== MEETING_STATUS.CONFIRMED) throw new Error('只有已确认占座的会谈可标记为举行');
    meeting.status = MEETING_STATUS.HELD;
    meeting.history.push({ at: this.clock(), event: 'held' });
    return meeting;
  }

  // 定时清理：超过截止时间仍未双方确认的提议自动取消（本就未占座，仅通知）。
  expireBefore(datetimeISO) {
    const expired = [];
    for (const meeting of this.meetings.values()) {
      if (meeting.status !== MEETING_STATUS.AWAITING && meeting.status !== MEETING_STATUS.AWAITING_SEAT) continue;
      const proposedAt = meeting.history[0]?.at;
      if (proposedAt && proposedAt < datetimeISO) {
        this._terminate(meeting, MEETING_STATUS.CANCELLED, '超过确认时限未获双方确认', 'expired');
        expired.push(meeting.id);
      }
    }
    return expired;
  }

  meetingsFor(orgId) {
    return [...this.meetings.values()].filter(
      (m) => m.buyer.orgId === orgId || m.supplier.orgId === orgId,
    );
  }

  _sideOf(meeting, contact) {
    if (meeting.buyer.orgId === contact.orgId) return 'buyer';
    if (meeting.supplier.orgId === contact.orgId) return 'supplier';
    return null;
  }

  _requireMeeting(meetingId) {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`会谈不存在：${meetingId}`);
    return meeting;
  }

  get(meetingId) {
    return this.meetings.get(meetingId);
  }
}
