// 平台内部使用的确定性编号生成器，便于测试与审计对账。
export function createIdGenerator() {
  const counters = new Map();
  return function nextId(prefix) {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(4, '0')}`;
  };
}
