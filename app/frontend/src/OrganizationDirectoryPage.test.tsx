import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@collab/shared/schemas.js';
import { OrganizationDirectoryPage } from './OrganizationDirectoryPage';
import { listDirectory } from './organization-directory-api';

vi.mock('./organization-directory-api', () => ({ listDirectory: vi.fn() }));
const identity: MeResponse = { user: { id: 'user-1', name: '管理员', email: 'admin', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null }, organization: { name: '测试组织', timezone: 'Asia/Shanghai' }, roles: [], permissions: ['organization:directory:read'], csrfToken: 'csrf' };
const originalMatchMedia = window.matchMedia;
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({ matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) }); });
afterAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('组织通讯录', () => {
  it('没有权限时不查询目录', () => {
    render(<OrganizationDirectoryPage identity={{ ...identity, permissions: [] }} />);
    expect(screen.getByText('没有查看通讯录的权限')).toBeTruthy();
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it('按姓名、内部账号、部门和岗位搜索当前可见成员', async () => {
    vi.mocked(listDirectory).mockResolvedValue([{ id: 'employee-1', userId: 'user-1', name: '张三', email: 'zhangsan', status: 'active', departmentId: 'department-1', departmentName: '研发部', positionId: 'position-1', positionName: '工程师' }, { id: 'employee-2', userId: 'user-2', name: '李四', email: 'lisi', status: 'active', departmentId: null, departmentName: null, positionId: null, positionName: null }]);
    const user = userEvent.setup(); render(<OrganizationDirectoryPage identity={identity} />);
    expect(await screen.findByText('张三')).toBeTruthy();
    await user.type(screen.getByLabelText('搜索通讯录'), '工程师');
    expect(screen.getByText('张三')).toBeTruthy(); expect(screen.queryByText('李四')).toBeNull();
  });
});
