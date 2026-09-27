// 主体注册与治理：重复主体识别、主体合并、授权联系人管理。
// 平台只保存示例化资料，不保存真实个人敏感信息。

const LEGAL_SUFFIXES = [
  '有限责任公司', '股份有限公司', '有限公司', '公司',
  'co.,ltd.', 'co., ltd.', 'co ltd', 'co., ltd', 'pte. ltd.', 'pte ltd', 'sdn. bhd.', 'sdn bhd',
  'limited', 'ltd.', 'ltd', 'inc.', 'inc', 'gmbh', 'llc', 'llp',
];

const PUNCT = /[\s,，.。()（）\-_·'‘’"“”]+/g;

const stripPunct = (s) => s.replace(PUNCT, '');

// 名称规范化：全角转半角、去标点空白、小写、去公司后缀，用于重复主体比对。
export function normalizeName(name) {
  let s = String(name ?? '').trim();
  s = s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/　/g, ' ');
  s = stripPunct(s.toLowerCase());
  const suffixes = LEGAL_SUFFIXES
    .map((x) => stripPunct(x.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  for (const suf of suffixes) {
    if (suf && s.endsWith(suf) && s.length > suf.length) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s;
}

// 联系人授权范围：确认洽谈、修改需求、登记意向/签约、同意保密信息扩散。
export const CONTACT_SCOPES = ['confirm_meeting', 'update_demand', 'sign_intent', 'share_confidential'];

export function createRegistry({ nextId, clock }) {
  const enterprises = new Map();
  const contacts = new Map();
  // 精确信号索引：注册号与规范化名称（含别名）O(1) 命中。
  const byRegistrationNo = new Map();
  const byNormalizedName = new Map();

  function registerEnterprise(input) {
    if (!input.legalName || !String(input.legalName).trim()) throw new Error('企业法定名称不能为空');
    const enterprise = {
      id: nextId('E'),
      legalName: String(input.legalName).trim(),
      normalizedName: normalizeName(input.legalName),
      aliases: [...new Set(input.aliases ?? [])],
      registrationNo: input.registrationNo ?? '',
      country: input.country ?? '',
      groupId: input.groupId ?? '',
      industry: input.industry ?? '',
      languages: input.languages ?? [],
      capabilities: input.capabilities ?? [],
      status: 'active',
      mergedInto: null,
      createdAt: clock(),
    };

    // 先走索引拿确定信号（注册号、规范化名称、别名），再对少量主体做包含式启发式比对。
    const hits = new Map();
    const bump = (existing, reason, confidence) => {
      if (existing.status !== 'active') return;
      const cur = hits.get(existing.id) ?? { enterpriseId: existing.id, legalName: existing.legalName, confidence: 0, reasons: [] };
      cur.confidence = Math.max(cur.confidence, confidence);
      if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
      hits.set(existing.id, cur);
    };
    if (enterprise.registrationNo && byRegistrationNo.has(enterprise.registrationNo)) {
      bump(byRegistrationNo.get(enterprise.registrationNo), '注册号一致', 1);
    }
    if (enterprise.normalizedName && byNormalizedName.has(enterprise.normalizedName)) {
      const existing = byNormalizedName.get(enterprise.normalizedName);
      if (existing.normalizedName === enterprise.normalizedName) bump(existing, '名称规范化后一致', 0.9);
      else bump(existing, '与已有主体别名一致', 0.85);
    }
    if (hits.size === 0 && enterprise.normalizedName.length >= 4) {
      for (const e of enterprises.values()) {
        if (e.status !== 'active' || e.normalizedName.length < 4) continue;
        if (enterprise.normalizedName.includes(e.normalizedName) || e.normalizedName.includes(enterprise.normalizedName)) {
          bump(e, '名称相互包含，疑似同一主体', 0.6);
        }
      }
    }
    const duplicates = [...hits.values()].sort((a, b) => b.confidence - a.confidence);

    enterprises.set(enterprise.id, enterprise);
    if (enterprise.registrationNo) byRegistrationNo.set(enterprise.registrationNo, enterprise);
    if (enterprise.normalizedName) byNormalizedName.set(enterprise.normalizedName, enterprise);
    for (const alias of enterprise.aliases) {
      const norm = normalizeName(alias);
      if (norm && !byNormalizedName.has(norm)) byNormalizedName.set(norm, enterprise);
    }
    return { enterprise, duplicates };
  }

  // 合并重复主体：保留主记录，吸收别名/语言/能力，迁移联系人，留痕备查。
  function mergeEnterprises(masterId, duplicateId, reason = '') {
    const master = mustEnterprise(masterId);
    const dup = mustEnterprise(duplicateId);
    if (master.id === dup.id) throw new Error('不能与自身合并');
    if (dup.status === 'merged') throw new Error(`主体 ${dup.id} 已并入 ${dup.mergedInto}`);
    master.aliases = [...new Set([...master.aliases, dup.legalName, ...dup.aliases])];
    master.languages = [...new Set([...master.languages, ...dup.languages])];
    master.capabilities = [...new Set([...master.capabilities, ...dup.capabilities])];
    if (!master.registrationNo && dup.registrationNo) {
      master.registrationNo = dup.registrationNo;
      byRegistrationNo.set(dup.registrationNo, master);
    }
    // 被并主体的名称与别名归入索引，后续登记仍能被识别为重复。
    for (const name of [dup.legalName, ...dup.aliases]) {
      const norm = normalizeName(name);
      if (norm) byNormalizedName.set(norm, master);
    }
    if (dup.registrationNo) byRegistrationNo.set(dup.registrationNo, master);
    for (const c of contacts.values()) {
      if (c.enterpriseId === dup.id) c.enterpriseId = master.id;
    }
    dup.status = 'merged';
    dup.mergedInto = master.id;
    dup.mergedReason = reason;
    return master;
  }

  function mustEnterprise(id) {
    const e = enterprises.get(id);
    if (!e) throw new Error(`企业不存在：${id}`);
    return e;
  }

  function registerContact(input) {
    mustEnterprise(input.enterpriseId);
    if (!input.name || !String(input.name).trim()) throw new Error('联系人姓名不能为空');
    const scopes = input.scopes ?? [];
    for (const s of scopes) {
      if (!CONTACT_SCOPES.includes(s)) throw new Error(`未知授权范围：${s}`);
    }
    const contact = {
      id: nextId('C'),
      enterpriseId: input.enterpriseId,
      name: String(input.name).trim(),
      role: input.role ?? '',
      scopes,
      status: 'active',
      validUntil: input.validUntil ?? null,
      replacedBy: null,
      createdAt: clock(),
    };
    contacts.set(contact.id, contact);
    return contact;
  }

  // 代表临时更换：旧代表停用留痕，接任者可以是新登记的联系人，也可以是本企业已有的授权联系人。
  function replaceContact(enterpriseId, oldContactId, input = {}) {
    const old = mustContact(oldContactId);
    if (old.enterpriseId !== enterpriseId) throw new Error('联系人不属于该企业');
    if (old.status !== 'active') throw new Error(`联系人 ${oldContactId} 当前状态为 ${old.status}，不能更换`);
    let fresh;
    if (input.existingContactId) {
      fresh = mustContact(input.existingContactId);
      if (fresh.enterpriseId !== enterpriseId) throw new Error('接任联系人必须属于本企业');
      if (fresh.status !== 'active') throw new Error('接任联系人必须在职');
    } else {
      fresh = registerContact({ ...input, enterpriseId });
    }
    old.status = 'replaced';
    old.replacedBy = fresh.id;
    return { oldContact: old, newContact: fresh };
  }

  function mustContact(id) {
    const c = contacts.get(id);
    if (!c) throw new Error(`联系人不存在：${id}`);
    return c;
  }

  function isUsable(contact, scope) {
    if (!contact || contact.status !== 'active') return false;
    if (contact.validUntil && Date.parse(contact.validUntil) < Date.parse(clock())) return false;
    if (scope && !contact.scopes.includes(scope)) return false;
    return true;
  }

  // 校验联系人为该企业在职且具备指定授权范围，否则抛出中文原因。
  function assertContact(enterpriseId, contactId, scope) {
    const c = mustContact(contactId);
    if (c.enterpriseId !== enterpriseId) throw new Error(`联系人 ${contactId} 不属于企业 ${enterpriseId}`);
    if (c.status !== 'active') throw new Error(`联系人 ${c.name} 已${c.status === 'replaced' ? '被更换' : '停用'}，不能代表企业操作`);
    if (c.validUntil && Date.parse(c.validUntil) < Date.parse(clock())) throw new Error(`联系人 ${c.name} 的授权已过期`);
    if (scope && !c.scopes.includes(scope)) throw new Error(`联系人 ${c.name} 缺少授权范围：${scope}`);
    return c;
  }

  return {
    registerEnterprise,
    mergeEnterprises,
    getEnterprise: mustEnterprise,
    listEnterprises: () => [...enterprises.values()],
    registerContact,
    replaceContact,
    getContact: mustContact,
    listContacts: (enterpriseId) => [...contacts.values()].filter((c) => c.enterpriseId === enterpriseId),
    isContactUsable: (contactId, scope) => isUsable(contacts.get(contactId), scope),
    assertContact,
  };
}
