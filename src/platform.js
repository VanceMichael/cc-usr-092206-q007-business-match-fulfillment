// 平台门面：把主体治理、可解释匹配、排程、履约串成一条全年运营流水线。
//
// 典型流程：
//   ingestOrganizations → authorizeContact → recommend → proposeMeeting
//   → 双方 confirm（此刻才占座）→ markHeld → openRelation → addMatter …
//   → sign / terminate（主办方只见终态与原因）

import { OrganizationRegistry, ContactBook } from './identity.js';
import { EmbargoRegistry, evaluateMatch, recommendForDemand } from './matching.js';
import { Scheduler, MEETING_STATUS } from './scheduling.js';
import { FulfillmentLedger, RELATION_STATUS } from './fulfillment.js';

export class MatchPlatform {
  constructor({ clock } = {}) {
    this.clock = clock ?? (() => new Date().toISOString());
    this.registry = new OrganizationRegistry();
    this.contacts = new ContactBook();
    this.embargo = new EmbargoRegistry();
    this.scheduler = new Scheduler({ contactBook: this.contacts, clock: this.clock });
    this.ledger = new FulfillmentLedger({ contactBook: this.contacts, clock: this.clock });
  }

  // ---------- 主体与联系人 ----------

  // 批量导入企业资料（峰会后的 4700+ 条供需信息即由此进入）。
  // 返回 { organizations, merged, pendingReview } 供秘书处复核。
  ingestOrganizations(records) {
    const organizations = [];
    const merged = [];
    const pendingReview = [];
    for (const record of records) {
      const result = this.registry.register(record);
      organizations.push(result.org);
      if (result.merged) merged.push({ into: result.org.id, source: record.sourceRef ?? record.name });
      if (result.pending) pendingReview.push(result.pending);
    }
    return { organizations, merged, pendingReview };
  }

  authorizeContact(orgId, contact) {
    return this.contacts.authorize(orgId, contact);
  }

  // 代表临时更换：登记继任者，并让排程释放其占有的资源、作废其确认。
  replaceRepresentative(orgId, oldContactId, replacement) {
    const successor = this.contacts.replace(orgId, oldContactId, replacement);
    const affectedMeetings = this.scheduler.onContactReplaced(orgId, oldContactId, successor.id);
    return { successor, affectedMeetings };
  }

  // ---------- 匹配 ----------

  // 为某企业的某条需求给出带理由的候选清单。
  recommend(buyerOrgId, demandId, { limit = 10 } = {}) {
    const buyer = this.registry.get(buyerOrgId);
    if (!buyer) throw new Error(`主体不存在：${buyerOrgId}`);
    const demand = buyer.demands.find((d) => d.id === demandId);
    if (!demand) throw new Error(`需求不存在：${demandId}`);
    return recommendForDemand({
      demand,
      buyer,
      registry: this.registry,
      embargo: this.embargo,
      contactBook: this.contacts,
      limit,
      historyOf: (a, b) => this._cooperationCount(a, b),
    });
  }

  // 单对评估（用于解释「为什么这两家没被配上」）。
  explain(buyerOrgId, demandId, supplierOrgId) {
    const buyer = this.registry.get(buyerOrgId);
    const supplier = this.registry.get(supplierOrgId);
    if (!buyer || !supplier) throw new Error('主体不存在');
    const demand = buyer.demands.find((d) => d.id === demandId);
    if (!demand) throw new Error(`需求不存在：${demandId}`);
    return evaluateMatch({
      demand,
      buyer,
      supplier,
      embargo: this.embargo,
      contactBook: this.contacts,
      priorCooperations: this._cooperationCount(buyerOrgId, supplierOrgId),
    });
  }

  _cooperationCount(orgA, orgB) {
    let count = 0;
    for (const rel of this.ledger.relations.values()) {
      const pair = [rel.buyerOrgId, rel.supplierOrgId];
      if (pair.includes(orgA) && pair.includes(orgB)) count += 1;
    }
    return count;
  }

  // ---------- 排程 ----------

  createActivity(input) {
    return this.scheduler.createActivity(input);
  }

  addSeat(input) {
    return this.scheduler.addSeat(input);
  }

  // 发起会谈提议（不占座）。
  proposeMeeting({ activityId, buyerOrgId, supplierOrgId, demandId, date, start, end }) {
    const buyer = this.registry.get(buyerOrgId);
    const supplier = this.registry.get(supplierOrgId);
    if (!buyer || !supplier) throw new Error('会谈主体不存在');
    return this.scheduler.proposeMeeting({
      activityId,
      buyer: { orgId: buyer.id, orgName: buyer.name },
      supplier: { orgId: supplier.id, orgName: supplier.name },
      demandId,
      date,
      start,
      end,
    });
  }

  confirmMeeting(meetingId, contactId) {
    return this.scheduler.confirm(meetingId, contactId);
  }

  declineMeeting(meetingId, contactId, reason) {
    return this.scheduler.decline(meetingId, contactId, reason);
  }

  // 企业改需求：更新资料，并使关联的未举行会谈失效、释放席位、通知双方。
  changeDemand(orgId, demandId, patch, reason) {
    const org = this.registry.get(orgId);
    if (!org) throw new Error(`主体不存在：${orgId}`);
    const demand = org.demands.find((d) => d.id === demandId);
    if (!demand) throw new Error(`需求不存在：${demandId}`);
    Object.assign(demand, patch);
    const invalidated = this.scheduler.invalidateByDemand(
      orgId,
      demandId,
      reason ?? '需求条件已变更，原配对失效',
    );
    return { demand, invalidatedMeetings: invalidated };
  }

  withdrawDemand(orgId, demandId, reason = '需求已撤销') {
    const org = this.registry.get(orgId);
    if (!org) throw new Error(`主体不存在：${orgId}`);
    org.demands = org.demands.filter((d) => d.id !== demandId);
    const invalidated = this.scheduler.invalidateByDemand(orgId, demandId, reason);
    return { invalidatedMeetings: invalidated };
  }

  // 某企业被同时安排进多场重叠活动时调用：释放冲突资源并通知。
  resolveDoubleBookings(orgId, options) {
    return this.scheduler.resolveDoubleBookings(orgId, options);
  }

  markMeetingHeld(meetingId) {
    const meeting = this.scheduler.markHeld(meetingId);
    // 会谈举行即建立合作关系，会后事项沿同一关系推进。
    const relation = this.ledger.openRelation({
      buyerOrgId: meeting.buyer.orgId,
      supplierOrgId: meeting.supplier.orgId,
      meetingId: meeting.id,
      demandId: meeting.demandId,
    });
    return { meeting, relation };
  }

  // ---------- 履约 ----------

  get ledgerApi() {
    return this.ledger;
  }

  // ---------- 视图 ----------

  // 主办方：只见签约、明确终止及原因。
  organizerDashboard() {
    return this.ledger.organizerView();
  }

  // 企业：下一行动与当前责任人。
  enterpriseDashboard(relationId, orgId) {
    return this.ledger.enterpriseView(relationId, orgId);
  }

  drainNotifications() {
    return this.scheduler.drainNotifications();
  }
}

export { MEETING_STATUS, RELATION_STATUS };
