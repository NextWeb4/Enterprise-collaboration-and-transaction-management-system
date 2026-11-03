import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { DepartmentWorkloadService } from '../src/modules/analytics/department-workload-service.js';
import type { AuthContext } from '../src/modules/core/auth-service.js';
import type { Project, Task } from '../src/modules/projects/project-service.js';
import { buildApp } from '../src/server.js';
import type { DocumentEnvelope } from '../src/storage/envelope.js';

describe('department workload analytics', () => {
  it('aggregates only organization-visible project tasks and enforces department-tree scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-department-workload-'));
    const config = loadConfig({
      DATA_DIR: dir,
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '3394',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
    });
    const { app, deps } = await buildApp({ config, logger: false, startReminderScheduler: false });
    try {
      const password = 'DepartmentAnalyticsStrong42!';
      await deps.auth.setupAdmin(
        { name: '部门分析管理员', email: 'department.analytics.admin', password },
        { requestId: null, ip: null, userAgent: null },
      );
      const login = await deps.auth.verifyLogin('department.analytics.admin', password, {
        ip: null,
        userAgent: null,
      });
      const initialActor = await deps.auth.loadContext(login.token);
      const root = await deps.organizationRepos.departments.create({
        parentId: null,
        name: '研发中心',
        code: 'RND',
        managerId: initialActor.user.id,
        description: '',
        sortOrder: 1,
      });
      const child = await deps.organizationRepos.departments.create({
        parentId: root.id,
        name: '平台组',
        code: 'PLATFORM',
        managerId: null,
        description: '',
        sortOrder: 1,
      });
      const other = await deps.organizationRepos.departments.create({
        parentId: null,
        name: '市场部',
        code: 'MARKET',
        managerId: null,
        description: '',
        sortOrder: 2,
      });
      await deps.repos.users.update(initialActor.user.id, initialActor.user.version, (user) => ({
        ...user,
        departmentId: root.id,
      }));
      const memberRole = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'member');
      if (!memberRole) throw new Error('member role seed is missing');
      const createUser = async (name: string, departmentId: string): Promise<string> => {
        const user = await deps.repos.users.create({
          name,
          email: name,
          passwordHash: await deps.auth.createPasswordHash(password),
          status: 'active',
          mustChangePassword: false,
          lastLoginAt: null,
          passwordChangedAt: null,
          failedLoginCount: 0,
          lockedUntil: null,
          roleIds: [memberRole.id],
          departmentId,
        });
        return user.id;
      };
      const rootUserId = await createUser('department.analytics.root', root.id);
      const childUserId = await createUser('department.analytics.child', child.id);
      const otherUserId = await createUser('department.analytics.other', other.id);
      const publicProject = await deps.projectRepos.projects.create({
        name: '组织可见项目',
        key: 'DEPTPUB',
        description: '',
        visibility: 'organization',
        status: 'active',
        ownerId: initialActor.user.id,
        statusReason: null,
        taskSeq: 0,
        startDate: null,
        dueDate: null,
      } satisfies Omit<Project, keyof DocumentEnvelope>);
      const privateProject = await deps.projectRepos.projects.create({
        name: '私有项目',
        key: 'DEPTPRI',
        description: '',
        visibility: 'private',
        status: 'active',
        ownerId: initialActor.user.id,
        statusReason: null,
        taskSeq: 0,
        startDate: null,
        dueDate: null,
      } satisfies Omit<Project, keyof DocumentEnvelope>);
      const createTask = async (
        projectId: string,
        taskNo: number,
        assigneeId: string,
        status: Task['status'],
        dueDate: string | null,
      ): Promise<void> => {
        await deps.projectRepos.tasks.create({
          projectId,
          taskNo,
          taskKey: `T-${projectId.slice(-4)}-${taskNo}`,
          title: `任务 ${taskNo}`,
          description: '',
          status,
          progress: status === 'done' ? 100 : 0,
          priority: 'medium',
          assigneeId,
          createdBy: initialActor.user.id,
          startDate: null,
          dueDate,
          completedAt: status === 'done' ? '2026-01-01T00:00:00.000Z' : null,
        } satisfies Omit<Task, keyof DocumentEnvelope>);
      };
      await createTask(publicProject.id, 1, rootUserId, 'todo', '2026-05-30');
      await createTask(publicProject.id, 2, rootUserId, 'done', null);
      await createTask(publicProject.id, 3, childUserId, 'in_progress', '2026-06-01');
      await createTask(publicProject.id, 4, otherUserId, 'cancelled', null);
      await createTask(privateProject.id, 1, rootUserId, 'todo', '2026-05-01');

      const adminRole = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
      if (!adminRole) throw new Error('org_admin role seed is missing');
      await deps.repos.roles.update(adminRole.id, adminRole.version, (role) => ({
        ...role,
        dataScope: 'department_tree',
      }));
      const actor = await deps.auth.loadContext(login.token);
      const service = new DepartmentWorkloadService(
        deps.projectRepos,
        deps.organizationRepos.departments,
        deps.repos,
        deps.uow,
        deps.auth,
        () => '2026-05-31T16:30:00.000Z',
        async () => 'Asia/Shanghai',
      );
      const report = await service.departmentWorkload(actor);
      expect(report.overdueAsOfLocalDate).toBe('2026-06-01');
      expect(report.departments.map((department) => department.departmentName)).toEqual(['研发中心', '平台组']);
      expect(report.departments).toEqual([
        expect.objectContaining({ activeUserCount: 2, taskCount: 2, completedTaskCount: 1, cancelledTaskCount: 0, openTaskCount: 1, overdueTaskCount: 1 }),
        expect.objectContaining({ activeUserCount: 1, taskCount: 1, completedTaskCount: 0, cancelledTaskCount: 0, openTaskCount: 1, overdueTaskCount: 0 }),
      ]);
      await expect(service.departmentWorkload(actor, { departmentId: other.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/analytics/department-workload',
        headers: { cookie: `${config.sessionCookieName}=${login.token}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ data: { departments: Array<{ departmentId: string }> } }>().data.departments.map((department) => department.departmentId)).toEqual([root.id, child.id]);

      const latestRole = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
      if (!latestRole) throw new Error('org_admin role seed is missing');
      await deps.repos.roles.update(latestRole.id, latestRole.version, (role) => ({ ...role, dataScope: 'self' }));
      const selfActor: AuthContext = await deps.auth.loadContext(login.token);
      await expect(service.departmentWorkload(selfActor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
