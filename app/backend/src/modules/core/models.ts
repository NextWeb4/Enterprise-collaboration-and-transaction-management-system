import { z } from 'zod';
import { loginIdentifierSchema } from '@collab/shared/schemas.js';
import type { DocumentEnvelope } from '../../storage/envelope.js';

export interface BootstrapRecordDocument extends DocumentEnvelope {
  type: 'bootstrap_record';
  message: string;
  source: 'bootstrap';
}


export interface UserDocument extends DocumentEnvelope {
  type: 'user';
  name: string;
  email: string;
  passwordHash: string;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  failedLoginCount: number;
  lockedUntil: string | null;
  roleIds: string[];
  departmentId: string | null;
  managerId?: string | null;
}

export interface RoleDocument extends DocumentEnvelope {
  type: 'role';
  code: string;
  name: string;
  description: string;
  dataScope: 'self' | 'department' | 'department_tree' | 'all';
  permissionCodes: string[];
  system: boolean;
}

export interface PermissionDocument extends DocumentEnvelope {
  type: 'permission';
  code: string;
  module: string;
  name: string;
}

export interface SessionDocument extends DocumentEnvelope {
  type: 'session';
  userId: string;
  tokenHash: string;
  csrfToken: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface OrganizationDocument extends DocumentEnvelope {
  type: 'org_profile';
  name: string;
  timezone: string;
}

export interface LoginRecordDocument extends DocumentEnvelope {
  type: 'login_record';
  userId: string | null;
  email: string;
  success: boolean;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditLogDocument extends DocumentEnvelope {
  type: 'audit_log';
  /** Optional only for legacy rows created before the sequenced hash-chain format. */
  seq?: number;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  result?: 'success' | 'failure';
  ip?: string | null;
  userAgent?: string | null;
  requestId: string | null;
  metadata: Record<string, string | number | boolean | null>;
  previousHash: string | null;
  hash: string;
}

export interface FileDocument extends DocumentEnvelope {
  type: 'file';
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  storageKey: string;
  refCount: number;
  uploadedBy: string;
  status: 'active' | 'deleted';
}

const envelope = z.object({
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  schemaVersion: z.number().int().min(1).max(1),
  version: z.number().int().min(1),
  createdAt: z.string().datetime({ offset: false }),
  updatedAt: z.string().datetime({ offset: false }),
  deletedAt: z.string().datetime({ offset: false }).nullable(),
});

export const bootstrapRecordSchema = envelope
  .extend({
    type: z.literal('bootstrap_record'),
    message: z.string().min(1).max(200),
    source: z.literal('bootstrap'),
  })
  .strict();

export const userSchema = envelope
  .extend({
    type: z.literal('user'),
    name: z.string().min(1).max(120),
    email: loginIdentifierSchema,
    passwordHash: z.string().min(20),
    status: z.enum(['active', 'disabled']),
    mustChangePassword: z.boolean(),
    lastLoginAt: z.string().datetime({ offset: false }).nullable(),
    passwordChangedAt: z.string().datetime({ offset: false }).nullable(),
    failedLoginCount: z.number().int().min(0),
    lockedUntil: z.string().datetime({ offset: false }).nullable(),
    roleIds: z.array(z.string().min(1)).max(20),
    departmentId: z.string().min(1).nullable(),
    managerId: z.string().min(1).nullable().optional(),
  })
  .strict();

export const roleSchema = envelope
  .extend({
    type: z.literal('role'),
    code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    name: z.string().min(2).max(30),
    description: z.string().max(300),
    dataScope: z.enum(['self', 'department', 'department_tree', 'all']),
    permissionCodes: z.array(z.string().min(1)).max(200),
    system: z.boolean(),
  })
  .strict();

export const permissionSchema = envelope
  .extend({
    type: z.literal('permission'),
    code: z.string().min(1).max(120),
    module: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
  })
  .strict();

export const sessionSchema = envelope
  .extend({
    type: z.literal('session'),
    userId: z.string().min(1),
    tokenHash: z.string().length(64),
    csrfToken: z.string().min(32),
    idleExpiresAt: z.string().datetime({ offset: false }),
    absoluteExpiresAt: z.string().datetime({ offset: false }),
    lastSeenAt: z.string().datetime({ offset: false }),
    revokedAt: z.string().datetime({ offset: false }).nullable(),
  })
  .strict();

export const organizationSchema = envelope
  .extend({
    type: z.literal('org_profile'),
    name: z.string().min(1).max(200),
    timezone: z.string().min(1).max(80),
  })
  .strict();

export const loginRecordSchema = envelope
  .extend({
    type: z.literal('login_record'),
    userId: z.string().nullable(),
    email: loginIdentifierSchema,
    success: z.boolean(),
    reason: z.string().max(120).nullable(),
    ip: z.string().max(128).nullable(),
    userAgent: z.string().max(512).nullable(),
  })
  .strict();

export const auditLogSchema = envelope
  .extend({
    type: z.literal('audit_log'),
    seq: z.number().int().positive().safe().optional(),
    actorUserId: z.string().nullable(),
    action: z.string().min(1).max(120),
    resourceType: z.string().min(1).max(80),
    resourceId: z.string().max(128).nullable(),
    result: z.enum(['success', 'failure']).optional(),
    ip: z.string().max(128).nullable().optional(),
    userAgent: z.string().max(512).nullable().optional(),
    requestId: z.string().max(128).nullable(),
    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    previousHash: z.string().length(64).nullable(),
    hash: z.string().length(64),
  })
  .strict();

export const fileSchema = envelope
  .extend({
    type: z.literal('file'),
    originalName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(200),
    size: z.number().int().nonnegative(),
    sha256: z.string().length(64),
    storageKey: z.string().regex(/^[a-f0-9]{2}\/[a-f0-9]{64}$/),
    refCount: z.number().int().min(0),
    uploadedBy: z.string().min(1),
    status: z.enum(['active', 'deleted']),
  })
  .strict();
