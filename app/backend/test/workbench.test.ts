import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';
import { ProjectService } from '../src/modules/projects/project-service.js';
import { createApprovalRepositories } from '../src/modules/approvals/repositories.js';
import { WorkbenchService, localDate, weekDates } from '../src/modules/workbench/workbench-service.js';
import { ApplicationService } from '../src/modules/approvals/application-service.js';
import { ApprovalService } from '../src/modules/approvals/approval-service.js';
import { WorkflowTemplateService } from '../src/modules/approvals/template-service.js';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../src/modules/core/auth-service.js';
import type { WorkbenchActivity } from '@collab/shared/schemas.js';

describe('workbench integration', () => {
  it('uses organization timezone and Monday boundaries across years', () => {
    expect(localDate(new Date('2026-11-01T17:00:00Z'), 'Asia/Shanghai')).toBe('2026-11-02');
    expect(weekDates('2026-11-02')).toEqual({ start: '2026-11-02', end: '2026-11-09' });
    expect(weekDates('2027-01-01')).toEqual({ start: '2026-12-28', end: '2027-01-04' });
  });
  it('aggregates assigned work and current approvals, persists visit and notification reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-workbench-'));
    const config = loadConfig({ DATA_DIR: dir, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3391', WEB_ORIGIN: 'http://127.0.0.1:5173' });
    const { app, deps } = await buildApp({ config, logger: false });
    try {
      const role = (await deps.repos.roles.list({ page: 1, pageSize: 10 })).items.find((item) => item.code === 'org_admin')!;
      const makeActor = async (name: string): Promise<{ actor: AuthContext; headers: Record<string, string> }> => {
        const password = 'FixturePasswordStrong42!';
        const user = await deps.repos.users.create({ name, email: name, passwordHash: await deps.auth.createPasswordHash(password), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null });
        const login = await deps.auth.verifyLogin(user.email, password, { ip: null, userAgent: null });
        return { actor: await deps.auth.loadContext(login.token), headers: { cookie: `collab_session=${login.token}; csrf_token=${login.csrfToken}`, origin: config.webOrigin, 'x-csrf-token': login.csrfToken } };
      };
      const owner = await makeActor('bench.owner'); const member = await makeActor('bench.member');
      const projects = new ProjectService(deps.projectRepos, deps.repos, deps.uow, deps.auth, deps.audit);
      const approvals = createApprovalRepositories(deps.engine, deps.repos.registry);
      const workbench = new WorkbenchService(deps.repos, deps.projectRepos, approvals, deps.auth, deps.uow);
      const audit = { actorUserId: owner.actor.user.id, action: '', resourceType: '' };
      const project = await projects.create(owner.actor, { name: '工作台项目', key: 'BENCH', visibility: 'private' }, audit);
      await projects.addMember(owner.actor, project.id, { userId: member.actor.user.id, role: 'member' }, audit);
      await projects.transition(owner.actor, project.id, { version: project.version, targetStatus: 'active' }, audit);
      const task = await projects.createTask(owner.actor, project.id, { title: '当日待办', priority: 'urgent', assigneeId: member.actor.user.id, dueDate: '2020-01-01' }, audit);
      await projects.createTask(owner.actor, project.id, { title: '未来待办', priority: 'low', assigneeId: member.actor.user.id, dueDate: '2090-01-01' }, audit);
      const activity = await app.inject({ method: 'GET', url: '/api/v1/workbench/activity', headers: member.headers });
      expect(activity.statusCode).toBe(200);
      const data = activity.json<{ data: WorkbenchActivity }>().data;
      expect(data.metrics.openTasks).toBe(2); expect(data.metrics.overdueTasks).toBe(1); expect(data.tasks[0]?.id).toBe(task.id);
      expect(data.projects[0]?.id).toBe(project.id);
      expect((await workbench.tasks(member.actor, 1, 20, true)).meta.total).toBe(1);
      await workbench.visit(member.actor, project.id);
      const visit = await deps.projectRepos.members.getByUniqueIndex('idx_project_members_key', `${project.id}:${member.actor.user.id}`);
      expect(visit?.lastViewedAt).toBeTruthy();
      await workbench.visit(member.actor, project.id);
      expect((await deps.projectRepos.members.get(visit!.id))?.version).toBe(visit?.version);
      const notice = await workbench.notifications(member.actor, 1, 20, true);
      expect(notice.meta.total).toBe(3); expect(notice.data.every((item) => item.available)).toBe(true);
      const one = notice.data[0]!;
      expect((await app.inject({ method: 'POST', url: `/api/v1/notifications/${one.id}/read`, headers: member.headers, payload: { version: one.version } })).statusCode).toBe(200);
      expect((await workbench.notifications(member.actor, 1, 20, true)).meta.total).toBe(2);
      await workbench.markRead(member.actor, null);
      expect((await workbench.notifications(member.actor, 1, 20, true)).meta.total).toBe(0);
      const templates = new WorkflowTemplateService(approvals, deps.repos, deps.uow, deps.auth, deps.audit);
      const template = await templates.create(owner.actor, { name: '工作台测试流程', applicationType: 'general', steps: [{ stepNo: 1, name: '主管审批', approverType: 'user', userId: member.actor.user.id }] });
      await templates.publish(owner.actor, template.id, template.version);
      const applications = new ApplicationService(approvals, deps.repos, deps.uow, deps.auth, deps.audit);
      const draft = await applications.create(owner.actor, { title: '工作台测试申请', applicationType: 'general', formData: { subject: '测试事务', content: '这是一项需要主管审批的测试事务' }, startAt: null, endAt: null, projectId: null });
      const workflow = new ApprovalService(approvals, deps.repos, deps.uow, deps.auth, deps.audit);
      await workflow.submit(owner.actor, draft.id, randomUUID());
      expect((await workbench.activity(member.actor)).approvals.map((item) => item.id)).toEqual([draft.id]);
      await workflow.decide(member.actor, draft.id, 'approve', '同意');
      expect((await workbench.activity(member.actor)).metrics.pendingApprovals).toBe(0);
      expect((await workbench.notifications(owner.actor, 1, 20, true)).data.some((item) => item.linkPath?.endsWith(draft.id))).toBe(true);
      expect(await deps.audit.verifyChain()).toBe(true);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
