import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@collab/shared/schemas.js';
import { ProjectsPage } from './ProjectsPage';
import { createProject, createTask, deleteTask, getProject, listProjectMembers, listProjects, listTasks, updateProject, updateTask } from './api';
import type { Project, Task } from './api';

vi.mock('./api', () => ({
  createProject: vi.fn(), createTask: vi.fn(), getProject: vi.fn(), listProjectMembers: vi.fn(), listProjects: vi.fn(), listTasks: vi.fn(),
  transitionProject: vi.fn(), updateProject: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(),
}));

const identity: MeResponse = {
  user: { id: 'user-1', name: '测试用户', email: 'internal.user', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null },
  organization: { name: '测试组织', timezone: 'Asia/Shanghai' }, roles: ['member'], permissions: [], csrfToken: 'csrf',
};
const project: Project = { id: 'project-1', name: '测试项目', key: 'TEST', description: '', visibility: 'private', status: 'active', ownerId: 'user-1', taskSeq: 1, startDate: null, dueDate: null, version: 2 };
const task: Task = { id: 'task-1', projectId: project.id, taskNo: 1, taskKey: 'TEST-1', title: '测试任务', description: '', status: 'in_progress', progress: 50, priority: 'medium', assigneeId: 'user-1', startDate: null, dueDate: null, createdBy: 'user-1', version: 3 };
const originalMatchMedia = window.matchMedia;

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({
    matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) });
});
afterAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia }); });
beforeEach(() => { vi.mocked(listProjects).mockResolvedValue([]); vi.mocked(listTasks).mockResolvedValue([]); vi.mocked(listProjectMembers).mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.resetAllMocks(); window.history.replaceState({}, '', '/'); });

describe('项目与任务页面', () => {
  it('无项目读取权限时显示提示且不请求项目', () => {
    render(<ProjectsPage identity={identity} />);
    expect(screen.getByText('没有查看项目的权限')).toBeTruthy();
    expect(listProjects).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '新建项目' })).toBeNull();
  });

  it('展示空项目列表并根据权限隐藏创建入口', async () => {
    render(<ProjectsPage identity={{ ...identity, permissions: ['project:read'] }} />);
    expect(await screen.findByText('暂无可访问项目')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新建项目' })).toBeNull();
  });

  it('创建项目后刷新列表', async () => {
    vi.mocked(createProject).mockResolvedValue(project);
    vi.mocked(listProjects).mockResolvedValueOnce([]).mockResolvedValueOnce([project]);
    const user = userEvent.setup();
    render(<ProjectsPage identity={{ ...identity, permissions: ['project:read', 'project:create'] }} />);
    await screen.findByText('暂无可访问项目');
    await user.click(screen.getByRole('button', { name: '新建项目' }));
    const modal = await screen.findByRole('dialog');
    await user.type(within(modal).getByLabelText('项目名称'), project.name);
    await user.type(within(modal).getByLabelText('项目短键'), project.key);
    await user.click(within(modal).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ name: project.name, key: project.key, visibility: 'private' }));
    expect(await screen.findByRole('button', { name: project.name })).toBeTruthy();
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it('提交任务状态与版本后刷新任务列表', async () => {
    vi.mocked(listProjects).mockResolvedValue([project]);
    vi.mocked(listTasks).mockResolvedValueOnce([task]).mockResolvedValueOnce([{ ...task, status: 'done', progress: 100, version: 4 }]);
    vi.mocked(updateTask).mockResolvedValue({ ...task, status: 'done', progress: 100, version: 4 });
    const user = userEvent.setup();
    render(<ProjectsPage identity={{ ...identity, permissions: ['project:read', 'task:read', 'task:update'] }} />);
    await user.click(await screen.findByRole('button', { name: project.name }));
    await user.click(await screen.findByRole('button', { name: '更新状态' }));
    const modal = await screen.findByRole('dialog');
    await user.click(within(modal).getByLabelText('状态'));
    await user.click(await screen.findByTitle('已完成'));
    const progress = within(modal).getByLabelText('进度（%）');
    await user.clear(progress);
    await user.type(progress, '100');
    await user.click(within(modal).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith(task.id, { version: 3, status: 'done', progress: 100 }));
    expect(await screen.findByText('100%')).toBeTruthy();
    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it('创建任务后重新读取项目版本和任务', async () => {
    vi.mocked(listProjects).mockResolvedValue([project]);
    vi.mocked(listTasks).mockResolvedValueOnce([]).mockResolvedValueOnce([task]);
    vi.mocked(createTask).mockResolvedValue(task);
    vi.mocked(getProject).mockResolvedValue({ ...project, version: 3 });
    const user = userEvent.setup();
    render(<ProjectsPage identity={{ ...identity, permissions: ['project:read', 'task:read', 'task:create'] }} />);
    await user.click(await screen.findByRole('button', { name: project.name }));
    await screen.findByText('暂无任务');
    await user.click(screen.getByRole('button', { name: '新建任务' }));
    const modal = await screen.findByRole('dialog');
    await user.type(within(modal).getByLabelText('任务名称'), task.title);
    await user.click(within(modal).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith(project.id, { title: task.title }));
    expect(await screen.findByText(task.taskKey)).toBeTruthy();
    expect(getProject).toHaveBeenCalledWith(project.id);
    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it('创建任务时提交负责人、优先级和起止日期', async () => {
    const member = { userId: 'user-2', name: '项目成员', role: 'member' as const, version: 1 };
    vi.mocked(listProjects).mockResolvedValue([project]);
    vi.mocked(listTasks).mockResolvedValueOnce([]).mockResolvedValueOnce([task]);
    vi.mocked(listProjectMembers).mockResolvedValue([member]);
    vi.mocked(createTask).mockResolvedValue(task);
    vi.mocked(getProject).mockResolvedValue(project);
    const user = userEvent.setup();
    render(<ProjectsPage identity={{ ...identity, permissions: ['project:read', 'task:read', 'task:create', 'task:assign'] }} />);
    await user.click(await screen.findByRole('button', { name: project.name }));
    await user.click(await screen.findByRole('button', { name: '新建任务' }));
    const modal = await screen.findByRole('dialog');
    await user.type(within(modal).getByLabelText('任务名称'), '带元数据的任务');
    await user.click(within(modal).getByLabelText('优先级'));
    await user.click(await screen.findByTitle('紧急'));
    await user.click(within(modal).getByLabelText('负责人'));
    await user.click(await screen.findByTitle('项目成员（member）'));
    await user.type(within(modal).getByLabelText('开始日期'), '2026-11-03');
    await user.type(within(modal).getByLabelText('截止日期'), '2026-11-05');
    await user.click(within(modal).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith(project.id, {
      title: '带元数据的任务', priority: 'urgent', assigneeId: member.userId, startDate: '2026-11-03', dueDate: '2026-11-05',
    }));
  });

  it('编辑任务元数据时提交版本并刷新列表', async () => {
    const member = { userId: 'user-2', name: '项目成员', role: 'member' as const, version: 1 };
    vi.mocked(listProjects).mockResolvedValue([project]);
    vi.mocked(listTasks).mockResolvedValueOnce([task]).mockResolvedValueOnce([{ ...task, title: '已编辑任务', priority: 'high', assigneeId: member.userId, startDate: '2026-11-03', dueDate: '2026-11-05', version: 4 }]);
    vi.mocked(listProjectMembers).mockResolvedValue([member]);
    vi.mocked(updateTask).mockResolvedValue({ ...task, title: '已编辑任务', priority: 'high', assigneeId: member.userId, startDate: '2026-11-03', dueDate: '2026-11-05', version: 4 });
    const user = userEvent.setup();
    render(<ProjectsPage identity={{ ...identity, permissions: ['project:read', 'task:read', 'task:update', 'task:assign'] }} />);
    await user.click(await screen.findByRole('button', { name: project.name }));
    await user.click(await screen.findByRole('button', { name: '编辑任务' }));
    const modal = await screen.findByRole('dialog');
    const title = within(modal).getByLabelText('任务名称');
    await user.clear(title);
    await user.type(title, '已编辑任务');
    await user.click(within(modal).getByLabelText('优先级'));
    await user.click(await screen.findByTitle('高'));
    await user.click(within(modal).getByLabelText('负责人'));
    await user.click(await screen.findByTitle('项目成员（member）'));
    await user.type(within(modal).getByLabelText('开始日期'), '2026-11-03');
    await user.type(within(modal).getByLabelText('截止日期'), '2026-11-05');
    await user.click(within(modal).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith(task.id, {
      version: task.version, title: '已编辑任务', description: '', priority: 'high', assigneeId: member.userId, startDate: '2026-11-03', dueDate: '2026-11-05',
    }));
    expect(await screen.findByText('已编辑任务')).toBeTruthy();
  });

  it('通过项目与任务查询参数定位任务', async () => {
    window.history.replaceState({}, '', `/app/projects?project=${project.id}&task=${task.id}`);
    vi.mocked(listProjects).mockResolvedValue([project]);
    vi.mocked(getProject).mockResolvedValue(project);
    vi.mocked(listTasks).mockResolvedValue([task]);
    render(<ProjectsPage identity={{ ...identity, permissions: ['project:read', 'task:read'] }} />);
    expect(await screen.findByText('定位任务')).toBeTruthy();
    expect(getProject).toHaveBeenCalledWith(project.id);
  });

  it('编辑项目时提交版本并展示更新后的内容', async () => {
    vi.mocked(listProjects).mockResolvedValue([project]);
    vi.mocked(updateProject).mockResolvedValue({ ...project, name: '更新项目', version: 3 });
    const user = userEvent.setup();
    render(<ProjectsPage identity={{ ...identity, permissions: ['project:read', 'project:update', 'task:read'] }} />);
    await user.click(await screen.findByRole('button', { name: project.name }));
    await user.click(await screen.findByRole('button', { name: '编辑项目' }));
    const modal = await screen.findByRole('dialog');
    const name = within(modal).getByLabelText('项目名称');
    await user.clear(name);
    await user.type(name, '更新项目');
    await user.click(within(modal).getByRole('button', { name: /OK/ }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith(project.id, { name: '更新项目', description: '', visibility: 'private', version: project.version }));
    expect(await screen.findByText('更新项目 (TEST)')).toBeTruthy();
  });

  it('确认删除任务时提交版本并刷新列表', async () => {
    vi.mocked(listProjects).mockResolvedValue([project]);
    vi.mocked(listTasks).mockResolvedValueOnce([task]).mockResolvedValueOnce([]);
    vi.mocked(deleteTask).mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<ProjectsPage identity={{ ...identity, permissions: ['project:read', 'task:read', 'task:delete'] }} />);
    await user.click(await screen.findByRole('button', { name: project.name }));
    await user.click(await screen.findByRole('button', { name: '删除' }));
    await user.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(deleteTask).toHaveBeenCalledWith(task.id, task.version));
    expect(await screen.findByText('暂无任务')).toBeTruthy();
    expect(listTasks).toHaveBeenCalledTimes(2);
  });
});
