import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LmdbStorageEngine } from '../src/storage/engine.js';
import { UnitOfWork } from '../src/storage/unit-of-work.js';
import { FakeClock } from '../src/shared/clock.js';
import { createCoreRepositories } from '../src/modules/core/repositories.js';
import { AuditService } from '../src/modules/core/audit-service.js';
import { AuthService } from '../src/modules/core/auth-service.js';

const fixtures: Array<{ engine: LmdbStorageEngine; dir: string }> = [];
const password = 'InitialPasswordForTests12!';
const nextPassword = 'ChangedPasswordForTests12!';

async function setup(): Promise<{
  auth: AuthService;
  audit: AuditService;
  repos: ReturnType<typeof createCoreRepositories>;
  clock: FakeClock;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-office-auth-service-'));
  const engine = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
  fixtures.push({ engine, dir });
  await engine.open();
  const clock = new FakeClock('2026-11-02T00:00:00.000Z');
  const repos = createCoreRepositories(engine, clock);
  const uow = new UnitOfWork(engine);
  const audit = new AuditService(repos, uow, clock);
  const auth = new AuthService(repos, uow, audit, clock);
  await repos.users.create({
    name: '改密测试用户', email: 'password-test@example.test',
    passwordHash: await auth.createPasswordHash(password), status: 'active',
    mustChangePassword: true, lastLoginAt: null, passwordChangedAt: null,
    failedLoginCount: 0, lockedUntil: null, roleIds: [], departmentId: null,
  });
  return { auth, audit, repos, clock };
}

afterEach(async () => {
  for (const { engine, dir } of fixtures.splice(0)) {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

describe('password changes with current transaction authorization', () => {
  it.each(['revoked', 'session_deleted', 'session_reassigned', 'idle_expired', 'absolute_expired', 'user_disabled', 'user_deleted'] as const)(
    'rejects an authenticated context that became %s before the password write',
    async (condition) => {
      const { auth, audit, repos, clock } = await setup();
      const login = await auth.verifyLogin('password-test@example.test', password, { ip: null, userAgent: null });
      const context = await auth.loadContext(login.token);
      const session = context.session;
      if (condition === 'revoked') await auth.revoke(session);
      if (condition === 'session_deleted') await repos.sessions.softDelete(session.id, session.version);
      if (condition === 'session_reassigned') await repos.sessions.update(session.id, session.version, (current) => ({ ...current, userId: 'another-user' }));
      if (condition === 'idle_expired') clock.advanceMinutes(480);
      if (condition === 'absolute_expired') await repos.sessions.update(session.id, session.version, (current) => ({ ...current, absoluteExpiresAt: clock.nowIso() }));
      if (condition === 'user_disabled') await repos.users.update(context.user.id, context.user.version, (current) => ({ ...current, status: 'disabled' }));
      if (condition === 'user_deleted') await repos.users.softDelete(context.user.id, context.user.version);
      const before = await repos.users.require(context.user.id);
      const auditsBefore = await repos.auditLogs.countAll();

      await expect(auth.changePassword(context, password, nextPassword, {
        actorUserId: context.user.id, action: 'auth.password.changed', resourceType: 'user', resourceId: context.user.id,
      })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

      expect(await repos.users.require(context.user.id)).toEqual(before);
      expect(await repos.auditLogs.countAll()).toBe(auditsBefore);
      expect(await audit.verifyChain()).toBe(true);
    },
  );

  it('changes a valid password and revokes other sessions atomically while retaining the current session', async () => {
    const { auth, audit, repos } = await setup();
    const login = await auth.verifyLogin('password-test@example.test', password, { ip: null, userAgent: null });
    const context = await auth.loadContext(login.token);
    const otherLogin = await auth.verifyLogin('password-test@example.test', password, { ip: null, userAgent: null });
    const otherContext = await auth.loadContext(otherLogin.token);

    await auth.changePassword(context, password, nextPassword, {
      actorUserId: context.user.id, action: 'auth.password.changed', resourceType: 'user', resourceId: context.user.id,
    });

    const updated = await repos.users.require(context.user.id);
    expect(updated.mustChangePassword).toBe(false);
    expect(updated.passwordHash).not.toBe(context.user.passwordHash);
    expect(updated.passwordChangedAt).not.toBeNull();
    expect((await repos.sessions.require(context.session.id)).revokedAt).toBeNull();
    expect((await repos.sessions.require(otherContext.session.id)).revokedAt).not.toBeNull();
    await expect(auth.loadContext(otherLogin.token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(auth.loadContext(login.token)).resolves.toMatchObject({ user: { id: updated.id } });
    await expect(auth.verifyLogin(updated.email, password, { ip: null, userAgent: null })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(auth.verifyLogin(updated.email, nextPassword, { ip: null, userAgent: null })).resolves.toMatchObject({ user: { id: updated.id } });
    const logs = await repos.auditLogs.list({ page: 1, pageSize: 100 });
    expect(logs.items.filter((entry) => entry.action === 'auth.password.changed')).toHaveLength(1);
    expect(await audit.verifyChain()).toBe(true);
  });
});
