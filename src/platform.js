// 平台门面：把主体治理、供需记录、可解释匹配、洽谈排程、会后履约与通知串成一条主线。
import { createIdGenerator } from './ids.js';
import { createNotificationCenter } from './notifications.js';
import { createRegistry } from './registry.js';
import { createRecordStore } from './records.js';
import { generateCandidates } from './matching.js';
import { createScheduler } from './scheduling.js';
import { createFulfillment } from './fulfillment.js';

export function createPlatform({ clock = () => new Date().toISOString() } = {}) {
  const nextId = createIdGenerator();
  const notify = createNotificationCenter({ nextId, clock });
  const registry = createRegistry({ nextId, clock });
  const records = createRecordStore({ nextId, clock });
  const scheduler = createScheduler({ nextId, clock, notify, registry, records });
  const fulfillment = createFulfillment({ nextId, clock, notify, registry });
  const exclusions = [];
  const candidates = new Map();

  // 合并重复主体：注册信息合并之外，还要把供需记录迁到主主体名下并告知秘书处。
  function mergeEnterprises(masterId, duplicateId, reason = '') {
    const master = registry.mergeEnterprises(masterId, duplicateId, reason);
    const moved = records.reassignEnterprise(duplicateId, masterId);
    notify.send({
      to: ['secretariat'],
      type: 'enterprise_merged',
      message: `重复主体已合并：${duplicateId} 并入 ${masterId}，迁移供需记录 ${moved} 条`,
      refs: { masterId, duplicateId },
    });
    return master;
  }

  function runMatching({ collectRejections = false } = {}) {
    const active = new Map(
      registry.listEnterprises().filter((e) => e.status === 'active').map((e) => [e.id, e]),
    );
    const open = records.list({ status: 'open' }).filter((r) => active.has(r.enterpriseId));
    const result = generateCandidates({
      supplies: open.filter((r) => r.kind === 'supply'),
      demands: open.filter((r) => r.kind === 'demand'),
      enterprisesById: active,
      exclusions,
      collectRejections,
    });
    candidates.clear();
    for (const c of result.candidates) candidates.set(c.id, c);
    return result;
  }

  function proposeMeeting(candidateId, slot, contacts) {
    const candidate = candidates.get(candidateId);
    if (!candidate) throw new Error(`候选 ${candidateId} 不存在或已失效，请重新运行匹配`);
    return scheduler.proposeMeeting({ candidate, slot, contacts });
  }

  // 企业改需求：升版本 → 释放相关会议并通知 → 重新匹配生成新候选。
  function updateDemand(recordId, changes, byContactId) {
    const record = records.get(recordId);
    registry.assertContact(record.enterpriseId, byContactId, 'update_demand');
    const updated = records.update(recordId, changes);
    const released = scheduler.handleRecordUpdated(recordId, record.enterpriseId);
    const result = runMatching();
    const fresh = result.candidates.filter((c) => c.supplyRecordId === recordId || c.demandRecordId === recordId);
    notify.send({
      to: [`enterprise:${record.enterpriseId}`, 'secretariat'],
      type: 'demand_updated',
      message: `供需记录 ${recordId} 已更新为第 ${updated.record.version} 版：释放会议 ${released.length} 场，生成新候选 ${fresh.length} 条`,
      refs: { recordId },
    });
    return { record: updated.record, released, newCandidates: fresh };
  }

  // 代表临时更换：注册新代表，排程层接续或释放受影响会议并通知相关方。
  function replaceContact(enterpriseId, oldContactId, input) {
    const { oldContact, newContact } = registry.replaceContact(enterpriseId, oldContactId, input);
    const affected = scheduler.handleContactReplaced(enterpriseId, oldContactId, newContact.id);
    notify.send({
      to: ['secretariat', `enterprise:${enterpriseId}`],
      type: 'representative_replaced',
      message: `企业 ${enterpriseId} 代表由 ${oldContact.name} 更换为 ${newContact.name}，受影响会议 ${affected.length} 场`,
      refs: { enterpriseId, oldContactId, newContactId: newContact.id },
    });
    return { oldContact, newContact, affected };
  }

  // 会谈完成：自动建立合作关系，会后事项沿同一关系推进。
  function completeMeeting(meetingId) {
    const meeting = scheduler.completeMeeting(meetingId);
    const relationship = fulfillment.openRelationship({
      meetingId,
      parties: [meeting.parties.supplier.enterpriseId, meeting.parties.demander.enterpriseId],
      owners: {
        [meeting.parties.supplier.enterpriseId]: meeting.parties.supplier.contactId,
        [meeting.parties.demander.enterpriseId]: meeting.parties.demander.contactId,
      },
    });
    return { meeting, relationship };
  }

  return {
    clock,
    registry,
    records,
    scheduler,
    fulfillment,
    notify,
    addExclusion: (a, b, reason) => exclusions.push({ a, b, reason }),
    runMatching,
    listCandidates: () => [...candidates.values()],
    getCandidate: (id) => candidates.get(id),
    proposeMeeting,
    confirmMeeting: (meetingId, enterpriseId, contactId) => scheduler.confirmMeeting(meetingId, enterpriseId, contactId),
    releaseMeeting: (meetingId, reason, detail) => scheduler.releaseMeeting(meetingId, reason, detail),
    updateDemand,
    replaceContact,
    mergeEnterprises,
    completeMeeting,
  };
}
