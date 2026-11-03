import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@collab/shared/schemas.js';
import { EmployeesPage } from './EmployeesPage';
import { listDepartments } from './api';
import { createEmployee, listActiveUsers, listEmployees, listPositions } from './organization-directory-api';

vi.mock('./api', () => ({ listDepartments: vi.fn() }));
vi.mock('./organization-directory-api', () => ({ createEmployee: vi.fn(), listActiveUsers: vi.fn(), listEmployees: vi.fn(), listPositions: vi.fn(), updateEmployee: vi.fn() }));
const identity: MeResponse = { user: { id: 'admin', name: '管理员', email: 'admin', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null }, organization: { name: '测试组织', timezone: 'Asia/Shanghai' }, roles: [], permissions: ['employee:read', 'employee:manage', 'department:read', 'position:read'], csrfToken: 'csrf' };
const originalMatchMedia = window.matchMedia;
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({ matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) }); });
afterAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia }); });
beforeEach(() => { vi.mocked(listEmployees).mockResolvedValue([]); vi.mocked(listActiveUsers).mockResolvedValue([{ userId: 'user-1', name: '张三' }]); vi.mocked(listDepartments).mockResolvedValue([{ id: 'department-1', version: 1, name: '研发部', code: null, parentId: null, managerId: null, description: '', sortOrder: 0 }]); vi.mocked(listPositions).mockResolvedValue([{ id: 'position-1', version: 1, name: '工程师', code: 'ENG', description: '', sortOrder: 0, status: 'active' }]); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('员工管理', () => {
  it('没有员工读取权限时不查询', () => {
    render(<EmployeesPage identity={{ ...identity, permissions: [] }} />);
    expect(screen.getByText('没有查看员工档案的权限')).toBeTruthy(); expect(listEmployees).not.toHaveBeenCalled();
  });

  it('选择在职账号后创建员工档案', async () => {
    vi.mocked(createEmployee).mockResolvedValue({ id: 'employee-1', userId: 'user-1', name: '张三', email: 'zhangsan', status: 'active', version: 1, employeeNo: 'E-001', phone: '138****5678', departmentId: 'department-1', departmentName: '研发部', positionId: 'position-1', positionName: '工程师', managerId: null, hireDate: '2026-01-01', avatarFileId: null });
    const user = userEvent.setup(); render(<EmployeesPage identity={identity} />); await screen.findByText('暂无员工档案'); await user.click(screen.getByRole('button', { name: '新建员工档案' })); const modal = await screen.findByRole('dialog');
    await user.click(within(modal).getByRole('combobox', { name: '在职账号' })); await user.click(await screen.findByTitle('张三'));
    await user.type(within(modal).getByLabelText('员工编号'), 'E-001'); await user.type(within(modal).getByLabelText('联系电话'), '13812345678'); await user.click(within(modal).getByRole('button', { name: /OK/ }));
    await waitFor(() => expect(createEmployee).toHaveBeenCalledWith({ userId: 'user-1', employeeNo: 'E-001', phone: '13812345678', departmentId: null, positionId: null, managerId: null, hireDate: null, avatarFileId: null }));
  });
});
