import { z } from 'zod';
import { systemClock } from '../../shared/clock.js';
import { AppError } from '../../shared/errors.js';
import type { DocumentEnvelope } from '../../storage/envelope.js';
import type { Repository } from '../../storage/repository.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import { permissionScopes, type AuthContext, type AuthService } from '../core/auth-service.js';
import type { CoreRepositories } from '../core/repositories.js';
import type { DepartmentDocument } from '../organization/models.js';
import type { Project, ProjectRepositories, Task } from '../projects/project-service.js';

const filterSchema = z.object({ departmentId: z.string().min(1).max(64).optional() }).strict();
const OPEN_TASK_STATUSES = new Set<Task['status']>(['todo', 'in_progress', 'in_review']);

export type DepartmentWorkloadFilter = z.output<typeof filterSchema>;
export type DepartmentWorkloadFilterInput = z.input<typeof filterSchema>;

export interface DepartmentWorkloadMetric {
  readonly departmentId: string;
  readonly departmentName: string;
  readonly activeUserCount: number;
  readonly taskCount: number;
  readonly completedTaskCount: number;
  readonly cancelledTaskCount: number;
  readonly openTaskCount: number;
  readonly overdueTaskCount: number;
}

export interface DepartmentWorkloadReport {
  readonly generatedAt: string;
  readonly timezone: string;
  readonly overdueAsOfLocalDate: string;
  readonly filter: DepartmentWorkloadFilter;
  readonly departments: readonly DepartmentWorkloadMetric[];
}

type TimezoneProvider = (tx: StorageTransaction) => Promise<string>;

async function listAll<T extends DocumentEnvelope>(
  repository: Repository<T>,
  tx: StorageTransaction,
): Promise<T[]> {
  const first = await repository.list({ page: 1, pageSize: 100 }, tx);
  const result = [...first.items] as T[];
  for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) {
    result.push(...((await repository.list({ page, pageSize: 100 }, tx)).items as T[]));
  }
  return result;
}

function localDateAt(instant: string, timezone: string): string {
  const value = new Date(instant);
  if (!Number.isFinite(value.getTime())) throw new AppError('STORAGE_CORRUPTED', '分析时间无效');
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
      parts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    if (!year || !month || !day) throw new Error('date parts missing');
    return `${year}-${month}-${day}`;
  } catch {
    throw new AppError('STORAGE_CORRUPTED', '组织时区配置无效');
  }
}

function allowedScopes(actor: AuthContext): Set<'department' | 'department_tree' | 'all'> {
  const scopes = new Set([
    ...permissionScopes(actor, 'analytics:read:project'),
    ...permissionScopes(actor, 'analytics:read:all'),
  ]);
  if (scopes.size === 0) throw new AppError('FORBIDDEN', '没有查看部门工作量的权限');
  const supported = new Set(
    [...scopes].filter(
      (scope): scope is 'department' | 'department_tree' | 'all' =>
        scope === 'department' || scope === 'department_tree' || scope === 'all',
    ),
  );
  if (supported.size === 0) {
    throw new AppError('FORBIDDEN', '个人数据范围不能读取部门汇总');
  }
  return supported;
}

function allowedDepartments(
  departments: readonly DepartmentDocument[],
  actorDepartmentId: string | null,
  scopes: ReadonlySet<'department' | 'department_tree' | 'all'>,
): Set<string> {
  if (scopes.has('all')) return new Set(departments.map((department) => department.id));
  if (actorDepartmentId === null) throw new AppError('FORBIDDEN', '当前用户没有有效部门，无法应用数据范围');
  const byId = new Map(departments.map((department) => [department.id, department]));
  if (!byId.has(actorDepartmentId)) throw new AppError('FORBIDDEN', '当前用户没有有效部门，无法应用数据范围');
  const allowed = new Set<string>([actorDepartmentId]);
  if (!scopes.has('department_tree')) return allowed;

  const children = new Map<string, string[]>();
  for (const department of departments) {
    if (department.parentId === null) continue;
    children.set(department.parentId, [...(children.get(department.parentId) ?? []), department.id]);
  }
  const queue = [actorDepartmentId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const childId of children.get(current) ?? []) {
      if (allowed.has(childId)) continue;
      allowed.add(childId);
      queue.push(childId);
    }
  }
  return allowed;
}

function treeOrder(
  departments: readonly DepartmentDocument[],
  selectedIds: ReadonlySet<string>,
): DepartmentDocument[] {
  const children = new Map<string | null, DepartmentDocument[]>();
  for (const department of departments) {
    const siblings = children.get(department.parentId) ?? [];
    siblings.push(department);
    children.set(department.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
  }
  const result: DepartmentDocument[] = [];
  const visited = new Set<string>();
  const visit = (parentId: string | null): void => {
    for (const department of children.get(parentId) ?? []) {
      if (visited.has(department.id)) continue;
      visited.add(department.id);
      if (selectedIds.has(department.id)) result.push(department);
      visit(department.id);
    }
  };
  visit(null);
  // Maintenance validation rejects cycles; this keeps a corrupted graph from
  // silently omitting a department in a read-only report before repair.
  for (const department of departments) {
    if (visited.has(department.id)) continue;
    visited.add(department.id);
    if (selectedIds.has(department.id)) result.push(department);
  }
  return result;
}

export class DepartmentWorkloadService {
  constructor(
    private readonly projects: ProjectRepositories,
    private readonly departments: Repository<DepartmentDocument>,
    private readonly core: CoreRepositories,
    private readonly uow: UnitOfWork,
    private readonly auth: AuthService,
    private readonly now: () => string = () => systemClock.nowIso(),
    private readonly timezoneFor: TimezoneProvider = async () => 'UTC',
  ) {}

  async departmentWorkload(
    requestContext: AuthContext,
    input: DepartmentWorkloadFilterInput = {},
  ): Promise<DepartmentWorkloadReport> {
    const parsed = filterSchema.safeParse(input);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '部门工作量筛选条件无效');
    const filter = parsed.data;
    return this.uow.run(async (tx) => {
      const actor = await this.auth.loadCurrentActor(requestContext, tx);
      const scopes = allowedScopes(actor);
      if (!actor.permissions.includes('project:read') || !actor.permissions.includes('task:read')) {
        throw new AppError('FORBIDDEN', '没有读取项目或任务的权限');
      }
      const generatedAt = this.now();
      const timezone = await this.timezoneFor(tx);
      const overdueAsOfLocalDate = localDateAt(generatedAt, timezone);
      const activeDepartments = (await listAll(this.departments, tx)).filter(
        (department) => department.deletedAt === null,
      );
      const permittedDepartmentIds = allowedDepartments(activeDepartments, actor.user.departmentId, scopes);
      if (filter.departmentId && !permittedDepartmentIds.has(filter.departmentId)) {
        throw new AppError('NOT_FOUND', '部门不存在或无权访问');
      }
      const selectedIds = new Set(
        [...permittedDepartmentIds].filter((departmentId) => !filter.departmentId || departmentId === filter.departmentId),
      );
      const selectedDepartments = treeOrder(activeDepartments, selectedIds);
      const metrics = new Map<string, DepartmentWorkloadMetric>(
        selectedDepartments.map((department) => [
          department.id,
          {
            departmentId: department.id,
            departmentName: department.name,
            activeUserCount: 0,
            taskCount: 0,
            completedTaskCount: 0,
            cancelledTaskCount: 0,
            openTaskCount: 0,
            overdueTaskCount: 0,
          },
        ]),
      );
      const users = await listAll(this.core.users, tx);
      const assigneeDepartments = new Map<string, string>();
      for (const user of users) {
        if (user.deletedAt !== null || user.status !== 'active' || user.departmentId === null) continue;
        const metric = metrics.get(user.departmentId);
        if (!metric) continue;
        assigneeDepartments.set(user.id, user.departmentId);
        metrics.set(user.departmentId, { ...metric, activeUserCount: metric.activeUserCount + 1 });
      }

      const publicProjectIds = new Set(
        (await listAll<Project>(this.projects.projects, tx))
          .filter((project) => project.deletedAt === null && project.visibility === 'organization')
          .map((project) => project.id),
      );
      for (const task of await listAll<Task>(this.projects.tasks, tx)) {
        if (task.deletedAt !== null || task.assigneeId === null || !publicProjectIds.has(task.projectId)) continue;
        const departmentId = assigneeDepartments.get(task.assigneeId);
        if (!departmentId) continue;
        const metric = metrics.get(departmentId);
        if (!metric) continue;
        const isOpen = OPEN_TASK_STATUSES.has(task.status);
        const isOverdue = isOpen && task.dueDate !== null && task.dueDate < overdueAsOfLocalDate;
        metrics.set(departmentId, {
          ...metric,
          taskCount: metric.taskCount + 1,
          completedTaskCount: metric.completedTaskCount + (task.status === 'done' ? 1 : 0),
          cancelledTaskCount: metric.cancelledTaskCount + (task.status === 'cancelled' ? 1 : 0),
          openTaskCount: metric.openTaskCount + (isOpen ? 1 : 0),
          overdueTaskCount: metric.overdueTaskCount + (isOverdue ? 1 : 0),
        });
      }
      return {
        generatedAt,
        timezone,
        overdueAsOfLocalDate,
        filter,
        departments: selectedDepartments.map((department) => metrics.get(department.id)!),
      };
    });
  }
}
