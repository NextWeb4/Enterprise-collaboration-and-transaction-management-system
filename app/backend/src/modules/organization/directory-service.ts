import { AppError } from '../../shared/errors.js';
import { systemClock, type Clock } from '../../shared/clock.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { Repository } from '../../storage/repository.js';
import type { DocumentEnvelope } from '../../storage/envelope.js';
import type { CoreRepositories } from '../core/repositories.js';
import type { AuthContext } from '../core/auth-service.js';
import { permissionScopes } from '../core/auth-service.js';
import type { AuditInput, AuditService } from '../core/audit-service.js';
import type { DepartmentDocument } from './models.js';
import type { EmployeeDocument, EmployeeInput, PositionDocument, PositionInput } from './directory-models.js';
import { employeeFieldsSchema, positionFieldsSchema } from './directory-models.js';

export interface DirectoryEntry {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly status: 'active' | 'disabled';
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly positionId: string | null;
  readonly positionName: string | null;
}

export interface ActiveUserOption {
  readonly userId: string;
  readonly name: string;
}

export interface EmployeeView extends DirectoryEntry {
  readonly version: number;
  readonly employeeNo: string | null;
  readonly phone: string | null;
  readonly managerId: string | null;
  readonly hireDate: string | null;
  readonly avatarFileId: string | null;
}

export interface DepartmentTreeNode {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  readonly parentId: string | null;
  readonly sortOrder: number;
  readonly employeeCount: number;
  readonly children: readonly DepartmentTreeNode[];
}

export type DirectoryAuditContext = Pick<AuditInput, 'ip' | 'userAgent' | 'requestId'>;

export class OrganizationDirectoryService {
  constructor(
    private readonly employees: Repository<EmployeeDocument>,
    private readonly positions: Repository<PositionDocument>,
    private readonly departments: Repository<DepartmentDocument>,
    private readonly core: CoreRepositories,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly clock: Clock = systemClock,
  ) {}

  async directory(actor: AuthContext): Promise<DirectoryEntry[]> {
    return this.uow.run(async (tx) => {
      const current = await this.loadActor(actor, tx);
      const allowed = await this.allowedUserIds(current, 'organization:directory:read', tx);
      return this.entries(tx, allowed);
    });
  }

  /** Minimal active-user selector for approval handoff/template configuration. */
  async activeUsers(actor: AuthContext): Promise<ActiveUserOption[]> {
    return this.uow.run(async (tx) => {
      const current = await this.loadActor(actor, tx);
      if (!current.permissions.includes('organization:directory:read') && !current.permissions.includes('employee:read')) {
        throw new AppError('FORBIDDEN', '没有查看在职用户的权限');
      }
      const users = await this.allUsers(tx);
      return users
        .filter((user) => user.deletedAt === null && user.status === 'active')
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
        .map((user) => ({ userId: user.id, name: user.name }));
    });
  }

  async listEmployees(actor: AuthContext): Promise<EmployeeView[]> {
    return this.uow.run(async (tx) => {
      const current = await this.loadActor(actor, tx);
      const allowed = await this.allowedUserIds(current, 'employee:read', tx);
      return this.employeeViews(tx, allowed, current);
    });
  }

  async getEmployee(actor: AuthContext, id: string): Promise<EmployeeView> {
    return this.uow.run(async (tx) => {
      const current = await this.loadActor(actor, tx);
      const employee = await this.employees.get(id, tx);
      if (!employee || employee.deletedAt !== null) throw new AppError('NOT_FOUND', '员工档案不存在');
      const allowed = await this.allowedUserIds(current, 'employee:read', tx);
      if (!allowed.has(employee.userId)) throw new AppError('NOT_FOUND', '员工档案不存在');
      const views = await this.employeeViews(tx, new Set([employee.userId]), current);
      const view = views.find((item) => item.id === id);
      if (!view) throw new AppError('NOT_FOUND', '员工档案不存在');
      return view;
    });
  }

  async createEmployee(actor: AuthContext, input: EmployeeInput, context: DirectoryAuditContext = {}): Promise<EmployeeView> {
    const fields = this.parseEmployee(input);
    return this.uow.run(async (tx) => {
      const current = await this.requireManager(actor, tx);
      await this.validateEmployeeFields(fields, null, tx);
      const created = await this.employees.create(this.profileFields(fields), tx);
      await this.syncUserManager(fields.userId, fields.managerId, tx);
      await this.audit.append({ actorUserId: current.user.id, action: 'employee.created', resourceType: 'employee', resourceId: created.id, ...context }, tx);
      const views = await this.employeeViews(tx, new Set([created.userId]), current);
      const view = views[0];
      if (!view) throw new AppError('STORAGE_CORRUPTED', '员工档案创建后不可读取');
      return view;
    });
  }

  async updateEmployee(actor: AuthContext, id: string, version: number, input: EmployeeInput, context: DirectoryAuditContext = {}): Promise<EmployeeView> {
    const fields = this.parseEmployee(input);
    return this.uow.run(async (tx) => {
      const current = await this.requireManager(actor, tx);
      const existing = await this.employees.get(id, tx);
      if (!existing || existing.deletedAt !== null) throw new AppError('NOT_FOUND', '员工档案不存在');
      await this.validateEmployeeFields(fields, id, tx);
      const updated = await this.employees.update(id, version, (document) => ({ ...document, ...this.profileFields(fields) }), tx);
      await this.syncUserManager(fields.userId, fields.managerId, tx);
      await this.audit.append({ actorUserId: current.user.id, action: 'employee.updated', resourceType: 'employee', resourceId: id, ...context }, tx);
      const views = await this.employeeViews(tx, new Set([updated.userId]), current);
      const view = views[0];
      if (!view) throw new AppError('STORAGE_CORRUPTED', '员工档案更新后不可读取');
      return view;
    });
  }

  async listPositions(actor: AuthContext): Promise<PositionDocument[]> {
    return this.uow.run(async (tx) => {
      const current = await this.loadActor(actor, tx);
      this.requirePermission(current, 'position:read');
      return this.allPositions(tx);
    });
  }

  async createPosition(actor: AuthContext, input: PositionInput, context: DirectoryAuditContext = {}): Promise<PositionDocument> {
    const fields = this.parsePosition(input);
    return this.uow.run(async (tx) => {
      const current = await this.requireManager(actor, tx);
      await this.assertPositionHistoryUnique(fields.name, fields.code, null, tx);
      const position = await this.positions.create(fields, tx);
      await this.audit.append({ actorUserId: current.user.id, action: 'position.created', resourceType: 'position', resourceId: position.id, ...context }, tx);
      return position;
    });
  }

  async updatePosition(actor: AuthContext, id: string, version: number, input: PositionInput, context: DirectoryAuditContext = {}): Promise<PositionDocument> {
    const fields = this.parsePosition(input);
    return this.uow.run(async (tx) => {
      const current = await this.requireManager(actor, tx);
      const existing = await this.positions.get(id, tx);
      if (!existing || existing.deletedAt !== null) throw new AppError('NOT_FOUND', '岗位不存在');
      await this.assertPositionHistoryUnique(fields.name, fields.code, id, tx);
      const updated = await this.positions.update(id, version, (document) => ({ ...document, ...fields }), tx);
      await this.audit.append({ actorUserId: current.user.id, action: 'position.updated', resourceType: 'position', resourceId: id, ...context }, tx);
      return updated;
    });
  }

  async deletePosition(actor: AuthContext, id: string, version: number, context: DirectoryAuditContext = {}): Promise<void> {
    await this.uow.run(async (tx) => {
      const current = await this.requireManager(actor, tx);
      const position = await this.positions.get(id, tx);
      if (!position || position.deletedAt !== null) throw new AppError('NOT_FOUND', '岗位不存在');
      const employees = await this.allEmployees(tx);
      if (employees.some((employee) => employee.positionId === id)) throw new AppError('VERSION_CONFLICT', '岗位仍被员工档案引用，不能删除');
      await this.positions.softDelete(id, version, tx);
      await this.audit.append({ actorUserId: current.user.id, action: 'position.deleted', resourceType: 'position', resourceId: id, ...context }, tx);
    });
  }

  async departmentTree(actor: AuthContext): Promise<DepartmentTreeNode[]> {
    return this.uow.run(async (tx) => {
      const current = await this.loadActor(actor, tx);
      const allowed = await this.allowedUserIds(current, 'organization:directory:read', tx);
      const departments = await this.allDepartments(tx);
      const employees = (await this.allEmployees(tx)).filter((employee) => allowed.has(employee.userId));
      const counts = new Map<string, number>();
      for (const employee of employees) if (employee.departmentId !== null) counts.set(employee.departmentId, (counts.get(employee.departmentId) ?? 0) + 1);
      const children = new Map<string | null, DepartmentDocument[]>();
      for (const department of departments) {
        const bucket = children.get(department.parentId) ?? [];
        bucket.push(department); children.set(department.parentId, bucket);
      }
      const build = (parentId: string | null, path: Set<string>): DepartmentTreeNode[] => (children.get(parentId) ?? [])
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .map((department) => {
          if (path.has(department.id)) throw new AppError('STORAGE_CORRUPTED', '部门树存在循环');
          const nextPath = new Set(path); nextPath.add(department.id);
          return { id: department.id, name: department.name, code: department.code, parentId: department.parentId, sortOrder: department.sortOrder, employeeCount: counts.get(department.id) ?? 0, children: build(department.id, nextPath) };
        });
      return build(null, new Set());
    });
  }

  private async requireManager(actor: AuthContext, tx: StorageTransaction): Promise<AuthContext> {
    const current = await this.loadActor(actor, tx);
    this.requirePermission(current, 'employee:manage');
    if (!permissionScopes(current, 'employee:manage').includes('all')) throw new AppError('FORBIDDEN', '当前数据范围不支持维护员工档案');
    return current;
  }

  private requirePermission(actor: AuthContext, permission: string): void {
    if (!actor.permissions.includes(permission)) throw new AppError('FORBIDDEN', '没有执行此操作的权限');
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

  private parseEmployee(input: EmployeeInput): EmployeeInput {
    const parsed = employeeFieldsSchema.safeParse(input);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '员工档案信息无效');
    return parsed.data;
  }

  private parsePosition(input: PositionInput): PositionInput {
    const parsed = positionFieldsSchema.safeParse(input);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '岗位信息无效');
    return parsed.data;
  }

  private async validateEmployeeFields(fields: EmployeeInput, currentId: string | null, tx: StorageTransaction): Promise<void> {
    const user = await this.core.users.get(fields.userId, tx);
    if (!user || user.deletedAt !== null || user.status !== 'active') throw new AppError('NOT_FOUND', '关联用户不存在或已停用');
    const existing = await this.employees.getByUniqueIndex('idx_employees_user', fields.userId, tx);
    if (existing && existing.deletedAt === null && existing.id !== currentId) throw new AppError('VERSION_CONFLICT', '一个用户只能有一份员工档案');
    if (fields.departmentId !== null) {
      const department = await this.departments.get(fields.departmentId, tx);
      if (!department || department.deletedAt !== null) throw new AppError('NOT_FOUND', '关联部门不存在');
    }
    if (fields.positionId !== null) {
      const position = await this.positions.get(fields.positionId, tx);
      if (!position || position.deletedAt !== null || position.status !== 'active') throw new AppError('NOT_FOUND', '关联岗位不存在或已停用');
    }
    if (fields.managerId !== null) {
      const manager = await this.core.users.get(fields.managerId, tx);
      if (!manager || manager.deletedAt !== null || manager.status !== 'active') throw new AppError('NOT_FOUND', '直属上级不存在或已停用');
      if (manager.id === fields.userId) throw new AppError('VALIDATION_FAILED', '直属上级不能是本人');
      await this.assertNoManagerCycle(fields.userId, fields.managerId, tx);
    }
    if (fields.employeeNo !== null) {
      const duplicate = await this.employees.getByUniqueIndex('idx_employees_employee_no', fields.employeeNo, tx);
      if (duplicate && duplicate.deletedAt === null && duplicate.id !== currentId) throw new AppError('VERSION_CONFLICT', '员工编号已存在');
    }
  }

  private async assertNoManagerCycle(userId: string, managerId: string, tx: StorageTransaction): Promise<void> {
    const seen = new Set<string>([userId]);
    let cursor: string | null = managerId;
    while (cursor !== null) {
      if (seen.has(cursor)) throw new AppError('VALIDATION_FAILED', '直属上级关系不能形成循环');
      seen.add(cursor);
      const manager = await this.core.users.get(cursor, tx);
      if (!manager || manager.deletedAt !== null || manager.status !== 'active') return;
      cursor = manager.managerId ?? null;
    }
  }

  private async assertPositionHistoryUnique(name: string, code: string, currentId: string | null, tx: StorageTransaction): Promise<void> {
    if (await this.positions.existsStored((position) => position.name === name && position.id !== currentId, tx)) throw new AppError('VERSION_CONFLICT', '岗位名称已存在（包括历史记录）');
    if (await this.positions.existsStored((position) => position.code === code && position.id !== currentId, tx)) throw new AppError('VERSION_CONFLICT', '岗位编码已存在（包括历史记录）');
  }

  private async allowedUserIds(actor: AuthContext, permission: string, tx: StorageTransaction): Promise<Set<string>> {
    const scopes = permissionScopes(actor, permission);
    if (scopes.length === 0) throw new AppError('FORBIDDEN', '没有执行此操作的权限');
    const users = await this.allUsers(tx);
    if (scopes.includes('all')) return new Set(users.filter((user) => user.deletedAt === null && user.status === 'active').map((user) => user.id));
    const actorDepartment = actor.user.departmentId;
    if (scopes.includes('department') || scopes.includes('department_tree')) {
      if (actorDepartment === null) throw new AppError('FORBIDDEN', '当前用户没有有效部门，无法应用数据范围');
      const department = await this.departments.get(actorDepartment, tx);
      if (!department || department.deletedAt !== null) throw new AppError('FORBIDDEN', '当前用户没有有效部门，无法应用数据范围');
    }
    const allowedDepartments = new Set<string>();
    if (scopes.includes('department') && actorDepartment !== null) allowedDepartments.add(actorDepartment);
    if (scopes.includes('department_tree') && actorDepartment !== null) {
      const all = await this.allDepartments(tx);
      const children = new Map<string, string[]>();
      for (const department of all) if (department.parentId !== null) children.set(department.parentId, [...(children.get(department.parentId) ?? []), department.id]);
      const queue = [actorDepartment];
      while (queue.length > 0) { const id = queue.shift(); if (!id || allowedDepartments.has(id)) continue; allowedDepartments.add(id); queue.push(...(children.get(id) ?? [])); }
    }
    const employeeDocs = await this.allEmployees(tx);
    const ids = new Set<string>();
    for (const employee of employeeDocs) {
      if (scopes.includes('self') && employee.userId === actor.user.id) ids.add(employee.userId);
      if (employee.departmentId !== null && allowedDepartments.has(employee.departmentId)) ids.add(employee.userId);
    }
    return ids;
  }

  private async entries(tx: StorageTransaction, allowed: Set<string>): Promise<DirectoryEntry[]> {
    const employees = await this.allEmployees(tx);
    const positions = new Map((await this.allPositions(tx)).map((position) => [position.id, position]));
    const departments = new Map((await this.allDepartments(tx)).map((department) => [department.id, department]));
    const result: DirectoryEntry[] = [];
    for (const employee of employees) {
      if (!allowed.has(employee.userId)) continue;
      const user = await this.core.users.get(employee.userId, tx);
      if (!user || user.deletedAt !== null) continue;
      result.push({ id: employee.id, userId: user.id, name: user.name, email: user.email, status: user.status, departmentId: employee.departmentId, departmentName: employee.departmentId ? (departments.get(employee.departmentId)?.name ?? null) : null, positionId: employee.positionId, positionName: employee.positionId ? (positions.get(employee.positionId)?.name ?? null) : null });
    }
    return result;
  }

  private async employeeViews(tx: StorageTransaction, allowed: Set<string>, actor: AuthContext): Promise<EmployeeView[]> {
    const entries = await this.entries(tx, allowed);
    const employees = new Map((await this.allEmployees(tx)).map((employee) => [employee.id, employee]));
    const users = new Map((await this.allUsers(tx)).map((user) => [user.id, user]));
    const canSeeAllPhones = actor.roles.some((role) => role.code === 'org_admin' || role.code === 'system_admin') || permissionScopes(actor, 'employee:manage').includes('all');
    return entries.map((entry) => {
      const employee = employees.get(entry.id);
      if (!employee) throw new AppError('STORAGE_CORRUPTED', '员工档案索引不一致');
      return { ...entry, version: employee.version, employeeNo: employee.employeeNo, phone: canSeeAllPhones || entry.userId === actor.user.id ? maskPhone(employee.phone) : null, managerId: users.get(entry.userId)?.managerId ?? null, hireDate: employee.hireDate, avatarFileId: employee.avatarFileId };
    });
  }

  private profileFields(fields: EmployeeInput): Omit<EmployeeInput, 'managerId'> {
    const { managerId: _managerId, ...profile } = fields;
    return profile;
  }

  private async syncUserManager(userId: string, managerId: string | null, tx: StorageTransaction): Promise<void> {
    const user = await this.core.users.require(userId, tx);
    if ((user.managerId ?? null) === managerId) return;
    await this.core.users.update(user.id, user.version, (current) => ({ ...current, managerId }), tx);
  }

  private async allEmployees(tx: StorageTransaction): Promise<EmployeeDocument[]> { return this.all(this.employees, tx); }
  private async allPositions(tx: StorageTransaction): Promise<PositionDocument[]> { return this.all(this.positions, tx); }
  private async allDepartments(tx: StorageTransaction): Promise<DepartmentDocument[]> { return this.all(this.departments, tx); }
  private async allUsers(tx: StorageTransaction): Promise<Awaited<ReturnType<typeof this.core.users.list>>['items'] extends readonly (infer T)[] ? T[] : never> {
    const first = await this.core.users.list({ page: 1, pageSize: 100 }, tx);
    const result = [...first.items];
    for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) result.push(...(await this.core.users.list({ page, pageSize: 100 }, tx)).items);
    return result;
  }
  private async all<T extends DocumentEnvelope>(repository: Repository<T>, tx: StorageTransaction): Promise<T[]> {
    const first = await repository.list({ page: 1, pageSize: 100 }, tx); const result = [...first.items];
    for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) result.push(...(await repository.list({ page, pageSize: 100 }, tx)).items);
    return result;
  }
}

function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  if (phone.length <= 7) return `${phone.slice(0, 2)}***`;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
