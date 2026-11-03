import type { AuthContext } from '../core/auth-service.js';
import type { CoreRepositories } from '../core/repositories.js';
import type { AuditInput, AuditService } from '../core/audit-service.js';
import { AppError } from '../../shared/errors.js';
import { systemClock, type Clock } from '../../shared/clock.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { Repository } from '../../storage/repository.js';
import { departmentFieldsSchema, type DepartmentDocument, type DepartmentInput } from './models.js';

export type DepartmentAuditContext = Pick<AuditInput, 'ip' | 'userAgent' | 'requestId'>;

export class DepartmentService {
  constructor(
    private readonly departments: Repository<DepartmentDocument>,
    private readonly core: CoreRepositories,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Only global scope is implemented; narrower scopes fail closed until tree filtering exists. */
  async list(actor: AuthContext): Promise<DepartmentDocument[]> {
    return this.uow.run(async (tx) => {
      await this.authorize(actor, 'department:read', tx);
      return this.allDepartments(tx);
    });
  }

  async create(actor: AuthContext, input: DepartmentInput, context: DepartmentAuditContext = {}): Promise<DepartmentDocument> {
    const fields = this.parse(input);
    return this.uow.run(async (tx) => {
      await this.authorize(actor, 'department:manage', tx);
      await this.validateTree(null, fields.parentId, tx);
      await this.validateManager(fields.managerId, tx);
      const created = await this.departments.create(fields, tx);
      await this.audit.append({ actorUserId: actor.user.id, action: 'department.created', resourceType: 'department', resourceId: created.id, ...context }, tx);
      return created;
    });
  }

  async update(actor: AuthContext, id: string, version: number, input: DepartmentInput, context: DepartmentAuditContext = {}): Promise<DepartmentDocument> {
    const fields = this.parse(input);
    return this.uow.run(async (tx) => {
      await this.authorize(actor, 'department:manage', tx);
      const existing = await this.departments.get(id, tx);
      if (!existing || existing.deletedAt !== null) throw new AppError('NOT_FOUND', '部门不存在');
      await this.validateTree(id, fields.parentId, tx);
      await this.validateManager(fields.managerId, tx);
      const updated = await this.departments.update(id, version, (current) => ({ ...current, ...fields }), tx);
      await this.audit.append({ actorUserId: actor.user.id, action: 'department.updated', resourceType: 'department', resourceId: id, ...context }, tx);
      return updated;
    });
  }

  private parse(input: DepartmentInput): DepartmentInput {
    const parsed = departmentFieldsSchema.safeParse(input);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '部门信息无效');
    return parsed.data;
  }

  private async authorize(actor: AuthContext, permission: string, tx: StorageTransaction): Promise<void> {
    const user = await this.core.users.get(actor.user.id, tx);
    const session = await this.core.sessions.get(actor.session.id, tx);
    const now = this.clock.now().getTime();
    if (!user || user.deletedAt !== null || user.status !== 'active' || user.mustChangePassword || !session || session.deletedAt !== null || session.userId !== user.id || session.revokedAt !== null || Date.parse(session.idleExpiresAt) <= now || Date.parse(session.absoluteExpiresAt) <= now) {
      throw new AppError('UNAUTHENTICATED', '会话已失效');
    }
    for (const roleId of user.roleIds) {
      const role = await this.core.roles.get(roleId, tx);
      if (role && role.deletedAt === null && role.dataScope === 'all' && role.permissionCodes.includes(permission)) return;
    }
    throw new AppError('FORBIDDEN', '没有执行此操作的权限或数据范围尚未支持');
  }

  private async allDepartments(tx: StorageTransaction): Promise<DepartmentDocument[]> {
    const first = await this.departments.list({ page: 1, pageSize: 100 }, tx);
    const result = [...first.items];
    for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) result.push(...(await this.departments.list({ page, pageSize: 100 }, tx)).items);
    return result;
  }

  private async validateTree(id: string | null, parentId: string | null, tx: StorageTransaction): Promise<void> {
    const all = await this.allDepartments(tx);
    const byId = new Map(all.map((department) => [department.id, department]));
    const depths = new Map<string, number>();
    const visiting = new Set<string>();
    const depth = (departmentId: string): number => {
      const cached = depths.get(departmentId);
      if (cached !== undefined) return cached;
      if (visiting.has(departmentId)) throw new AppError('VALIDATION_FAILED', '部门不能形成循环');
      const department = byId.get(departmentId);
      if (!department) throw new AppError('NOT_FOUND', '上级部门不存在');
      visiting.add(departmentId);
      if (visiting.size > 10) throw new AppError('VALIDATION_FAILED', '部门层级不能超过 10 层');
      const parent = departmentId === id ? parentId : department.parentId;
      const result = parent === null ? 1 : depth(parent) + 1;
      visiting.delete(departmentId);
      if (result > 10) throw new AppError('VALIDATION_FAILED', '部门层级不能超过 10 层');
      depths.set(departmentId, result);
      return result;
    };
    if (id !== null) for (const department of all) depth(department.id);
    else if (parentId !== null && depth(parentId) >= 10) throw new AppError('VALIDATION_FAILED', '部门层级不能超过 10 层');
  }

  private async validateManager(managerId: string | null, tx: StorageTransaction): Promise<void> {
    if (managerId === null) return;
    const manager = await this.core.users.get(managerId, tx);
    if (!manager || manager.deletedAt !== null || manager.status !== 'active') throw new AppError('NOT_FOUND', '部门负责人不存在或已停用');
  }
}
