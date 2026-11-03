import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@collab/shared/schemas.js';
import { ProjectMembers } from './ProjectMembers';
import { addProjectMember, getProject, listAllAccounts, listProjectMembers, removeProjectMember, transferProjectOwner } from './api';
import type { Project, ProjectMember } from './api';

vi.mock('./api', () => ({ addProjectMember: vi.fn(), getProject: vi.fn(), listAllAccounts: vi.fn(), listProjectMembers: vi.fn(), removeProjectMember: vi.fn(), transferProjectOwner: vi.fn() }));
const identity: MeResponse = { user: { id: 'owner', name: '负责人', email: 'owner', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null }, organization: { name: '测试组织', timezone: 'Asia/Shanghai' }, roles: ['org_admin'], permissions: ['project:member:manage', 'project:owner:transfer', 'user:manage'], csrfToken: 'csrf' };
const project: Project = { id: 'project-1', name: '测试项目', key: 'TEST', description: '', visibility: 'private', status: 'active', ownerId: 'owner', taskSeq: 0, startDate: null, dueDate: null, version: 2 };
const owner: ProjectMember = { userId: 'owner', name: '负责人', role: 'owner', version: 1 };
const member: ProjectMember = { userId: 'member', name: '现有成员', role: 'member', version: 3 };
const originalMatchMedia = window.matchMedia;
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({ matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) }); });
afterAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia }); });
beforeEach(() => { vi.mocked(listProjectMembers).mockResolvedValue([owner, member]); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('项目成员', () => {
  it('显示成员角色并在归档时隐藏写操作', async () => {
    render(<ProjectMembers project={{ ...project, status: 'archived' }} identity={identity} onProjectChanged={vi.fn()} />);
    expect(await screen.findByText('现有成员')).toBeTruthy();
    expect(screen.getByText('成员')).toBeTruthy();
    expect(listProjectMembers).toHaveBeenCalledWith(project.id);
    expect(screen.queryByRole('button', { name: '添加成员' })).toBeNull();
    expect(screen.queryByRole('button', { name: '移除' })).toBeNull();
    expect(screen.queryByRole('button', { name: '转让负责人' })).toBeNull();
  });

  it('添加有效内部账号并刷新成员列表', async () => {
    vi.mocked(listAllAccounts).mockResolvedValue([{ id: 'new', name: '新成员', email: 'new-account', status: 'active', version: 1 }, { id: 'disabled', name: '停用账号', email: 'disabled', status: 'disabled', version: 1 }, { id: 'member', name: '现有成员', email: 'member', status: 'active', version: 1 }]);
    vi.mocked(addProjectMember).mockResolvedValue({ userId: 'new', name: '新成员', role: 'member', version: 1 });
    vi.mocked(listProjectMembers).mockResolvedValueOnce([owner, member]).mockResolvedValueOnce([owner, member, { userId: 'new', name: '新成员', role: 'member', version: 1 }]);
    const user = userEvent.setup();
    render(<ProjectMembers project={project} identity={identity} onProjectChanged={vi.fn()} />);
    await screen.findByText('现有成员');
    await user.click(screen.getByRole('button', { name: '添加成员' }));
    const modal = await screen.findByRole('dialog');
    await user.click(within(modal).getByLabelText('内部账号'));
    await user.click(await screen.findByTitle('新成员 (new-account)'));
    await user.click(within(modal).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(addProjectMember).toHaveBeenCalledWith(project.id, { userId: 'new', role: 'member' }));
    expect(await screen.findByText('新成员')).toBeTruthy();
    expect(listProjectMembers).toHaveBeenCalledTimes(2);
  });

  it('确认转让后更新项目及成员', async () => {
    const changed = { ...project, ownerId: member.userId, version: 3 };
    vi.mocked(transferProjectOwner).mockResolvedValue(changed);
    vi.mocked(listProjectMembers).mockResolvedValueOnce([owner, member]).mockResolvedValueOnce([{ ...owner, role: 'manager' }, { ...member, role: 'owner' }]);
    const onProjectChanged = vi.fn();
    const user = userEvent.setup();
    render(<ProjectMembers project={project} identity={identity} onProjectChanged={onProjectChanged} />);
    await screen.findByText('现有成员');
    await user.click(screen.getByRole('button', { name: '转让负责人' }));
    await user.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(transferProjectOwner).toHaveBeenCalledWith(project.id, member, project.version));
    expect(onProjectChanged).toHaveBeenCalledWith(changed);
    await waitFor(() => expect(listProjectMembers).toHaveBeenCalledTimes(2));
  });

  it('确认移除后刷新成员和项目', async () => {
    vi.mocked(removeProjectMember).mockResolvedValue({ success: true });
    vi.mocked(listProjectMembers).mockResolvedValueOnce([owner, member]).mockResolvedValueOnce([owner]);
    vi.mocked(getProject).mockResolvedValue({ ...project, version: 3 });
    const onProjectChanged = vi.fn();
    const user = userEvent.setup();
    render(<ProjectMembers project={project} identity={identity} onProjectChanged={onProjectChanged} />);
    await screen.findByText('现有成员');
    await user.click(screen.getByRole('button', { name: '移除' }));
    await user.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(removeProjectMember).toHaveBeenCalledWith(project.id, member));
    await waitFor(() => expect(onProjectChanged).toHaveBeenCalledWith({ ...project, version: 3 }));
    expect(screen.queryByText('现有成员')).toBeNull();
  });

  it('显示列表加载失败', async () => {
    vi.mocked(listProjectMembers).mockRejectedValue(new Error('无法读取成员'));
    render(<ProjectMembers project={project} identity={identity} onProjectChanged={vi.fn()} />);
    expect(await screen.findByText('无法读取成员')).toBeTruthy();
    expect(screen.queryByText('现有成员')).toBeNull();
  });
});
