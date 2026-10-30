import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { API_SCOPES, DEFAULT_USER_NOTIFY_PREFS, createApiKeyRequestSchema, type UserMailboxPolicy } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { attachments, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { assertReceiveOnlyRequest, isReceiveOnly } from '../src/lib/receive-only.js';
import { createApiKey } from '../src/services/api-key.js';
import { replaceMailboxShares } from '../src/services/mailbox-share.js';
import { getUserNotifyPrefs, loadNotifyOwners, notifyOwnersFromRows } from '../src/services/notify-prefs.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { updateUser } from '../src/services/user.js';

const app = createApp();
const db = createDb(env);
const domain = 'private.receive.test';
const publicDomain = 'public.receive.test';
const policy: UserMailboxPolicy = { receiveOnly: true, perUserLimit: 2, domains: [{ domain, perUserLimit: 2 }] };

async function fixture() {
  const prefix = `receive-${crypto.randomUUID().slice(0, 8)}`;
  await updateSettings(env, {
    domains: { list: [{ domain, public: false, perUserLimit: 1 }, { domain: publicDomain, public: true, perUserLimit: 1 }] },
    mailbox_policy: { perUserLimit: 1, reservedLocalParts: ['admin'] },
    code_extract: { enabled: false, aiEnabled: false }, security: { require2fa: false }, api: { enabled: true },
  });
  async function account(name: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${name}`, passwordHash: 'test-only', role,
      authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
    return { ...user, jwt };
  }
  const admin = await account('admin', 'admin');
  const user = await account('staff');
  const other = await account('other');
  const set = async (mailboxPolicy: UserMailboxPolicy | null, id = user.id) => {
    const row = (await db.select().from(users).where(eq(users.id, id)).get())!;
    return updateUser(env, admin.id, id, { mailboxPolicy, expectedMailboxPolicyRevision: row.mailboxPolicyRevision });
  };
  const box = async (id: number) => (await db.insert(mailboxes).values({ userId: id, domain,
    address: `${prefix}-${id}@${domain}` }).returning().get())!;
  const mail = async (address: string) => {
    const rawR2Key = `receive-only/${crypto.randomUUID()}`;
    await env.r2.put(rawR2Key, 'Subject: receive-only test\r\n\r\nowned message');
    return (await db.insert(messages).values({ address, domain, direction: 'inbound', status: 'received',
      bodyText: 'owned message', rawR2Key }).returning().get())!;
  };
  return { prefix, admin, user, other, set, box, mail };
}

async function request(path: string, token: string, method = 'GET', body?: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}

describe('receive-only users', () => {
  it('allows private-domain prefixes, own reads, read state and notes while enforcing domain and quota rules', async () => {
    const f = await fixture();
    await f.set(policy);
    expect(await data(await request('/api/auth/me', f.user.jwt))).toMatchObject({ role: 'user', receiveOnly: true });
    expect(await data(await request('/api/domains', f.user.jwt))).toEqual([domain]);
    const box = await data<{ id: number; address: string }>(await request('/api/mailboxes', f.user.jwt, 'POST',
      { localPart: `${f.prefix}-one`, domain }), 201);
    const mail = await f.mail(box.address);
    expect((await request(`/api/messages/${mail.id}`, f.user.jwt)).status).toBe(200);
    expect((await request(`/api/messages/${mail.id}/raw`, f.user.jwt)).status).toBe(200);
    expect((await request(`/api/messages/${mail.id}/thread`, f.user.jwt)).status).toBe(200);
    expect(await data(await request('/api/messages/read', f.user.jwt, 'POST', { ids: [mail.id], isRead: true }))).toEqual({ changed: 1 });
    expect((await request(`/api/mailboxes/${box.id}`, f.user.jwt, 'PUT', { displayName: 'Billing' })).status).toBe(200);
    expect((await request('/api/mailboxes', f.user.jwt, 'POST', { localPart: `${f.prefix}-public`, domain: publicDomain })).status).toBe(403);
    expect((await request('/api/mailboxes', f.user.jwt, 'POST', { localPart: 'admin', domain })).status).toBe(403);
    expect((await request('/api/mailboxes', f.user.jwt, 'POST', { localPart: `${f.prefix}-two`, domain })).status).toBe(201);
    expect((await request('/api/mailboxes', f.user.jwt, 'POST', { localPart: `${f.prefix}-three`, domain })).status).toBe(403);
  });

  it('denies sending, destructive actions, sharing, settings and administration before handling the request body', async () => {
    const f = await fixture();
    const box = await f.box(f.user.id);
    const mail = await f.mail(box.address);
    await f.set(policy);
    const denied = [
      ['POST', '/api/messages/send'], ['POST', '/api/messages/delete'], ['POST', '/api/messages/restore'],
      ['POST', '/api/messages/purge'], ['POST', '/api/messages/star'], ['POST', `/api/messages/${mail.id}/translate`],
      ['POST', '/api/uploads'], ['GET', '/api/api-keys'], ['POST', '/api/api-keys'],
      ['GET', '/api/hosted-domains'], ['POST', '/api/hosted-domains'], ['PUT', '/api/me/notify-prefs'],
      ['GET', '/api/me/notify-prefs'], ['GET', '/api/mailboxes/share-users'], ['PUT', '/api/mailboxes/shares'],
      ['POST', '/api/mailboxes/shares/batch'], ['DELETE', `/api/mailboxes/${box.id}`],
      ['GET', '/api/admin/users'], ['PUT', `/api/admin/users/${f.user.id}`],
    ];
    for (const [method, path] of denied) {
      const response = await request(path!, f.user.jwt, method, method === 'GET' ? undefined : {});
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect((await db.select().from(messages).where(eq(messages.id, mail.id)).get())?.deletedAt).toBeNull();
    expect(() => assertReceiveOnlyRequest({ role: 'user', receiveOnly: true }, 'POST', '/api/future-feature')).toThrow();
  });

  it('never exposes another mailbox even when shared, including threads, raw files and attachments', async () => {
    const f = await fixture();
    const own = await f.box(f.user.id);
    const foreign = await f.box(f.other.id);
    const ownMail = await f.mail(own.address);
    const foreignMail = await f.mail(foreign.address);
    const attachment = (await db.insert(attachments).values({ messageId: foreignMail.id, r2Key: foreignMail.rawR2Key! }).returning().get())!;
    await replaceMailboxShares(env, f.other.id, foreign.id, [f.user.id]);
    expect((await request(`/api/messages/${foreignMail.id}`, f.user.jwt)).status).toBe(200);
    await f.set(policy);
    expect(await data(await request('/api/mailboxes/shared', f.user.jwt))).toEqual([]);
    const list = await data<{ items: { id: number }[] }>(await request('/api/messages', f.user.jwt));
    expect(list.items.map(({ id }) => id)).toEqual([ownMail.id]);
    for (const path of [`/api/messages/${foreignMail.id}`, `/api/messages/${foreignMail.id}/thread`,
      `/api/messages/${foreignMail.id}/raw`, `/api/attachments/${attachment.id}`]) {
      expect((await request(path, f.user.jwt)).status, path).toBe(404);
    }
    expect((await request(`/api/messages?scope=user&userId=${f.other.id}`, f.user.jwt)).status).toBe(403);
    expect((await request('/api/mailboxes?all=1', f.user.jwt)).status).toBe(403);
    expect(await data(await request('/api/messages/read', f.user.jwt, 'POST', { ids: [foreignMail.id], isRead: true }))).toEqual({ changed: 0 });
  });

  it('applies immediately to old sessions and API keys, including the auth migration path; administrators stay exempt', async () => {
    const f = await fixture();
    const key = await createApiKey(env, f.user.id, createApiKeyRequestSchema.parse({ name: 'existing', scopes: [...API_SCOPES] }));
    expect((await request('/v1/domains', key.key)).status).toBe(200);
    await f.set(policy);
    expect((await request('/v1/domains', key.key)).status).toBe(403);
    expect((await request('/v1/messages', key.key, 'POST', {})).status).toBe(403);
    await db.update(users).set({ authVersionMigrated: false }).where(eq(users.id, f.user.id));
    expect(await data(await request('/api/auth/me', f.user.jwt))).toMatchObject({ receiveOnly: true });
    expect((await request('/api/messages/send', f.user.jwt, 'POST', {})).status).toBe(403);
    await f.set(policy, f.admin.id);
    expect(await data(await request('/api/auth/me', f.admin.jwt))).toMatchObject({ receiveOnly: false });
    expect((await request('/api/admin/users', f.admin.jwt)).status).toBe(200);
    await f.set(null);
    expect(await data(await request('/api/auth/me', f.user.jwt))).toMatchObject({ receiveOnly: false });
    expect((await request('/v1/domains', key.key)).status).toBe(200);
  });

  it('suppresses previously enabled automatic forwarding and notifications on every owner-loading path', async () => {
    const f = await fixture();
    const prefs = { ...DEFAULT_USER_NOTIFY_PREFS, forward: { enabled: true, addresses: ['recipient@example.com'] } };
    await db.update(users).set({ notifyPrefs: prefs }).where(eq(users.id, f.user.id));
    expect((await getUserNotifyPrefs(env, f.user.id)).forward.enabled).toBe(true);
    await f.set(policy);
    expect(await getUserNotifyPrefs(env, f.user.id)).toEqual(DEFAULT_USER_NOTIFY_PREFS);
    expect((await loadNotifyOwners(env, [f.user.id])).get(f.user.id)?.prefs).toEqual(DEFAULT_USER_NOTIFY_PREFS);
    expect(notifyOwnersFromRows([{ id: f.user.id, role: 'user', status: 'active', notify_prefs: JSON.stringify(prefs),
      mailbox_policy: JSON.stringify(policy) }], []).get(f.user.id)?.prefs).toEqual(DEFAULT_USER_NOTIFY_PREFS);
    await f.set(null);
    expect((await getUserNotifyPrefs(env, f.user.id)).forward.enabled).toBe(true);
  });

  it('fails closed on malformed policies and leaves legacy policies unrestricted', () => {
    for (const value of ['broken', '[]', '{"receiveOnly":"true"}']) expect(() => isReceiveOnly('user', value)).toThrow();
    expect(isReceiveOnly('user', null)).toBe(false);
    expect(isReceiveOnly('user', { perUserLimit: 2, domains: [] })).toBe(false);
    expect(isReceiveOnly('admin', policy)).toBe(false);
  });
});
