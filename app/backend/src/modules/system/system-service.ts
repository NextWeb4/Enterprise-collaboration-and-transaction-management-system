import { AppError } from '../../shared/errors.js';
import { systemClock, type Clock } from '../../shared/clock.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { CoreRepositories } from '../core/repositories.js';
import type { AuthContext } from '../core/auth-service.js';
import { permissionScopes } from '../core/auth-service.js';
import type { AuditService } from '../core/audit-service.js';
import type { AuditLogDocument, LoginRecordDocument, OrganizationDocument, UserDocument } from '../core/models.js';

const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SystemSettingsView {
  readonly id: string;
  readonly version: number;
  readonly displayName: string;
  readonly timezone: string;
  readonly workflowAllowSelfApproval: false;
}

export interface UpdateSystemSettingsInput {
  readonly version: number;
  readonly displayName: string;
  readonly timezone: string;
}

export interface LoginRecordFilter {
  readonly from?: string;
  readonly to?: string;
  readonly email?: string;
  readonly result?: 'success' | 'failure';
  readonly ip?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface AuditLogFilter {
  readonly from?: string;
  readonly to?: string;
  readonly actorUserId?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly result?: 'success' | 'failure';
  readonly requestId?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface SystemPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface LoginRecordView {
  readonly id: string;
  readonly userId: string | null;
  readonly email: string;
  readonly success: boolean;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
}

export interface AuditLogView {
  readonly id: string;
  readonly seq: number | null;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly result: 'success' | 'failure';
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly metadata: Record<string, string | number | boolean | null>;
  readonly createdAt: string;
}

export class SystemService {
  constructor(
    private readonly core: CoreRepositories,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly clock: Clock = systemClock,
  ) {}

  async settings(actor: AuthContext): Promise<SystemSettingsView> {
    return this.uow.run(async (tx) => {
      const current = await this.loadActor(actor, tx);
      this.requireAllScope(current, 'setting:manage');
      return this.settingsView(await this.organization(tx));
    });
  }

  async updateSettings(actor: AuthContext, input: UpdateSystemSettingsInput, context: { requestId?: string | null; ip?: string | null; userAgent?: string | null } = {}): Promise<SystemSettingsView> {
    this.assertSettingsInput(input);
    return this.uow.run(async (tx) => {
      const current = await this.loadActor(actor, tx);
      this.requireAllScope(current, 'setting:manage');
      const organization = await this.organization(tx);
      const changed = organization.name !== input.displayName || organization.timezone !== input.timezone;
      const updated = await this.core.organizations.update(
        organization.id,
        input.version,
        (document) => ({ ...document, name: input.displayName, timezone: input.timezone }),
        tx,
      );
      if (changed) {
        await this.audit.append({
          actorUserId: current.user.id,
          action: 'system.settings.updated',
          resourceType: 'org_profile',
          resourceId: updated.id,
          requestId: context.requestId,
          ip: context.ip,
          userAgent: context.userAgent,
          metadata: {
            displayNameChanged: organization.name !== updated.name,
            timezoneChanged: organization.timezone !== updated.timezone,
          },
        }, tx);
      }
      return this.settingsView(updated);
    });
  }

  async loginRecords(actor: AuthContext, filter: LoginRecordFilter): Promise<SystemPage<LoginRecordView>> {
    this.assertLoginFilter(filter);
    return this.uow.run(async (tx) => {
      const current = await this.loadActor(actor, tx);
      this.requireAllScope(current, 'login:read');
      const records = await this.all(this.core.loginRecords, tx);
      const from = this.startOfFilter(filter.from);
      const to = this.endOfFilter(filter.to);
      const items = records
        .filter((record) => this.matchesLogin(record, filter, from, to))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
      return this.page(items.map((record) => this.loginView(record)), filter.page, filter.pageSize);
    });
  }

  async auditLogs(actor: AuthContext, filter: AuditLogFilter): Promise<SystemPage<AuditLogView>> {
    this.assertAuditFilter(filter);
    return this.uow.run(async (tx) => {
      const current = await this.loadActor(actor, tx);
      this.requireAllScope(current, 'audit:read');
      const users = new Map((await this.all(this.core.users, tx)).map((user) => [user.id, user]));
      const records = await this.all(this.core.auditLogs, tx);
      const from = this.startOfFilter(filter.from);
      const to = this.endOfFilter(filter.to);
      const items = records
        .filter((record) => this.matchesAudit(record, filter, from, to))
        .sort((left, right) => (right.seq ?? 0) - (left.seq ?? 0));
      return this.page(items.map((record) => this.auditView(record, users.get(record.actorUserId ?? '') ?? null)), filter.page, filter.pageSize);
    });
  }

  private async loadActor(actor: AuthContext, tx: StorageTransaction): Promise<AuthContext> {
    const user = await this.core.users.get(actor.user.id, tx);
    const session = await this.core.sessions.get(actor.session.id, tx);
    const now = this.clock.now();
    if (!user || user.deletedAt !== null || user.status !== 'active' || user.mustChangePassword || !session || session.deletedAt !== null || session.userId !== user.id || session.revokedAt !== null || new Date(session.idleExpiresAt) <= now || new Date(session.absoluteExpiresAt) <= now) throw new AppError('UNAUTHENTICATED', '会话已失效');
    const roles = [];
    for (const roleId of user.roleIds) {
      const role = await this.core.roles.get(roleId, tx);
      if (role && role.deletedAt === null) roles.push(role);
    }
    return { user, session, roles, permissions: [...new Set(roles.flatMap((role) => role.permissionCodes))] };
  }

  private requireAllScope(actor: AuthContext, permission: string): void {
    if (!actor.permissions.includes(permission) || !permissionScopes(actor, permission).includes('all')) throw new AppError('FORBIDDEN', '当前数据范围不支持此系统管理操作');
  }

  private async organization(tx: StorageTransaction): Promise<OrganizationDocument> {
    const page = await this.core.organizations.list({ page: 1, pageSize: 2 }, tx);
    if (page.total !== 1 || !page.items[0]) throw new AppError('STORAGE_CORRUPTED', '组织配置不完整或不唯一');
    return page.items[0];
  }

  private settingsView(organization: OrganizationDocument): SystemSettingsView {
    return { id: organization.id, version: organization.version, displayName: organization.name, timezone: organization.timezone, workflowAllowSelfApproval: false };
  }

  private assertSettingsInput(input: UpdateSystemSettingsInput): void {
    if (!Number.isInteger(input.version) || input.version < 1 || !isSafeDisplayName(input.displayName) || !isIanaTimezone(input.timezone)) throw new AppError('VALIDATION_FAILED', '系统配置无效');
  }

  private assertLoginFilter(filter: LoginRecordFilter): void {
    this.assertPage(filter.page, filter.pageSize);
    this.assertRange(filter.from, filter.to);
    if (filter.email !== undefined && (filter.email.length === 0 || filter.email.length > 120)) throw new AppError('VALIDATION_FAILED', '邮箱筛选条件无效');
    if (filter.ip !== undefined && (filter.ip.length === 0 || filter.ip.length > 128)) throw new AppError('VALIDATION_FAILED', 'IP 筛选条件无效');
  }

  private assertAuditFilter(filter: AuditLogFilter): void {
    this.assertPage(filter.page, filter.pageSize);
    this.assertRange(filter.from, filter.to);
    for (const value of [filter.actorUserId, filter.action, filter.resourceType, filter.requestId]) if (value !== undefined && (value.length === 0 || value.length > 128)) throw new AppError('VALIDATION_FAILED', '日志筛选条件无效');
  }

  private assertPage(page: number, pageSize: number): void {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new AppError('VALIDATION_FAILED', '分页参数无效');
  }

  private assertRange(from: string | undefined, to: string | undefined): void {
    const lower = this.startOfFilter(from); const upper = this.endOfFilter(to);
    if (lower > upper || upper - lower > MAX_RANGE_MS) throw new AppError('VALIDATION_FAILED', '查询时间跨度不得超过 90 天');
  }

  private startOfFilter(value: string | undefined): number {
    if (value === undefined) return this.clock.now().getTime() - DEFAULT_RANGE_MS;
    const time = Date.parse(value); if (!Number.isFinite(time)) throw new AppError('VALIDATION_FAILED', '开始时间无效'); return time;
  }

  private endOfFilter(value: string | undefined): number {
    if (value === undefined) return this.clock.now().getTime();
    const time = Date.parse(value); if (!Number.isFinite(time)) throw new AppError('VALIDATION_FAILED', '结束时间无效'); return time;
  }

  private matchesLogin(record: LoginRecordDocument, filter: LoginRecordFilter, from: number, to: number): boolean {
    const createdAt = Date.parse(record.createdAt);
    return createdAt >= from && createdAt <= to && (filter.email === undefined || record.email.includes(filter.email)) && (filter.result === undefined || record.success === (filter.result === 'success')) && (filter.ip === undefined || record.ip === filter.ip);
  }

  private matchesAudit(record: AuditLogDocument, filter: AuditLogFilter, from: number, to: number): boolean {
    const createdAt = Date.parse(record.createdAt);
    return createdAt >= from && createdAt <= to && (filter.actorUserId === undefined || record.actorUserId === filter.actorUserId) && (filter.action === undefined || record.action === filter.action) && (filter.resourceType === undefined || record.resourceType === filter.resourceType) && (filter.result === undefined || record.result === filter.result) && (filter.requestId === undefined || record.requestId === filter.requestId);
  }

  private loginView(record: LoginRecordDocument): LoginRecordView {
    return { id: record.id, userId: record.userId, email: record.email, success: record.success, reason: record.reason, ip: record.ip, userAgent: record.userAgent, createdAt: record.createdAt };
  }

  private auditView(record: AuditLogDocument, actor: UserDocument | null): AuditLogView {
    return { id: record.id, seq: record.seq ?? null, actorUserId: record.actorUserId, actorName: actor?.deletedAt === null ? actor.name : null, action: record.action, resourceType: record.resourceType, resourceId: record.resourceId, result: record.result ?? 'success', ip: record.ip ?? null, userAgent: record.userAgent ?? null, requestId: record.requestId, metadata: redactMetadata(record.metadata), createdAt: record.createdAt };
  }

  private page<T>(items: readonly T[], page: number, pageSize: number): SystemPage<T> {
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
  }

  private async all<T extends { readonly deletedAt: string | null }>(repository: { list(query: { page: number; pageSize: number }, tx: StorageTransaction): Promise<{ items: readonly T[]; total: number }> }, tx: StorageTransaction): Promise<T[]> {
    const first = await repository.list({ page: 1, pageSize: 100 }, tx); const result = [...first.items];
    for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) result.push(...(await repository.list({ page, pageSize: 100 }, tx)).items);
    return result;
  }
}

function isSafeDisplayName(value: string): boolean {
  const name = value.trim();
  return name.length >= 2 && name.length <= 80 && [...name].every((character) => { const code = character.codePointAt(0) ?? 0; return code >= 32 && code !== 127; });
}

function isIanaTimezone(value: string): boolean {
  try { Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

function redactMetadata(metadata: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => (/password|token|cookie|secret|content|body/i.test(key) ? [key, '[REDACTED]'] : [key, value])));
}
