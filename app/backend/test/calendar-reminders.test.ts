import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { buildApp } from '../src/server.js';
import { FakeClock } from '../src/shared/clock.js';
import { CalendarService } from '../src/modules/calendar/calendar-service.js';
import type { AuthContext } from '../src/modules/core/auth-service.js';

describe('calendar reminder delivery', () => {
  it('delivers due reminders without a calendar request, skips disabled invitees, and keeps the audit chain valid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-calendar-reminder-'));
    const config = loadConfig({
      DATA_DIR: dir,
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '3393',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
    });
    const { app, deps } = await buildApp({ config, logger: false, startReminderScheduler: false });
    try {
      const adminRole = (await deps.repos.roles.list({ page: 1, pageSize: 10 })).items.find(
        (role) => role.code === 'org_admin',
      );
      if (!adminRole) throw new Error('org_admin role seed is missing');
      const createActor = async (name: string): Promise<AuthContext> => {
        const password = 'FixturePasswordStrong42!';
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
          roleIds: [adminRole.id],
          departmentId: null,
        });
        const login = await deps.auth.verifyLogin(user.email, password, { ip: null, userAgent: null });
        return deps.auth.loadContext(login.token);
      };
      const owner = await createActor('reminder.owner');
      const invitee = await createActor('reminder.invitee');
      const clock = new FakeClock(new Date().toISOString());
      const service = new CalendarService(
        deps.calendarRepos,
        deps.repos,
        deps.projectRepos,
        deps.uow,
        deps.auth,
        deps.audit,
        clock,
      );
      const startAt = new Date(clock.now().getTime() + 4 * 60_000).toISOString();
      const endAt = new Date(clock.now().getTime() + 34 * 60_000).toISOString();
      const event = await service.create(
        owner,
        {
          kind: 'meeting',
          title: '后台提醒',
          startAt,
          endAt,
          reminderMinutes: 5,
          participantIds: [invitee.user.id],
        },
        {},
      );
      await deps.repos.users.update(invitee.user.id, invitee.user.version, (user) => ({
        ...user,
        status: 'disabled',
      }));

      expect(await service.deliverDueRemindersForAllActiveUsers()).toBe(1);
      expect(await service.deliverDueRemindersForAllActiveUsers()).toBe(0);
      expect(
        await deps.calendarRepos.reminders.getByUniqueIndex(
          'idx_calendar_reminder_delivery_key',
          `${event.data.id}:${owner.user.id}:${startAt}:5`,
        ),
      ).toBeDefined();
      expect(
        await deps.calendarRepos.reminders.getByUniqueIndex(
          'idx_calendar_reminder_delivery_key',
          `${event.data.id}:${invitee.user.id}:${startAt}:5`,
        ),
      ).toBeUndefined();
      const notifications = await deps.calendarRepos.notifications.list({ page: 1, pageSize: 100 });
      expect(
        notifications.items.filter((item) => item.notificationType === 'calendar_reminder'),
      ).toHaveLength(1);
      expect(await deps.audit.verifyChain()).toBe(true);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
