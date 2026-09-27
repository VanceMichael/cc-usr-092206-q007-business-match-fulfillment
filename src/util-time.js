// 时间与时段工具：统一使用 IANA 时区下的「星期/时刻」语义，避免跨境排期错位。
// 时刻用分钟数表示（0-1439），星期用 1-7 表示周一到周日。

export const DAYS = [1, 2, 3, 4, 5, 6, 7];

export function parseMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`时间格式应为 HH:MM，收到 ${hhmm}`);
  const value = Number(m[1]) * 60 + Number(m[2]);
  if (value > 24 * 60) throw new Error(`时间超出范围：${hhmm}`);
  return value;
}

export function formatMinutes(value) {
  const h = Math.floor(value / 60);
  const m = value % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 两个周期可用时段（[起始分钟, 结束分钟)）是否有交集。
export function windowsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

// 找出同一星期下两组时段的交集，返回 [{day, start, end}]。
export function intersectAvailability(left, right) {
  const overlaps = [];
  for (const a of left) {
    for (const b of right) {
      if (a.day === b.day && windowsOverlap(a, b)) {
        overlaps.push({
          day: a.day,
          start: Math.max(a.start, b.start),
          end: Math.min(a.end, b.end),
        });
      }
    }
  }
  return overlaps;
}

// ISO 日期字符串转 Date（UTC 解读，仅用于比较先后，不做本地换算）。
export function dayFromISO(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`日期应为 YYYY-MM-DD：${iso}`);
  return new Date(`${iso}T00:00:00Z`);
}

export function isExpired(iso, today = new Date().toISOString().slice(0, 10)) {
  return dayFromISO(iso).getTime() < dayFromISO(today).getTime();
}

// 把 [{day:'1', start:'09:00', end:'10:30'}] 这类外部输入规范化。
export function normalizeSlots(slots) {
  return (slots ?? []).map((s) => {
    const start = typeof s.start === 'number' ? s.start : parseMinutes(s.start);
    const end = typeof s.end === 'number' ? s.end : parseMinutes(s.end);
    if (end <= start) throw new Error(`可用时段结束必须晚于开始：${JSON.stringify(s)}`);
    return { day: Number(s.day), start, end };
  });
}
