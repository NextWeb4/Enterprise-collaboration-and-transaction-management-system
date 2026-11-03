import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@collab/shared/schemas.js';
import { DepartmentsPage } from './DepartmentsPage';
import { createDepartment, listAllAccounts, listDepartments, updateDepartment } from './api';
import type { Department } from './api';

vi.mock('./api', () => ({ createDepartment: vi.fn(), listAllAccounts: vi.fn(), listDepartments: vi.fn(), updateDepartment: vi.fn() }));
const identity: MeResponse = { user: { id: 'admin', name: '管理员', email: 'admin', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null }, organization: { name: '测试组织', timezone: 'Asia/Shanghai' }, roles: ['org_admin'], permissions: [], csrfToken: 'csrf' };
const department: Department = { id: 'department-1', version: 4, name: '研发部', code: 'DEV', parentId: null, managerId: null, description: '', sortOrder: 0 };
const originalMatchMedia = window.matchMedia;
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({ matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) }); });
afterAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia }); });
beforeEach(() => { vi.mocked(listDepartments).mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('部门管理', () => {
  it('没有读取权限时不请求部门', () => {
    render(<DepartmentsPage identity={identity} />);
    expect(screen.getByText('没有查看部门的权限')).toBeTruthy();
    expect(listDepartments).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '新建部门' })).toBeNull();
  });

  it('显示空态并对只读用户隐藏管理入口', async () => {
    render(<DepartmentsPage identity={{ ...identity, permissions: ['department:read'] }} />);
    expect(await screen.findByText('暂无部门')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新建部门' })).toBeNull();
  });

  it('创建部门并重新加载列表', async () => {
    vi.mocked(listDepartments).mockResolvedValueOnce([]).mockResolvedValueOnce([department]);
    vi.mocked(createDepartment).mockResolvedValue(department);
    vi.mocked(listAllAccounts).mockResolvedValue([]);
    const user = userEvent.setup();
    render(<DepartmentsPage identity={{ ...identity, permissions: ['department:read', 'department:manage', 'user:manage'] }} />);
    await screen.findByText('暂无部门');
    await user.click(screen.getByRole('button', { name: '新建部门' }));
    const modal = await screen.findByRole('dialog');
    await user.type(within(modal).getByLabelText('部门名称'), '研发部');
    await user.type(within(modal).getByLabelText('部门编码'), 'DEV');
    await user.click(await within(modal).findByRole('button', { name: /OK/ }));
    await waitFor(() => expect(createDepartment).toHaveBeenCalledWith({ name: '研发部', code: 'DEV', parentId: null, managerId: null, description: '', sortOrder: 0 }));
    expect(await screen.findByText('研发部')).toBeTruthy();
    expect(listDepartments).toHaveBeenCalledTimes(2);
    expect(listAllAccounts).toHaveBeenCalledOnce();
  });

  it('编辑部门时保留版本并刷新列表', async () => {
    const updated = { ...department, name: '产品研发部', version: 5 };
    vi.mocked(listDepartments).mockResolvedValueOnce([department]).mockResolvedValueOnce([updated]);
    vi.mocked(updateDepartment).mockResolvedValue(updated);
    const user = userEvent.setup();
    render(<DepartmentsPage identity={{ ...identity, permissions: ['department:read', 'department:manage'] }} />);
    expect(await screen.findByText('研发部')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '编辑' }));
    const modal = await screen.findByRole('dialog');
    const name = within(modal).getByLabelText('部门名称');
    await user.clear(name);
    await user.type(name, '产品研发部');
    await user.click(await within(modal).findByRole('button', { name: /OK/ }));
    await waitFor(() => expect(updateDepartment).toHaveBeenCalledWith(department.id, { name: '产品研发部', code: 'DEV', parentId: null, managerId: null, description: '', sortOrder: 0, version: 4 }));
    expect(await screen.findByText('产品研发部')).toBeTruthy();
    expect(listAllAccounts).not.toHaveBeenCalled();
  });
});
