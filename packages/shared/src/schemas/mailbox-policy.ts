import { z } from 'zod';
import { domainSchema } from './mailbox.js';

/** 用户专属认领规则：完整替代公共域名与数量配置；0 表示不限。 */
export const userMailboxPolicySchema = z.object({
  /** 仅收信：只读自己的邮件、创建邮箱前缀和维护账户安全。管理员豁免。 */
  receiveOnly: z.boolean().optional(),
  perUserLimit: z.number().int().min(0).max(10000),
  domains: z.array(z.object({
    domain: domainSchema,
    perUserLimit: z.number().int().min(0).max(10000),
  })).max(64).refine((entries) => new Set(entries.map((entry) => entry.domain)).size === entries.length, '域名不能重复'),
});
export type UserMailboxPolicy = z.infer<typeof userMailboxPolicySchema>;
