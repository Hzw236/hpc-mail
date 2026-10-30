import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { userMailboxPolicySchema, type AdminUser, type UserMailboxPolicy } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

const limitError = (value: string) => value.trim() !== '' && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 10000
  ? undefined : '请输入 0–10000 的整数';

export function MailboxPolicyDialog({ target, onClose }: { target: AdminUser | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: queryKeys.admin.settings, queryFn: adminApi.getSettings, enabled: target !== null });
  const [mode, setMode] = useState<'public' | 'custom'>('public');
  const [total, setTotal] = useState('50');
  const [receiveOnly, setReceiveOnly] = useState(false);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  const [customInitialized, setCustomInitialized] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);

  function load(user: AdminUser) {
    setMode(user.mailboxPolicy ? 'custom' : 'public');
    setTotal(String(user.mailboxPolicy?.perUserLimit ?? 50));
    setReceiveOnly(user.mailboxPolicy?.receiveOnly === true);
    setLimits(Object.fromEntries((user.mailboxPolicy?.domains ?? []).map((entry) => [entry.domain, String(entry.perUserLimit)])));
    setRevision(user.mailboxPolicyRevision);
    setCustomInitialized(user.mailboxPolicy !== null);
    setErrors({});
    setError(null);
    setConflict(false);
  }

  useEffect(() => {
    if (target) load(target);
  }, [target?.id, target?.mailboxPolicyRevision]);

  const mutation = useMutation({
    mutationFn: (mailboxPolicy: UserMailboxPolicy | null) => adminApi.updateUser(target!.id, {
      mailboxPolicy, expectedMailboxPolicyRevision: revision,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.users });
      void queryClient.invalidateQueries({ queryKey: queryKeys.domains });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes.root });
      toast({ title: '邮箱权限已保存', variant: 'success' });
      onClose();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : '保存失败，请重试');
      setConflict(err instanceof ApiError && err.code === 'conflict');
    },
  });

  function changeMode(value: 'public' | 'custom') {
    if (value === 'custom' && !customInitialized && settings.data) {
      setTotal(String(settings.data.mailbox_policy.perUserLimit));
      setLimits(Object.fromEntries(settings.data.domains.list.filter((entry) => entry.public)
        .map((entry) => [entry.domain, String(entry.perUserLimit)])));
      setCustomInitialized(true);
    }
    setMode(value);
    setErrors({});
    setError(null);
  }

  async function reload() {
    if (!target) return;
    setReloading(true);
    try {
      const [users] = await Promise.all([
        queryClient.fetchQuery({ queryKey: queryKeys.admin.users, queryFn: adminApi.listUsers }),
        queryClient.fetchQuery({ queryKey: queryKeys.admin.settings, queryFn: adminApi.getSettings }),
      ]);
      const fresh = users.find((user) => user.id === target.id);
      if (!fresh) throw new Error('用户已不存在，请关闭弹窗并刷新列表');
      load(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败，请重试');
    } finally {
      setReloading(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!target || conflict || mutation.isPending || reloading) return;
    setError(null);
    if (mode === 'public') {
      mutation.mutate(null);
      return;
    }
    if (!settings.data || settings.isError) return;
    const nextErrors: Record<string, string | undefined> = { total: limitError(total) };
    for (const [domain, value] of Object.entries(limits)) nextErrors[domain] = limitError(value);
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    const parsed = userMailboxPolicySchema.safeParse({ perUserLimit: Number(total), ...(receiveOnly ? { receiveOnly: true } : {}),
      domains: Object.entries(limits).map(([domain, value]) => ({ domain, perUserLimit: Number(value) })) });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查输入');
      return;
    }
    mutation.mutate(parsed.data);
  }

  const entries = settings.data?.domains.list ?? [];
  const configured = new Set(entries.map(({ domain }) => domain));
  const missing = Object.keys(limits).filter((domain) => !configured.has(domain));
  const domainNames = [...entries.map(({ domain }) => domain), ...missing];
  const locked = mutation.isPending || reloading;
  const saveDisabled = locked || conflict || (mode === 'custom' && (!settings.data || settings.isError || missing.length > 0));

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !locked && onClose()}>
      <DialogContent className="max-w-xl" showClose={!locked}>
        <DialogHeader title="邮箱权限" description={target ? `设置 ${target.username} 的可认领域名与邮箱数量` : undefined} />
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogBody className="flex flex-col gap-4">
            <fieldset disabled={locked || settings.isPending} className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-ink">配置来源</span>
                <SegmentedControl aria-label="邮箱配置来源" value={mode} onValueChange={changeMode} options={[
                  { value: 'public', label: '公共配置' }, { value: 'custom', label: '专属配置' },
                ]} />
              </div>
              {mode === 'public' ? (
                <p className="text-sm text-ink-secondary">使用系统公开域名和公共数量上限，后续随公共配置变化。</p>
              ) : settings.isPending ? (
                <div role="status" className="flex items-center gap-2 text-sm text-ink-secondary"><Spinner />正在加载系统域名…</div>
              ) : settings.isError ? (
                <QueryErrorState error={settings.error} onRetry={() => void settings.refetch()} />
              ) : (
                <>
                  <p className="text-sm text-ink-secondary">以下域名与数量替代公共配置，可单独授权非公开域名。0 表示不限。</p>
                  <label className="flex items-start gap-3 rounded-md border border-line p-3">
                    <Checkbox checked={receiveOnly} onCheckedChange={(value) => setReceiveOnly(value === true)} aria-label="仅收信" />
                    <span className="text-sm"><span className="font-medium">仅收信</span>
                      <span className="mt-1 block text-xs text-ink-secondary">只读自己邮箱的来信、创建前缀和修改备注；禁止发信、转发通知、共享、删除和 API Key，保留账户安全设置。</span>
                    </span>
                  </label>
                  <FormField label="邮箱总数上限" description={`所有名下邮箱合计；当前 ${target?.mailboxCount ?? 0} 个。`} error={errors.total}>
                    {(field) => <Input {...field} type="number" min={0} max={10000} step={1} value={total}
                      onChange={(event) => setTotal(event.target.value)}
                      onBlur={() => setErrors((current) => ({ ...current, total: limitError(total) }))} />}
                  </FormField>
                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-ink">可认领域名与各域名上限</span>
                    {domainNames.map((domain) => {
                      const entry = entries.find((candidate) => candidate.domain === domain);
                      const selected = limits[domain] !== undefined;
                      const owned = target?.mailboxes.filter((address) => address.endsWith(`@${domain}`)).length ?? 0;
                      return (
                        <div key={domain} className="rounded-md border border-line bg-canvas p-3">
                          <label className="flex min-h-11 cursor-pointer items-center gap-3">
                            <Checkbox checked={selected} aria-label={`允许 ${domain}`} onCheckedChange={(checked) => {
                              setLimits((current) => {
                                const next = { ...current };
                                if (checked === true) next[domain] = String(entry?.perUserLimit ?? 0);
                                else delete next[domain];
                                return next;
                              });
                            }} />
                            <span className="min-w-0 flex-1 break-all text-sm font-medium text-ink">{domain}</span>
                            {!entry ? <Badge tone="critical">已移除</Badge> : !entry.public ? <Badge tone="neutral">非公开</Badge> : null}
                          </label>
                          {selected && entry && (
                            <FormField label={`${domain} 邮箱上限`} description={`当前已绑定 ${owned} 个。`} error={errors[domain]}>
                              {(field) => <Input {...field} type="number" min={0} max={10000} step={1} value={limits[domain]}
                                onChange={(event) => setLimits((current) => ({ ...current, [domain]: event.target.value }))}
                                onBlur={() => setErrors((current) => ({ ...current, [domain]: limitError(limits[domain]!) }))} />}
                            </FormField>
                          )}
                        </div>
                      );
                    })}
                    {domainNames.length === 0 && <p className="text-sm text-ink-secondary">尚未配置系统域名。</p>}
                    {Object.keys(limits).length === 0 && <p className="text-xs text-ink-tertiary">未选择域名：该用户将不能新增认领邮箱。</p>}
                    {missing.length > 0 && <p role="alert" className="text-xs text-critical">请取消已移除域名的授权后保存。</p>}
                  </div>
                </>
              )}
            </fieldset>
            <p className="text-xs text-ink-tertiary">已有邮箱继续计入额度。仅收信限制会立即应用到现有会话和 API Key。域名与数量配置同时约束新增认领和管理员过户，系统保留前缀仍受限制。</p>
            {error && <p role="alert" className="text-sm text-critical">{error}</p>}
            {conflict && <Button type="button" variant="secondary" loading={reloading} onClick={() => void reload()}>重新加载配置</Button>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={locked} onClick={onClose}>取消</Button>
            <Button type="submit" loading={mutation.isPending} disabled={saveDisabled}>保存权限</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
