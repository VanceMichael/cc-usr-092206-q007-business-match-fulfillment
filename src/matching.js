// 可解释撮合引擎。
//
// 对每一条「需求 × 候选能力」先过硬门槛（任何一条不过即拒绝，拒绝也给理由），
// 再计算 0-100 的适配分与逐因素理由。硬门槛包括：
//   1. 禁配关系（企业自报禁运区域、平台登记的禁配主体对、制裁/监管禁入）
//   2. 行业能力（产品类目与行业）
//   3. 需求条件（资质认证、目标区域、最小数量/产能、金额区间）
//   4. 语言（双方授权联系人/企业至少有一种共同工作语言）
//   5. 可用时段（周期性可用窗口有交集）
// 软评分因素：行业契合、产能富余、区域偏好、语言、时段宽度、历史合作。

import { intersectAvailability, formatMinutes } from './util-time.js';

export const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 全局禁配主体对与禁入区域，由秘书处/合规维护。
export class EmbargoRegistry {
  constructor() {
    this.pairs = new Set(); // "orgA|orgB" 双向
    this.forbiddenRegions = new Set(); // 任意企业不得对接该区域主体
    this.reasons = new Map(); // key -> 原因
  }

  static pairKey(a, b) {
    return [a, b].sort().join('|');
  }

  forbidPair(orgA, orgB, reason) {
    const key = EmbargoRegistry.pairKey(orgA, orgB);
    this.pairs.add(key);
    if (reason) this.reasons.set(key, reason);
  }

  forbidRegion(region, reason) {
    this.forbiddenRegions.add(region);
    if (reason) this.reasons.set(`region:${region}`, reason);
  }

  pairForbidden(orgA, orgB) {
    const key = EmbargoRegistry.pairKey(orgA, orgB);
    return this.pairs.has(key) ? (this.reasons.get(key) ?? '存在禁配主体关系') : null;
  }

  regionForbidden(region) {
    return this.forbiddenRegions.has(region)
      ? this.reasons.get(`region:${region}`) ?? `区域 ${region} 处于禁入名单`
      : null;
  }
}

function sharedLanguages(left, right) {
  const lb = new Set(left);
  return right.filter((l) => lb.has(l));
}

function describeOverlaps(overlaps) {
  return overlaps
    .slice(0, 3)
    .map((o) => `${WEEKDAY_CN[o.day]} ${formatMinutes(o.start)}-${formatMinutes(o.end)}`)
    .join('、');
}

// 评估单条需求与单个供给主体。返回 { eligible, score, reasons[], rejections[] }。
// priorCooperations：双方历史合作次数（用于软评分）。
export function evaluateMatch({ demand, buyer, supplier, embargo, contactBook, priorCooperations = 0 }) {
  const rejections = [];
  const reasons = [];

  // 1. 禁配关系
  const pairBan = embargo?.pairForbidden(buyer.id, supplier.id);
  if (pairBan) rejections.push({ code: 'forbidden-pair', detail: pairBan });

  const regions = new Set([
    supplier.region,
    ...(supplier.capabilities ?? []).flatMap((c) => c.regions ?? []),
  ].filter(Boolean));
  for (const region of regions) {
    const ban = embargo?.regionForbidden(region);
    if (ban) rejections.push({ code: 'forbidden-region', detail: `${region}：${ban}` });
  }
  for (const banned of buyer.embargoRegions ?? []) {
    if (supplier.region === banned) {
      rejections.push({ code: 'buyer-region-embargo', detail: `采购方声明不与 ${banned} 主体对接` });
    }
  }
  for (const banned of supplier.embargoRegions ?? []) {
    if (buyer.region === banned) {
      rejections.push({ code: 'supplier-region-embargo', detail: `供应方声明不与 ${banned} 主体对接` });
    }
  }

  // 2. 行业能力：在供应方能力清单里找产品/行业匹配项。
  const matchedCap = (supplier.capabilities ?? []).find((c) => {
    const productOk = c.product === demand.product;
    const industryOk = !demand.industry || !c.industry || c.industry === demand.industry;
    return productOk && industryOk;
  });
  if (!matchedCap) {
    rejections.push({
      code: 'no-capability',
      detail: `供应方不具备「${demand.product}${demand.industry ? ` / ${demand.industry}` : ''}」的供给能力`,
    });
  }

  // 3. 需求条件
  if (matchedCap && demand.requiredCertifications?.length) {
    const held = new Set(matchedCap.certifications ?? []);
    const missing = demand.requiredCertifications.filter((c) => !held.has(c));
    if (missing.length) {
      rejections.push({ code: 'missing-certification', detail: `缺少资质：${missing.join('、')}` });
    }
  }
  if (matchedCap && demand.targetRegions?.length) {
    const served = new Set(matchedCap.regions ?? [supplier.region].filter(Boolean));
    const hit = demand.targetRegions.filter((r) => served.has(r));
    if (!hit.length) {
      rejections.push({
        code: 'region-mismatch',
        detail: `供应方服务区域不覆盖目标区域：${demand.targetRegions.join('、')}`,
      });
    } else if (hit.length === demand.targetRegions.length) {
      reasons.push({ factor: '区域', score: 15, text: `覆盖全部目标区域（${hit.join('、')}）` });
    } else {
      reasons.push({ factor: '区域', score: 8, text: `覆盖部分目标区域（${hit.join('、')}）` });
    }
  }
  if (matchedCap && demand.minQuantity && matchedCap.annualCapacity != null) {
    if (matchedCap.annualCapacity < demand.minQuantity) {
      rejections.push({
        code: 'capacity-shortfall',
        detail: `年产能 ${matchedCap.annualCapacity} 低于最小需求量 ${demand.minQuantity}`,
      });
    } else {
      const headroom = matchedCap.annualCapacity / demand.minQuantity;
      const score = headroom >= 2 ? 15 : headroom >= 1.3 ? 10 : 5;
      reasons.push({
        factor: '产能',
        score,
        text: `年产能 ${matchedCap.annualCapacity}，对最小需求 ${demand.minQuantity} 有 ${headroom.toFixed(1)} 倍富余`,
      });
    }
  }
  if (matchedCap && demand.maxUnitPrice != null && matchedCap.unitPrice != null) {
    if (matchedCap.unitPrice > demand.maxUnitPrice) {
      rejections.push({
        code: 'price-exceeds-budget',
        detail: `报价 ${matchedCap.unitPrice} 超出预算上限 ${demand.maxUnitPrice}`,
      });
    } else {
      reasons.push({ factor: '价格', score: 5, text: `报价 ${matchedCap.unitPrice} 在预算上限 ${demand.maxUnitPrice} 以内` });
    }
  }

  // 4. 语言：优先看双方实际出席的授权联系人，其次看企业登记语言。
  const buyerContact = contactBook?.findAuthorized(buyer.id, 'match');
  const supplierContact = contactBook?.findAuthorized(supplier.id, 'match');
  const buyerLangs = buyerContact?.languages?.length ? buyerContact.languages : buyer.languages;
  const supplierLangs = supplierContact?.languages?.length ? supplierContact.languages : supplier.languages;
  const common = sharedLanguages(buyerLangs ?? [], supplierLangs ?? []);
  if (!common.length) {
    rejections.push({
      code: 'no-common-language',
      detail: `无共同工作语言（采购方：${(buyerLangs ?? []).join('/') || '未登记'}；供应方：${(supplierLangs ?? []).join('/') || '未登记'}）`,
    });
  } else {
    reasons.push({ factor: '语言', score: common.length >= 2 ? 10 : 7, text: `共同语言：${common.join('、')}` });
  }

  // 5. 可用时段
  const overlaps = intersectAvailability(buyer.availability ?? [], supplier.availability ?? []);
  if (!overlaps.length) {
    rejections.push({ code: 'no-overlapping-slot', detail: '双方周期性可用时段没有交集' });
  } else {
    const minutes = overlaps.reduce((sum, o) => sum + (o.end - o.start), 0);
    const score = minutes >= 180 ? 15 : minutes >= 90 ? 10 : 5;
    reasons.push({ factor: '时段', score, text: `共同可约时段：${describeOverlaps(overlaps)}` });
  }

  if (rejections.length) {
    return { eligible: false, score: 0, reasons, rejections, commonLanguages: common, overlaps };
  }

  // 行业契合评分
  if (demand.industry && matchedCap.industry === demand.industry) {
    reasons.push({ factor: '行业', score: 20, text: `同属 ${demand.industry} 行业，产品线直接对口` });
  } else {
    reasons.push({ factor: '行业', score: 12, text: '产品类目匹配' });
  }
  if (priorCooperations > 0) {
    reasons.push({ factor: '历史', score: 10, text: `双方已有 ${priorCooperations} 次合作记录` });
  }

  let score = reasons.reduce((s, r) => s + r.score, 0);
  score = Math.min(100, score);
  return { eligible: true, score, reasons, rejections: [], commonLanguages: common, overlaps, matchedCap };
}

// 为一条需求在全体主体中找候选，按分数降序。supplierOrgIds 可限定候选范围。
// historyOf(buyerId, supplierId) 可选，返回双方历史合作次数。
export function recommendForDemand({ demand, buyer, registry, embargo, contactBook, limit = 10, excludeOwn = true, historyOf }) {
  const candidates = [];
  for (const supplier of registry.list()) {
    if (excludeOwn && supplier.id === buyer.id) continue;
    const priorCooperations = historyOf ? historyOf(buyer.id, supplier.id) : 0;
    const result = evaluateMatch({ demand, buyer, supplier, embargo, contactBook, priorCooperations });
    candidates.push({ supplierId: supplier.id, supplierName: supplier.name, ...result });
  }
  candidates.sort((a, b) => b.score - a.score);
  const eligible = candidates.filter((c) => c.eligible).slice(0, limit);
  const rejected = candidates.filter((c) => !c.eligible);
  return { eligible, rejectedCount: rejected.length, rejectedSample: rejected.slice(0, 5) };
}
