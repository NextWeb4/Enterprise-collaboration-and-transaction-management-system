import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { AppError } from '../../shared/errors.js';
import type { Clock } from '../../shared/clock.js';
import { systemClock } from '../../shared/clock.js';
import type { DocumentEnvelope } from '../../storage/envelope.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { CoreRepositories } from './repositories.js';
import type { AuditInput, AuditService } from './audit-service.js';
import { publicUser } from './repositories.js';
import type { RoleDocument, SessionDocument, UserDocument } from './models.js';
import { isAcceptablePassword } from '@collab/shared/schemas.js';
import { isPermissionCode, SYSTEM_ROLE_CODES } from '@collab/shared/permissions.js';
import { scopesForPermission } from './permission-scopes.js';

const DUMMY_PASSWORD = 'collab-office-dummy-password';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface AuthContext {
  readonly user: UserDocument;
  readonly session: SessionDocument;
  readonly permissions: readonly string[];
  readonly roles: readonly RoleDocument[];
}

/** This calculates entitlements only; resource-specific guards remain mandatory. */
export function permissionScopes(context: AuthContext, permission: string): ReturnType<typeof scopesForPermission> {
  return scopesForPermission(context.roles, permission);
}

export interface RoleInput {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly dataScope: RoleDocument['dataScope'];
  readonly permissionCodes: readonly string[];
}

export interface RolePatch {
  readonly name?: string;
  readonly description?: string;
  readonly dataScope?: RoleDocument['dataScope'];
  readonly permissionCodes?: readonly string[];
  readonly version: number;
}

export interface RoleAuditContext {
  readonly requestId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface CreateManagedUserInput {
  readonly name: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly roleCodes: readonly string[];
}

export interface ManagedUserPermissions {
  readonly user: ReturnType<typeof publicUser>;
  readonly version: number;
  readonly roleIds: readonly string[];
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export class AuthService {
  private dummyHashPromise: Promise<string> | null = null;

  constructor(
    private readonly repos: CoreRepositories,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly clock: Clock = systemClock,
    private readonly idleMinutes = 480,
    private readonly absoluteDays = 7,
    private readonly hasProjectOwnership?: (userId: string, tx: StorageTransaction) => Promise<boolean>,
    private readonly hasCurrentApproval?: (userId: string, tx: StorageTransaction) => Promise<boolean>,
  ) {}

  async createPasswordHash(password: string): Promise<string> {
    return hash(password, { memoryCost: 65_536, timeCost: 3, parallelism: 1 });
  }

  async isSetupRequired(): Promise<boolean> {
    return (await this.repos.users.countStored()) === 0 && (await this.repos.auditLogs.countStored()) === 0;
  }

  async setupAdmin(input: { name: string; email: string; password: string }, auditContext: RoleAuditContext): Promise<void> {
    const passwordHash = await this.createPasswordHash(input.password);
    await this.uow.run(async (tx) => {
      if ((await this.repos.users.countStored(tx)) !== 0 || (await this.repos.auditLogs.countStored(tx)) !== 0) throw new AppError('VERSION_CONFLICT', '数据目录已有用户或审计记录，不能初始化');
      const role = await this.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin', tx);
      if (!role) throw new AppError('STORAGE_UNAVAILABLE', '管理员角色未初始化');
      const user = await this.repos.users.create({ name: input.name, email: input.email, passwordHash, status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: this.clock.nowIso(), failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>, tx);
      await this.audit.append({ actorUserId: null, action: 'user.bootstrap_created', resourceType: 'user', resourceId: user.id, requestId: auditContext.requestId, ip: auditContext.ip, userAgent: auditContext.userAgent }, tx);
    });
  }

  async verifyLogin(
    email: string,
    password: string,
    metadata: { ip: string | null; userAgent: string | null; requestId?: string | null },
  ): Promise<{ user: UserDocument; token: string; csrfToken: string }> {
    const normalized = email.trim().toLowerCase();
    const user = await this.repos.users.getByUniqueIndex('idx_users_email', normalized);
    const candidateHash = user?.passwordHash ?? (await this.dummyHash());
    const passwordMatches = await verify(candidateHash, password).catch(() => false);
    if (!user || !passwordMatches) {
      await this.recordFailedLogin(user, normalized, metadata);
      throw new AppError('INVALID_CREDENTIALS', '账号或密码错误');
    }
    if (user.status !== 'active') {
      await this.recordFailedLogin(user, normalized, metadata, 'disabled');
      throw new AppError('INVALID_CREDENTIALS', '账号或密码错误');
    }
    if (user.lockedUntil && new Date(user.lockedUntil) > this.clock.now()) {
      await this.recordFailedLogin(user, normalized, metadata, 'locked');
      throw new AppError('INVALID_CREDENTIALS', '账号或密码错误');
    }
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const createdAt = this.clock.nowIso();
    const now = this.clock.now();
    const idleExpiresAt = new Date(now.getTime() + this.idleMinutes * 60_000).toISOString();
    const absoluteExpiresAt = new Date(
      now.getTime() + this.absoluteDays * 86_400_000,
    ).toISOString();
    const result = await this.uow.run(async (tx) => {
      const current = await this.repos.users.get(user.id, tx);
      if (
        !current ||
        current.status !== 'active' ||
        current.passwordHash !== user.passwordHash ||
        (current.lockedUntil && new Date(current.lockedUntil) > now)
      ) {
        await this.recordLoginAttempt(
          tx,
          current?.id ?? null,
          normalized,
          metadata,
          'credentials_changed',
        );
        return null;
      }
      const loggedIn = await this.repos.users.update(
        current.id,
        current.version,
        (document) => ({
          ...document,
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: createdAt,
        }),
        tx,
      );
      const session = await this.repos.sessions.create(
        {
          userId: loggedIn.id,
          tokenHash: sha256(token),
          csrfToken,
          idleExpiresAt,
          absoluteExpiresAt,
          lastSeenAt: createdAt,
          revokedAt: null,
        } as Omit<SessionDocument, keyof DocumentEnvelope>,
        tx,
      );
      await this.recordLoginAttempt(tx, loggedIn.id, normalized, metadata, null, true);
      const auditInput: AuditInput = {
        actorUserId: loggedIn.id,
        action: 'auth.login',
        resourceType: 'session',
        resourceId: session.id,
        requestId: metadata.requestId ?? null,
        ip: metadata.ip,
        userAgent: metadata.userAgent,
      };
      await this.audit.append(auditInput, tx);
      return loggedIn;
    });
    if (!result) throw new AppError('INVALID_CREDENTIALS', '账号或密码错误');
    return { user: result, token, csrfToken };
  }

  async loadContext(token: string): Promise<AuthContext> {
    const session = await this.repos.sessions.getByUniqueIndex(
      'idx_sessions_token_hash',
      sha256(token),
    );
    if (!session || session.revokedAt) {
      throw new AppError('UNAUTHENTICATED', '会话已失效');
    }
    const now = this.clock.now();
    if (new Date(session.idleExpiresAt) <= now || new Date(session.absoluteExpiresAt) <= now) {
      await this.repos.sessions.update(session.id, session.version, (current) => ({
        ...current,
        revokedAt: this.clock.nowIso(),
      }));
      throw new AppError('UNAUTHENTICATED', '会话已失效');
    }
    const user = await this.repos.users.get(session.userId);
    if (!user || user.deletedAt !== null || user.status !== 'active') {
      throw new AppError('UNAUTHENTICATED', '会话已失效');
    }
    const roles = await this.activeRolesForUser(user);
    const permissions = [...new Set(roles.flatMap((role) => role.permissionCodes))];
    return { user, session, permissions, roles };
  }

  async touchSession(session: SessionDocument): Promise<SessionDocument> {
    return this.uow.run(async (tx) => {
      const current = await this.repos.sessions.get(session.id, tx);
      const now = this.clock.now();
      if (
        !current ||
        current.revokedAt ||
        new Date(current.idleExpiresAt) <= now ||
        new Date(current.absoluteExpiresAt) <= now
      ) {
        throw new AppError('UNAUTHENTICATED', '会话已失效');
      }
      // Limit LMDB writes while keeping the sliding expiry within one minute of activity.
      if (now.getTime() - new Date(current.lastSeenAt).getTime() < 60_000) return current;
      const nextIdle = new Date(now.getTime() + this.idleMinutes * 60_000).toISOString();
      return this.repos.sessions.update(
        current.id,
        current.version,
        (document) => ({
          ...document,
          lastSeenAt: this.clock.nowIso(),
          idleExpiresAt: nextIdle,
        }),
        tx,
      );
    });
  }

  async revoke(session: SessionDocument, auditInput?: AuditInput): Promise<void> {
    await this.uow.run(async (tx) => {
      const current = await this.repos.sessions.get(session.id, tx);
      if (current && !current.revokedAt) {
        await this.repos.sessions.update(
          current.id,
          current.version,
          (document) => ({ ...document, revokedAt: this.clock.nowIso() }),
          tx,
        );
      }
      if (auditInput) await this.audit.append(auditInput, tx);
    });
  }

  async changePassword(
    context: AuthContext,
    currentPassword: string,
    newPassword: string,
    auditInput?: AuditInput,
  ): Promise<void> {
    if (newPassword.length < 12) throw new AppError('WEAK_PASSWORD', '密码至少 12 个字符');
    if (!isAcceptablePassword(newPassword))
      throw new AppError('WEAK_PASSWORD', '新密码过于常见，请更换为不易猜测的密码');
    const valid = await verify(context.user.passwordHash, currentPassword).catch(() => false);
    if (!valid) throw new AppError('INVALID_CREDENTIALS', '当前密码错误');
    const passwordHash = await this.createPasswordHash(newPassword);
    await this.uow.run(async (tx) => {
      const currentActor = await this.loadCurrentActor(context, tx);
      const user = currentActor.user;
      if (user.passwordHash !== context.user.passwordHash)
        throw new AppError('VERSION_CONFLICT', '账号已更新，请重新登录后重试');
      await this.repos.users.update(
        user.id,
        user.version,
        (current) => ({
          ...current,
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: this.clock.nowIso(),
        }),
        tx,
      );
      const firstPage = await this.repos.sessions.list({ page: 1, pageSize: 1 }, tx);
      const pageCount = Math.ceil(firstPage.total / 100);
      for (let page = 1; page <= pageCount; page += 1) {
        const result = await this.repos.sessions.list({ page, pageSize: 100 }, tx);
        for (const session of result.items) {
          if (
            session.userId === context.user.id &&
            session.id !== context.session.id &&
            !session.revokedAt
          ) {
            await this.repos.sessions.update(
              session.id,
              session.version,
              (current) => ({ ...current, revokedAt: this.clock.nowIso() }),
              tx,
            );
          }
        }
      }
      if (auditInput) await this.audit.append(auditInput, tx);
    });
  }

  async rolesAndPermissions(
    user: UserDocument,
  ): Promise<{ roles: string[]; permissions: string[] }> {
    const roles = user.deletedAt === null ? await this.activeRolesForUser(user) : [];
    return {
      roles: roles.map((role) => role.code),
      permissions: [...new Set(roles.flatMap((role) => role.permissionCodes))],
    };
  }

  /**
   * Create a non-system role while enforcing the actor's effective permission
   * ceiling. Role administration itself is intentionally not a capability
   * that can be delegated unless the actor already has it.
   */
  async createRole(
    actor: AuthContext,
    input: RoleInput,
    auditContext: RoleAuditContext,
  ): Promise<RoleDocument> {
    this.assertPermissionCatalog(input.permissionCodes);
    if (SYSTEM_ROLE_CODES.includes(input.code as (typeof SYSTEM_ROLE_CODES)[number])) {
      throw new AppError('FORBIDDEN', '系统角色代码不能用于自定义角色');
    }
    return this.uow.run(async (tx) => {
      const currentActor = await this.requireRoleManager(actor, tx);
      this.assertRolePermissionSubset(currentActor, input.permissionCodes);
      this.assertDelegableScope(currentActor, input.dataScope, input.permissionCodes);
      const created = await this.repos.roles.create(
        {
          code: input.code,
          name: input.name,
          description: input.description,
          dataScope: input.dataScope,
          permissionCodes: [...new Set(input.permissionCodes)],
          system: false,
        } as Omit<RoleDocument, keyof DocumentEnvelope>,
        tx,
      );
      await this.audit.append(
        {
          actorUserId: currentActor.user.id,
          action: 'role.created',
          resourceType: 'role',
          resourceId: created.id,
          requestId: auditContext.requestId,
          ip: auditContext.ip,
          userAgent: auditContext.userAgent,
          metadata: {
            code: created.code,
            dataScope: created.dataScope,
            permissionCodes: created.permissionCodes.join(','),
          },
        },
        tx,
      );
      return created;
    });
  }

  async updateRole(
    actor: AuthContext,
    roleId: string,
    patch: RolePatch,
    auditContext: RoleAuditContext,
  ): Promise<RoleDocument> {
    return this.uow.run(async (tx) => {
      const currentActor = await this.requireRoleManager(actor, tx);
      const current = await this.repos.roles.require(roleId, tx);
      if (current.deletedAt !== null) throw new AppError('NOT_FOUND', '角色不存在');
      if (current.system) throw new AppError('FORBIDDEN', '系统角色不可修改');
      const nextPermissions = patch.permissionCodes ?? current.permissionCodes;
      this.assertPermissionCatalog(nextPermissions);
      this.assertRolePermissionSubset(currentActor, nextPermissions);
      this.assertDelegableScope(currentActor, patch.dataScope ?? current.dataScope, nextPermissions);
      const updated = await this.repos.roles.update(
        current.id,
        patch.version,
        (document) => ({
          ...document,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.dataScope === undefined ? {} : { dataScope: patch.dataScope }),
          permissionCodes: [...new Set(nextPermissions)],
        }),
        tx,
      );
      await this.audit.append(
        {
          actorUserId: currentActor.user.id,
          action: 'role.updated',
          resourceType: 'role',
          resourceId: updated.id,
          requestId: auditContext.requestId,
          ip: auditContext.ip,
          userAgent: auditContext.userAgent,
          metadata: {
            code: updated.code,
            dataScopeBefore: current.dataScope,
            dataScopeAfter: updated.dataScope,
            permissionsAdded: updated.permissionCodes
              .filter((code) => !current.permissionCodes.includes(code))
              .join(','),
            permissionsRemoved: current.permissionCodes
              .filter((code) => !updated.permissionCodes.includes(code))
              .join(','),
          },
        },
        tx,
      );
      return updated;
    });
  }

  async deleteRole(
    actor: AuthContext,
    roleId: string,
    expectedVersion: number,
    auditContext: RoleAuditContext,
  ): Promise<void> {
    await this.uow.run(async (tx) => {
      const currentActor = await this.requireRoleManager(actor, tx);
      const role = await this.repos.roles.require(roleId, tx);
      if (role.deletedAt !== null) throw new AppError('NOT_FOUND', '角色不存在');
      if (role.system) throw new AppError('FORBIDDEN', '系统角色不可删除');
      const users = await this.listAllUsers(tx);
      if (users.some((user) => user.roleIds.includes(role.id))) {
        throw new AppError('VERSION_CONFLICT', '角色仍被用户引用，不能删除');
      }
      await this.repos.roles.softDelete(role.id, expectedVersion, tx);
      await this.audit.append(
        {
          actorUserId: currentActor.user.id,
          action: 'role.deleted',
          resourceType: 'role',
          resourceId: role.id,
          requestId: auditContext.requestId,
          ip: auditContext.ip,
          userAgent: auditContext.userAgent,
          metadata: {
            code: role.code,
            dataScope: role.dataScope,
            permissionCodes: role.permissionCodes.join(','),
          },
        },
        tx,
      );
    });
  }

  async replaceUserRoles(
    actor: AuthContext,
    userId: string,
    roleIds: readonly string[],
    expectedVersion: number,
    auditContext: RoleAuditContext,
  ): Promise<UserDocument> {
    const uniqueRoleIds = [...new Set(roleIds)];
    if (uniqueRoleIds.length === 0) throw new AppError('VALIDATION_FAILED', '用户至少需要一个角色');
    return this.uow.run(async (tx) => {
      const currentActor = await this.requireRoleManager(actor, tx);
      const current = await this.repos.users.require(userId, tx);
      this.requireAllScope(currentActor, 'role:manage');
      if (current.deletedAt !== null) throw new AppError('NOT_FOUND', '用户不存在');
      if (current.id === currentActor.user.id)
        throw new AppError('FORBIDDEN', '不能直接修改自己的角色');
      const roles = await this.loadRoles(uniqueRoleIds, tx);
      const currentRoles = await this.loadRoles(current.roleIds, tx);
      this.assertRoleAssignmentAllowed(currentActor, roles, currentRoles);
      const updated = await this.repos.users.update(
        current.id,
        expectedVersion,
        (document) => ({ ...document, roleIds: uniqueRoleIds }),
        tx,
      );
      const added = roles
        .filter((role) => !current.roleIds.includes(role.id))
        .map((role) => role.code);
      const removed = currentRoles
        .filter((role) => !uniqueRoleIds.includes(role.id))
        .map((role) => role.code);
      await this.audit.append(
        {
          actorUserId: currentActor.user.id,
          action: 'user.roles.updated',
          resourceType: 'user',
          resourceId: updated.id,
          requestId: auditContext.requestId,
          ip: auditContext.ip,
          userAgent: auditContext.userAgent,
          metadata: { added: added.join(','), removed: removed.join(',') },
        },
        tx,
      );
      for (const role of roles.filter((candidate) => added.includes(candidate.code))) {
        await this.audit.append(
          {
            actorUserId: currentActor.user.id,
            action: 'role.assigned',
            resourceType: 'role',
            resourceId: role.id,
            requestId: auditContext.requestId,
            ip: auditContext.ip,
            userAgent: auditContext.userAgent,
            metadata: { roleCode: role.code, userId: updated.id },
          },
          tx,
        );
      }
      for (const role of currentRoles.filter((candidate) => removed.includes(candidate.code))) {
        await this.audit.append(
          {
            actorUserId: currentActor.user.id,
            action: 'role.revoked',
            resourceType: 'role',
            resourceId: role.id,
            requestId: auditContext.requestId,
            ip: auditContext.ip,
            userAgent: auditContext.userAgent,
            metadata: { roleCode: role.code, userId: updated.id },
          },
          tx,
        );
      }
      return updated;
    });
  }

  async disableUser(
    actor: AuthContext,
    userId: string,
    expectedVersion: number,
    reason: string | undefined,
    auditContext: RoleAuditContext,
  ): Promise<UserDocument> {
    return this.uow.run(async (tx) => {
      const currentActor = await this.loadCurrentActor(actor, tx);
      this.requireCurrentPermission(currentActor, 'user:manage');
      this.requireAllScope(currentActor, 'user:manage');
      const current = await this.repos.users.require(userId, tx);
      if (current.deletedAt !== null) throw new AppError('NOT_FOUND', '用户不存在');
      if (current.id === currentActor.user.id)
        throw new AppError('VERSION_CONFLICT', '不能停用自己');
      if (current.status !== 'active') throw new AppError('VERSION_CONFLICT', '用户已停用');

      if (!this.hasProjectOwnership) throw new AppError('STORAGE_UNAVAILABLE', '无法校验项目负责人，不能停用用户');
      if (await this.hasProjectOwnership(current.id, tx)) {
        throw new AppError('VERSION_CONFLICT', '用户仍是项目负责人，请先转让项目');
      }
      if (!this.hasCurrentApproval) throw new AppError('STORAGE_UNAVAILABLE', '无法校验当前审批人，不能停用用户');
      if (await this.hasCurrentApproval(current.id, tx)) throw new AppError('CURRENT_APPROVER_ACTIVE', '用户仍是当前审批人，请先转交');

      const targetRoles = await this.activeRolesForUser(current, tx);
      if (targetRoles.some((role) => role.code === 'org_admin')) {
        const users = await this.listAllUsers(tx);
        let activeOrgAdminCount = 0;
        for (const user of users) {
          if (user.deletedAt !== null || user.status !== 'active') continue;
          const roles = await this.activeRolesForUser(user, tx);
          if (roles.some((role) => role.code === 'org_admin')) activeOrgAdminCount += 1;
        }
        if (activeOrgAdminCount <= 1)
          throw new AppError('LAST_ADMIN_PROTECTED', '不能停用最后一个组织管理员');
      }

      const updated = await this.repos.users.update(
        current.id,
        expectedVersion,
        (document) => ({ ...document, status: 'disabled' }),
        tx,
      );
      const sessionPage = await this.repos.sessions.list({ page: 1, pageSize: 1 }, tx);
      const sessionPages = Math.ceil(sessionPage.total / 100);
      const normalizedReason = reason ?? null;
      for (let page = 1; page <= sessionPages; page += 1) {
        const result = await this.repos.sessions.list({ page, pageSize: 100 }, tx);
        for (const session of result.items) {
          if (session.userId !== updated.id || session.revokedAt !== null) continue;
          const revoked = await this.repos.sessions.update(
            session.id,
            session.version,
            (document) => ({ ...document, revokedAt: this.clock.nowIso() }),
            tx,
          );
          await this.audit.append(
            {
              actorUserId: currentActor.user.id,
              action: 'session.revoked',
              resourceType: 'session',
              resourceId: revoked.id,
              requestId: auditContext.requestId,
              ip: auditContext.ip,
              userAgent: auditContext.userAgent,
              metadata: { userId: updated.id, reason: normalizedReason },
            },
            tx,
          );
        }
      }
      await this.audit.append(
        {
          actorUserId: currentActor.user.id,
          action: 'user.disabled',
          resourceType: 'user',
          resourceId: updated.id,
          requestId: auditContext.requestId,
          ip: auditContext.ip,
          userAgent: auditContext.userAgent,
          metadata: { reason: normalizedReason },
        },
        tx,
      );
      return updated;
    });
  }

  async enableUser(actor: AuthContext, userId: string, version: number, context: RoleAuditContext): Promise<UserDocument> {
    return this.uow.run(async (tx) => {
      const currentActor = await this.loadCurrentActor(actor, tx);
      this.requireCurrentPermission(currentActor, 'user:manage');
      this.requireAllScope(currentActor, 'user:manage');
      const target = await this.repos.users.require(userId, tx);
      if (target.deletedAt !== null) throw new AppError('NOT_FOUND', '用户不存在');
      if (target.status !== 'disabled') throw new AppError('VERSION_CONFLICT', '用户已启用');
      const updated = await this.repos.users.update(userId, version, (value) => ({ ...value, status: 'active', failedLoginCount: 0, lockedUntil: null }), tx);
      // Enabling an account must never revive any session that predates activation.
      await this.revokeManagedSessions(currentActor, userId, 'account_enabled', context, tx);
      await this.audit.append({ ...context, actorUserId: currentActor.user.id, action: 'user.enabled', resourceType: 'user', resourceId: userId }, tx);
      return updated;
    });
  }

  async resetManagedPassword(actor: AuthContext, userId: string, version: number, context: RoleAuditContext): Promise<{ user: UserDocument; temporaryPassword: string }> {
    // Reject unauthorized callers before doing costly password hashing, then recheck in the write transaction.
    await this.uow.run(async (tx) => {
      const current = await this.loadCurrentActor(actor, tx);
      this.requireCurrentPermission(current, 'user:manage');
      this.requireAllScope(current, 'user:manage');
    });
    const temporaryPassword = randomBytes(24).toString('base64url');
    const passwordHash = await this.createPasswordHash(temporaryPassword);
    const user = await this.uow.run(async (tx) => {
      const currentActor = await this.loadCurrentActor(actor, tx);
      this.requireCurrentPermission(currentActor, 'user:manage');
      this.requireAllScope(currentActor, 'user:manage');
      const target = await this.repos.users.require(userId, tx);
      if (target.deletedAt !== null) throw new AppError('NOT_FOUND', '用户不存在');
      if (target.id === currentActor.user.id) throw new AppError('VERSION_CONFLICT', '请通过个人设置修改自己的密码');
      if (target.status !== 'active') throw new AppError('VERSION_CONFLICT', '请先启用账号再重置密码');
      const updated = await this.repos.users.update(userId, version, (value) => ({ ...value, passwordHash, mustChangePassword: true, passwordChangedAt: this.clock.nowIso(), failedLoginCount: 0, lockedUntil: null }), tx);
      await this.revokeManagedSessions(currentActor, userId, 'password_reset', context, tx);
      await this.audit.append({ ...context, actorUserId: currentActor.user.id, action: 'user.password_reset', resourceType: 'user', resourceId: userId }, tx);
      return updated;
    });
    return { user, temporaryPassword };
  }

  async forceLogoutUser(actor: AuthContext, userId: string, version: number, context: RoleAuditContext): Promise<{ revokedSessions: number }> {
    return this.uow.run(async (tx) => {
      const currentActor = await this.loadCurrentActor(actor, tx);
      this.requireCurrentPermission(currentActor, 'session:manage');
      this.requireAllScope(currentActor, 'session:manage');
      const target = await this.repos.users.require(userId, tx);
      if (target.deletedAt !== null) throw new AppError('NOT_FOUND', '用户不存在');
      if (target.version !== version) throw new AppError('VERSION_CONFLICT', '账号已更新，请刷新后重试');
      const revokedSessions = await this.revokeManagedSessions(currentActor, userId, 'forced_logout', context, tx);
      await this.audit.append({ ...context, actorUserId: currentActor.user.id, action: 'user.force_logged_out', resourceType: 'user', resourceId: userId, metadata: { revokedSessions } }, tx);
      return { revokedSessions };
    });
  }

  private async revokeManagedSessions(actor: AuthContext, userId: string, reason: string, context: RoleAuditContext, tx: StorageTransaction): Promise<number> {
    const first = await this.repos.sessions.list({ page: 1, pageSize: 100 }, tx);
    let revokedCount = 0;
    for (let page = 1; page <= Math.ceil(first.total / 100); page += 1) {
      const sessions = page === 1 ? first : await this.repos.sessions.list({ page, pageSize: 100 }, tx);
      for (const session of sessions.items) {
        if (session.userId !== userId || session.revokedAt !== null) continue;
        await this.repos.sessions.update(session.id, session.version, (value) => ({ ...value, revokedAt: this.clock.nowIso() }), tx);
        await this.audit.append({ ...context, actorUserId: actor.user.id, action: 'session.revoked', resourceType: 'session', resourceId: session.id, metadata: { userId, reason } }, tx);
        revokedCount += 1;
      }
    }
    return revokedCount;
  }

  async createManagedUser(
    actor: AuthContext,
    input: CreateManagedUserInput,
    auditContext: RoleAuditContext,
  ): Promise<UserDocument> {
    const roleCodes = [...new Set(input.roleCodes)];
    if (roleCodes.length === 0) throw new AppError('VALIDATION_FAILED', '用户至少需要一个角色');
    return this.uow.run(async (tx) => {
      const currentActor = await this.loadCurrentActor(actor, tx);
      this.requireCurrentPermission(currentActor, 'user:manage');
      this.requireAllScope(currentActor, 'user:manage');
      const roles = await this.loadRolesByCodes(roleCodes, tx);
      const isDefaultMemberAssignment = roles.length === 1 && roles[0]?.code === 'member';
      if (!isDefaultMemberAssignment || currentActor.permissions.includes('role:manage')) {
        this.requireCurrentPermission(currentActor, 'role:manage');
        this.assertRoleAssignmentAllowed(currentActor, roles, []);
      }
      const created = await this.repos.users.create(
        {
          name: input.name,
          email: input.email,
          passwordHash: input.passwordHash,
          status: 'active',
          mustChangePassword: true,
          lastLoginAt: null,
          passwordChangedAt: null,
          failedLoginCount: 0,
          lockedUntil: null,
          roleIds: roles.map((role) => role.id),
          departmentId: null,
        } as Omit<UserDocument, keyof DocumentEnvelope>,
        tx,
      );
      await this.audit.append(
        {
          actorUserId: currentActor.user.id,
          action: 'user.created',
          resourceType: 'user',
          resourceId: created.id,
          requestId: auditContext.requestId,
          ip: auditContext.ip,
          userAgent: auditContext.userAgent,
        },
        tx,
      );
      for (const role of roles) {
        await this.audit.append(
          {
            actorUserId: currentActor.user.id,
            action: 'role.assigned',
            resourceType: 'role',
            resourceId: role.id,
            requestId: auditContext.requestId,
            ip: auditContext.ip,
            userAgent: auditContext.userAgent,
            metadata: { roleCode: role.code, userId: created.id },
          },
          tx,
        );
      }
      return created;
    });
  }

  async getManagedUserPermissions(
    actor: AuthContext,
    userId: string,
  ): Promise<ManagedUserPermissions> {
    return this.uow.run(async (tx) => {
      const currentActor = await this.requireRoleManager(actor, tx);
      this.requireAllScope(currentActor, 'role:manage');
      const user = await this.repos.users.get(userId, tx);
      if (!user || user.deletedAt !== null) throw new AppError('NOT_FOUND', '用户不存在');
      const roles = await this.activeRolesForUser(user, tx);
      return {
        user: publicUser(user),
        version: user.version,
        roleIds: [...user.roleIds],
        roles: roles.map((role) => role.code),
        permissions: [...new Set(roles.flatMap((role) => role.permissionCodes))],
      };
    });
  }

  private assertPermissionCatalog(permissionCodes: readonly string[]): void {
    if (
      new Set(permissionCodes).size !== permissionCodes.length ||
      permissionCodes.some((code) => !isPermissionCode(code))
    ) {
      throw new AppError('VALIDATION_FAILED', '角色包含未知或重复权限码');
    }
  }

  private assertRolePermissionSubset(actor: AuthContext, permissionCodes: readonly string[]): void {
    const actorPermissions = new Set(actor.permissions);
    if (permissionCodes.some((permission) => !actorPermissions.has(permission))) {
      throw new AppError('FORBIDDEN', '自定义角色权限不能超出操作者自身权限');
    }
  }

  // Until department scope is enforced, only org administrators may delegate
  // broader scopes. A non-admin may delegate self only for permissions for
  // which they themselves have self or all, not an unrelated role's scope.
  private assertDelegableScope(actor: AuthContext, scope: RoleDocument['dataScope'], permissions: readonly string[]): void {
    if (actor.roles.some((role) => role.code === 'org_admin')) return;
    if (scope !== 'self' || permissions.some((permission) => {
      const scopes = permissionScopes(actor, permission);
      return !scopes.includes('self') && !scopes.includes('all');
    })) throw new AppError('FORBIDDEN', '不能授予超出操作者范围的数据权限');
  }

  private assertRoleAssignmentAllowed(
    actor: AuthContext,
    roles: readonly RoleDocument[],
    currentRoles: readonly RoleDocument[],
  ): void {
    const actorIsOrgAdmin = actor.roles.some((role) => role.code === 'org_admin');
    const actorIsSystemAdmin = actor.roles.some((role) => role.code === 'system_admin');
    if (roles.some((role) => role.code === 'org_admin') && actorIsSystemAdmin) {
      throw new AppError('FORBIDDEN', '系统管理员不能授予组织管理员角色');
    }
    if (
      roles.some(
        (role) => role.system && ['org_admin', 'system_admin', 'auditor'].includes(role.code),
      ) &&
      !actorIsOrgAdmin
    ) {
      throw new AppError('FORBIDDEN', '只有组织管理员可以授予管理员角色');
    }
    const nextRoleIds = new Set(roles.map((role) => role.id));
    if (
      !actorIsOrgAdmin &&
      currentRoles.some((role) => this.isAdminRole(role) && !nextRoleIds.has(role.id))
    ) {
      throw new AppError('FORBIDDEN', '只有组织管理员可以撤销管理员角色');
    }
    this.assertRolePermissionSubset(
      actor,
      roles.flatMap((role) => role.permissionCodes),
    );
    for (const role of roles) this.assertDelegableScope(actor, role.dataScope, role.permissionCodes);
  }

  private async loadRoles(
    roleIds: readonly string[],
    tx?: StorageTransaction,
  ): Promise<RoleDocument[]> {
    const roles: RoleDocument[] = [];
    for (const roleId of roleIds) {
      const role = await this.repos.roles.get(roleId, tx);
      if (!role || role.deletedAt !== null) throw new AppError('VALIDATION_FAILED', '角色不存在');
      roles.push(role);
    }
    return roles;
  }

  private async loadRolesByCodes(
    roleCodes: readonly string[],
    tx?: StorageTransaction,
  ): Promise<RoleDocument[]> {
    const roles: RoleDocument[] = [];
    for (const roleCode of roleCodes) {
      const role = await this.repos.roles.getByUniqueIndex('idx_roles_code', roleCode, tx);
      if (!role || role.deletedAt !== null) throw new AppError('VALIDATION_FAILED', '角色不存在');
      roles.push(role);
    }
    return roles;
  }

  private async activeRolesForUser(
    user: UserDocument,
    tx?: StorageTransaction,
  ): Promise<RoleDocument[]> {
    const roles: RoleDocument[] = [];
    for (const roleId of user.roleIds) {
      const role = await this.repos.roles.get(roleId, tx);
      if (role && role.deletedAt === null) roles.push(role);
    }
    return roles;
  }

  async loadCurrentActor(actor: AuthContext, tx: StorageTransaction): Promise<AuthContext> {
    const current = await this.repos.users.get(actor.user.id, tx);
    if (!current || current.deletedAt !== null || current.status !== 'active') {
      throw new AppError('UNAUTHENTICATED', '会话已失效');
    }
    const session = await this.repos.sessions.get(actor.session.id, tx);
    const now = this.clock.now();
    if (
      !session ||
      session.deletedAt !== null ||
      session.userId !== current.id ||
      session.revokedAt !== null ||
      new Date(session.idleExpiresAt) <= now ||
      new Date(session.absoluteExpiresAt) <= now
    ) {
      throw new AppError('UNAUTHENTICATED', '会话已失效');
    }
    const roles = await this.activeRolesForUser(current, tx);
    return {
      user: current,
      session,
      roles,
      permissions: [...new Set(roles.flatMap((role) => role.permissionCodes))],
    };
  }

  private requireCurrentPermission(actor: AuthContext, permission: string): void {
    if (!actor.permissions.includes(permission))
      throw new AppError('FORBIDDEN', '没有执行此操作的权限');
  }

  private requireAllScope(actor: AuthContext, permission: string): void {
    if (!permissionScopes(actor, permission).includes('all')) {
      throw new AppError('FORBIDDEN', '当前数据范围暂不支持管理其他用户');
    }
  }

  private async requireRoleManager(
    actor: AuthContext,
    tx: StorageTransaction,
  ): Promise<AuthContext> {
    const currentActor = await this.loadCurrentActor(actor, tx);
    this.requireCurrentPermission(currentActor, 'role:manage');
    return currentActor;
  }

  private isAdminRole(role: RoleDocument): boolean {
    return role.system && ['org_admin', 'system_admin', 'auditor'].includes(role.code);
  }

  private async listAllUsers(tx?: StorageTransaction): Promise<UserDocument[]> {
    const firstPage = await this.repos.users.list({ page: 1, pageSize: 1 }, tx);
    const pages = Math.ceil(firstPage.total / 100);
    const users: UserDocument[] = [];
    for (let page = 1; page <= pages; page += 1)
      users.push(
        ...(await this.repos.users
          .list({ page, pageSize: 100 }, tx)
          .then((result) => [...result.items])),
      );
    return users;
  }

  publicUser(user: UserDocument): ReturnType<typeof publicUser> {
    return publicUser(user);
  }

  private async dummyHash(): Promise<string> {
    this.dummyHashPromise ??= this.createPasswordHash(DUMMY_PASSWORD);
    return this.dummyHashPromise;
  }

  private async recordFailedLogin(
    user: UserDocument | undefined,
    email: string,
    metadata: { ip: string | null; userAgent: string | null },
    reason = 'invalid',
  ): Promise<void> {
    await this.uow.run((tx) =>
      this.recordLoginAttempt(tx, user?.id ?? null, email, metadata, reason),
    );
  }

  private async recordLoginAttempt(
    tx: StorageTransaction,
    userId: string | null,
    email: string,
    metadata: { ip: string | null; userAgent: string | null },
    reason: string | null,
    success = false,
  ): Promise<void> {
    const user = userId ? await this.repos.users.get(userId, tx) : undefined;
    const lockIsActive =
      user?.lockedUntil !== null &&
      user?.lockedUntil !== undefined &&
      new Date(user.lockedUntil) > this.clock.now();
    if (!success && user && !lockIsActive) {
      const nextCount = user.failedLoginCount + 1;
      const lockedUntil =
        nextCount >= 5
          ? new Date(this.clock.now().getTime() + 15 * 60_000).toISOString()
          : user.lockedUntil;
      await this.repos.users.update(
        user.id,
        user.version,
        (current) => ({ ...current, failedLoginCount: nextCount, lockedUntil }),
        tx,
      );
    }
    await this.repos.loginRecords.create(
      {
        userId: user?.id ?? null,
        email,
        success,
        reason: success ? null : reason,
        ip: metadata.ip,
        userAgent: metadata.userAgent,
      } as Omit<import('./models.js').LoginRecordDocument, keyof DocumentEnvelope>,
      tx,
    );
  }
}
