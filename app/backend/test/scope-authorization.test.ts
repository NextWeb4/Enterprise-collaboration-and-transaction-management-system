import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';
import type { RoleDocument, UserDocument } from '../src/modules/core/models.js';
import type { DocumentEnvelope } from '../src/storage/envelope.js';

const paths: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-scope-authorization-'));
  paths.push(dir);
  const config = loadConfig({ ...process.env, DATA_DIR: dir, WEB_ORIGIN: 'http://localhost:5173', HOST: '127.0.0.1', PORT: '3000' });
  const built = await buildApp({ config, logger: false });
  cleanups.push(() => built.app.close());
  return built;
}

describe('scope delegation and audit access', () => {
  it('rejects create, update, and assignment of broader scopes while permitting self and org admin', async () => {
    const { deps } = await fixture();
    const role = await deps.repos.roles.create({ code: 'scope_manager', name: '范围管理', description: '', system: false, dataScope: 'self', permissionCodes: ['employee:read'] } as Omit<RoleDocument, keyof DocumentEnvelope>);
    const manager = await deps.repos.roles.create({ code: 'scope_role_manager', name: '角色管理', description: '', system: false, dataScope: 'all', permissionCodes: ['role:manage'] } as Omit<RoleDocument, keyof DocumentEnvelope>);
    const unrelated = await deps.repos.roles.create({ code: 'unrelated_all', name: '其他权限', description: '', system: false, dataScope: 'all', permissionCodes: ['audit:read'] } as Omit<RoleDocument, keyof DocumentEnvelope>);
    const wide = await deps.repos.roles.create({ code: 'wide_reader', name: '全员档案', description: '', system: false, dataScope: 'all', permissionCodes: ['employee:read'] } as Omit<RoleDocument, keyof DocumentEnvelope>);
    const password = 'ScopeManagerPassword12!';
    const passwordHash = await deps.auth.createPasswordHash(password);
    const user = await deps.repos.users.create({ name: '管理员', email: 'scope-manager', passwordHash, status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id, manager.id, unrelated.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    const target = await deps.repos.users.create({ name: '目标', email: 'scope-target', passwordHash, status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    const login = await deps.auth.verifyLogin(user.email, password, { ip: null, userAgent: null });
    const actor = await deps.auth.loadContext(login.token);
    const input = { code: 'self_reader', name: '本人档案', description: '', dataScope: 'self' as const, permissionCodes: ['employee:read'] };
    await expect(deps.auth.createRole(actor, { ...input, code: 'illegal_reader', dataScope: 'all' }, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'illegal_reader')).toBeUndefined();
    const selfRole = await deps.auth.createRole(actor, input, {});
    await expect(deps.auth.updateRole(actor, selfRole.id, { version: selfRole.version, dataScope: 'all' }, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await deps.repos.roles.require(selfRole.id)).dataScope).toBe('self');
    await expect(deps.auth.replaceUserRoles(actor, target.id, [wide.id], target.version, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await deps.repos.users.require(target.id)).roleIds).toEqual([role.id]);
    const assigned = await deps.auth.replaceUserRoles(actor, target.id, [selfRole.id], target.version, {});
    expect(assigned.roleIds).toEqual([selfRole.id]);
    const adminRole = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
    if (!adminRole) throw new Error('missing org admin');
    const admin = await deps.repos.users.create({ name: '组织管理员', email: 'scope-org-admin', passwordHash, status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [adminRole.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    const adminLogin = await deps.auth.verifyLogin(admin.email, password, { ip: null, userAgent: null });
    const adminActor = await deps.auth.loadContext(adminLogin.token);
    const allowed = await deps.auth.createRole(adminActor, { ...input, code: 'admin_all_reader', dataScope: 'all' }, {});
    expect(allowed.dataScope).toBe('all');
  });

  it('denies audit queries without all scope on audit:read, including unrelated all scope', async () => {
    const { app, deps } = await fixture();
    const self = await deps.repos.roles.create({ code: 'audit_self', name: '本人审计', description: '', system: false, dataScope: 'self', permissionCodes: ['audit:read'] } as Omit<RoleDocument, keyof DocumentEnvelope>);
    const unrelated = await deps.repos.roles.create({ code: 'audit_other_all', name: '其他范围', description: '', system: false, dataScope: 'all', permissionCodes: ['employee:read'] } as Omit<RoleDocument, keyof DocumentEnvelope>);
    const adminRole = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
    if (!adminRole) throw new Error('missing org admin');
    const password = 'AuditScopePassword12!';
    const passwordHash = await deps.auth.createPasswordHash(password);
    for (const [email, roleIds, expected] of [['audit-self-user', [self.id, unrelated.id], 403], ['audit-admin-user', [adminRole.id], 200]] as const) {
      await deps.repos.users.create({ name: email, email, passwordHash, status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [...roleIds], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost:5173' }, payload: { email, password } });
      expect(login.statusCode).toBe(200);
      const cookies = (login.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
      const response = await app.inject({ method: 'GET', url: '/api/v1/audit-logs', headers: { cookie: cookies } });
      expect(response.statusCode, response.body).toBe(expected);
    }
  });

  it('rejects user administration without all on the relevant permission', async () => {
    const { app, deps } = await fixture();
    const restricted = await deps.repos.roles.create({ code: 'limited_user_manager', name: '受限管理', description: '', system: false, dataScope: 'self', permissionCodes: ['user:manage', 'role:manage'] } as Omit<RoleDocument, keyof DocumentEnvelope>);
    const other = await deps.repos.roles.create({ code: 'unrelated_scope_all', name: '无关范围', description: '', system: false, dataScope: 'all', permissionCodes: ['audit:read'] } as Omit<RoleDocument, keyof DocumentEnvelope>);
    const member = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'member');
    if (!member) throw new Error('missing member');
    const password = 'LimitedManagerPassword12!';
    const passwordHash = await deps.auth.createPasswordHash(password);
    const input = { name: '受限管理员', email: 'limited-manager', passwordHash, status: 'active' as const, mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [restricted.id, other.id], departmentId: null };
    const user = await deps.repos.users.create(input);
    const target = await deps.repos.users.create({ ...input, name: '目标', email: 'limited-target', roleIds: [member.id] });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost:5173' }, payload: { email: user.email, password } });
    const cookies = (login.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
    expect((await app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie: cookies } })).statusCode).toBe(403);
    const token = cookies.match(/collab_session=([^;]+)/)?.[1];
    if (!token) throw new Error('missing token');
    const actor = await deps.auth.loadContext(token);
    await expect(deps.auth.disableUser(actor, target.id, target.version, undefined, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deps.auth.replaceUserRoles(actor, target.id, [member.id], target.version, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deps.auth.getManagedUserPermissions(actor, target.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deps.auth.createManagedUser(actor, { name: '新用户', email: 'limited-new', passwordHash, roleCodes: ['member'] }, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await deps.repos.users.require(target.id)).status).toBe('active');
  });

  it('prevents disabling a project owner until the project no longer has that owner', async () => {
    const { deps } = await fixture();
    const adminRole = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
    const member = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'member');
    if (!adminRole || !member) throw new Error('missing seed roles');
    const password = 'OwnerProtectionPassword12!';
    const passwordHash = await deps.auth.createPasswordHash(password);
    const input = { name: '组织管理员', email: 'owner-admin', passwordHash, status: 'active' as const, mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [adminRole.id], departmentId: null };
    const admin = await deps.repos.users.create(input);
    const owner = await deps.repos.users.create({ ...input, name: '项目负责人', email: 'project-owner', roleIds: [member.id] });
    const project = await deps.projectRepos.projects.create({ name: '测试项目', key: 'TST', description: '', visibility: 'private', status: 'planning', statusReason: null, ownerId: owner.id, taskSeq: 0, startDate: null, dueDate: null });
    const login = await deps.auth.verifyLogin(admin.email, password, { ip: null, userAgent: null });
    const actor = await deps.auth.loadContext(login.token);
    await expect(deps.auth.disableUser(actor, owner.id, owner.version, undefined, {})).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await deps.repos.users.require(owner.id)).status).toBe('active');
    await deps.projectRepos.projects.softDelete(project.id, project.version);
    expect((await deps.auth.disableUser(actor, owner.id, owner.version, undefined, {})).status).toBe('disabled');
  });
});
