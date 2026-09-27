import { createPlatform } from '../src/platform.js';

// 固定时钟的测试平台：每次调用时钟前进一秒，保证通知与记录时间确定且有序。
export function makePlatform() {
  let t = Date.parse('2026-10-12T08:00:00+08:00');
  const clock = () => new Date((t += 1000)).toISOString();
  return createPlatform({ clock });
}

export const FULL_SCOPES = ['confirm_meeting', 'update_demand', 'sign_intent', 'share_confidential'];

// 注册企业并登记一名全授权联系人，返回 { enterprise, contact }。
export function addEnterprise(platform, input, scopes = FULL_SCOPES) {
  const { enterprise, duplicates } = platform.registry.registerEnterprise(input);
  const contact = platform.registry.registerContact({
    enterpriseId: enterprise.id,
    name: input.contactName ?? `${enterprise.legalName}代表`,
    role: '参会代表',
    scopes,
  });
  return { enterprise, contact, duplicates };
}
