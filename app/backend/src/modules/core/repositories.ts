import { createHash } from 'node:crypto';
import { SYSTEM_ROLE_SEEDS, PERMISSION_CATALOG } from '@collab/shared/permissions.js';
import type { Clock } from '../../shared/clock.js';
import { systemClock } from '../../shared/clock.js';
import type { StorageEngine } from '../../storage/engine.js';
import { BaseRepository, type Repository } from '../../storage/repository.js';
import { SchemaRegistry } from '../../storage/schema-registry.js';
import type { IndexDefinition } from '../../storage/index-registry.js';
import type { StoreName } from '../../storage/store-names.js';
import type { ErrorCode } from '@collab/shared/errors.js';
import type {
  AuditLogDocument,
  BootstrapRecordDocument,
  FileDocument,
  LoginRecordDocument,
  OrganizationDocument,
  PermissionDocument,
  RoleDocument,
  SessionDocument,
  UserDocument,
} from './models.js';
import {
  auditLogSchema,
  bootstrapRecordSchema,
  fileSchema,
  loginRecordSchema,
  organizationSchema,
  permissionSchema,
  roleSchema,
  sessionSchema,
  userSchema,
} from './models.js';

export interface CoreRepositories {
  readonly bootstrapRecords: Repository<BootstrapRecordDocument>;
  readonly users: Repository<UserDocument>;
  readonly roles: Repository<RoleDocument>;
  readonly permissions: Repository<PermissionDocument>;
  readonly sessions: Repository<SessionDocument>;
  readonly organizations: Repository<OrganizationDocument>;
  readonly loginRecords: Repository<LoginRecordDocument>;
  readonly auditLogs: Repository<AuditLogDocument>;
  readonly files: Repository<FileDocument>;
  readonly registry: SchemaRegistry;
}

export const CORE_UNIQUE_INDEXES = [
  { source: 'users', indexStore: 'idx_users_email', field: 'email' },
  { source: 'roles', indexStore: 'idx_roles_code', field: 'code' },
  { source: 'permissions', indexStore: 'idx_permissions_code', field: 'code' },
  { source: 'sessions', indexStore: 'idx_sessions_token_hash', field: 'tokenHash' },
  { source: 'files', indexStore: 'idx_files_storage_key', field: 'storageKey' },
  { source: 'projects', indexStore: 'idx_projects_key', field: 'key' },
  { source: 'project_members', indexStore: 'idx_project_members_key', field: 'membershipKey' },
  { source: 'tasks', indexStore: 'idx_tasks_key', field: 'taskKey' },
] as const satisfies readonly { source: StoreName; indexStore: string; field: string }[];

function index<T>(name: string, source: StoreName, unique: boolean, keys: (doc: T) => readonly string[], conflictCode?: ErrorCode): IndexDefinition<T> {
  return { name, source, unique, indexKeys: keys, ...(conflictCode ? { conflictCode } : {}) };
}

export function createCoreRepositories(engine: StorageEngine, clock: Clock = systemClock): CoreRepositories {
  const registry = new SchemaRegistry();
  const bootstrapRecords = new BaseRepository<BootstrapRecordDocument>({
    store: 'bootstrap_records', type: 'bootstrap_record', schemaVersion: 1, schema: bootstrapRecordSchema, clock,
    indexes: [],
  }, registry, engine);
  const users = new BaseRepository<UserDocument>({
    store: 'users', type: 'user', schemaVersion: 1, schema: userSchema, clock,
    indexes: [index<UserDocument>('idx_users_email', 'users', true, (doc) => [doc.email], 'USER_EMAIL_TAKEN')],
    defaultIndexName: 'idx_users_email',
  }, registry, engine);
  const roles = new BaseRepository<RoleDocument>({
    store: 'roles', type: 'role', schemaVersion: 1, schema: roleSchema, clock,
    indexes: [index<RoleDocument>('idx_roles_code', 'roles', true, (doc) => [doc.code])],
    defaultIndexName: 'idx_roles_code',
  }, registry, engine);
  const permissions = new BaseRepository<PermissionDocument>({
    store: 'permissions', type: 'permission', schemaVersion: 1, schema: permissionSchema, clock,
    indexes: [index<PermissionDocument>('idx_permissions_code', 'permissions', true, (doc) => [doc.code])],
    defaultIndexName: 'idx_permissions_code',
  }, registry, engine);
  const sessions = new BaseRepository<SessionDocument>({
    store: 'sessions', type: 'session', schemaVersion: 1, schema: sessionSchema, clock,
    indexes: [index<SessionDocument>('idx_sessions_token_hash', 'sessions', true, (doc) => [doc.tokenHash])],
  }, registry, engine);
  const organizations = new BaseRepository<OrganizationDocument>({
    store: 'org_profile', type: 'org_profile', schemaVersion: 1, schema: organizationSchema, clock,
    indexes: [],
  }, registry, engine);
  const loginRecords = new BaseRepository<LoginRecordDocument>({
    store: 'login_records', type: 'login_record', schemaVersion: 1, schema: loginRecordSchema, clock,
    indexes: [],
  }, registry, engine);
  const auditLogs = new BaseRepository<AuditLogDocument>({
    store: 'audit_logs', type: 'audit_log', schemaVersion: 1, schema: auditLogSchema, clock,
    indexes: [],
  }, registry, engine);
  const files = new BaseRepository<FileDocument>({
    store: 'files', type: 'file', schemaVersion: 1, schema: fileSchema, clock,
    indexes: [index<FileDocument>('idx_files_storage_key', 'files', true, (doc) => [doc.storageKey])],
  }, registry, engine);
  return { bootstrapRecords, users, roles, permissions, sessions, organizations, loginRecords, auditLogs, files, registry };
}

export async function seedCoreData(repos: CoreRepositories): Promise<void> {
  for (const permission of PERMISSION_CATALOG) {
    if (!(await repos.permissions.getByUniqueIndex('idx_permissions_code', permission.code))) {
      await repos.permissions.create({
        code: permission.code,
        module: permission.module,
        name: permission.name,
      } as Omit<PermissionDocument, keyof import('../../storage/envelope.js').DocumentEnvelope>);
    }
  }
  for (const seed of SYSTEM_ROLE_SEEDS) {
    if (!(await repos.roles.getByUniqueIndex('idx_roles_code', seed.code))) {
      await repos.roles.create({
        code: seed.code,
        name: seed.name,
        description: seed.description,
        dataScope: seed.dataScope,
        permissionCodes: [...seed.permissionCodes],
        system: true,
      } as Omit<RoleDocument, keyof import('../../storage/envelope.js').DocumentEnvelope>);
    }
  }
  const orgs = await repos.organizations.list({ page: 1, pageSize: 1 });
  if (orgs.total === 0) {
    await repos.organizations.create({ name: '我的组织', timezone: 'Asia/Shanghai' } as Omit<OrganizationDocument, keyof import('../../storage/envelope.js').DocumentEnvelope>);
  }
}

export function publicUser(user: UserDocument): { id: string; name: string; email: string; status: UserDocument['status']; mustChangePassword: boolean; lastLoginAt: string | null; passwordChangedAt: string | null } {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    passwordChangedAt: user.passwordChangedAt,
  };
}

export interface AuditHashPayload {
  readonly seq: number;
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly result: 'success' | 'failure';
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly metadata: Record<string, string | number | boolean | null>;
  readonly createdAt: string;
  readonly prevHash: string | null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(object)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function auditHash(input: AuditHashPayload): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(input))).digest('hex');
}
