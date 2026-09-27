// 会后履约台账。
//
// 一次会谈若产生后续，所有事项——保密纪要、意向金额、政策咨询、法律服务、
// 投融资——都挂在同一条「合作关系」上推进，不散落在名片夹里。
//
// 关键约束：
//   - 事项内容默认仅合作双方可见；向任何第三方（含主办方）扩散，
//     必须双方各自持有 fulfillment 授权的联系人分别同意。
//   - 主办方视图只有终态：已签约 / 已终止及原因（不含金额、纪要等内容）。
//   - 企业视图聚焦执行：每个事项的下一行动与当前责任人。

export const MATTER_TYPES = ['minutes', 'intent', 'policy', 'legal', 'financing'];

export const RELATION_STATUS = {
  ACTIVE: 'active',
  SIGNED: 'signed',
  TERMINATED: 'terminated',
};

export class FulfillmentLedger {
  constructor({ contactBook, clock = () => new Date().toISOString() } = {}) {
    if (!contactBook) throw new Error('履约台账必须接入授权联系人簿');
    this.contactBook = contactBook;
    this.clock = clock;
    this.relations = new Map(); // relationId -> relation
    this._seq = 0;
    this._matterSeq = 0;
    this._consentSeq = 0;
  }

  // 会谈举行后建立合作关系（同一对企业只建一条，重复调用返回已有关系）。
  openRelation({ buyerOrgId, supplierOrgId, meetingId = null, demandId = null }) {
    const existing = this.findRelation(buyerOrgId, supplierOrgId);
    if (existing) {
      if (meetingId && !existing.meetingIds.includes(meetingId)) existing.meetingIds.push(meetingId);
      return existing;
    }
    const id = `rel-${String(++this._seq).padStart(5, '0')}`;
    const relation = {
      id,
      buyerOrgId,
      supplierOrgId,
      meetingIds: meetingId ? [meetingId] : [],
      demandId,
      status: RELATION_STATUS.ACTIVE,
      matters: [],
      consents: [], // 扩散同意记录
      openedAt: this.clock(),
      closedAt: null,
      closeReason: null,
      contractRef: null,
    };
    this.relations.set(id, relation);
    return relation;
  }

  findRelation(orgA, orgB) {
    for (const rel of this.relations.values()) {
      const pair = [rel.buyerOrgId, rel.supplierOrgId];
      if (pair.includes(orgA) && pair.includes(orgB)) return rel;
    }
    return null;
  }

  // ---------- 事项登记与推进 ----------

  // 登记事项。byContactId 必须是任一方持 fulfillment 授权的联系人。
  addMatter(relationId, { type, title, content = '', amount = null, currency = null, ownerContactId, nextAction = '', dueDate = null }, byContactId) {
    const rel = this._requireActive(relationId);
    if (!MATTER_TYPES.includes(type)) throw new Error(`未知事项类型：${type}`);
    this._requirePartyScope(rel, byContactId, 'fulfillment');
    if (!ownerContactId) throw new Error('事项必须指定当前责任人');
    this._requirePartyContact(rel, ownerContactId);

    const matter = {
      id: `matter-${String(++this._matterSeq).padStart(5, '0')}`,
      relationId,
      type,
      title,
      content, // 保密内容：仅双方可见
      amount,
      currency,
      ownerContactId,
      nextAction,
      dueDate,
      sharedWith: [], // 经双方同意可查看的第三方（orgId 或 'secretariat'）
      history: [{ at: this.clock(), event: 'created', by: byContactId }],
      createdAt: this.clock(),
    };
    rel.matters.push(matter);
    return matter;
  }

  // 更新下一行动 / 责任人 / 期限。
  updateMatter(relationId, matterId, patch, byContactId) {
    const rel = this._requireActive(relationId);
    this._requirePartyScope(rel, byContactId, 'fulfillment');
    const matter = this._requireMatter(rel, matterId);
    if (patch.ownerContactId) this._requirePartyContact(rel, patch.ownerContactId);
    for (const key of ['title', 'content', 'amount', 'currency', 'nextAction', 'dueDate', 'ownerContactId']) {
      if (key in patch) matter[key] = patch[key];
    }
    matter.history.push({ at: this.clock(), event: 'updated', by: byContactId });
    return matter;
  }

  // ---------- 保密与扩散 ----------

  // 申请把某事项共享给第三方（含 'secretariat'）。双方同意前不产生任何可见性。
  requestDisclosure(relationId, matterId, toParty, byContactId) {
    const rel = this._requireRelation(relationId);
    this._requirePartyScope(rel, byContactId, 'fulfillment');
    this._requireMatter(rel, matterId);
    const consent = {
      id: `consent-${String(++this._consentSeq).padStart(5, '0')}`,
      relationId,
      matterId,
      toParty,
      approvals: new Set(),
      status: 'pending',
      createdAt: this.clock(),
    };
    rel.consents.push(consent);
    // 发起方的同意视为已表达。
    this.consentDisclosure(relationId, consent.id, byContactId);
    return consent;
  }

  // 一方同意。双方（买方企业 + 供应方企业）都同意后才生效。
  consentDisclosure(relationId, consentId, byContactId) {
    const rel = this._requireRelation(relationId);
    const contact = this._requirePartyScope(rel, byContactId, 'fulfillment');
    const consent = rel.consents.find((c) => c.id === consentId);
    if (!consent) throw new Error(`扩散申请不存在：${consentId}`);
    if (consent.status !== 'pending') return consent;

    consent.approvals.add(contact.orgId);
    const bothApproved = consent.approvals.has(rel.buyerOrgId) && consent.approvals.has(rel.supplierOrgId);
    if (bothApproved) {
      consent.status = 'granted';
      const matter = this._requireMatter(rel, consent.matterId);
      if (!matter.sharedWith.includes(consent.toParty)) matter.sharedWith.push(consent.toParty);
      matter.history.push({ at: this.clock(), event: 'disclosed', to: consent.toParty });
    }
    return consent;
  }

  // 读取事项内容：双方成员始终可读；第三方须出现在 sharedWith。
  readMatter(relationId, matterId, readerOrgId) {
    const rel = this._requireRelation(relationId);
    const matter = this._requireMatter(rel, matterId);
    const isParty = readerOrgId === rel.buyerOrgId || readerOrgId === rel.supplierOrgId;
    if (!isParty && !matter.sharedWith.includes(readerOrgId)) {
      throw new Error('未经双方同意，该事项内容不可扩散');
    }
    return matter;
  }

  // ---------- 终态 ----------

  sign(relationId, byContactId, { contractRef = null } = {}) {
    const rel = this._requireActive(relationId);
    this._requirePartyScope(rel, byContactId, 'fulfillment');
    rel.status = RELATION_STATUS.SIGNED;
    rel.closedAt = this.clock();
    rel.contractRef = contractRef;
    return rel;
  }

  terminate(relationId, byContactId, reason) {
    const rel = this._requireActive(relationId);
    this._requirePartyScope(rel, byContactId, 'fulfillment');
    if (!reason) throw new Error('终止必须填写原因，供主办方复盘');
    rel.status = RELATION_STATUS.TERMINATED;
    rel.closedAt = this.clock();
    rel.closeReason = reason;
    return rel;
  }

  // ---------- 视图 ----------

  // 主办方视图：只有终态与原因，不含任何事项内容、金额。
  organizerView() {
    return [...this.relations.values()].map((rel) => ({
      relationId: rel.id,
      buyerOrgId: rel.buyerOrgId,
      supplierOrgId: rel.supplierOrgId,
      status: rel.status,
      closedAt: rel.closedAt,
      contractRef: rel.status === RELATION_STATUS.SIGNED ? rel.contractRef : null,
      terminateReason: rel.status === RELATION_STATUS.TERMINATED ? rel.closeReason : null,
      matterCounts: rel.matters.reduce((acc, m) => {
        acc[m.type] = (acc[m.type] ?? 0) + 1;
        return acc;
      }, {}),
    }));
  }

  // 企业视图：下一行动与当前责任人。orgId 必须是合作一方。
  enterpriseView(relationId, orgId) {
    const rel = this._requireRelation(relationId);
    if (orgId !== rel.buyerOrgId && orgId !== rel.supplierOrgId) {
      throw new Error('只有合作双方可以查看企业视图');
    }
    return {
      relationId: rel.id,
      status: rel.status,
      counterpart: orgId === rel.buyerOrgId ? rel.supplierOrgId : rel.buyerOrgId,
      matters: rel.matters.map((m) => {
        const owner = this.contactBook.get(m.ownerContactId);
        return {
          id: m.id,
          type: m.type,
          title: m.title,
          amount: m.amount,
          currency: m.currency,
          nextAction: m.nextAction,
          dueDate: m.dueDate,
          owner: owner ? { contactId: owner.id, name: owner.name, orgId: owner.orgId } : null,
          sharedWith: [...m.sharedWith],
        };
      }),
    };
  }

  // ---------- 内部 ----------

  _requireRelation(relationId) {
    const rel = this.relations.get(relationId);
    if (!rel) throw new Error(`合作关系不存在：${relationId}`);
    return rel;
  }

  _requireActive(relationId) {
    const rel = this._requireRelation(relationId);
    if (rel.status !== RELATION_STATUS.ACTIVE) throw new Error(`合作关系已关闭（${rel.status}）`);
    return rel;
  }

  _requireMatter(rel, matterId) {
    const matter = rel.matters.find((m) => m.id === matterId);
    if (!matter) throw new Error(`事项不存在：${matterId}`);
    return matter;
  }

  _requirePartyContact(rel, contactId) {
    const contact = this.contactBook.get(contactId);
    if (!contact) throw new Error(`联系人不存在：${contactId}`);
    if (contact.orgId !== rel.buyerOrgId && contact.orgId !== rel.supplierOrgId) {
      throw new Error('责任人必须来自合作双方之一');
    }
    return contact;
  }

  _requirePartyScope(rel, contactId, scope) {
    const contact = this._requirePartyContact(rel, contactId);
    if (!contact.active) throw new Error('该联系人授权已失效');
    if (!contact.scope.includes(scope)) {
      throw new Error(`该联系人缺少 ${scope} 授权`);
    }
    return contact;
  }
}
