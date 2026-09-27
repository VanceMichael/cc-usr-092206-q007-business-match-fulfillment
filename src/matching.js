// 可解释匹配：依据行业能力、需求条件、禁配关系、语言与可用时段生成带理由的候选。
// 每条候选都附带理由；被排除的组合也记录原因，便于秘书处解释"为什么没有配上"。

function intersect(a, b) {
  const set = new Set(b);
  return [...new Set(a)].filter((x) => set.has(x));
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let hit = 0;
  for (const x of sa) if (sb.has(x)) hit += 1;
  return hit / (sa.size + sb.size - hit);
}

const round2 = (x) => Math.round(x * 100) / 100;
const decap = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// 需求条件：minX/maxX 表示数值上下限；数组表示需全部具备；其余为相等或包含。
export function checkConditions(conditions = {}, attributes = {}) {
  const satisfied = [];
  const failures = [];
  for (const [key, expected] of Object.entries(conditions)) {
    if (key.startsWith('min') && key.length > 3) {
      const attr = decap(key.slice(3));
      const actual = attributes[attr];
      if (typeof actual === 'number' && actual >= expected) satisfied.push(`${attr} ${actual} ≥ 要求的 ${expected}`);
      else failures.push(`${attr} 需 ≥ ${expected}（实际 ${actual ?? '未提供'}）`);
    } else if (key.startsWith('max') && key.length > 3) {
      const attr = decap(key.slice(3));
      const actual = attributes[attr];
      if (typeof actual === 'number' && actual <= expected) satisfied.push(`${attr} ${actual} ≤ 要求的 ${expected}`);
      else failures.push(`${attr} 需 ≤ ${expected}（实际 ${actual ?? '未提供'}）`);
    } else if (Array.isArray(expected)) {
      const actual = attributes[key];
      const have = Array.isArray(actual) ? actual : actual == null ? [] : [actual];
      const missing = expected.filter((v) => !have.includes(v));
      if (missing.length === 0) satisfied.push(`${key} 具备 ${expected.join('、')}`);
      else failures.push(`${key} 缺少 ${missing.join('、')}`);
    } else {
      const actual = attributes[key];
      const ok = actual === expected || (Array.isArray(actual) && actual.includes(expected));
      if (ok) satisfied.push(`${key} 符合 ${expected}`);
      else failures.push(`${key} 需为 ${expected}（实际 ${Array.isArray(actual) ? actual.join('、') : actual ?? '未提供'}）`);
    }
  }
  return { satisfied, failures };
}

function exclusionReason(a, b, exclusions) {
  if (a.id === b.id) return '同一主体';
  if (a.groupId && a.groupId === b.groupId) return '同一集团';
  const hit = exclusions.find((e) => (e.a === a.id && e.b === b.id) || (e.a === b.id && e.b === a.id));
  return hit ? `禁配关系：${hit.reason}` : null;
}

const recordLanguages = (record, enterprise) => record.languages ?? enterprise.languages ?? [];

function evaluatePair(supply, demand, enterprisesById, exclusions) {
  const fail = (reason) => ({ ok: false, reason });
  const supplier = enterprisesById.get(supply.enterpriseId);
  const demander = enterprisesById.get(demand.enterpriseId);
  if (!supplier || !demander) return fail('主体缺失或已合并');

  const excluded = exclusionReason(supplier, demander, exclusions);
  if (excluded) return fail(excluded);

  const capOverlap = intersect(supply.capabilities ?? [], demand.needs ?? []);
  const sameIndustry = Boolean(supply.industry) && supply.industry === demand.industry;
  if (!sameIndustry && capOverlap.length === 0) return fail('行业与能力不匹配');

  const cond = checkConditions(demand.conditions, supply.attributes);
  if (cond.failures.length > 0) return fail(`需求条件不满足：${cond.failures[0]}`);

  const langs = intersect(recordLanguages(supply, supplier), recordLanguages(demand, demander));
  if (langs.length === 0) return fail('无共同语言');

  const slots = intersect(supply.slots ?? [], demand.slots ?? []);
  if (slots.length === 0) return fail('无共同可用时段');

  const reasons = [];
  if (sameIndustry) reasons.push(`同行业：${supply.industry}`);
  if (capOverlap.length > 0) reasons.push(`供应能力「${capOverlap.join('、')}」覆盖对方需求`);
  for (const c of cond.satisfied) reasons.push(`需求条件满足：${c}`);
  reasons.push(`共同语言：${langs.join('、')}`);
  reasons.push(`共同可用时段 ${slots.length} 个`);

  const score = round2(
    50 * jaccard(supply.capabilities ?? [], demand.needs ?? []) +
    30 +
    (10 * Math.min(langs.length, 2)) / 2 +
    (10 * Math.min(slots.length, 3)) / 3,
  );

  return {
    ok: true,
    candidate: {
      id: `CAND-${supply.id}-${demand.id}`,
      supplyRecordId: supply.id,
      demandRecordId: demand.id,
      supplierEnterpriseId: supplier.id,
      demanderEnterpriseId: demander.id,
      score,
      reasons,
      commonSlots: slots,
      commonLanguages: langs,
      versions: { supply: supply.version, demand: demand.version },
    },
  };
}

export function generateCandidates({ supplies, demands, enterprisesById, exclusions = [], collectRejections = false }) {
  // 行业与需求标签倒排索引，避免 4700+ 记录的全量两两比对。
  const byIndustry = new Map();
  const byNeed = new Map();
  const indexPush = (map, key, value) => {
    if (!key) return;
    const arr = map.get(key) ?? [];
    arr.push(value);
    map.set(key, arr);
  };
  for (const d of demands) {
    indexPush(byIndustry, d.industry, d);
    for (const n of d.needs ?? []) indexPush(byNeed, n, d);
  }

  const candidates = [];
  const rejections = [];
  const rejectionSummary = {};
  const seen = new Set();

  for (const s of supplies) {
    const pool = new Set([
      ...(byIndustry.get(s.industry) ?? []),
      ...(s.capabilities ?? []).flatMap((c) => byNeed.get(c) ?? []),
    ]);
    for (const d of pool) {
      const key = `${s.id}|${d.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = evaluatePair(s, d, enterprisesById, exclusions);
      if (result.ok) {
        candidates.push(result.candidate);
      } else {
        rejectionSummary[result.reason] = (rejectionSummary[result.reason] ?? 0) + 1;
        if (collectRejections) {
          rejections.push({ supplyRecordId: s.id, demandRecordId: d.id, reason: result.reason });
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { candidates, rejectionSummary, rejections };
}
