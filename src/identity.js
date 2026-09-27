// 主体治理：解决「同一家企业被录入多次」与「这个人是否有权代表企业」两个问题。
//
// 重复主体识别策略（按可信度从高到低）：
//   1. 统一社会信用代码（注册证件号）一致 → 必然同一主体
//   2. 规范化名称一致（去空白/标点/大小写/常见后缀差异）→ 疑似同一主体，自动合并到已确认主体
//   3. 名称高相似度 + 同一注册地 → 标记为待人工确认，不自动合并
// 合并时保留全部来源记录（sourceRefs），联系人取并集，冲突字段由秘书处人工裁决。

import { normalizeSlots as normalizeAvailability } from './util-time.js';

export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    // 统一常见全角半角括号
    .replace(/[（）]/g, (ch) => (ch === '（' ? '(' : ')'))
    .toLowerCase();
}

// 名称中的组织后缀（跨境场景下中英文都可能出现），用于相似度比较时弱化后缀差异。
const SUFFIX_TOKENS = [
  '股份有限公司',
  '有限责任公司',
  '有限公司',
  '公司',
  '集团',
  'company',
  'co.',
  'co',
  'ltd',
  'limited',
  'inc',
  'corp',
  'corporation',
  'gmbh',
  'pte',
  'sdn',
  'bhd',
];

export function stripSuffix(name) {
  let s = normalizeName(name);
  for (const token of SUFFIX_TOKENS) {
    if (token.includes('.') || token.length <= 4) {
      s = s.split(token).join('');
    } else {
      s = s.endsWith(token) ? s.slice(0, -token.length) : s;
    }
  }
  return s.replace(/[.,()\s]/g, '');
}

// 经典 Dice / bigram 相似度，对中文、英文混合名称都适用。
export function nameSimilarity(a, b) {
  const left = stripSuffix(a);
  const right = stripSuffix(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const bigrams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = bigrams(left);
  const gb = bigrams(right);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  const total = [...ga.values()].reduce((x, y) => x + y, 0)
    + [...gb.values()].reduce((x, y) => x + y, 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

function normalizeRegion(region) {
  return String(region ?? '').trim();
}

export class OrganizationRegistry {
  constructor({ similarityThreshold = 0.82 } = {}) {
    this.organizations = new Map(); // orgId -> 合并后的主体
    this.recordsByTaxId = new Map(); // taxId -> orgId
    this.recordsByNormName = new Map(); // 规范化名称 -> orgId
    this.pendingMerges = []; // 待秘书处人工确认的疑似重复
    this.similarityThreshold = similarityThreshold;
    this._seq = 0;
  }

  // 录入或合并一条企业资料。返回 { org, merged: bool, pending?: {...} }。
  register(record) {
    if (!record || !record.name) throw new Error('企业资料缺少名称');
    const taxId = record.taxId ? String(record.taxId).trim().toUpperCase() : null;
    const norm = normalizeName(record.name);

    let orgId = taxId ? this.recordsByTaxId.get(taxId) : undefined;
    if (!orgId) orgId = this.recordsByNormName.get(norm);

    if (orgId) {
      const org = this.organizations.get(orgId);
      this._mergeInto(org, record, taxId);
      return { org, merged: true };
    }

    // 高相似度 + 同注册地：不自动合并，挂起人工确认。
    for (const existing of this.organizations.values()) {
      const score = nameSimilarity(existing.name, record.name);
      if (score >= this.similarityThreshold && normalizeRegion(existing.region) === normalizeRegion(record.region)) {
        const pending = { record, candidateOrgId: existing.id, score };
        this.pendingMerges.push(pending);
        // 暂存主体，但标记为待裁决；确认前两个 id 都有效。
        const provisional = this._create(record, taxId);
        pending.provisionalOrgId = provisional.id;
        return { org: provisional, merged: false, pending };
      }
    }

    const org = this._create(record, taxId);
    return { org, merged: false };
  }

  _create(record, taxId) {
    const id = record.id ?? `org-${String(++this._seq).padStart(5, '0')}`;
    const org = {
      id,
      name: record.name,
      taxId: taxId ?? null,
      region: normalizeRegion(record.region) || null,
      industry: record.industry ?? null,
      // 能力描述：{ product, industry, regions[], certifications[], annualCapacity }
      capabilities: (record.capabilities ?? []).map((c) =>
        typeof c === 'string' ? { product: c } : { ...c },
      ),
      // 需求描述：{ id, product, industry, targetRegions[], requiredCertifications[],
      //          minQuantity, amount, currency }
      demands: (record.demands ?? []).map((d) => ({ ...d })),
      // 企业自报或秘书处登记的禁配区域/主体等限制
      embargoRegions: [...(record.embargoRegions ?? [])],
      languages: [...new Set(record.languages ?? [])],
      availability: normalizeAvailability(record.availability),
      constraints: { ...(record.constraints ?? {}) },
      sourceRefs: [record.sourceRef ?? record.name],
      contacts: [],
      createdAt: record.createdAt ?? null,
      mergedFrom: [],
    };
    this.organizations.set(id, org);
    if (taxId) this.recordsByTaxId.set(taxId, id);
    this.recordsByNormName.set(normalizeName(org.name), id);
    return org;
  }

  _mergeInto(org, record, taxId) {
    if (taxId && !org.taxId) {
      org.taxId = taxId;
      this.recordsByTaxId.set(taxId, org.id);
    }
    if (!org.industry && record.industry) org.industry = record.industry;
    if (!org.region && record.region) org.region = normalizeRegion(record.region);
    for (const rawCap of record.capabilities ?? []) {
      const cap = typeof rawCap === 'string' ? { product: rawCap } : rawCap;
      if (!org.capabilities.some((x) => x.product === cap.product)) org.capabilities.push({ ...cap });
    }
    for (const d of record.demands ?? []) {
      if (!org.demands.some((x) => x.id === d.id || (x.product === d.product && x.industry === d.industry))) {
        org.demands.push({ ...d });
      }
    }
    for (const r of record.embargoRegions ?? []) {
      if (!org.embargoRegions.includes(r)) org.embargoRegions.push(r);
    }
    for (const slot of record.availability ?? []) {
      if (!org.availability.some((x) => x.day === slot.day && x.start === slot.start && x.end === slot.end)) {
        org.availability.push(slot);
      }
    }
    for (const lang of record.languages ?? []) {
      if (!org.languages.includes(lang)) org.languages.push(lang);
    }
    Object.assign(org.constraints, record.constraints ?? {});
    if (record.sourceRef) org.sourceRefs.push(record.sourceRef);
    org.mergedFrom.push(record.sourceRef ?? record.name);
  }

  // 秘书处确认疑似重复：保留保留方主体，吸收被合并方。
  confirmMerge(provisionalOrgId, targetOrgId) {
    const victim = this.organizations.get(provisionalOrgId);
    const keeper = this.organizations.get(targetOrgId);
    if (!victim || !keeper) throw new Error('待合并的主体不存在');
    this._mergeInto(keeper, victim, victim.taxId);
    keeper.mergedFrom.push(victim.id);
    this.recordsByNormName.set(normalizeName(victim.name), keeper.id);
    for (const c of victim.contacts) keeper.contacts.push(c);
    this.organizations.delete(provisionalOrgId);
    this.pendingMerges = this.pendingMerges.filter(
      (p) => p.provisionalOrgId !== provisionalOrgId,
    );
    return keeper;
  }

  rejectMerge(provisionalOrgId) {
    this.pendingMerges = this.pendingMerges.filter(
      (p) => p.provisionalOrgId !== provisionalOrgId,
    );
  }

  get(orgId) {
    return this.organizations.get(orgId);
  }

  list() {
    return [...this.organizations.values()];
  }

  get stats() {
    return {
      organizationCount: this.organizations.size,
      pendingMergeCount: this.pendingMerges.length,
    };
  }
}

// 授权联系人：企业在授权范围（scope）与有效期内委派的代表。
// scope 例：['match']（仅确认配对）、['meeting']（可确认/改约席位）、
//           ['fulfillment']（可推进会后事项、签署纪要）、['admin']（可改企业资料与授权他人）。
export const SCOPES = ['match', 'meeting', 'fulfillment', 'admin'];

export class ContactBook {
  constructor({ today } = {}) {
    this.today = today ?? null;
    // orgId -> contactId -> contact
    this.byOrg = new Map();
    this._seq = 0;
  }

  _now() {
    return this.today ?? new Date().toISOString().slice(0, 10);
  }

  authorize(orgId, contact) {
    if (!contact || !contact.name) throw new Error('联系人缺少姓名');
    const scope = contact.scope ?? ['match'];
    for (const s of scope) {
      if (!SCOPES.includes(s)) throw new Error(`未知授权范围：${s}`);
    }
    if (contact.validUntil && contact.validUntil < this._now()) {
      throw new Error('授权有效期已过，不能新增');
    }
    let map = this.byOrg.get(orgId);
    if (!map) {
      map = new Map();
      this.byOrg.set(orgId, map);
    }
    const id = contact.id ?? `contact-${String(++this._seq).padStart(5, '0')}`;
    const entry = {
      id,
      orgId,
      name: contact.name,
      title: contact.title ?? null,
      languages: [...new Set(contact.languages ?? [])],
      scope: [...new Set(scope)],
      validFrom: contact.validFrom ?? this._now(),
      validUntil: contact.validUntil ?? null,
      replacedBy: null,
      active: true,
    };
    map.set(id, entry);
    return entry;
  }

  get(contactId) {
    for (const map of this.byOrg.values()) {
      const found = map.get(contactId);
      if (found) return found;
    }
    return null;
  }

  listFor(orgId) {
    const map = this.byOrg.get(orgId);
    return map ? [...map.values()] : [];
  }

  // 代表临时更换：旧联系人标记为被谁接替；默认把未到期授权转给新代表。
  replace(orgId, oldContactId, replacement) {
    const map = this.byOrg.get(orgId);
    const oldContact = map?.get(oldContactId);
    if (!oldContact) throw new Error('原联系人不存在');
    oldContact.active = false;
    oldContact.replacedBy = replacement?.id ?? null;
    const successor = this.authorize(orgId, {
      ...replacement,
      scope: replacement.scope ?? oldContact.scope,
      languages: replacement.languages ?? oldContact.languages,
      validUntil: replacement.validUntil ?? oldContact.validUntil,
    });
    oldContact.replacedBy = successor.id;
    return successor;
  }

  revoke(contactId) {
    const c = this.get(contactId);
    if (c) c.active = false;
  }

  // 是否存在在有效期内、具备所需授权范围的联系人。
  hasAuthorized(orgId, requiredScope, { at } = {}) {
    return this.findAuthorized(orgId, requiredScope, { at }) !== null;
  }

  findAuthorized(orgId, requiredScope, { at } = {}) {
    const day = at ?? this._now();
    const list = this.listFor(orgId);
    const candidates = list.filter(
      (c) =>
        c.active &&
        c.scope.includes(requiredScope) &&
        c.validFrom <= day &&
        (c.validUntil === null || c.validUntil >= day),
    );
    if (candidates.length === 0) return null;
    // 行政授权优先（更稳定），其次有效期更长者。
    candidates.sort((a, b) => {
      if (a.scope.includes('admin') !== b.scope.includes('admin')) {
        return a.scope.includes('admin') ? -1 : 1;
      }
      return (b.validUntil ?? '9999-12-31').localeCompare(a.validUntil ?? '9999-12-31');
    });
    return candidates[0];
  }
}
