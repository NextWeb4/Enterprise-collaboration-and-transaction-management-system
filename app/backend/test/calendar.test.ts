import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';
import { ProjectService } from '../src/modules/projects/project-service.js';
import type { AuthContext } from '../src/modules/core/auth-service.js';
import type { AuditInput } from '../src/modules/core/audit-service.js';

describe('calendar integration', () => {
  it('supports personal events, meeting responses, conflict warnings, reminder dedupe and private project ACL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-calendar-'));
    const config = loadConfig({ DATA_DIR: dir, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3392', WEB_ORIGIN: 'http://127.0.0.1:5173' });
    const { app, deps } = await buildApp({ config, logger: false });
    try {
      const roles = (await deps.repos.roles.list({ page: 1, pageSize: 10 })).items;
      const createActor = async (name: string, roleCode: 'org_admin' | 'member'): Promise<{ actor: AuthContext; headers: Record<string, string> }> => {
        const role = roles.find((item) => item.code === roleCode)!;
        const password = 'FixturePasswordStrong42!';
        const user = await deps.repos.users.create({ name, email: name, passwordHash: await deps.auth.createPasswordHash(password), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null });
        const login = await deps.auth.verifyLogin(user.email, password, { ip: null, userAgent: null });
        return { actor: await deps.auth.loadContext(login.token), headers: { cookie: `collab_session=${login.token}; csrf_token=${login.csrfToken}`, origin: config.webOrigin, 'x-csrf-token': login.csrfToken } };
      };
      const owner = await createActor('calendar.owner', 'org_admin');
      const invited = await createActor('calendar.invited', 'member');
      const outsider = await createActor('calendar.outsider', 'member');
      const projectAudit = (actor: AuthContext): AuditInput => ({
        actorUserId: actor.user.id,
        action: 'test.action',
        resourceType: 'test',
        ip: null,
      });
      const projects = new ProjectService(deps.projectRepos, deps.repos, deps.uow, deps.auth, deps.audit);
      const project = await projects.create(owner.actor, { name: '私密日程项目', key: 'CALPRJ', visibility: 'private' }, projectAudit(owner.actor));
      await projects.addMember(owner.actor, project.id, { userId: invited.actor.user.id, role: 'member' }, projectAudit(owner.actor));
      const personalStart = '2026-11-03T11:00:00.000Z';
      const createPersonal = await app.inject({ method: 'POST', url: '/api/v1/calendar/events', headers: owner.headers, payload: { kind: 'personal', title: '个人安排', startAt: personalStart, endAt: '2026-11-03T11:30:00.000Z', reminderMinutes: null } });
      expect(createPersonal.statusCode).toBe(201);
      const personal = createPersonal.json<{ data: { id: string; version: number } }>().data;
      expect((await app.inject({ method: 'GET', url: '/api/v1/calendar/events?from=2026-11-03T00%3A00%3A00.000Z&to=2026-11-04T00%3A00%3A00.000Z', headers: invited.headers })).json<{ data: unknown[] }>().data).toHaveLength(0);
      const crudCreate = await app.inject({ method: 'POST', url: '/api/v1/calendar/events', headers: owner.headers, payload: { kind: 'personal', title: 'CRUD检查', startAt: '2026-11-03T12:00:00.000Z', endAt: '2026-11-03T12:30:00.000Z' } });
      const crudEvent = crudCreate.json<{ data: { id: string; version: number } }>().data;
      const crudUpdate = await app.inject({ method: 'PATCH', url: `/api/v1/calendar/events/${crudEvent.id}`, headers: owner.headers, payload: { version: crudEvent.version, kind: 'personal', title: 'CRUD检查已更新', startAt: '2026-11-03T12:00:00.000Z', endAt: '2026-11-03T12:45:00.000Z' } });
      expect(crudUpdate.statusCode).toBe(200);
      const changed = crudUpdate.json<{ data: { version: number; title: string } }>().data;
      expect(changed.title).toBe('CRUD检查已更新');
      expect((await app.inject({ method: 'GET', url: `/api/v1/calendar/events/${crudEvent.id}`, headers: owner.headers })).statusCode).toBe(200);
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/calendar/events/${crudEvent.id}`, headers: owner.headers, payload: { version: changed.version } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/v1/calendar/events/${crudEvent.id}`, headers: owner.headers })).statusCode).toBe(404);
      const conflict = await app.inject({ method: 'POST', url: '/api/v1/calendar/events', headers: owner.headers, payload: { kind: 'meeting', title: '项目会议', projectId: project.id, participantIds: [invited.actor.user.id], startAt: personalStart, endAt: '2026-11-03T11:20:00.000Z', reminderMinutes: 5 } });
      expect(conflict.statusCode).toBe(201);
      const meetingBody = conflict.json<{ data: { id: string; version: number; participants: Array<{ response: string }> }; conflicts: Array<{ userId: string }> }>();
      expect(meetingBody.conflicts.some((item) => item.userId === owner.actor.user.id)).toBe(true);
      expect(JSON.stringify(meetingBody.conflicts)).not.toContain('个人安排');
      expect(meetingBody.data.participants[0]?.response).toBe('pending');
      const meetingId = meetingBody.data.id;
      const invitedList = await app.inject({ method: 'GET', url: '/api/v1/calendar/events?from=2026-11-03T00%3A00%3A00.000Z&to=2026-11-04T00%3A00%3A00.000Z', headers: invited.headers });
      expect(invitedList.json<{ data: Array<{ id: string }> }>().data.map((event) => event.id)).toContain(meetingId);
      const response = await app.inject({ method: 'POST', url: `/api/v1/calendar/events/${meetingId}/response`, headers: invited.headers, payload: { version: meetingBody.data.version, response: 'accepted' } });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ data: { participants: Array<{ response: string }> } }>().data.participants[0]?.response).toBe('accepted');

      const privateProjectEvent = await app.inject({ method: 'POST', url: '/api/v1/calendar/events', headers: owner.headers, payload: { kind: 'milestone', projectId: project.id, title: '移出成员后应不可见', startAt: '2026-11-03T15:00:00.000Z', endAt: '2026-11-03T16:00:00.000Z' } });
      expect(privateProjectEvent.statusCode).toBe(201);
      const privateId = privateProjectEvent.json<{ data: { id: string } }>().data.id;
      const privateDetail = await app.inject({ method: 'GET', url: `/api/v1/calendar/events/${privateId}`, headers: outsider.headers });
      expect(privateDetail.statusCode).toBe(404);
      const member = await deps.projectRepos.members.getByUniqueIndex('idx_project_members_key', `${project.id}:${invited.actor.user.id}`);
      await projects.removeMember(owner.actor, project.id, invited.actor.user.id, member!.version, projectAudit(owner.actor));
      const removedMemberDetail = await app.inject({ method: 'GET', url: `/api/v1/calendar/events/${meetingId}`, headers: invited.headers });
      expect(removedMemberDetail.statusCode).toBe(404);
      const hiddenNotice = await app.inject({ method: 'GET', url: '/api/v1/notifications?page=1&pageSize=100', headers: invited.headers });
      expect(hiddenNotice.statusCode, hiddenNotice.body).toBe(200);
      expect(hiddenNotice.json<{ data: Array<{ title: string; linkPath: string | null; available: boolean }> }>().data.some((notification) => notification.title === '内容已删除或无权访问' && notification.linkPath === null && !notification.available)).toBe(true);

      const dueStart = new Date(Date.now() + 3 * 60_000);
      const dueEnd = new Date(dueStart.getTime() + 30 * 60_000);
      const dueCreate = await app.inject({ method: 'POST', url: '/api/v1/calendar/events', headers: owner.headers, payload: { kind: 'personal', title: '即将开始', startAt: dueStart.toISOString(), endAt: dueEnd.toISOString(), reminderMinutes: 5 } });
      expect(dueCreate.statusCode, dueCreate.body).toBe(201);
      const dueEvent = dueCreate.json<{ data: { id: string; startAt: string } }>().data;
      const dueRangeStart = new Date(dueStart.getTime() - 3_600_000).toISOString();
      const dueRangeEnd = new Date(dueEnd.getTime() + 3_600_000).toISOString();
      await app.inject({ method: 'GET', url: `/api/v1/calendar/events?from=${encodeURIComponent(dueRangeStart)}&to=${encodeURIComponent(dueRangeEnd)}`, headers: owner.headers });
      await app.inject({ method: 'GET', url: `/api/v1/calendar/events?from=${encodeURIComponent(dueRangeStart)}&to=${encodeURIComponent(dueRangeEnd)}`, headers: owner.headers });
      const delivery = await deps.calendarRepos.reminders.getByUniqueIndex('idx_calendar_reminder_delivery_key', `${dueEvent.id}:${owner.actor.user.id}:${dueEvent.startAt}:5`);
      expect(delivery).toBeDefined();
      const ownerNotifications = await app.inject({ method: 'GET', url: '/api/v1/notifications?page=1&pageSize=100', headers: owner.headers });
      expect(ownerNotifications.statusCode, ownerNotifications.body).toBe(200);
      expect(ownerNotifications.json<{ data: Array<{ linkPath: string | null }> }>().data.filter((item) => item.linkPath?.endsWith(dueEvent.id))).toHaveLength(1);
      expect(await deps.audit.verifyChain()).toBe(true);
      expect(await deps.calendarRepos.events.get(personal.id)).toBeDefined();
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
