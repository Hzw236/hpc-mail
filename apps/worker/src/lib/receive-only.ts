import { sql } from 'drizzle-orm';
import { AppError } from './errors.js';

/** A user permission, independent of the account's Cloudflare sending plan. */
export function isReceiveOnly(role: string, policy: unknown): boolean {
  if (role === 'admin' || policy === null || policy === undefined) return false;
  let value: unknown = policy;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new AppError('internal', '邮箱权限配置无效，请联系管理员'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('internal', '邮箱权限配置无效，请联系管理员');
  }
  const restricted = (value as { receiveOnly?: unknown }).receiveOnly;
  if (restricted !== undefined && typeof restricted !== 'boolean') {
    throw new AppError('internal', '邮箱权限配置无效，请联系管理员');
  }
  return restricted === true;
}

/** Explicit allow-list: new business endpoints stay unavailable until reviewed. */
export function assertReceiveOnlyRequest(user: { role: string; receiveOnly?: boolean }, method: string, path: string): void {
  if (user.role === 'admin' || !user.receiveOnly) return;
  const allowed = method === 'GET'
    ? /^(?:\/api\/auth\/me|\/api\/domains|\/api\/mailboxes(?:\/(?:availability|random-plan|shared))?|\/api\/messages(?:\/(?:unread-count|sync|\d+(?:\/(?:thread|raw))?))?|\/api\/attachments\/\d+)$/.test(path)
    : method === 'POST'
      ? /^(?:\/api\/auth\/(?:logout|avatar|2fa\/(?:setup|enable|disable))|\/api\/mailboxes(?:\/(?:batch|availability\/batch))?|\/api\/messages\/(?:read|read-all))$/.test(path)
      : method === 'PUT'
        ? /^(?:\/api\/auth\/password|\/api\/mailboxes\/\d+)$/.test(path)
        : method === 'DELETE' && path === '/api/auth/avatar';
  if (!allowed) throw new AppError('forbidden', '此账号仅可收信和创建邮箱前缀');
}

/** Receive-only users never gain access through another user's mailbox share. */
export const sharedMailAllowed = (userId: number) => sql`NOT EXISTS (
  SELECT 1 FROM users AS access_user WHERE access_user.id = ${userId}
    AND access_user.role != 'admin'
    AND json_extract(access_user.mailbox_policy, '$.receiveOnly') = 1
)`;
