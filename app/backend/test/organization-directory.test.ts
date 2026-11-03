import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LmdbStorageEngine } from '../src/storage/engine.js';
import { UnitOfWork } from '../src/storage/unit-of-work.js';
import { createCoreRepositories } from '../src/modules/core/repositories.js';
import { AuditService } from '../src/modules/core/audit-service.js';
import type { AuthContext } from '../src/modules/core/auth-service.js';
import { createOrganizationRepositories } from '../src/modules/organization/repositories.js';
import { createOrganizationDirectoryRepositories } from '../src/modules/organization/directory-repositories.js';
import { OrganizationDirectoryService } from '../src/modules/organization/directory-service.js';
import { employeeFieldsSchema, type EmployeeInput, type PositionInput } from '../src/modules/organization/directory-models.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(): Promise<{ service: OrganizationDirectoryService; actor: AuthContext; core: ReturnType<typeof createCoreRepositories>; engine: LmdbStorageEngine }> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-directory-'));
  const engine = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') }); await engine.open();
  cleanups.push(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
  const core = createCoreRepositories(engine); const organization = createOrganizationRepositories(engine); const directory = createOrganizationDirectoryRepositories(engine, undefined, core.registry); const uow = new UnitOfWork(engine); const audit = new AuditService(core, uow);
  const role = await core.roles.create({ code: 'directory_admin', name: '组织目录管理员', description: '', dataScope: 'all', permissionCodes: ['organization:directory:read', 'employee:read', 'employee:manage', 'position:read', 'position:manage', 'department:read'], system: false });
  const user = await core.users.create({ name: '管理员', email: 'directory-admin', passwordHash: 'x'.repeat(30), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null });
  const session = await core.sessions.create({ userId: user.id, tokenHash: 'f'.repeat(64), csrfToken: 'a'.repeat(32), idleExpiresAt: '2099-01-01T00:00:00.000Z', absoluteExpiresAt: '2099-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', revokedAt: null });
  const actor: AuthContext = { user, session, roles: [role], permissions: role.permissionCodes };
  return { service: new OrganizationDirectoryService(directory.employees, directory.positions, organization.departments, core, uow, audit), actor, core, engine };
}

const position = (name = '工程师'): PositionInput => ({ name, code: name === '工程师' ? 'ENG' : 'MGR', description: '', sortOrder: 0, status: 'active' });
const employee = (userId: string, departmentId: string | null = null, positionId: string | null = null): EmployeeInput => ({ userId, employeeNo: null, phone: '13812345678', departmentId, positionId, managerId: null, hireDate: '2026-01-01', avatarFileId: null });

describe('organization directory service', () => {
  it('stores employee profiles, validates references, masks contacts and enforces uniqueness', async () => {
    const { service, actor, core } = await fixture();
    const user = await core.users.create({ name: '张三', email: 'zhangsan', passwordHash: 'x'.repeat(30), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [], departmentId: null });
    const positionDoc = await service.createPosition(actor, position());
    const profile = await service.createEmployee(actor, employee(user.id, null, positionDoc.id));
    expect(profile.phone).toBe('138****5678');
    expect((await service.listEmployees(actor)).map((item) => item.userId)).toContain(user.id);
    expect((await service.activeUsers(actor)).map((item) => item.userId)).toEqual(expect.arrayContaining([actor.user.id, user.id]));
    await expect(service.createEmployee(actor, employee(user.id))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(service.createPosition(actor, position())).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(service.createEmployee(actor, { ...employee(user.id), userId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(employeeFieldsSchema.safeParse({ ...employee(user.id), avatarFileId: 'unsupported-file' }).success).toBe(false);
  });

  it('rejects invalid manager relationships and deleting referenced positions', async () => {
    const { service, actor, core } = await fixture();
    const manager = await core.users.create({ name: '主管', email: 'manager', passwordHash: 'x'.repeat(30), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [], departmentId: null });
    const report = await core.users.create({ name: '员工', email: 'report', passwordHash: 'x'.repeat(30), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [], departmentId: null });
    const positionDoc = await service.createPosition(actor, position());
    await service.createEmployee(actor, { ...employee(manager.id, null, positionDoc.id), employeeNo: 'M-1' });
    const reportProfile = await service.createEmployee(actor, { ...employee(report.id, null, positionDoc.id), employeeNo: 'R-1', managerId: manager.id });
    await expect(service.deletePosition(actor, positionDoc.id, positionDoc.version)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(service.updateEmployee(actor, reportProfile.id, reportProfile.version, { ...employee(report.id, null, positionDoc.id), employeeNo: 'R-1', managerId: report.id })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('fails closed for department-scoped readers without a department and applies tree scope', async () => {
    const { service, core } = await fixture();
    const role = await core.roles.create({ code: 'directory_department', name: '部门目录', description: '', dataScope: 'department', permissionCodes: ['employee:read'], system: false });
    const departmentUser = await core.users.create({ name: '部门用户', email: 'dept-user', passwordHash: 'x'.repeat(30), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null });
    const session = await core.sessions.create({ userId: departmentUser.id, tokenHash: 'e'.repeat(64), csrfToken: 'b'.repeat(32), idleExpiresAt: '2099-01-01T00:00:00.000Z', absoluteExpiresAt: '2099-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', revokedAt: null });
    const scoped: AuthContext = { user: departmentUser, session, roles: [role], permissions: role.permissionCodes };
    await expect(service.listEmployees(scoped)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
