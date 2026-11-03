import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountsPage } from './AccountsPage';
import { createUser, disableAccount, listAccounts } from './api';
import type { Account } from './api';

vi.mock('./api', () => ({ createUser: vi.fn(), disableAccount: vi.fn(), listAccounts: vi.fn() }));
const first: Account = { id: 'user-1', name: '测试成员', email: 'test.member', status: 'active', version: 4 };
const second: Account = { id: 'user-2', name: '停用成员', email: 'disabled.member', status: 'disabled', version: 2 };
const originalMatchMedia = window.matchMedia;
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({
    matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) });
});
afterAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('内部账号管理', () => {
  it('展示分页账号，并在停用时提交最新 version 后刷新', async () => {
    vi.mocked(listAccounts).mockResolvedValue({ data: [first, second], meta: { page: 1, pageSize: 20, total: 2 } });
    vi.mocked(disableAccount).mockResolvedValue({ id: first.id, name: first.name, email: first.email, status: 'disabled' });
    const user = userEvent.setup();
    render(<AccountsPage />);
    expect(await screen.findByText('test.member')).toBeTruthy();
    expect(screen.getByText('共 2 个账号')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '停用' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '停用' }));
    await screen.findByText(`停用 ${first.email}？`);
    await user.click(screen.getByRole('button', { name: /yes|是|ok/i }));
    await waitFor(() => expect(disableAccount).toHaveBeenCalledWith(first.id, first.version));
    await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(2));
  });

  it('校验确认密码后才创建账号并刷新列表', async () => {
    vi.mocked(listAccounts).mockResolvedValue({ data: [], meta: { page: 1, pageSize: 20, total: 0 } });
    vi.mocked(createUser).mockResolvedValue({ user: { id: 'new-id', name: '新成员', email: 'new.member' } });
    const user = userEvent.setup();
    render(<AccountsPage />);
    await user.type(await screen.findByLabelText('姓名'), '新成员');
    await user.type(screen.getByLabelText('内部账号'), 'new.member');
    await user.type(screen.getByLabelText('初始密码'), 'StrongInitialPassword42!');
    await user.type(screen.getByLabelText('确认初始密码'), 'StrongInitialPassword42!');
    await user.click(screen.getByRole('button', { name: '创建账号' }));
    await waitFor(() => expect(createUser).toHaveBeenCalledWith({ name: '新成员', email: 'new.member', password: 'StrongInitialPassword42!' }));
    expect(await screen.findByText('账号 new.member 已创建')).toBeTruthy();
  });
});
