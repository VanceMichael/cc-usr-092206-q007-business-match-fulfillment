// 供需记录：承载企业发布的供给与需求，支持版本化更新（企业改需求即升版本）。
export function createRecordStore({ nextId, clock }) {
  const records = new Map();

  function add(input) {
    if (!input.enterpriseId) throw new Error('供需记录必须归属企业');
    if (!['supply', 'demand'].includes(input.kind)) throw new Error('kind 必须为 supply 或 demand');
    const record = {
      id: nextId('SD'),
      enterpriseId: input.enterpriseId,
      kind: input.kind,
      industry: input.industry ?? '',
      capabilities: input.capabilities ?? [],
      needs: input.needs ?? [],
      conditions: input.conditions ?? {},
      attributes: input.attributes ?? {},
      languages: input.languages ?? null, // 缺省继承企业语言
      slots: input.slots ?? [],
      version: 1,
      status: 'open',
      createdAt: clock(),
      updatedAt: clock(),
    };
    records.set(record.id, record);
    return record;
  }

  function update(id, changes) {
    const record = must(id);
    if (record.status !== 'open') throw new Error(`记录 ${id} 已关闭，不能修改`);
    const previousVersion = record.version;
    for (const key of ['industry', 'capabilities', 'needs', 'conditions', 'attributes', 'languages', 'slots']) {
      if (changes[key] !== undefined) record[key] = changes[key];
    }
    record.version += 1;
    record.updatedAt = clock();
    return { record, previousVersion };
  }

  function close(id) {
    const record = must(id);
    record.status = 'closed';
    record.updatedAt = clock();
    return record;
  }

  function reassignEnterprise(fromId, toId) {
    let moved = 0;
    for (const r of records.values()) {
      if (r.enterpriseId === fromId) {
        r.enterpriseId = toId;
        moved += 1;
      }
    }
    return moved;
  }

  function must(id) {
    const r = records.get(id);
    if (!r) throw new Error(`供需记录不存在：${id}`);
    return r;
  }

  return {
    add,
    update,
    close,
    reassignEnterprise,
    get: must,
    list: ({ status } = {}) => [...records.values()].filter((r) => !status || r.status === status),
    byEnterprise: (enterpriseId) => [...records.values()].filter((r) => r.enterpriseId === enterpriseId),
  };
}
