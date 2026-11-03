import { z } from 'zod';
import { systemClock } from '../../shared/clock.js';
import { AppError } from '../../shared/errors.js';
import type { DocumentEnvelope } from '../../storage/envelope.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { ListQuery, Repository } from '../../storage/repository.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { AuthContext, AuthService } from '../core/auth-service.js';
import { permissionScopes } from '../core/auth-service.js';
import type { Project, ProjectMember, ProjectRepositories, Task } from '../projects/project-service.js';

const filterSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    /** Inclusive lower bound on project.createdAt. */
    createdFrom: z.string().datetime().optional(),
    /** Exclusive upper bound on project.createdAt. */
    createdTo: z.string().datetime().optional(),
    overduePage: z.coerce.number().int().min(1).default(1),
    overduePageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .superRefine((filter, context) => {
    if (filter.createdFrom && filter.createdTo && filter.createdFrom >= filter.createdTo) {
      context.addIssue({ code: 'custom', message: 'createdTo 必须晚于 createdFrom' });
    }
  });

export type ProjectAnalyticsFilter = z.output<typeof filterSchema>;
export type ProjectAnalyticsFilterInput = z.input<typeof filterSchema>;

export interface ProjectCompletionMetric {
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly projectStatus: Project['status'];
  readonly projectCreatedAt: string;
  /** Non-deleted tasks, including cancelled tasks. */
  readonly taskCount: number;
  readonly completedTaskCount: number;
  readonly cancelledTaskCount: number;
  readonly effectiveTaskCount: number;
  readonly openTaskCount: number;
  /** Percentage in [0, 100], rounded to two decimal places. */
  readonly completionRate: number;
  readonly overdueTaskCount: number;
  readonly overdueRate: number;
}

export interface OverdueTaskMetric {
  readonly taskId: string;
  readonly taskKey: string;
  readonly title: string;
  readonly dueDate: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
}

export interface ProjectCompletionReport {
  readonly generatedAt: string;
  readonly timezone: string;
  readonly overdueAsOfLocalDate: string;
  readonly temporalSemantics: 'current_snapshot_filtered_by_project_creation_time';
  readonly filter: ProjectAnalyticsFilter;
  readonly projects: readonly ProjectCompletionMetric[];
  readonly overdueTasks: readonly OverdueTaskMetric[];
  readonly overdueMeta: { readonly page: number; readonly pageSize: number; readonly total: number };
  readonly totals: {
    readonly projectCount: number;
    readonly taskCount: number;
    readonly completedTaskCount: number;
    readonly cancelledTaskCount: number;
    readonly effectiveTaskCount: number;
    readonly openTaskCount: number;
    readonly completionRate: number;
    readonly overdueTaskCount: number;
    readonly overdueRate: number;
  };
}

const OPEN_TASK_STATUSES = new Set<Task['status']>(['todo', 'in_progress', 'in_review']);
const LEADERSHIP_ROLES = new Set<ProjectMember['role']>(['owner', 'manager']);

function localDateAt(instant: string, timezone: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new AppError('STORAGE_CORRUPTED', '分析时间无效');
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
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

type TimezoneProvider = (tx: StorageTransaction) => Promise<string>;

async function listAll<T extends DocumentEnvelope>(
  repo: Repository<T>,
  query: Pick<ListQuery, 'indexName' | 'prefix'>,
  tx: StorageTransaction,
): Promise<T[]> {
  const first = await repo.list({ ...query, page: 1, pageSize: 100 }, tx);
  const items = [...first.items] as T[];
  for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) {
    items.push(...((await repo.list({ ...query, page, pageSize: 100 }, tx)).items as T[]));
  }
  return items;
}

function percent(completed: number, effective: number): number {
  if (effective === 0) return 0;
  return Math.round((completed / effective) * 10_000) / 100;
}

function assertRangeIsSupported(context: AuthContext): { readonly all: boolean } {
  const projectScopes = permissionScopes(context, 'analytics:read:project');
  const allScopes = permissionScopes(context, 'analytics:read:all');
  const scopes = [...projectScopes, ...allScopes];
  if (scopes.length === 0) throw new AppError('FORBIDDEN', '没有查看项目分析的权限');
  if (scopes.some((scope) => scope === 'department' || scope === 'department_tree')) {
    throw new AppError('FORBIDDEN', '项目分析暂不支持部门数据范围');
  }
  return { all: scopes.includes('all') };
}

function matchesTimeFilter(project: Project, filter: ProjectAnalyticsFilter): boolean {
  return (
    (!filter.createdFrom || project.createdAt >= filter.createdFrom) &&
    (!filter.createdTo || project.createdAt < filter.createdTo)
  );
}

export class ProjectAnalyticsService {
  constructor(
    private readonly projects: ProjectRepositories,
    private readonly uow: UnitOfWork,
    private readonly auth: AuthService,
    private readonly now: () => string = () => systemClock.nowIso(),
    private readonly timezoneFor: TimezoneProvider = async () => 'UTC',
  ) {}

  async projectCompletion(
    requestContext: AuthContext,
    input: ProjectAnalyticsFilterInput = {},
  ): Promise<ProjectCompletionReport> {
    const parsed = filterSchema.safeParse(input);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '项目分析筛选条件无效');
    const filter = parsed.data;

    return this.uow.run(async (tx) => {
      const generatedAt = this.now();
      const timezone = await this.timezoneFor(tx);
      const overdueAsOfLocalDate = localDateAt(generatedAt, timezone);
      const actor = await this.auth.loadCurrentActor(requestContext, tx);
      const scope = assertRangeIsSupported(actor);
      if (
        !actor.permissions.includes('project:read') &&
        !actor.permissions.includes('project:read:all')
      ) {
        throw new AppError('FORBIDDEN', '没有读取项目的权限');
      }
      if (!actor.permissions.includes('task:read')) {
        throw new AppError('FORBIDDEN', '没有读取任务的权限');
      }

      const memberships = (await listAll<ProjectMember>(
        this.projects.members,
        { indexName: 'idx_project_members_user', prefix: actor.user.id },
        tx,
      )).filter(
        (member) =>
          member.deletedAt === null &&
          member.userId === actor.user.id &&
          member.projectId.length > 0,
      );
      const membershipByProject = new Map(memberships.map((member) => [member.projectId, member]));
      const managedProjectIds = new Set(
        memberships.filter((member) => LEADERSHIP_ROLES.has(member.role)).map((member) => member.projectId),
      );
      const canReadAllOrganizationProjects =
        actor.permissions.includes('project:read:all') &&
        permissionScopes(actor, 'project:read:all').includes('all');

      let candidates: Project[];
      if (filter.projectId) {
        const project = await this.projects.projects.get(filter.projectId, tx);
        if (!project || project.deletedAt !== null) throw new AppError('NOT_FOUND', '项目不存在');
        const isMember = membershipByProject.has(project.id);
        const privatelyReadable = project.visibility !== 'private' || isMember;
        const scopeAllowsProject =
          scope.all
            ? isMember || (project.visibility === 'organization' && canReadAllOrganizationProjects)
            : managedProjectIds.has(project.id);
        if (!privatelyReadable || !scopeAllowsProject) {
          throw new AppError('NOT_FOUND', '项目不存在');
        }
        candidates = [project];
      } else {
        const visibleProjects = await listAll<Project>(
          this.projects.projects,
          { indexName: 'idx_projects_visibility', prefix: 'organization' },
          tx,
        );
        const byId = new Map<string, Project>();
        for (const project of visibleProjects) {
          if (
            project.deletedAt === null &&
            project.visibility === 'organization' &&
            canReadAllOrganizationProjects &&
            scope.all
          ) {
            byId.set(project.id, project);
          }
        }
        for (const member of memberships) {
          if (!LEADERSHIP_ROLES.has(member.role)) continue;
          const project = await this.projects.projects.get(member.projectId, tx);
          if (project && project.deletedAt === null) byId.set(project.id, project);
        }
        candidates = [...byId.values()];
      }

      const eligibleProjects = candidates
        .filter((project) => matchesTimeFilter(project, filter))
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        );
      const metrics: ProjectCompletionMetric[] = [];
      const overdueTasks: OverdueTaskMetric[] = [];
      for (const project of eligibleProjects) {
        const tasks = (await listAll<Task>(
          this.projects.tasks,
          { indexName: 'idx_tasks_project', prefix: project.id },
          tx,
        )).filter((task) => task.projectId === project.id && task.deletedAt === null);
        const completedTaskCount = tasks.filter((task) => task.status === 'done').length;
        const cancelledTaskCount = tasks.filter((task) => task.status === 'cancelled').length;
        const effectiveTaskCount = tasks.length - cancelledTaskCount;
        const openTasks = tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status));
        const projectOverdueTasks = openTasks.filter(
          (task) => task.dueDate !== null && task.dueDate < overdueAsOfLocalDate,
        );
        overdueTasks.push(
          ...projectOverdueTasks.map((task) => ({
            taskId: task.id,
            taskKey: task.taskKey,
            title: task.title,
            dueDate: task.dueDate!,
            projectId: project.id,
            projectKey: project.key,
            projectName: project.name,
          })),
        );
        metrics.push({
          projectId: project.id,
          projectKey: project.key,
          projectName: project.name,
          projectStatus: project.status,
          projectCreatedAt: project.createdAt,
          taskCount: tasks.length,
          completedTaskCount,
          cancelledTaskCount,
          effectiveTaskCount,
          openTaskCount: openTasks.length,
          completionRate: percent(completedTaskCount, effectiveTaskCount),
          overdueTaskCount: projectOverdueTasks.length,
          overdueRate: percent(projectOverdueTasks.length, openTasks.length),
        });
      }
      overdueTasks.sort(
        (left, right) =>
          left.dueDate.localeCompare(right.dueDate) ||
          left.projectKey.localeCompare(right.projectKey) ||
          left.taskKey.localeCompare(right.taskKey),
      );

      const totals = metrics.reduce(
        (current, metric) => ({
          projectCount: current.projectCount + 1,
          taskCount: current.taskCount + metric.taskCount,
          completedTaskCount: current.completedTaskCount + metric.completedTaskCount,
          cancelledTaskCount: current.cancelledTaskCount + metric.cancelledTaskCount,
          effectiveTaskCount: current.effectiveTaskCount + metric.effectiveTaskCount,
          openTaskCount: current.openTaskCount + metric.openTaskCount,
          completionRate: 0,
          overdueTaskCount: current.overdueTaskCount + metric.overdueTaskCount,
          overdueRate: 0,
        }),
        {
          projectCount: 0,
          taskCount: 0,
          completedTaskCount: 0,
          cancelledTaskCount: 0,
          effectiveTaskCount: 0,
          openTaskCount: 0,
          completionRate: 0,
          overdueTaskCount: 0,
          overdueRate: 0,
        },
      );

      return {
        generatedAt,
        timezone,
        overdueAsOfLocalDate,
        temporalSemantics: 'current_snapshot_filtered_by_project_creation_time',
        filter,
        projects: metrics,
        overdueTasks: overdueTasks.slice(
          (filter.overduePage - 1) * filter.overduePageSize,
          filter.overduePage * filter.overduePageSize,
        ),
        overdueMeta: {
          page: filter.overduePage,
          pageSize: filter.overduePageSize,
          total: overdueTasks.length,
        },
        totals: {
          ...totals,
          completionRate: percent(totals.completedTaskCount, totals.effectiveTaskCount),
          overdueRate: percent(totals.overdueTaskCount, totals.openTaskCount),
        },
      };
    });
  }
}
