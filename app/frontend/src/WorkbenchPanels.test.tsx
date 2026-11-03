import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { MyTasksPage, NotificationsPage, WorkbenchPanels } from './WorkbenchPanels';
import * as api from './workbench-api';
import { updateTask } from './api';

vi.mock('./api', () => ({ updateTask: vi.fn() }));
vi.mock('./workbench-api', () => ({ getActivity: vi.fn(), getMyTasks: vi.fn(), getNotifications: vi.fn(), markAllNotificationsRead: vi.fn(), markNotificationRead: vi.fn() }));
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({ matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('workbench panels', () => {
  it('renders live counters and direct project and approval links', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ generatedAt: '2026-11-02T00:00:00Z', timezone: 'Asia/Shanghai', metrics: { openTasks: 0, overdueTasks: 0, dueThisWeek: 0, completedThisWeek: 2, pendingApprovals: 1, unreadNotifications: 3 }, tasks: [], approvals: [{ id: 'a1', title: '采购资料用印', applicationType: 'seal', applicantName: '同事', submittedAt: '2026-11-02T00:00:00Z', step: '主管' }], projects: [{ id: 'p1', name: '协作项目', key: 'TEAM', role: 'owner', status: 'active', openTasks: 0 }] });
    render(<MemoryRouter><WorkbenchPanels /></MemoryRouter>);
    expect((await screen.findByRole('link', { name: '采购资料用印' })).getAttribute('href')).toBe('/app/applications/a1');
    expect(screen.getByRole('link', { name: 'TEAM · 协作项目' }).getAttribute('href')).toBe('/app/projects?project=p1');
    expect(screen.getByText('暂无待办任务')).toBeTruthy();
  });
  it('marks a notification read before following its target', async () => {
    vi.mocked(api.getNotifications).mockResolvedValue({ data: [{ id: 'n1', version: 3, title: '新的任务', content: '', readAt: null, createdAt: '2026-11-02T00:00:00Z', linkPath: '/app/projects?project=p1', available: true }], meta: { page: 1, pageSize: 20, total: 1 } });
    vi.mocked(api.markNotificationRead).mockResolvedValue({ success: true });
    const user = userEvent.setup(); render(<MemoryRouter><NotificationsPage /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '新的任务' }));
    await waitFor(() => expect(api.markNotificationRead).toHaveBeenCalledWith('n1', 3));
  });
  it('completes a task with its version and refreshes its pending list', async () => {
    vi.mocked(api.getMyTasks).mockResolvedValueOnce({ data: [{ id: 't1', version: 4, title: '完成工作', taskKey: 'T-1', projectId: 'p1', projectName: '协作项目', status: 'in_progress', priority: 'high', dueDate: null, overdue: false, canComplete: true }], meta: { page: 1, pageSize: 20, total: 1 } }).mockResolvedValue({ data: [], meta: { page: 1, pageSize: 20, total: 0 } });
    const user = userEvent.setup(); render(<MemoryRouter><MyTasksPage /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '完成任务' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith('t1', { version: 4, status: 'done', progress: 100 }));
    expect(await screen.findByText('暂无待办任务')).toBeTruthy();
  });
});
