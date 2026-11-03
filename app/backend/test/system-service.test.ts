import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LmdbStorageEngine } from '../src/storage/engine.js';
import { UnitOfWork } from '../src/storage/unit-of-work.js';
import { createCoreRepositories } from '../src/modules/core/repositories.js';
import { AuditService } from '../src/modules/core/audit-service.js';
import type { AuthContext } from '../src/modules/core/auth-service.js';
import { SystemService } from '../src/modules/system/system-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(): Promise<{ service: SystemService; actor: AuthContext; core: ReturnType<typeof createCoreRepositories>; audit: AuditService }> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-system-'));
  const engine = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') }); await engine.open();
  cleanups.push(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
  const core = createCoreRepositories(engine); const uow = new UnitOfWork(engine); const audit = new AuditService(core, uow);
  await core.organizations.create({ name: '我的组织', timezone: 'Asia/Shanghai' });
  const role = await core.roles.create({ code: 'system_operator', name: '系统管理员', description: '', dataScope: 'all', permissionCodes: ['setting:manage', 'login:read', 'audit:read'], system: false });
  const user = await core.users.create({ name: '管理员', email: 'system-admin', passwordHash: 'x'.repeat(30), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null });
  const session = await core.sessions.create({ userId: user.id, tokenHash: 'f'.repeat(64), csrfToken: 'a'.repeat(32), idleExpiresAt: '2099-01-01T00:00:00.000Z', absoluteExpiresAt: '2099-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', revokedAt: null });
  return { service: new SystemService(core, uow, audit), actor: { user, session, roles: [role], permissions: role.permissionCodes }, core, audit };
}

describe('system service with isolated LMDB', () => {
  it('updates only validated organization settings and appends an audit entry atomically', async () => {
    const { service, actor, core, audit } = await fixture();
    const settings = await service.settings(actor);
    expect(settings).toMatchObject({ displayName: '我的组织', timezone: 'Asia/Shanghai', workflowAllowSelfApproval: false });
    const updated = await service.updateSettings(actor, { version: settings.version, displayName: '协同平台', timezone: 'Asia/Tokyo' });
    expect(updated).toMatchObject({ displayName: '协同平台', timezone: 'Asia/Tokyo', version: settings.version + 1 });
    await expect(service.updateSettings(actor, { version: updated.version, displayName: 'x', timezone: 'Invalid/Timezone' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await core.organizations.get(updated.id))?.timezone).toBe('Asia/Tokyo');
    expect(await audit.verifyChain()).toBe(true);
  });

  it('filters immutable login and audit records with page metadata and redacts unsafe log metadata', async () => {
    const { service, actor, core, audit } = await fixture();
    await core.loginRecords.create({ userId: actor.user.id, email: actor.user.email, success: true, reason: null, ip: '127.0.0.1', userAgent: 'test' });
    await core.loginRecords.create({ userId: null, email: 'bad-user', success: false, reason: 'invalid', ip: '127.0.0.2', userAgent: 'test' });
    await audit.append({ actorUserId: actor.user.id, action: 'user.updated', resourceType: 'user', resourceId: actor.user.id, metadata: { changed: true, passwordHint: 'secret' } });
    const logins = await service.loginRecords(actor, { result: 'failure', page: 1, pageSize: 20 });
    expect(logins.total).toBe(1); expect(logins.items[0]).toMatchObject({ email: 'bad-user', success: false });
    const logs = await service.auditLogs(actor, { action: 'user.updated', page: 1, pageSize: 20 });
    expect(logs.total).toBe(1); expect(logs.items[0]).toMatchObject({ actorName: '管理员', metadata: { changed: true, passwordHint: '[REDACTED]' } });
    await expect(service.loginRecords(actor, { from: '2020-01-01T00:00:00.000Z', to: '2020-04-01T00:00:00.000Z', page: 1, pageSize: 20 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('fails closed if the current role loses the required all-scope system permission', async () => {
    const { service, actor, core } = await fixture();
    const role = actor.roles[0]; if (!role) throw new Error('missing role');
    await core.roles.update(role.id, role.version, (document) => ({ ...document, dataScope: 'self' }));
    await expect(service.auditLogs(actor, { page: 1, pageSize: 20 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
