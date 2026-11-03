import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@collab/shared/schemas.js';
import { RolesPage } from './RolesPage';
import { getEffectivePermissions, listAllAccounts, listAllRoles, replaceUserRoles } from './api';
import type { Account, EffectivePermissions, Role } from './api';

vi.mock('./api', () => ({
  createRole: vi.fn(), deleteRole: vi.fn(), getEffectivePermissions: vi.fn(), listAllAccounts: vi.fn(),
  listAllRoles: vi.fn(), replaceUserRoles: vi.fn(), updateRole: vi.fn(),
}));

const identity: MeResponse = {
  user: { id: 'admin', name: '管理员', email: 'internal.admin', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null },
  organization: { name: '测试组织', timezone: 'Asia/Shanghai' }, roles: ['org_admin'],
  permissions: ['role:manage', 'user:manage'], csrfToken: 'csrf',
};
const memberRole: Role = { id: 'role-member', code: 'member', name: '普通成员', description: '', dataScope: 'self', permissionCodes: ['project:read', 'task:read'], system: true, version: 1 };
const extraRole: Role = { id: 'role-extra', code: 'extra_reader', name: '补充权限', description: '', dataScope: 'self', permissionCodes: ['document:read'], system: false, version: 2 };
const account: Account = { id: 'target-user', name: '目标成员', email: 'target.user', status: 'active', version: 7 };
const effective: EffectivePermissions = { user: account, version: 7, roleIds: [memberRole.id], roles: [memberRole.code], permissions: memberRole.permissionCodes };
const originalMatchMedia = window.matchMedia;

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({
    matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) });
});
afterAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('角色与权限管理', () => {
  it('用有效权限端点返回的 version 提交角色替换', async () => {
    vi.mocked(listAllRoles).mockResolvedValue([memberRole, extraRole]);
    vi.mocked(listAllAccounts).mockResolvedValue([account]);
    vi.mocked(getEffectivePermissions).mockResolvedValueOnce(effective).mockResolvedValue({ ...effective, version: 8, roleIds: [memberRole.id, extraRole.id] });
    vi.mocked(replaceUserRoles).mockResolvedValue(account);
    const user = userEvent.setup();
    render(<RolesPage identity={identity} />);

    await screen.findByText('普通成员');
    await user.click(screen.getByRole('combobox', { name: '内部账号' }));
    await user.click(await screen.findByTitle('目标成员 (target.user)'));
    await screen.findByText(/当前有效权限/u);
    const selects = screen.getAllByRole('combobox');
    await user.click(selects[1]!);
    await user.click(await screen.findByTitle('补充权限 (extra_reader)'));
    await user.click(screen.getByRole('button', { name: '保存角色分配' }));

    await waitFor(() => expect(replaceUserRoles).toHaveBeenCalledWith(account.id, [memberRole.id, extraRole.id], effective.version));
    expect(getEffectivePermissions).toHaveBeenCalledWith(account.id);
  });
});
