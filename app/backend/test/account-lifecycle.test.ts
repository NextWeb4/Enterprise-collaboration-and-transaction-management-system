import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-account-lifecycle-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const built = await buildApp({ config: loadConfig({ DATA_DIR: dir, HOST: '127.0.0.1', PORT: '3000', WEB_ORIGIN: 'http://localhost:5173' }), logger: false });
  cleanups.push(() => built.app.close());
  return built;
}
const password = 'LifecycleInitialPassword42!';
async function user(deps: Awaited<ReturnType<typeof buildApp>>['deps'], email: string, roleCode = 'member'): Promise<string> {
  const role = await deps.repos.roles.getByUniqueIndex('idx_roles_code', roleCode);
  if (!role) throw new Error('missing role');
  return (await deps.repos.users.create({ name: email, email, passwordHash: await deps.auth.createPasswordHash(password), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, departmentId: null, roleIds: [role.id] })).id;
}
async function login(app: Awaited<ReturnType<typeof buildApp>>['app'], email: string, secret = password): Promise<{ cookie: string; origin: string; 'x-csrf-token': string }> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost:5173' }, payload: { email, password: secret } });
  expect(response.statusCode, response.body).toBe(200);
  const cookie = (response.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
  return { cookie, origin: 'http://localhost:5173', 'x-csrf-token': cookie.match(/csrf_token=([^;]+)/)?.[1] ?? '' };
}

describe('managed account lifecycle API', () => {
  it('resets with a one-time generated password, revokes every session and requires password change', async () => {
    const { app, deps } = await fixture();
    await user(deps, 'manager', 'org_admin');
    const target = await user(deps, 'target');
    const admin = await login(app, 'manager');
    const sessions = [await login(app, 'target'), await login(app, 'target')];
    const before = await deps.repos.users.require(target);
    const response = await app.inject({ method: 'POST', url: `/api/v1/users/${target}/reset-password`, headers: admin, payload: { version: before.version } });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json().data as { temporaryPassword: string; user: Record<string, unknown> };
    expect(body.temporaryPassword.length).toBeGreaterThanOrEqual(24);
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.user.mustChangePassword).toBe(true);
    for (const headers of sessions) expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers })).statusCode).toBe(401);
    const oldLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: admin.origin }, payload: { email: 'target', password } });
    expect(oldLogin.statusCode).toBe(401);
    const renewed = await login(app, 'target', body.temporaryPassword);
    expect((await app.inject({ method: 'GET', url: '/api/v1/workbench', headers: renewed })).statusCode).toBe(403);
    const list = await app.inject({ method: 'GET', url: '/api/v1/users', headers: admin });
    expect(list.body).not.toContain(body.temporaryPassword);
    const logs = await deps.repos.auditLogs.list({ pageSize: 100 });
    expect(JSON.stringify(logs)).not.toContain(body.temporaryPassword);
    expect(logs.items.some((entry) => entry.action === 'user.password_reset' && entry.resourceId === target)).toBe(true);
    expect(await deps.audit.verifyChain()).toBe(true);
  });

  it('force logout preserves the password and enable never resurrects revoked sessions', async () => {
    const { app, deps } = await fixture();
    await user(deps, 'manager', 'org_admin');
    const target = await user(deps, 'target');
    const admin = await login(app, 'manager');
    const member = await login(app, 'target');
    const original = await deps.repos.users.require(target);
    const logout = await app.inject({ method: 'POST', url: `/api/v1/users/${target}/force-logout`, headers: admin, payload: { version: original.version } });
    expect(logout.statusCode, logout.body).toBe(200);
    expect(logout.json().data.revokedSessions).toBe(1);
    expect((await deps.repos.users.require(target)).passwordHash).toBe(original.passwordHash);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: member })).statusCode).toBe(401);
    const secondSession = await login(app, 'target');
    const current = await deps.repos.users.require(target);
    expect((await app.inject({ method: 'POST', url: `/api/v1/users/${target}/disable`, headers: admin, payload: { version: current.version } })).statusCode).toBe(200);
    const disabled = await deps.repos.users.require(target);
    const enabled = await app.inject({ method: 'POST', url: `/api/v1/users/${target}/enable`, headers: admin, payload: { version: disabled.version } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().data.status).toBe('active');
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: secondSession })).statusCode).toBe(401);
    await login(app, 'target');
    expect(await deps.audit.verifyChain()).toBe(true);
  });

  it('rejects missing CSRF, foreign origins, insufficient permission and stale writes without mutation', async () => {
    const { app, deps } = await fixture();
    const manager = await user(deps, 'manager', 'org_admin');
    const target = await user(deps, 'target');
    const admin = await login(app, 'manager');
    const member = await login(app, 'target');
    const before = await deps.repos.users.require(target);
    for (const operation of ['reset-password', 'force-logout', 'enable']) {
      const url = `/api/v1/users/${target}/${operation}`;
      expect((await app.inject({ method: 'POST', url, headers: { cookie: admin.cookie, origin: admin.origin }, payload: { version: before.version } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: { ...admin, origin: 'http://evil.test' }, payload: { version: before.version } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/api/v1/users/${manager}/${operation}`, headers: member, payload: { version: 1 } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: `/api/v1/users/${target}/reset-password`, headers: admin, payload: { version: before.version + 100 } })).statusCode).toBe(409);
    expect(await deps.repos.users.require(target)).toEqual(before);
    expect((await app.inject({ method: 'POST', url: `/api/v1/users/${manager}/reset-password`, headers: admin, payload: { version: (await deps.repos.users.require(manager)).version } })).statusCode).toBe(409);
  });

  it('serializes competing resets and rolls back password/session changes if audit append fails', async () => {
    const { app, deps } = await fixture();
    await user(deps, 'manager', 'org_admin');
    const target = await user(deps, 'target');
    const admin = await login(app, 'manager');
    const original = await deps.repos.users.require(target);
    const request = { method: 'POST' as const, url: `/api/v1/users/${target}/reset-password`, headers: admin, payload: { version: original.version } };
    const responses = await Promise.all([app.inject(request), app.inject(request)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const before = await deps.repos.users.require(target);
    await deps.engine.transaction((tx) => tx.remove('meta', 'auditLastHash'));
    const failed = await app.inject({ ...request, payload: { version: before.version } });
    expect(failed.statusCode).toBe(503);
    expect(await deps.repos.users.require(target)).toEqual(before);
  });
});
