// 通知中心：平台所有资源变动都通过这里告知企业联系人、企业与秘书处，留痕可查。
export function createNotificationCenter({ nextId, clock }) {
  const log = [];

  function send({ to, type, message, refs = {} }) {
    const recipients = Array.isArray(to) ? to : [to];
    const notice = { id: nextId('N'), at: clock(), type, recipients, message, refs };
    log.push(notice);
    return notice;
  }

  function listFor(recipient) {
    return log.filter((n) => n.recipients.includes(recipient));
  }

  function all() {
    return log.slice();
  }

  return { send, listFor, all };
}
