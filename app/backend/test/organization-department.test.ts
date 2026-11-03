import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LmdbStorageEngine } from '../src/storage/engine.js';
import { UnitOfWork } from '../src/storage/unit-of-work.js';
import { createCoreRepositories } from '../src/modules/core/repositories.js';
import { AuditService } from '../src/modules/core/audit-service.js';
import type { AuthContext } from '../src/modules/core/auth-service.js';
import { createOrganizationRepositories } from '../src/modules/organization/repositories.js';
import { DepartmentService } from '../src/modules/organization/department-service.js';
import type { DepartmentInput } from '../src/modules/organization/models.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(): Promise<{ service: DepartmentService; actor: AuthContext; core: ReturnType<typeof createCoreRepositories>; audit: AuditService; engine: LmdbStorageEngine; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-departments-'));
  const engine = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
  await engine.open();
  cleanups.push(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
  const core = createCoreRepositories(engine);
  const org = createOrganizationRepositories(engine);
  const uow = new UnitOfWork(engine);
  const audit = new AuditService(core, uow);
  const role = await core.roles.create({ code: 'admin', name: '管理员', description: '', dataScope: 'all', permissionCodes: ['department:read', 'department:manage'], system: false });
  const user = await core.users.create({ name: '管理员', email: 'admin.test', passwordHash: 'x'.repeat(30), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null });
  const session = await core.sessions.create({ userId: user.id, tokenHash: 'f'.repeat(64), csrfToken: 'a'.repeat(32), idleExpiresAt: '2099-01-01T00:00:00.000Z', absoluteExpiresAt: '2099-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', revokedAt: null });
  return { service: new DepartmentService(org.departments, core, uow, audit), actor: { user, session, roles: [role], permissions: role.permissionCodes }, core, audit, engine, dir };
}

function fields(name: string, parentId: string | null = null): DepartmentInput {
  return { name, parentId, code: null, managerId: null, description: '', sortOrder: 0 };
}

describe('department service with isolated LMDB', () => {
  it('creates and updates departments atomically, enforcing unique sibling names, codes and versions', async () => {
    const { service, actor, audit } = await fixture();
    const root = await service.create(actor, { ...fields('研发部'), code: 'DEV' });
    const child = await service.create(actor, fields('平台组', root.id));
    await expect(service.create(actor, fields('平台组', root.id))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(service.create(actor, { ...fields('其他'), code: 'DEV' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(service.update(actor, child.id, 99, fields('平台组', root.id))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const updated = await service.update(actor, child.id, child.version, fields('产品组', root.id));
    expect(updated.version).toBe(2);
    expect((await service.list(actor)).map((item) => item.name).sort()).toEqual(['产品组', '研发部'].sort());
    expect(await audit.verifyChain()).toBe(true);
  });

  it('rejects cycles, invalid managers and a move that makes descendants deeper than ten levels', async () => {
    const { service, actor } = await fixture();
    const root = await service.create(actor, fields('一级'));
    const child = await service.create(actor, fields('二级', root.id));
    await expect(service.update(actor, root.id, root.version, fields('一级', child.id))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.create(actor, { ...fields('错误负责人'), managerId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    let parent = child;
    for (let level = 3; level <= 10; level += 1) parent = await service.create(actor, fields(`第${level}级`, parent.id));
    await expect(service.create(actor, fields('第十一级', parent.id))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const other = await service.create(actor, fields('另一根'));
    await expect(service.update(actor, root.id, root.version, fields('一级', other.id))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rechecks session and permission-bearing scope from current records', async () => {
    const { service, actor, core } = await fixture();
    const role = actor.roles[0];
    if (!role) throw new Error('missing role');
    await core.roles.update(role.id, role.version, (current) => ({ ...current, dataScope: 'department' }));
    await expect(service.create(actor, fields('禁止'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const broad = await core.roles.create({ code: 'broad', name: '范围角色', description: '', dataScope: 'all', permissionCodes: ['user:manage'], system: false });
    await core.users.update(actor.user.id, actor.user.version, (current) => ({ ...current, roleIds: [role.id, broad.id] }));
    await expect(service.list(actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await core.sessions.update(actor.session.id, actor.session.version, (current) => ({ ...current, revokedAt: new Date().toISOString() }));
    await expect(service.list(actor)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rolls back the department and unique indexes when audit append fails', async () => {
    const { service, actor, engine } = await fixture();
    await engine.transaction((tx) => { tx.put('meta', 'auditSeq', -1); });
    await expect(service.create(actor, fields('回滚部门'))).rejects.toMatchObject({ code: 'STORAGE_CORRUPTED' });
    expect(await service.list(actor)).toEqual([]);
    await engine.transaction((tx) => { tx.remove('meta', 'auditSeq'); });
    expect((await service.create(actor, fields('回滚部门'))).name).toBe('回滚部门');
  });

  it('verifies, rebuilds and preserves department indexes across restart', async () => {
    const { service, actor, engine, dir } = await fixture();
    const department = await service.create(actor, { ...fields('持久部门'), code: 'PERSIST' });
    for (const name of ['files', 'tmp', 'trash']) await mkdir(join(dir, name), { recursive: true });
    await engine.transaction((tx) => {
      tx.remove('idx_departments_parent_name', JSON.stringify([null, department.name]));
      tx.put('idx_departments_code', 'STALE', 'missing');
    });
    await engine.close();
    const run = (script: string): ReturnType<typeof spawnSync> => spawnSync(process.execPath, ['--import', 'tsx', script], {
      cwd: process.cwd(), env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', timeout: 30000,
    });
    const failed = run('app/backend/src/cli/storage-verify.ts');
    expect(failed.status).not.toBe(0);
    expect(String(failed.stdout)).toContain('idx_departments_parent_name');
    expect(String(failed.stdout)).toContain('idx_departments_code');
    const rebuilt = run('app/backend/src/cli/rebuild-indexes.ts');
    expect(rebuilt.status, String(rebuilt.stderr)).toBe(0);
    const verified = run('app/backend/src/cli/storage-verify.ts');
    expect(verified.status, String(verified.stderr)).toBe(0);
    expect(String(verified.stdout)).toContain('"departments": 1');
    const reopened = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
    await reopened.open();
    try {
      const repos = createOrganizationRepositories(reopened);
      expect((await repos.departments.getByUniqueIndex('idx_departments_parent_name', JSON.stringify([null, department.name])))?.id).toBe(department.id);
      expect((await repos.departments.getByUniqueIndex('idx_departments_code', 'PERSIST'))?.id).toBe(department.id);
      expect(await repos.departments.getByUniqueIndex('idx_departments_code', 'STALE')).toBeUndefined();
      await expect(repos.departments.create({ ...fields('另一部门'), code: 'PERSIST' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    } finally { await reopened.close(); }
  });
});
