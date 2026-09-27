// 会后履约：保密纪要、意向金额、政策咨询、法律服务、投融资事项沿同一合作关系推进。
// 保密条目未经双方同意不得向第三方披露；主办方只看到签约、终止及其原因；
// 企业看到下一行动与当前责任人。

export const ITEM_KINDS = ['minutes', 'intent_amount', 'policy_consult', 'legal_service', 'financing'];
export const ITEM_KIND_LABELS = {
  minutes: '保密纪要',
  intent_amount: '意向金额',
  policy_consult: '政策咨询',
  legal_service: '法律服务',
  financing: '投融资事项',
};

export function createFulfillment({ nextId, clock, notify, registry }) {
  const relationships = new Map();

  function mustRel(id) {
    const r = relationships.get(id);
    if (!r) throw new Error(`合作关系不存在：${id}`);
    return r;
  }

  function mustActive(id) {
    const r = mustRel(id);
    if (r.status !== 'active') {
      throw new Error(`合作关系 ${id} 已${r.status === 'signed' ? '签约' : '终止'}，不能继续操作`);
    }
    return r;
  }

  // 仅合作关系双方的在职联系人可以推进事项。
  function assertPartyContact(rel, contactId) {
    const contact = registry.getContact(contactId);
    if (!rel.parties.includes(contact.enterpriseId)) throw new Error(`联系人 ${contact.name} 不属于合作关系双方`);
    if (contact.status !== 'active') throw new Error(`联系人 ${contact.name} 已不在职`);
    return contact;
  }

  const ownerContacts = (rel) => rel.parties.map((p) => rel.owners[p]).filter(Boolean).map((c) => `contact:${c}`);

  function openRelationship({ meetingId, parties, owners }) {
    if (!Array.isArray(parties) || parties.length !== 2) throw new Error('合作关系需要双方企业');
    const rel = {
      id: nextId('REL'),
      meetingId,
      parties: [...parties],
      owners: { ...owners }, // 各企业当前责任人（联系人编号）
      status: 'active',
      items: [],
      nextAction: null,
      terminationReason: null,
      history: [{ at: clock(), event: 'opened', meetingId }],
      createdAt: clock(),
    };
    relationships.set(rel.id, rel);
    notify.send({
      to: [...ownerContacts(rel), 'secretariat'],
      type: 'relationship_opened',
      message: `合作关系 ${rel.id} 已建立（源自会谈 ${meetingId}），会后事项将沿此关系推进`,
      refs: { relationshipId: rel.id },
    });
    return rel;
  }

  function addItem(relId, input, byContactId) {
    const rel = mustActive(relId);
    const contact = assertPartyContact(rel, byContactId);
    if (!ITEM_KINDS.includes(input.kind)) throw new Error(`未知事项类型：${input.kind}`);
    if (input.kind === 'intent_amount') {
      registry.assertContact(contact.enterpriseId, byContactId, 'sign_intent');
      if (!(Number(input.amount) > 0) || !input.currency) throw new Error('意向金额必须包含正数金额与币种');
    }
    const item = {
      id: nextId('ITEM'),
      kind: input.kind,
      title: input.title ?? ITEM_KIND_LABELS[input.kind],
      content: input.content ?? '',
      amount: input.kind === 'intent_amount' ? Number(input.amount) : null,
      currency: input.kind === 'intent_amount' ? input.currency : null,
      confidential: input.confidential !== false, // 默认保密
      createdBy: byContactId,
      createdAt: clock(),
      disclosures: [],
    };
    rel.items.push(item);
    rel.history.push({ at: clock(), event: 'item_added', itemId: item.id, kind: item.kind, by: byContactId });
    const counterpart = rel.parties.find((p) => p !== contact.enterpriseId);
    notify.send({
      to: [`contact:${rel.owners[counterpart]}`, `contact:${byContactId}`],
      type: 'item_added',
      message: `合作关系 ${rel.id} 新增${ITEM_KIND_LABELS[item.kind]}「${item.title}」`,
      refs: { relationshipId: rel.id, itemId: item.id },
    });
    return item;
  }

  function mustItem(rel, itemId) {
    const item = rel.items.find((i) => i.id === itemId);
    if (!item) throw new Error(`事项不存在：${itemId}`);
    return item;
  }

  // 向第三方披露保密条目：需双方各自同意，缺一不可。
  function requestDisclosure(relId, itemId, to, byContactId) {
    const rel = mustActive(relId);
    assertPartyContact(rel, byContactId);
    const item = mustItem(rel, itemId);
    if (!item.confidential) throw new Error('非保密条目无需披露审批');
    const disclosure = {
      id: nextId('DISC'),
      to,
      requestedBy: byContactId,
      consents: {},
      status: 'pending',
      createdAt: clock(),
    };
    item.disclosures.push(disclosure);
    rel.history.push({ at: clock(), event: 'disclosure_requested', itemId, disclosureId: disclosure.id, to });
    notify.send({
      to: [...ownerContacts(rel), 'secretariat'],
      type: 'disclosure_requested',
      message: `合作关系 ${rel.id} 申请向 ${to} 披露「${item.title}」，需双方同意后方可提供`,
      refs: { relationshipId: rel.id, itemId, disclosureId: disclosure.id },
    });
    return disclosure;
  }

  function consentDisclosure(relId, itemId, disclosureId, enterpriseId, byContactId) {
    const rel = mustActive(relId);
    if (!rel.parties.includes(enterpriseId)) throw new Error(`企业 ${enterpriseId} 不是合作关系双方`);
    registry.assertContact(enterpriseId, byContactId, 'share_confidential');
    const item = mustItem(rel, itemId);
    const disclosure = item.disclosures.find((d) => d.id === disclosureId);
    if (!disclosure) throw new Error(`披露申请不存在：${disclosureId}`);
    if (disclosure.status !== 'pending') throw new Error('该披露申请已处理完毕');
    disclosure.consents[enterpriseId] = { contactId: byContactId, at: clock() };
    if (rel.parties.every((p) => disclosure.consents[p])) {
      disclosure.status = 'granted';
      rel.history.push({ at: clock(), event: 'disclosure_granted', itemId, disclosureId: disclosure.id });
      notify.send({
        to: [...ownerContacts(rel), disclosure.to, 'secretariat'],
        type: 'disclosure_granted',
        message: `「${item.title}」经双方同意，已向 ${disclosure.to} 提供`,
        refs: { relationshipId: rel.id, itemId, disclosureId: disclosure.id },
      });
    } else {
      const waitingFor = rel.parties.find((p) => !disclosure.consents[p]);
      notify.send({
        to: [`contact:${rel.owners[waitingFor]}`],
        type: 'disclosure_awaiting_consent',
        message: `「${item.title}」的披露申请已获一方同意，等待你方确认`,
        refs: { relationshipId: rel.id, itemId, disclosureId: disclosure.id },
      });
    }
    return disclosure;
  }

  function setNextAction(relId, action, byContactId) {
    const rel = mustActive(relId);
    assertPartyContact(rel, byContactId);
    if (!action || !action.description) throw new Error('下一行动需要描述');
    if (!rel.parties.includes(action.ownerEnterpriseId)) throw new Error('责任人必须来自合作关系双方');
    registry.assertContact(action.ownerEnterpriseId, action.ownerContactId);
    rel.nextAction = {
      description: action.description,
      ownerEnterpriseId: action.ownerEnterpriseId,
      ownerContactId: action.ownerContactId,
      dueAt: action.dueAt ?? null,
      setBy: byContactId,
      setAt: clock(),
    };
    rel.history.push({ at: clock(), event: 'next_action_set', by: byContactId });
    notify.send({
      to: [`contact:${action.ownerContactId}`],
      type: 'next_action_set',
      message: `你已成为合作关系 ${rel.id} 的当前责任人：${action.description}`,
      refs: { relationshipId: rel.id },
    });
    return rel.nextAction;
  }

  function sign(relId, byContactId) {
    const rel = mustActive(relId);
    const contact = assertPartyContact(rel, byContactId);
    registry.assertContact(contact.enterpriseId, byContactId, 'sign_intent');
    rel.status = 'signed';
    rel.signedAt = clock();
    rel.history.push({ at: clock(), event: 'signed', by: byContactId });
    notify.send({
      to: [...ownerContacts(rel), 'secretariat'],
      type: 'relationship_signed',
      message: `合作关系 ${rel.id} 已签约`,
      refs: { relationshipId: rel.id },
    });
    return rel;
  }

  function terminate(relId, reason, byContactId) {
    const rel = mustActive(relId);
    assertPartyContact(rel, byContactId);
    if (!reason || !String(reason).trim()) throw new Error('终止合作关系必须填写原因');
    rel.status = 'terminated';
    rel.terminationReason = String(reason).trim();
    rel.terminatedAt = clock();
    rel.history.push({ at: clock(), event: 'terminated', reason: rel.terminationReason, by: byContactId });
    notify.send({
      to: [...ownerContacts(rel), 'secretariat'],
      type: 'relationship_terminated',
      message: `合作关系 ${rel.id} 已终止：${rel.terminationReason}`,
      refs: { relationshipId: rel.id },
    });
    return rel;
  }

  // 主办方视图：只看签约、终止及其原因，不看保密内容与意向金额。
  function organizerView() {
    const rels = [...relationships.values()];
    const summary = (r) => ({ id: r.id, meetingId: r.meetingId, parties: [...r.parties] });
    return {
      signed: rels.filter((r) => r.status === 'signed').map((r) => ({ ...summary(r), signedAt: r.signedAt })),
      terminated: rels
        .filter((r) => r.status === 'terminated')
        .map((r) => ({ ...summary(r), reason: r.terminationReason, terminatedAt: r.terminatedAt })),
      activeCount: rels.filter((r) => r.status === 'active').length,
    };
  }

  // 企业视图：看到下一行动与当前责任人，以及本关系的全部事项。
  function enterpriseView(enterpriseId) {
    return [...relationships.values()]
      .filter((r) => r.parties.includes(enterpriseId))
      .map((r) => {
        let nextAction = null;
        if (r.nextAction) {
          const owner = registry.getContact(r.nextAction.ownerContactId);
          nextAction = {
            description: r.nextAction.description,
            dueAt: r.nextAction.dueAt,
            owner: { contactId: owner.id, name: owner.name, role: owner.role, enterpriseId: owner.enterpriseId },
          };
        }
        const pendingConsents = r.items
          .flatMap((i) => i.disclosures)
          .filter((d) => d.status === 'pending' && !d.consents[enterpriseId]).length;
        return {
          id: r.id,
          status: r.status,
          counterpart: r.parties.find((p) => p !== enterpriseId),
          terminationReason: r.terminationReason,
          nextAction,
          pendingConsents,
          items: r.items.map((i) => ({
            id: i.id,
            kind: i.kind,
            title: i.title,
            content: i.content,
            amount: i.amount,
            currency: i.currency,
            createdAt: i.createdAt,
          })),
        };
      });
  }

  // 第三方视图：仅能看到经双方同意披露给自己的条目。
  function recipientView(recipient) {
    const visible = [];
    for (const r of relationships.values()) {
      for (const item of r.items) {
        for (const d of item.disclosures) {
          if (d.to === recipient && d.status === 'granted') {
            visible.push({
              relationshipId: r.id,
              item: {
                id: item.id,
                kind: item.kind,
                title: item.title,
                content: item.content,
                amount: item.amount,
                currency: item.currency,
              },
            });
          }
        }
      }
    }
    return visible;
  }

  return {
    openRelationship,
    addItem,
    requestDisclosure,
    consentDisclosure,
    setNextAction,
    sign,
    terminate,
    organizerView,
    enterpriseView,
    recipientView,
    getRelationship: mustRel,
    listRelationships: () => [...relationships.values()],
  };
}
