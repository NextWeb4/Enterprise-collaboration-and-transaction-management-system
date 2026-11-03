import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { App } from './App';
import { GlobalErrorBoundary } from './GlobalErrorBoundary';
import { changePassword, health, login, logout, me, readBootstrapStorage, setupStatus, workbench, writeBootstrapStorage } from './api';
import type { MeResponse, WorkbenchResponse } from '@collab/shared/schemas.js';
import { listEmployees } from './organization-directory-api';

vi.mock('./workbench-api', () => ({ getActivity: vi.fn().mockResolvedValue({ generatedAt: '2026-11-02T00:00:00Z', timezone: 'Asia/Shanghai', metrics: { openTasks: 0, overdueTasks: 0, dueThisWeek: 0, completedThisWeek: 0, pendingApprovals: 0, unreadNotifications: 0 }, tasks: [], approvals: [], projects: [] }) }));

vi.mock('./organization-directory-api', () => ({ listEmployees: vi.fn() }));

vi.mock('./api', () => ({
  changePassword: vi.fn(),
  createUser: vi.fn(),
  disableAccount: vi.fn(),
  listAccounts: vi.fn(),
  setupAdmin: vi.fn(),
  setupStatus: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn(),
  workbench: vi.fn(),
  health: vi.fn(),
  readBootstrapStorage: vi.fn(),
  writeBootstrapStorage: vi.fn(),
}));

const identity: MeResponse = {
  user: {
    id: 'user-1',
    name: '测试管理员',
    email: 'internal.admin',
    status: 'active',
    mustChangePassword: false,
    lastLoginAt: null,
    passwordChangedAt: null,
  },
  organization: { name: '测试组织', timezone: 'Asia/Shanghai' },
  roles: ['org_admin'],
  permissions: [],
  csrfToken: 'csrf-token',
};

const workbenchData: WorkbenchResponse = {
  user: identity.user,
  organization: identity.organization,
  security: { activeSessions: 1, lastLoginAt: null, passwordChangedAt: null },
  modules: [],
};

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.clearAllMocks();
});

const originalMatchMedia = window.matchMedia;
beforeEach(() => { vi.mocked(setupStatus).mockResolvedValue({ required: false }); });
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (media: string): MediaQueryList => ({
      matches: false,
      media,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});
afterAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
});

describe('M0 application shell', () => {
  it('shows backend health and writes then reads a bootstrap record', async () => {
    vi.mocked(health).mockResolvedValue({ ok: true, status: 'ok', storage: { ok: true, schemaVersion: 1, writable: true } });
    vi.mocked(readBootstrapStorage).mockResolvedValue({ record: null });
    vi.mocked(writeBootstrapStorage).mockResolvedValue({
      record: { id: 'record-1', type: 'bootstrap_record', version: 1, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', message: '浏览器验证', source: 'bootstrap' },
      readBack: { id: 'record-1', type: 'bootstrap_record', version: 1, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', message: '浏览器验证', source: 'bootstrap' },
    });
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText('已连接')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '写入并读取' }));
    expect(await screen.findByText('浏览器验证')).toBeTruthy();
    expect(writeBootstrapStorage).toHaveBeenCalledOnce();
  });

  it('provides a personal settings route with real account and role data', async () => {
    window.history.pushState({}, '', '/app/settings');
    vi.mocked(me).mockResolvedValue(identity);
    vi.mocked(workbench).mockResolvedValue(workbenchData);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '个人设置' })).toBeTruthy();
    expect(screen.getByText('internal.admin')).toBeTruthy();
    expect(screen.getByText('org_admin')).toBeTruthy();
    expect(screen.getByLabelText('当前密码')).toBeTruthy();
  });

  it('provides the current user employee profile route when it is authorized', async () => {
    window.history.pushState({}, '', '/app/profile');
    vi.mocked(me).mockResolvedValue({ ...identity, permissions: ['employee:read'] });
    vi.mocked(listEmployees).mockResolvedValue([
      {
        id: 'employee-1',
        userId: identity.user.id,
        name: identity.user.name,
        email: identity.user.email,
        status: 'active',
        version: 1,
        employeeNo: 'E-001',
        phone: '138****5678',
        departmentId: 'department-1',
        departmentName: '研发部',
        positionId: 'position-1',
        positionName: '工程师',
        managerId: null,
        hireDate: '2026-01-01',
        avatarFileId: null,
      },
    ]);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '我的员工档案' })).toBeTruthy();
    expect(screen.getByText('E-001')).toBeTruthy();
    expect(screen.getByRole('link', { name: '我的档案' })).toBeTruthy();
  });

  it('shows the authentication error returned by the login API', async () => {
    window.history.pushState({}, '', '/login');
    vi.mocked(login).mockRejectedValue(new Error('账号或密码错误'));
    const user = userEvent.setup();

    render(<App />);
    await user.type(await screen.findByLabelText('内部账号'), 'internal.admin');
    await user.type(screen.getByLabelText('密码'), 'WrongPassword123!');
    await user.click(screen.getByRole('button', { name: /登\s*录/u }));

    expect(await screen.findByText('账号或密码错误')).toBeTruthy();
  });

  it('navigates to the real workbench after login succeeds', async () => {
    window.history.pushState({}, '', '/login');
    vi.mocked(login).mockResolvedValue(identity);
    vi.mocked(me).mockResolvedValue(identity);
    vi.mocked(workbench).mockResolvedValue({
      ...workbenchData,
      modules: [{ key: 'workbench', name: '工作台', status: 'available' }],
    });
    const user = userEvent.setup();

    render(<App />);
    await user.type(await screen.findByLabelText('内部账号'), 'internal.admin');
    await user.type(screen.getByLabelText('密码'), 'CorrectHorseBattery12!');
    await user.click(screen.getByRole('button', { name: /登\s*录/u }));

    expect(await screen.findByText(/(早上好|中午好|下午好|晚上好)，测试管理员/u)).toBeTruthy();
    expect(login).toHaveBeenCalledWith({ email: 'internal.admin', password: 'CorrectHorseBattery12!' });
    expect(workbench).toHaveBeenCalledOnce();
  });

  it('redirects an expired session to the login page', async () => {
    window.history.pushState({}, '', '/app');
    vi.mocked(me).mockRejectedValue(new Error('会话已失效'));

    render(<App />);

    expect(await screen.findByRole('heading', { name: '企业协同与事务管理平台' })).toBeTruthy();
    expect(screen.getByLabelText('内部账号')).toBeTruthy();
  });

  it('renders a workbench error state when its API request fails', async () => {
    window.history.pushState({}, '', '/app');
    vi.mocked(me).mockResolvedValue(identity);
    vi.mocked(workbench).mockRejectedValue(new Error('服务暂不可用'));

    render(<App />);

    expect(await screen.findByText('服务暂不可用')).toBeTruthy();
    expect(screen.getByText('工作台加载失败')).toBeTruthy();
  });

  it('returns unknown public routes to the bootstrap page', async () => {
    window.history.pushState({}, '', '/unknown');
    vi.mocked(health).mockResolvedValue({ ok: true, status: 'ok', storage: { ok: true, schemaVersion: 1, writable: true } });
    vi.mocked(readBootstrapStorage).mockResolvedValue({ record: null });

    render(<App />);

    expect(await screen.findByText('项目启动检查')).toBeTruthy();
  });

  it('blocks mismatched password confirmation before calling the password API', async () => {
    window.history.pushState({}, '', '/app');
    vi.mocked(me).mockResolvedValue({ ...identity, user: { ...identity.user, mustChangePassword: true } });
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole('heading', { name: '请先修改密码' });
    await user.type(screen.getByLabelText('当前密码'), 'TemporaryPassword12!');
    await user.type(screen.getByLabelText('新密码', { exact: true }), 'NewPassword123!');
    await user.type(screen.getByLabelText('确认新密码'), 'DifferentPassword123!');
    await user.click(screen.getByRole('button', { name: '修改密码' }));

    expect(await screen.findByText('两次输入的新密码不一致')).toBeTruthy();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('logs out locally even if the revoke request fails', async () => {
    window.history.pushState({}, '', '/app');
    vi.mocked(me).mockResolvedValue(identity);
    vi.mocked(workbench).mockResolvedValue(workbenchData);
    vi.mocked(logout).mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole('heading', { name: /(早上好|中午好|下午好|晚上好)，测试管理员/u });
    await user.click(screen.getByRole('button', { name: '退出登录' }));

    expect(await screen.findByLabelText('内部账号')).toBeTruthy();
    expect(logout).toHaveBeenCalledOnce();
  });

  it('shows a global fallback when a rendered child throws', () => {
    const originalError = console.error;
    console.error = vi.fn();
    function BrokenPage(): ReactNode {
      throw new Error('render failure');
    }

    try {
      render(<GlobalErrorBoundary><BrokenPage /></GlobalErrorBoundary>);
      expect(screen.getByText('页面发生异常')).toBeTruthy();
      expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy();
    } finally {
      console.error = originalError;
    }
  });
});
