import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AdminUser } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { MailboxPolicyDialog } from './mailbox-policy-dialog';

const mocks = vi.hoisted(() => ({ getSettings: vi.fn(), updateUser: vi.fn(), listUsers: vi.fn(), toast: vi.fn() }));
vi.mock('@/api/resources', () => ({ adminApi: mocks }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
const settings = { ...DEFAULT_SETTINGS,
  mailbox_policy: { perUserLimit: 2, reservedLocalParts: ['admin'] },
  domains: { list: [{ domain: 'public.example', public: true, perUserLimit: 1 }, { domain: 'private.example', public: false, perUserLimit: 1 }] },
};
const user = (patch: Partial<AdminUser> = {}): AdminUser => ({
  id: 8, username: 'alice', role: 'user', status: 'active', mailboxCount: 1,
  mailboxes: ['owned@private.example'], mailboxPolicy: null, mailboxPolicyRevision: 7,
  apiKeyCount: 0, createdAt: '2026-10-11T00:00:00.000Z', lastLoginAt: null, avatarUrl: null, ...patch,
});
function show(target = user()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const close = vi.fn();
  render(<QueryClientProvider client={client}><MailboxPolicyDialog target={target} onClose={close} /></QueryClientProvider>);
  return { client, close };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mocks.getSettings.mockResolvedValue(settings);
  mocks.updateUser.mockResolvedValue(user());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function custom() {
  const option = screen.getByRole('radio', { name: '专属配置' });
  await waitFor(() => expect(option).not.toBeDisabled());
  await userEvent.click(option);
}

describe('邮箱权限弹窗', () => {
  it('保存并回显仅收信限制，取消时恢复普通权限', async () => {
    show();
    await custom();
    await userEvent.click(screen.getByRole('checkbox', { name: '仅收信' }));
    await userEvent.click(screen.getByRole('button', { name: '保存权限' }));
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith(8, {
      mailboxPolicy: { receiveOnly: true, perUserLimit: 2, domains: [{ domain: 'public.example', perUserLimit: 1 }] },
      expectedMailboxPolicyRevision: 7,
    }));
    cleanup();
    show(user({ mailboxPolicy: { receiveOnly: true, perUserLimit: 2, domains: [] } }));
    expect(await screen.findByRole('checkbox', { name: '仅收信' })).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: '仅收信' }));
    await userEvent.click(screen.getByRole('button', { name: '保存权限' }));
    await waitFor(() => expect(mocks.updateUser).toHaveBeenLastCalledWith(8, {
      mailboxPolicy: { perUserLimit: 2, domains: [] }, expectedMailboxPolicyRevision: 7,
    }));
  });

  it('从公共配置初始化，授权私有域并保存独立总数、域名上限及版本', async () => {
    const { close } = show();
    await custom();
    expect(screen.getByLabelText('邮箱总数上限')).toHaveValue(2);
    expect(screen.getByRole('checkbox', { name: '允许 public.example' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '允许 private.example' })).not.toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: '允许 public.example' }));
    await userEvent.click(screen.getByRole('checkbox', { name: '允许 private.example' }));
    fireEvent.change(screen.getByLabelText('邮箱总数上限'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('private.example 邮箱上限'), { target: { value: '3' } });
    await userEvent.click(screen.getByRole('button', { name: '保存权限' }));
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith(8, {
      mailboxPolicy: { perUserLimit: 10, domains: [{ domain: 'private.example', perUserLimit: 3 }] },
      expectedMailboxPolicyRevision: 7,
    }));
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith({ title: '邮箱权限已保存', variant: 'success' });
  });

  it('回显专属配置，允许恢复公共配置', async () => {
    show(user({ mailboxPolicy: { perUserLimit: 9, domains: [{ domain: 'private.example', perUserLimit: 4 }] } }));
    await screen.findByLabelText('邮箱总数上限');
    expect(screen.getByLabelText('邮箱总数上限')).toHaveValue(9);
    expect(screen.getByLabelText('private.example 邮箱上限')).toHaveValue(4);
    await userEvent.click(screen.getByRole('radio', { name: '公共配置' }));
    await userEvent.click(screen.getByRole('button', { name: '保存权限' }));
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith(8, { mailboxPolicy: null, expectedMailboxPolicyRevision: 7 }));
  });

  it('空数量不会变成不限，显示字段错误并阻止保存', async () => {
    show();
    await custom();
    const total = screen.getByLabelText('邮箱总数上限');
    fireEvent.change(total, { target: { value: '' } });
    fireEvent.blur(total);
    expect(screen.getByRole('alert')).toHaveTextContent('请输入 0–10000 的整数');
    await userEvent.click(screen.getByRole('button', { name: '保存权限' }));
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('空白名单可保存，提示用户将不能新增认领邮箱', async () => {
    show();
    await custom();
    await userEvent.click(screen.getByRole('checkbox', { name: '允许 public.example' }));
    expect(screen.getByText(/未选择域名/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '保存权限' }));
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith(8, {
      mailboxPolicy: { perUserLimit: 2, domains: [] }, expectedMailboxPolicyRevision: 7,
    }));
  });

  it('配置冲突保留草稿并要求显式重载，重载后使用新版本', async () => {
    mocks.updateUser.mockRejectedValueOnce(new ApiError('邮箱权限已改变', { code: 'conflict', httpStatus: 409 }));
    mocks.listUsers.mockResolvedValue([user({ mailboxPolicyRevision: 9,
      mailboxPolicy: { perUserLimit: 11, domains: [{ domain: 'private.example', perUserLimit: 5 }] } })]);
    show();
    await custom();
    await userEvent.click(screen.getByRole('button', { name: '保存权限' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('邮箱权限已改变');
    expect(screen.getByRole('button', { name: '保存权限' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '重新加载配置' }));
    await waitFor(() => expect(screen.getByLabelText('邮箱总数上限')).toHaveValue(11));
    await userEvent.click(screen.getByRole('button', { name: '保存权限' }));
    await waitFor(() => expect(mocks.updateUser).toHaveBeenLastCalledWith(8, {
      mailboxPolicy: { perUserLimit: 11, domains: [{ domain: 'private.example', perUserLimit: 5 }] }, expectedMailboxPolicyRevision: 9,
    }));
  });

  it('已从系统移除的授权域名必须取消后才能保存', async () => {
    show(user({ mailboxPolicy: { perUserLimit: 1, domains: [{ domain: 'gone.example', perUserLimit: 0 }] } }));
    await screen.findByRole('checkbox', { name: '允许 gone.example' });
    expect(screen.getByRole('button', { name: '保存权限' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: '允许 gone.example' }));
    await userEvent.click(screen.getByRole('button', { name: '保存权限' }));
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith(8, {
      mailboxPolicy: { perUserLimit: 1, domains: [] }, expectedMailboxPolicyRevision: 7,
    }));
  });

  it('系统配置读取失败时不能保存专属配置，但可恢复公共配置', async () => {
    mocks.getSettings.mockRejectedValue(new ApiError('配置加载失败', { code: 'network' }));
    show(user({ mailboxPolicy: { perUserLimit: 1, domains: [] } }));
    await screen.findByText('配置加载失败');
    expect(screen.getByRole('button', { name: '保存权限' })).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: '公共配置' }));
    await userEvent.click(screen.getByRole('button', { name: '保存权限' }));
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith(8, { mailboxPolicy: null, expectedMailboxPolicyRevision: 7 }));
  });
});
