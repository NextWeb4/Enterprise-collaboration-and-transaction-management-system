import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';
import { ProjectService } from '../src/modules/projects/project-service.js';
import { seedCoreData } from '../src/modules/core/repositories.js';
import { indexStoreKey } from '../src/storage/index-registry.js';

describe('project and task endpoints', () => {
  it('enforces membership, transactions, task numbering and state transitions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-project-'));
    const config = loadConfig({
      NODE_ENV: 'development',
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      PORT: '3309',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
    });
    const { app, deps } = await buildApp({ config, logger: false });
    const base = { host: '127.0.0.1:3309', origin: config.webOrigin };
    try {
      const setup = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/admin',
        headers: base,
        payload: { name: '管理员', email: 'admin.test', password: 'AdminPasswordStrong42!' },
      });
      expect(setup.statusCode).toBe(201);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: base,
        payload: { email: 'admin.test', password: 'AdminPasswordStrong42!' },
      });
      const admin = {
        ...base,
        cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        'x-csrf-token': login.json().data.csrfToken as string,
      };
      const member = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: admin,
        payload: { name: '普通成员', email: 'member.test', password: 'MemberPasswordStrong42!' },
      });
      expect(member.statusCode).toBe(201);
      const userId = member.json().data.user.id as string;
      const memberLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: base,
        payload: { email: 'member.test', password: 'MemberPasswordStrong42!' },
      });
      const memberHeaders = {
        ...base,
        cookie: memberLogin.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        'x-csrf-token': memberLogin.json().data.csrfToken as string,
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/change-password',
            headers: memberHeaders,
            payload: {
              currentPassword: 'MemberPasswordStrong42!',
              newPassword: 'MemberNewStrongPass42!',
            },
          })
        ).statusCode,
      ).toBe(200);
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: admin,
        payload: { name: '私有项目', key: 'PRJ', visibility: 'private' },
      });
      expect(create.statusCode).toBe(201);
      const project = create.json().data as { id: string; version: number };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/projects',
            headers: admin,
            payload: { name: '重复项目', key: 'PRJ', visibility: 'private' },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/projects/${project.id}`,
            headers: memberHeaders,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({ method: 'GET', url: '/api/v1/projects', headers: memberHeaders })
        ).json().meta.total,
      ).toBe(0);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/projects/${project.id}/tasks`,
            headers: memberHeaders,
          })
        ).statusCode,
      ).toBe(404);
      const ownerMembership = (await deps.projectRepos.members.list({ page: 1, pageSize: 1 }))
        .items[0]!;
      await deps.engine.transaction((tx) => {
        tx.put('idx_project_members_key', `${project.id}:${userId}`, ownerMembership.id);
        tx.put(
          'idx_project_members_user',
          indexStoreKey(userId, ownerMembership.id),
          ownerMembership.id,
        );
        tx.put('idx_projects_visibility', indexStoreKey('organization', project.id), project.id);
      });
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/projects/${project.id}`,
            headers: memberHeaders,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({ method: 'GET', url: '/api/v1/projects', headers: memberHeaders })
        ).json().meta.total,
      ).toBe(0);
      await deps.engine.transaction((tx) => {
        tx.remove('idx_project_members_key', `${project.id}:${userId}`);
        tx.remove('idx_project_members_user', indexStoreKey(userId, ownerMembership.id));
        tx.remove('idx_projects_visibility', indexStoreKey('organization', project.id));
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/projects/${project.id}/members`,
            headers: admin,
            payload: { userId, role: 'member' },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/projects/${project.id}`,
            headers: memberHeaders,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/projects/${project.id}/tasks`,
            headers: admin,
            payload: { title: '未启动任务' },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/projects/${project.id}/transition`,
            headers: admin,
            payload: { targetStatus: 'active', version: project.version },
          })
        ).statusCode,
      ).toBe(200);
      const creations = await Promise.all(
        [1, 2].map((n) =>
          app.inject({
            method: 'POST',
            url: `/api/v1/projects/${project.id}/tasks`,
            headers: admin,
            payload: { title: `任务${n}`, assigneeId: userId },
          }),
        ),
      );
      expect(creations.map((x) => x.statusCode)).toEqual([201, 201]);
      const tasks = creations.map(
        (x) => x.json().data as { id: string; taskNo: number; taskKey: string; version: number },
      );
      expect(tasks.map((x) => x.taskNo).sort()).toEqual([1, 2]);
      expect(tasks.map((x) => x.taskKey).sort()).toEqual(['PRJ-1', 'PRJ-2']);
      const latest = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}`,
        headers: admin,
      });
      const version = latest.json().data.version as number;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/projects/${project.id}/transition`,
            headers: admin,
            payload: { targetStatus: 'on_hold', reason: '暂时暂停', version: project.version },
          })
        ).statusCode,
      ).toBe(409);
      expect(version).toBeGreaterThan(project.version);
      const task = tasks[0]!;
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/tasks/${task.id}`,
            headers: memberHeaders,
            payload: { version: task.version, progress: 100 },
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/tasks/${task.id}`,
            headers: memberHeaders,
            payload: { version: task.version, title: '越权标题' },
          })
        ).statusCode,
      ).toBe(403);
      const done = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tasks/${task.id}`,
        headers: memberHeaders,
        payload: { version: task.version, status: 'done' },
      });
      expect(done.statusCode).toBe(200);
      expect(done.json().data.progress).toBe(100);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/tasks/${task.id}`,
            headers: memberHeaders,
            payload: { version: task.version, status: 'in_progress' },
          })
        ).statusCode,
      ).toBe(409);
      const current = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${project.id}`,
        headers: admin,
      });
      // An incomplete derived index must not permit unsafe completion or member removal.
      await deps.engine.transaction((tx) => {
        for (const entry of tx.range('idx_tasks_project', {}))
          tx.remove('idx_tasks_project', entry.key);
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/projects/${project.id}/transition`,
            headers: admin,
            payload: { targetStatus: 'completed', version: current.json().data.version },
          })
        ).statusCode,
      ).toBe(409);
      const members = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/projects/${project.id}/members`,
          headers: admin,
        })
      ).json().data as { userId: string; role: string; version: number }[];
      const target = members.find((item) => item.userId === userId)!;
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/projects/${project.id}/members/${userId}`,
            headers: admin,
            payload: { version: target.version },
          })
        ).statusCode,
      ).toBe(409);
      const transferred = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.id}/transfer-owner`,
        headers: admin,
        payload: { userId, version: current.json().data.version },
      });
      expect(transferred.statusCode).toBe(200);
      const nextMembers = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/projects/${project.id}/members`,
          headers: admin,
        })
      ).json().data as { userId: string; role: string; version: number }[];
      expect(
        nextMembers.filter((item) => item.role === 'owner').map((item) => item.userId),
      ).toEqual([userId]);
      const owner = nextMembers.find((item) => item.userId === userId)!;
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/projects/${project.id}/members/${userId}`,
            headers: admin,
            payload: { version: owner.version },
          })
        ).statusCode,
      ).toBe(403);
      const targetUser = await deps.repos.users.require(userId);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/users/${userId}/disable`,
            headers: admin,
            payload: { version: targetUser.version },
          })
        ).statusCode,
      ).toBe(409);
      expect((await deps.repos.users.require(userId)).status).toBe('active');
      const owned = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: memberHeaders,
        payload: { name: '成员创建项目', key: 'OWN', visibility: 'private' },
      });
      expect(owned.statusCode).toBe(201);
      const ownedProject = owned.json().data as { id: string; version: number };
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/projects/${ownedProject.id}`,
            headers: admin,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/projects/${ownedProject.id}/transition`,
            headers: memberHeaders,
            payload: { targetStatus: 'active', version: ownedProject.version },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/projects/${ownedProject.id}`,
            headers: memberHeaders,
            payload: { version: ownedProject.version + 1 },
          })
        ).statusCode,
      ).toBe(403);
      const ownerTask = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${ownedProject.id}/tasks`,
        headers: memberHeaders,
        payload: { title: '负责人任务', assigneeId: userId },
      });
      expect(ownerTask.statusCode).toBe(201);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/tasks/${ownerTask.json().data.id}`,
            headers: memberHeaders,
            payload: { version: ownerTask.json().data.version },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/projects/${ownedProject.id}/members`,
            headers: memberHeaders,
            payload: { userId: login.json().data.user.id, role: 'viewer' },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/projects/${ownedProject.id}/tasks`,
            headers: admin,
            payload: { title: '观察者不能创建' },
          })
        ).statusCode,
      ).toBe(403);
      const ownedMembers = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/projects/${ownedProject.id}/members`,
          headers: memberHeaders,
        })
      ).json().data as { userId: string; role: string; version: number }[];
      const adminId = login.json().data.user.id as string;
      const viewer = ownedMembers.find((member) => member.userId === adminId)!;
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/projects/${ownedProject.id}/members/${userId}`,
            headers: memberHeaders,
            payload: { role: 'manager', version: 1 },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/projects/${ownedProject.id}/members/${adminId}`,
            headers: memberHeaders,
            payload: { role: 'member', version: viewer.version + 1 },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/projects/${ownedProject.id}/members/${adminId}`,
            headers: memberHeaders,
            payload: { role: 'member', version: viewer.version },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/projects/${ownedProject.id}`,
            headers: admin,
            payload: { version: ownedProject.version },
          })
        ).statusCode,
      ).toBe(409);
      const ownedCurrent = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${ownedProject.id}`,
        headers: admin,
      });
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/projects/${ownedProject.id}`,
            headers: admin,
            payload: { version: ownedCurrent.json().data.version },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/projects/${ownedProject.id}`,
            headers: admin,
          })
        ).statusCode,
      ).toBe(404);
      const reused = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: memberHeaders,
        payload: { name: '不可重用项目', key: 'OWN', visibility: 'private' },
      });
      expect(reused.statusCode).toBe(409);
      expect(reused.json().code).toBe('PROJECT_KEY_TAKEN');
      expect((await deps.projectRepos.tasks.require(ownerTask.json().data.id)).taskKey).toBe(
        'OWN-1',
      );
      const staleContext = await deps.auth.loadContext(
        memberLogin.cookies.find((cookie) => cookie.name === config.sessionCookieName)!.value,
      );
      await deps.auth.revoke(staleContext.session, {
        actorUserId: userId,
        action: 'test.session_revoked',
        resourceType: 'session',
      });
      const service = new ProjectService(
        deps.projectRepos,
        deps.repos,
        deps.uow,
        deps.auth,
        deps.audit,
      );
      const transferredVersion = transferred.json().data.version as number;
      const edit = await app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${project.id}`,
        headers: admin,
        payload: { version: transferredVersion, name: '更新项目' },
      });
      expect(edit.statusCode).toBe(200);
      expect(edit.json().data.name).toBe('更新项目');
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/projects/${project.id}`,
            headers: admin,
            payload: { version: transferredVersion, key: 'OTHER' },
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/projects/${project.id}`,
            headers: admin,
            payload: { version: transferredVersion, name: '冲突修改' },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({ method: 'GET', url: `/api/v1/tasks/${task.id}`, headers: admin })
        ).json().data.id,
      ).toBe(task.id);
      const remaining = tasks[1]!;
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/tasks/${remaining.id}`,
            headers: admin,
            payload: { version: remaining.version + 1 },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/tasks/${remaining.id}`,
            headers: admin,
            payload: { version: remaining.version },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: `/api/v1/tasks/${remaining.id}`, headers: admin }))
          .statusCode,
      ).toBe(404);
      await expect(
        service.create(
          staleContext,
          { name: '失效会话项目', key: 'STALE', visibility: 'private' },
          { actorUserId: userId, action: '', resourceType: '' },
        ),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(
        await deps.projectRepos.projects.getByUniqueIndex('idx_projects_key', 'STALE'),
      ).toBeUndefined();
      expect(await deps.audit.verifyChain()).toBe(true);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('does not silently change an existing member role when seeding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-role-seed-'));
    const config = loadConfig({
      NODE_ENV: 'development',
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      PORT: '3309',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
    });
    const { app, deps } = await buildApp({ config, logger: false });
    try {
      const role = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'member');
      expect(role).toBeDefined();
      const olderCodes = role!.permissionCodes.filter((code) => code !== 'project:update');
      const oldRole = await deps.repos.roles.update(role!.id, role!.version, (item) => ({
        ...item,
        permissionCodes: olderCodes,
      }));
      await seedCoreData(deps.repos);
      const after = await deps.repos.roles.require(oldRole.id);
      expect(after.version).toBe(oldRole.version);
      expect(after.permissionCodes).toEqual(olderCodes);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
