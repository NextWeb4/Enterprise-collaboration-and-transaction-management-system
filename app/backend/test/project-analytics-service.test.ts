import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { ProjectAnalyticsService } from '../src/modules/analytics/project-analytics-service.js';
import { buildApp } from '../src/server.js';
import type { Project, ProjectMember, Task } from '../src/modules/projects/project-service.js';
import type { DocumentEnvelope } from '../src/storage/envelope.js';

const password = 'AnalyticsStrongPassword42!';

describe('project analytics with isolated LMDB', () => {
  it('rechecks permissions, preserves project privacy, scopes data, and uses the documented denominator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-project-analytics-'));
    const config = loadConfig({
      NODE_ENV: 'development',
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      PORT: '3318',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
    });
    const { app, deps } = await buildApp({ config, logger: false });
    try {
      await deps.auth.setupAdmin(
        { name: '分析管理员', email: 'analytics.admin', password },
        { requestId: null, ip: null, userAgent: null },
      );
      const loggedIn = await deps.auth.verifyLogin('analytics.admin', password, {
        ip: null,
        userAgent: null,
      });
      const initialActor = await deps.auth.loadContext(loggedIn.token);
      const service = new ProjectAnalyticsService(
        deps.projectRepos,
        deps.uow,
        deps.auth,
        () => '2026-05-31T16:30:00.000Z',
        async (tx) => (await deps.repos.organizations.list({ page: 1, pageSize: 1 }, tx)).items[0]?.timezone ?? 'UTC',
      );
      expect((await service.projectCompletion(initialActor)).projects).toEqual([]);
      const actor = initialActor;

      const createProject = async (input: {
        readonly key: string;
        readonly visibility: Project['visibility'];
        readonly ownerId: string;
        readonly createdAt: string;
        readonly memberRole?: 'owner' | 'manager' | 'member' | 'viewer';
      }): Promise<Project> => {
        const project = await deps.projectRepos.projects.create(
          {
            name: `项目-${input.key}`,
            key: input.key,
            description: '',
            visibility: input.visibility,
            status: 'active',
            ownerId: input.ownerId,
            statusReason: null,
            taskSeq: 0,
            startDate: null,
            dueDate: null,
          } satisfies Omit<Project, keyof DocumentEnvelope>,
          undefined,
          { createdAt: input.createdAt },
        );
        if (input.memberRole) {
          await deps.projectRepos.members.create(
            {
              projectId: project.id,
              userId: input.ownerId,
              role: input.memberRole,
              membershipKey: `${project.id}:${input.ownerId}`,
            } satisfies Omit<ProjectMember, keyof DocumentEnvelope>,
            undefined,
            { createdAt: input.createdAt },
          );
        }
        return project;
      };
      const createTask = async (
        project: Project,
        taskNo: number,
        status: Task['status'],
        dueDate: string | null = null,
      ): Promise<Task> =>
        deps.projectRepos.tasks.create(
          {
            projectId: project.id,
            taskNo,
            taskKey: `${project.key}-${taskNo}`,
            title: `任务${taskNo}`,
            description: '',
            status,
            progress: status === 'done' ? 100 : 0,
            priority: 'medium',
            assigneeId: null,
            createdBy: actor.user.id,
            startDate: null,
            dueDate,
            completedAt: status === 'done' ? '2026-05-01T00:00:00.000Z' : null,
          } satisfies Omit<Task, keyof DocumentEnvelope>,
          undefined,
          { createdAt: '2026-04-01T00:00:00.000Z' },
        );

      const ownedPublic = await createProject({
        key: 'OWN',
        visibility: 'organization',
        ownerId: actor.user.id,
        memberRole: 'owner',
        createdAt: '2026-01-15T00:00:00.000Z',
      });
      const otherPublic = await createProject({
        key: 'PUB',
        visibility: 'organization',
        ownerId: 'another-user',
        createdAt: '2026-02-15T00:00:00.000Z',
      });
      const hiddenPrivate = await createProject({
        key: 'HID',
        visibility: 'private',
        ownerId: 'another-user',
        createdAt: '2026-03-15T00:00:00.000Z',
      });

      await createTask(ownedPublic, 1, 'done');
      await createTask(ownedPublic, 2, 'done');
      await createTask(ownedPublic, 3, 'cancelled');
      await createTask(ownedPublic, 4, 'todo', '2026-05-31');
      await createTask(ownedPublic, 5, 'in_review', '2026-06-01');
      const removed = await createTask(ownedPublic, 6, 'done');
      await createTask(ownedPublic, 7, 'in_progress', '2026-05-30');
      await deps.projectRepos.tasks.softDelete(removed.id, removed.version);
      await createTask(otherPublic, 1, 'done');
      await createTask(hiddenPrivate, 1, 'done');

      const allReport = await service.projectCompletion(actor);
      expect(allReport.temporalSemantics).toBe('current_snapshot_filtered_by_project_creation_time');
      expect(allReport.timezone).toBe('Asia/Shanghai');
      expect(allReport.overdueAsOfLocalDate).toBe('2026-06-01');
      expect(allReport.projects.map((project) => project.projectKey)).toEqual(['OWN', 'PUB']);
      expect(allReport.projects.find((project) => project.projectKey === 'HID')).toBeUndefined();
      expect(allReport.projects[0]).toMatchObject({
        taskCount: 6,
        completedTaskCount: 2,
        cancelledTaskCount: 1,
        effectiveTaskCount: 5,
        openTaskCount: 3,
        completionRate: 40,
        overdueTaskCount: 2,
        overdueRate: 66.67,
      });
      expect(allReport.overdueTasks).toMatchObject([
        { taskKey: 'OWN-7', dueDate: '2026-05-30', projectKey: 'OWN' },
        { taskKey: 'OWN-4', dueDate: '2026-05-31', projectKey: 'OWN' },
      ]);
      expect(allReport.overdueMeta).toEqual({ page: 1, pageSize: 20, total: 2 });
      const overduePage = await service.projectCompletion(actor, { overduePage: 2, overduePageSize: 1 });
      expect(overduePage.overdueTasks.map((task) => task.taskKey)).toEqual(['OWN-4']);
      expect(overduePage.overdueMeta).toEqual({ page: 2, pageSize: 1, total: 2 });
      expect(allReport.totals).toMatchObject({
        projectCount: 2,
        taskCount: 7,
        completedTaskCount: 3,
        cancelledTaskCount: 1,
        effectiveTaskCount: 6,
        openTaskCount: 3,
        completionRate: 50,
        overdueTaskCount: 2,
        overdueRate: 66.67,
      });

      const apiLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: config.webOrigin }, payload: { email: 'analytics.admin', password } });
      expect(apiLogin.statusCode, apiLogin.body).toBe(200);
      const setCookie = apiLogin.headers['set-cookie'];
      const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter((value): value is string => typeof value === 'string').map((value) => value.split(';')[0]).join('; ');
      const apiReport = await app.inject({ method: 'GET', url: '/api/v1/analytics/project-completion', headers: { cookie: cookies } });
      expect(apiReport.statusCode, apiReport.body).toBe(200);
      expect((apiReport.json() as { data: { totals: { projectCount: number } } }).data.totals.projectCount).toBe(2);

      const createdAtFiltered = await service.projectCompletion(actor, {
        createdFrom: '2026-01-01T00:00:00.000Z',
        createdTo: '2026-02-01T00:00:00.000Z',
      });
      expect(createdAtFiltered.projects.map((project) => project.projectKey)).toEqual(['OWN']);
      await expect(
        service.projectCompletion(actor, {
          createdFrom: '2026-03-01T00:00:00.000Z',
          createdTo: '2026-02-01T00:00:00.000Z',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      const latestRole = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
      if (!latestRole) throw new Error('org_admin role missing');
      await deps.repos.roles.update(latestRole.id, latestRole.version, (role) => ({ ...role, dataScope: 'self' }));
      const selfActor = await deps.auth.loadContext(loggedIn.token);
      const selfReport = await service.projectCompletion(selfActor);
      expect(selfReport.projects.map((project) => project.projectKey)).toEqual(['OWN']);

      const selfRole = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
      if (!selfRole) throw new Error('org_admin role missing');
      await deps.repos.roles.update(selfRole.id, selfRole.version, (role) => ({ ...role, dataScope: 'department' }));
      const departmentActor = await deps.auth.loadContext(loggedIn.token);
      await expect(service.projectCompletion(departmentActor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
