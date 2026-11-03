/**
 * 前后端共享 API 契约（Zod schema + 类型）。
 * 来源：docs/03-technical/api-design.md §3/§8；M0 仅含已实现端点。
 */
import { z } from 'zod';
import { DATA_SCOPES } from './permissions.js';

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const pageMetaSchema = z
  .object({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
  })
  .strict();
export type PageMeta = z.infer<typeof pageMetaSchema>;

// Keep email-shaped identifiers readable for existing data; new accounts use
// internal identifiers. The wire/storage field is retained for compatibility.
export const internalAccountSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/u, '内部账号须为 3–64 位字母、数字、点、下划线或连字符');
export const loginIdentifierSchema = z.union([
  internalAccountSchema,
  z.string().trim().toLowerCase().email().max(254),
]);

export const loginRequestSchema = z
  .object({
    email: loginIdentifierSchema,
    password: z.string().min(1).max(128),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

const COMMON_WEAK_PASSWORDS = new Set([
  'password1234',
  'password12345',
  'qwerty123456',
  'qwertyuiop12',
  '123456789012',
  '1234567890123',
  'admin12345678',
  'letmein123456',
  'welcome12345',
  'iloveyou1234',
]);

export function isAcceptablePassword(password: string): boolean {
  const normalized = password.toLowerCase().replace(/[^a-z0-9]/gu, '');
  if (COMMON_WEAK_PASSWORDS.has(normalized)) return false;
  if (/^(.)\1{11,}$/u.test(normalized)) return false;
  if (/^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/u.test(normalized)) return false;
  return true;
}

export const initialPasswordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine(isAcceptablePassword, '密码过于常见，请更换为不易猜测的密码');
export const setupAdminRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: internalAccountSchema,
    password: initialPasswordSchema,
  })
  .strict();
export type SetupAdminRequest = z.infer<typeof setupAdminRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z
      .string()
      .min(12)
      .max(128)
      .refine(isAcceptablePassword, '新密码过于常见，请更换为不易猜测的密码'),
  })
  .strict();
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const roleCreateRequestSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    name: z.string().trim().min(2).max(30),
    description: z.string().max(300).default(''),
    dataScope: z.enum(DATA_SCOPES),
    permissionCodes: z
      .array(z.string().min(1))
      .max(200)
      .refine((codes) => new Set(codes).size === codes.length, '权限码不可重复'),
  })
  .strict();
export type RoleCreateRequest = z.infer<typeof roleCreateRequestSchema>;

export const roleUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(30).optional(),
    description: z.string().max(300).optional(),
    dataScope: z.enum(DATA_SCOPES).optional(),
    permissionCodes: z
      .array(z.string().min(1))
      .max(200)
      .refine((codes) => new Set(codes).size === codes.length, '权限码不可重复')
      .optional(),
    version: z.number().int().min(1),
  })
  .strict()
  .refine(
    (request) =>
      request.name !== undefined ||
      request.description !== undefined ||
      request.dataScope !== undefined ||
      request.permissionCodes !== undefined,
    '至少提供一个角色修改字段',
  );
export type RoleUpdateRequest = z.infer<typeof roleUpdateRequestSchema>;

export const roleDeleteRequestSchema = z.object({ version: z.number().int().min(1) }).strict();
export type RoleDeleteRequest = z.infer<typeof roleDeleteRequestSchema>;

export const replaceUserRolesRequestSchema = z
  .object({
    roleIds: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, '角色不可重复'),
    version: z.number().int().min(1),
  })
  .strict();
export type ReplaceUserRolesRequest = z.infer<typeof replaceUserRolesRequestSchema>;

export const disableUserRequestSchema = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type DisableUserRequest = z.infer<typeof disableUserRequestSchema>;

export const accountLifecycleRequestSchema = z.object({ version: z.number().int().positive() }).strict();
export type AccountLifecycleRequest = z.infer<typeof accountLifecycleRequestSchema>;

export const createUserRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: internalAccountSchema,
    password: initialPasswordSchema.optional(),
    roleCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,63}$/)
      .default('member'),
  })
  .strict();
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const userInfoSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    email: loginIdentifierSchema,
    status: z.enum(USER_STATUSES),
    mustChangePassword: z.boolean(),
    lastLoginAt: z.string().nullable(),
    passwordChangedAt: z.string().nullable(),
  })
  .strict();
export type UserInfo = z.infer<typeof userInfoSchema>;

export const organizationInfoSchema = z
  .object({
    name: z.string().min(1),
    timezone: z.string().min(1),
  })
  .strict();
export type OrganizationInfo = z.infer<typeof organizationInfoSchema>;

export const meResponseSchema = z
  .object({
    user: userInfoSchema,
    organization: organizationInfoSchema.nullable(),
    roles: z.array(z.string().min(1)),
    permissions: z.array(z.string().min(1)),
    csrfToken: z.string().min(1),
  })
  .strict();
export type MeResponse = z.infer<typeof meResponseSchema>;

export const moduleStatusSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(['available', 'planned']),
    milestone: z.string().min(1).optional(),
  })
  .strict();
export type ModuleStatus = z.infer<typeof moduleStatusSchema>;

export const workbenchResponseSchema = z
  .object({
    user: userInfoSchema,
    organization: organizationInfoSchema.nullable(),
    security: z
      .object({
        activeSessions: z.number().int().nonnegative(),
        lastLoginAt: z.string().nullable(),
        passwordChangedAt: z.string().nullable(),
      })
      .strict(),
    modules: z.array(moduleStatusSchema),
  })
  .strict();
export type WorkbenchResponse = z.infer<typeof workbenchResponseSchema>;

export const workbenchTaskSchema = z.object({
  id: z.string(), version: z.number().int(), taskKey: z.string(), title: z.string(),
  projectId: z.string(), projectName: z.string(), status: z.string(), priority: z.string(),
  dueDate: z.string().nullable(), overdue: z.boolean(), canComplete: z.boolean(),
});
export const workbenchActivitySchema = z.object({
  generatedAt: z.string(), timezone: z.string(),
  metrics: z.object({ openTasks: z.number(), overdueTasks: z.number(), dueThisWeek: z.number(), completedThisWeek: z.number(), pendingApprovals: z.number(), unreadNotifications: z.number() }),
  tasks: z.array(workbenchTaskSchema),
  approvals: z.array(z.object({ id: z.string(), title: z.string(), applicationType: z.string(), applicantName: z.string(), submittedAt: z.string().nullable(), step: z.string() })),
  projects: z.array(z.object({ id: z.string(), name: z.string(), key: z.string(), status: z.string(), role: z.string(), openTasks: z.number() })),
});
export type WorkbenchActivity = z.infer<typeof workbenchActivitySchema>;
export type WorkbenchTask = z.infer<typeof workbenchTaskSchema>;
export const notificationViewSchema = z.object({
  id: z.string(), version: z.number().int(), title: z.string(), content: z.string(),
  linkPath: z.string().nullable(), available: z.boolean(), readAt: z.string().nullable(), createdAt: z.string(),
});
export type NotificationView = z.infer<typeof notificationViewSchema>;

const projectDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, '日期无效');
export const projectCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
    description: z.string().max(10000).optional(),
    visibility: z.enum(['private', 'organization']),
    startDate: projectDateSchema.nullable().optional(),
    dueDate: projectDateSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => !value.startDate || !value.dueDate || value.startDate <= value.dueDate,
    '截止日期不能早于开始日期',
  );
export const projectTransitionSchema = z
  .object({
    targetStatus: z.enum(['active', 'on_hold', 'completed', 'cancelled', 'archived']),
    version: z.number().int().positive(),
    reason: z.string().trim().min(2).max(500).optional(),
  })
  .strict();
export const taskCreateSchema = z
  .object({
    title: z.string().trim().min(2).max(120),
    description: z.string().max(10000).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assigneeId: z.string().min(1).nullable().optional(),
    startDate: projectDateSchema.nullable().optional(),
    dueDate: projectDateSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => !value.startDate || !value.dueDate || value.startDate <= value.dueDate,
    '截止日期不能早于开始日期',
  );
export const taskUpdateSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(2).max(120).optional(),
    description: z.string().max(10000).optional(),
    status: z.enum(['todo', 'in_progress', 'in_review', 'done', 'cancelled']).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assigneeId: z.string().min(1).nullable().optional(),
    startDate: projectDateSchema.nullable().optional(),
    dueDate: projectDateSchema.nullable().optional(),
  })
  .strict();
export const projectMemberCreateSchema = z
  .object({ userId: z.string().min(1), role: z.enum(['manager', 'member', 'viewer']) })
  .strict();
export const projectTransferOwnerSchema = z
  .object({ userId: z.string().min(1), version: z.number().int().positive() })
  .strict();
export const projectMemberDeleteSchema = z
  .object({ version: z.number().int().positive() })
  .strict();

const departmentTextSchema = z.string().trim().refine((value) => [...value].every((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code >= 32 && code !== 127;
}), '不允许控制字符');

export const departmentCreateSchema = z.object({
  parentId: z.string().min(1).max(64).nullable(),
  name: departmentTextSchema.pipe(z.string().min(1).max(80)),
  code: departmentTextSchema.pipe(z.string().min(1).max(64)).nullable(),
  managerId: z.string().min(1).max(64).nullable(),
  description: departmentTextSchema.pipe(z.string().max(300)),
  sortOrder: z.number().int().min(0).max(1000000),
}).strict();
export type DepartmentCreateRequest = z.infer<typeof departmentCreateSchema>;

export const departmentUpdateSchema = departmentCreateSchema.extend({ version: z.number().int().positive() }).strict();
export type DepartmentUpdateRequest = z.infer<typeof departmentUpdateSchema>;

export const projectUpdateSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().max(10000).optional(),
  visibility: z.enum(['private', 'organization']).optional(),
  startDate: projectDateSchema.nullable().optional(),
  dueDate: projectDateSchema.nullable().optional(),
}).strict();
export const projectMemberUpdateSchema = z.object({
  role: z.enum(['manager', 'member', 'viewer']),
  version: z.number().int().positive(),
}).strict();

const commentContentSchema = z.string().trim().min(1).max(2000).refine((value) => !/<\s*\/?\s*[a-z!][^>]*>/i.test(value), '评论不能包含原始 HTML');
export const taskCommentCreateSchema = z.object({ content: commentContentSchema }).strict();
export const taskCommentUpdateSchema = z.object({ version: z.number().int().positive(), content: commentContentSchema }).strict();
export const taskCommentDeleteSchema = z.object({ version: z.number().int().positive(), reason: z.string().trim().min(2).max(500).optional() }).strict();
export const taskBoardMoveSchema = z.object({ version: z.number().int().positive(), targetStatus: z.enum(['todo','in_progress','in_review','done']), targetIndex: z.number().int().min(0).max(100000), progress: z.number().int().min(0).max(100).optional(), beforeTaskId:z.string().min(1).optional(), afterTaskId:z.string().min(1).optional() }).strict().refine((value)=>!(value.beforeTaskId && value.afterTaskId),'只能指定一个相邻任务');

const approvalText = z.string().trim().refine((value) => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}, '不允许控制字符');
const approvalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, '日期无效');
const approvalDateTime = z.string().datetime({ offset: true });

export const approvalFormSchemas = {
  leave: z.object({
    leaveType: z.enum(['annual', 'sick', 'personal', 'compensatory', 'marriage', 'maternity', 'paternity', 'bereavement']),
    durationDays: z.number().positive().max(365).multipleOf(0.5),
    reason: approvalText.pipe(z.string().min(10).max(500)),
    handoverUserId: z.string().min(1).nullable().optional(),
  }).strict(),
  travel: z.object({
    destination: approvalText.pipe(z.string().min(2).max(100)),
    purpose: approvalText.pipe(z.string().min(10).max(500)),
    transport: z.enum(['plane', 'train', 'car', 'other']),
    estimatedCost: z.number().min(0).max(1_000_000).multipleOf(0.01).optional(),
  }).strict(),
  field: z.object({
    location: approvalText.pipe(z.string().min(2).max(100)),
    purpose: approvalText.pipe(z.string().min(10).max(500)),
  }).strict(),
  seal: z.object({
    documentName: approvalText.pipe(z.string().min(2).max(100)),
    sealType: z.enum(['company', 'contract', 'finance', 'other']),
    copies: z.number().int().min(1).max(100),
    purpose: approvalText.pipe(z.string().min(10).max(500)),
    expectedDate: approvalDate,
    recipient: approvalText.pipe(z.string().min(2).max(50)),
  }).strict(),
  general: z.object({
    subject: approvalText.pipe(z.string().min(2).max(100)),
    content: approvalText.pipe(z.string().min(10).max(2000)),
    expectedDate: approvalDate.optional(),
  }).strict(),
} as const;

export const applicationDraftRequestSchema = z.object({
  applicationType: z.enum(['leave', 'travel', 'field', 'seal', 'general']),
  title: approvalText.pipe(z.string().min(2).max(100)),
  formData: z.record(z.unknown()),
  startAt: approvalDateTime.nullable(),
  endAt: approvalDateTime.nullable(),
  projectId: z.string().min(1).nullable(),
}).strict();
export type ApplicationDraftRequest = z.infer<typeof applicationDraftRequestSchema>;

export const applicationUpdateRequestSchema = applicationDraftRequestSchema.extend({ version: z.number().int().positive() }).strict();
export const applicationVersionRequestSchema = z.object({ version: z.number().int().positive() }).strict();
export const applicationWithdrawRequestSchema = z.object({ reason: approvalText.pipe(z.string().max(500)) }).strict();
export const approvalDecisionRequestSchema = z.object({ comment: approvalText.pipe(z.string().max(500)).default('') }).strict();
export const approvalReassignRequestSchema = z.object({ newApproverId: z.string().min(1), reason: approvalText.pipe(z.string().min(5).max(500)) }).strict();
export const workflowTemplateRequestSchema = z.object({
  name: approvalText.pipe(z.string().min(2).max(50)),
  applicationType: z.enum(['leave', 'travel', 'field', 'seal', 'general']),
  steps: z.array(z.object({
    stepNo: z.number().int().min(1).max(10),
    name: approvalText.pipe(z.string().min(1).max(50)),
    approverType: z.enum(['user', 'department_manager', 'direct_manager']),
    userId: z.string().min(1).nullable(),
  }).strict()).min(1).max(10),
}).strict();
export const workflowTemplateVersionRequestSchema = z.object({ version: z.number().int().positive() }).strict();
export const approvalListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['draft', 'pending', 'approved', 'rejected', 'withdrawn']).optional(),
  view: z.enum(['mine', 'involved', 'all', 'pending']).default('mine'),
  applicationType: z.enum(['leave', 'travel', 'field', 'seal', 'general']).optional(),
  q: z.string().trim().max(100).optional(),
}).strict();
export const approvalPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export * from './documents-contracts.js';
