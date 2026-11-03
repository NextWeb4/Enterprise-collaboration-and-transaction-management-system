/**
 * 权限目录与内置角色种子（唯一来源：docs/02-business/permission-model.md §3-4）。
 * 权限码是稳定契约：改名视为破坏性变更。测试必须校验"代码常量集合 == seed 集合"。
 */

export const DATA_SCOPES = ['self', 'department', 'department_tree', 'all'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

export interface PermissionDef {
  readonly code: string;
  readonly module: string;
  readonly name: string;
}

export const PERMISSION_CATALOG: readonly PermissionDef[] = [
  { code: 'workbench:read', module: 'workbench', name: '查看工作台' },
  { code: 'project:create', module: 'project', name: '创建项目' },
  { code: 'project:read', module: 'project', name: '读取项目' },
  { code: 'project:read:all', module: 'project', name: '读取全部项目' },
  { code: 'project:update', module: 'project', name: '编辑项目' },
  { code: 'project:archive', module: 'project', name: '归档/取消项目' },
  { code: 'project:delete', module: 'project', name: '软删除项目' },
  { code: 'project:member:manage', module: 'project', name: '管理项目成员' },
  { code: 'project:owner:transfer', module: 'project', name: '转让项目负责人' },
  { code: 'task:create', module: 'task', name: '创建任务' },
  { code: 'task:read', module: 'task', name: '读取任务' },
  { code: 'task:update', module: 'task', name: '更新任务' },
  { code: 'task:assign', module: 'task', name: '分配/改期任务' },
  { code: 'task:delete', module: 'task', name: '删除任务' },
  { code: 'task:comment', module: 'task', name: '任务评论' },
  { code: 'task:comment:moderate', module: 'task', name: '删除他人评论' },
  { code: 'application:create', module: 'workflow', name: '发起申请' },
  { code: 'application:read:self', module: 'workflow', name: '查看自己的申请' },
  { code: 'application:read:all', module: 'workflow', name: '查看全部申请' },
  { code: 'application:submit', module: 'workflow', name: '提交申请' },
  { code: 'application:withdraw', module: 'workflow', name: '撤回申请' },
  { code: 'application:approve', module: 'workflow', name: '审批申请' },
  { code: 'workflow:template:manage', module: 'workflow', name: '管理审批模板' },
  { code: 'workflow:reassign', module: 'workflow', name: '转交审批' },
  { code: 'organization:directory:read', module: 'organization', name: '查看通讯录' },
  { code: 'department:read', module: 'organization', name: '查看部门' },
  { code: 'department:manage', module: 'organization', name: '管理部门' },
  { code: 'position:read', module: 'organization', name: '查看岗位' },
  { code: 'position:manage', module: 'organization', name: '管理岗位' },
  { code: 'employee:read', module: 'organization', name: '查看员工档案' },
  { code: 'employee:manage', module: 'organization', name: '维护员工档案' },
  { code: 'user:manage', module: 'system', name: '管理用户账号' },
  { code: 'role:manage', module: 'system', name: '管理角色与权限分配' },
  { code: 'permission:read', module: 'system', name: '查看权限目录' },
  { code: 'session:manage', module: 'system', name: '管理会话' },
  { code: 'login:read', module: 'system', name: '查看登录记录' },
  { code: 'audit:read', module: 'system', name: '查看操作日志' },
  { code: 'setting:manage', module: 'system', name: '管理系统配置' },
  { code: 'analytics:read:project', module: 'analytics', name: '查看授权项目分析' },
  { code: 'analytics:read:all', module: 'analytics', name: '查看全量经营分析' },
  { code: 'document:read', module: 'document', name: '读取文档' },
  { code: 'document:read:all', module: 'document', name: '读取全部文档' },
  { code: 'document:create', module: 'document', name: '上传文档' },
  { code: 'document:update', module: 'document', name: '编辑文档元数据' },
  { code: 'document:delete', module: 'document', name: '软删除文档' },
  { code: 'document:version:create', module: 'document', name: '上传文档新版本' },
  { code: 'document:acl:manage', module: 'document', name: '管理文档 ACL' },
  { code: 'document:category:manage', module: 'document', name: '管理文档分类' },
  { code: 'document:tag:manage', module: 'document', name: '管理文档标签' },
  { code: 'document:manage:all', module: 'document', name: '管理全部文档' },
  { code: 'calendar:read', module: 'calendar', name: '读取日历与日程' },
  { code: 'calendar:create', module: 'calendar', name: '创建日程' },
  { code: 'calendar:update', module: 'calendar', name: '修改日程' },
  { code: 'calendar:delete', module: 'calendar', name: '删除日程' },
  { code: 'calendar:invite', module: 'calendar', name: '邀请会议参与人' },
  { code: 'calendar:respond', module: 'calendar', name: '响应会议邀请' },
];

export const PERMISSION_CODES: readonly string[] = PERMISSION_CATALOG.map((p) => p.code);

export function isPermissionCode(code: string): boolean {
  return PERMISSION_CODES.includes(code);
}

export const SYSTEM_ROLE_CODES = ['member', 'org_admin', 'system_admin', 'auditor'] as const;
export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

export interface SystemRoleSeed {
  readonly code: SystemRoleCode;
  readonly name: string;
  readonly description: string;
  readonly dataScope: DataScope;
  readonly permissionCodes: readonly string[];
}

const MEMBER_PERMISSIONS: readonly string[] = [
  'workbench:read',
  'project:create',
  'project:read',
  'project:update',
  'project:archive',
  'project:member:manage',
  'project:owner:transfer',
  'task:create',
  'task:read',
  'task:update',
  'task:assign',
  'task:delete',
  'task:comment',
  'task:comment:moderate',
  'application:create',
  'application:read:self',
  'application:submit',
  'application:withdraw',
  'application:approve',
  'organization:directory:read',
  'department:read',
  'position:read',
  'document:read',
  'document:create',
  'document:update',
  'document:delete',
  'document:version:create',
  'document:acl:manage',
  'calendar:read',
  'calendar:create',
  'calendar:update',
  'calendar:delete',
  'calendar:invite',
  'calendar:respond',
];

const SYSTEM_ADMIN_PERMISSIONS: readonly string[] = [
  'user:manage',
  'session:manage',
  'login:read',
  'audit:read',
  'setting:manage',
  'permission:read',
];

const AUDITOR_PERMISSIONS: readonly string[] = ['login:read', 'audit:read', 'permission:read'];

export const SYSTEM_ROLE_SEEDS: readonly SystemRoleSeed[] = [
  {
    code: 'member',
    name: '普通成员',
    description: '默认角色：做任务、提申请、参与项目',
    dataScope: 'self',
    permissionCodes: MEMBER_PERMISSIONS,
  },
  {
    code: 'org_admin',
    name: '组织管理员',
    description: '组织/系统全量管理权限',
    dataScope: 'all',
    permissionCodes: PERMISSION_CODES,
  },
  {
    code: 'system_admin',
    name: '系统管理员',
    description: '账号、会话、配置与日志；默认不读业务正文',
    dataScope: 'all',
    permissionCodes: SYSTEM_ADMIN_PERMISSIONS,
  },
  {
    code: 'auditor',
    name: '审计员',
    description: '只读审计与登录记录',
    dataScope: 'all',
    permissionCodes: AUDITOR_PERMISSIONS,
  },
];
