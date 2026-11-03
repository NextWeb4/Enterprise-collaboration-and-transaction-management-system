import type { NotificationView, WorkbenchActivity, WorkbenchTask } from '@collab/shared/schemas.js';
import { AppError } from '../../shared/errors.js';
import { systemClock, type Clock } from '../../shared/clock.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { CoreRepositories } from '../core/repositories.js';
import { permissionScopes, type AuthContext, type AuthService } from '../core/auth-service.js';
import type {
  ProjectRepositories,
  Project,
  ProjectMember,
  Task,
} from '../projects/project-service.js';
import type { ApprovalRepositories } from '../approvals/repositories.js';
import type { SharedNotification } from '../core/shared-records.js';
import type { CalendarRepositories } from '../calendar/repositories.js';

const openStatuses = new Set(['todo', 'in_progress', 'in_review']);
const priorities: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
async function rows<T>(
  repo: {
    list(
      input: { page: number; pageSize: number },
      tx: StorageTransaction,
    ): Promise<{ items: readonly T[]; total: number }>;
  },
  tx: StorageTransaction,
): Promise<T[]> {
  const first = await repo.list({ page: 1, pageSize: 100 }, tx);
  const result = [...first.items];
  for (let page = 2; page <= Math.ceil(first.total / 100); page++)
    result.push(...(await repo.list({ page, pageSize: 100 }, tx)).items);
  return result;
}
export function localDate(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  return ['year', 'month', 'day']
    .map((key) => parts.find((part) => part.type === key)?.value)
    .join('-');
}
export function weekDates(today: string): { start: string; end: string } {
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  const start = day.toISOString().slice(0, 10);
  day.setUTCDate(day.getUTCDate() + 7);
  return { start, end: day.toISOString().slice(0, 10) };
}
export class WorkbenchService {
  constructor(
    private readonly core: CoreRepositories,
    private readonly projects: ProjectRepositories,
    private readonly approvals: ApprovalRepositories,
    private readonly auth: AuthService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock = systemClock,
    private readonly calendar?: CalendarRepositories,
  ) {}

  private async actor(context: AuthContext, tx: StorageTransaction): Promise<AuthContext> {
    const actor = await this.auth.loadCurrentActor(context, tx);
    if (!actor.permissions.includes('workbench:read')) throw new AppError('FORBIDDEN');
    return actor;
  }
  private async taskData(
    actor: AuthContext,
    tx: StorageTransaction,
  ): Promise<{
    tasks: Task[];
    projects: Map<string, Project>;
    members: Map<string, ProjectMember>;
  }> {
    const members = new Map(
      (await rows(this.projects.members, tx))
        .filter((member) => member.userId === actor.user.id)
        .map((member) => [member.projectId, member]),
    );
    const projects = new Map(
      (await rows(this.projects.projects, tx))
        .filter(
          (project) =>
            project.status !== 'archived' &&
            (project.visibility === 'organization' || members.has(project.id)),
        )
        .map((project) => [project.id, project]),
    );
    const tasks = actor.permissions.includes('task:read')
      ? (await rows(this.projects.tasks, tx)).filter(
          (task) => projects.has(task.projectId) && task.assigneeId === actor.user.id,
        )
      : [];
    return { tasks, projects, members };
  }
  private taskView(
    task: Task,
    project: Project,
    member: ProjectMember | undefined,
    actor: AuthContext,
    today: string,
  ): WorkbenchTask {
    return {
      id: task.id,
      version: task.version,
      title: task.title,
      taskKey: task.taskKey,
      projectId: project.id,
      projectName: project.name,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      overdue: !!task.dueDate && task.dueDate < today,
      canComplete:
        actor.permissions.includes('task:update') &&
        !!member &&
        member.role !== 'viewer' &&
        ['planning', 'active', 'on_hold'].includes(project.status) &&
        ['in_progress', 'in_review'].includes(task.status),
    };
  }
  private async timezone(tx: StorageTransaction): Promise<string> {
    const org = (await this.core.organizations.list({ page: 1, pageSize: 1 }, tx)).items[0];
    if (!org) throw new AppError('STORAGE_CORRUPTED', '组织配置不存在');
    return org.timezone;
  }
  async activity(context: AuthContext): Promise<WorkbenchActivity> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, tx);
      const timezone = await this.timezone(tx);
      const now = this.clock.now();
      const today = localDate(now, timezone);
      const week = weekDates(today);
      const data = await this.taskData(actor, tx);
      const open = data.tasks
        .filter((task) => openStatuses.has(task.status))
        .sort(
          (a, b) =>
            (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
            (priorities[a.priority] ?? 9) - (priorities[b.priority] ?? 9) ||
            a.id.localeCompare(b.id),
        );
      const pending: WorkbenchActivity['approvals'] = [];
      if (actor.permissions.includes('application:approve')) {
        for (const step of await rows(this.approvals.steps, tx)) {
          if (step.approverId !== actor.user.id || step.status !== 'active') continue;
          const instance = await this.approvals.instances.get(step.instanceId, tx);
          if (
            !instance ||
            instance.deletedAt !== null ||
            instance.status !== 'running' ||
            instance.currentStepNo !== step.stepNo
          )
            continue;
          const application = await this.approvals.applications.get(instance.applicationId, tx);
          if (
            !application ||
            application.deletedAt !== null ||
            application.status !== 'pending' ||
            application.applicantId === actor.user.id
          )
            continue;
          const applicant = await this.core.users.get(application.applicantId, tx);
          pending.push({
            id: application.id,
            title: application.title,
            applicationType: application.applicationType,
            applicantName: applicant?.name ?? '已离职用户',
            submittedAt: application.submittedAt,
            step: step.name,
          });
        }
      }
      pending.sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));
      const mine = actor.permissions.includes('project:read')
        ? [...data.projects.values()]
            .filter((project) => data.members.has(project.id))
            .sort((a, b) =>
              (data.members.get(b.id)?.lastViewedAt ?? b.updatedAt).localeCompare(
                data.members.get(a.id)?.lastViewedAt ?? a.updatedAt,
              ),
            )
        : [];
      const allTasks = actor.permissions.includes('task:read')
        ? await rows(this.projects.tasks, tx)
        : [];
      const notifications = (await rows(this.approvals.notifications, tx)).filter(
        (item) => item.recipientId === actor.user.id,
      );
      return {
        generatedAt: now.toISOString(),
        timezone,
        metrics: {
          openTasks: open.length,
          overdueTasks: open.filter((task) => task.dueDate && task.dueDate < today).length,
          dueThisWeek: open.filter(
            (task) => task.dueDate && task.dueDate >= week.start && task.dueDate < week.end,
          ).length,
          completedThisWeek: data.tasks.filter(
            (task) =>
              task.status === 'done' &&
              task.completedAt &&
              localDate(new Date(task.completedAt), timezone) >= week.start &&
              localDate(new Date(task.completedAt), timezone) < week.end,
          ).length,
          pendingApprovals: pending.length,
          unreadNotifications: notifications.filter((item) => item.readAt === null).length,
        },
        tasks: open
          .slice(0, 10)
          .map((task) =>
            this.taskView(
              task,
              data.projects.get(task.projectId)!,
              data.members.get(task.projectId),
              actor,
              today,
            ),
          ),
        approvals: pending.slice(0, 10),
        projects: mine
          .slice(0, 6)
          .map((project) => ({
            id: project.id,
            name: project.name,
            key: project.key,
            status: project.status,
            role: data.members.get(project.id)!.role,
            openTasks: allTasks.filter(
              (task) => task.projectId === project.id && openStatuses.has(task.status),
            ).length,
          })),
      };
    });
  }
  async tasks(
    context: AuthContext,
    page: number,
    pageSize: number,
    overdueOnly: boolean,
  ): Promise<{ data: WorkbenchTask[]; meta: { total: number; page: number; pageSize: number } }> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, tx);
      const today = localDate(this.clock.now(), await this.timezone(tx));
      const data = await this.taskData(actor, tx);
      const tasks = data.tasks
        .filter(
          (task) =>
            openStatuses.has(task.status) &&
            (!overdueOnly || (task.dueDate !== null && task.dueDate < today)),
        )
        .sort(
          (a, b) =>
            (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
            (priorities[a.priority] ?? 9) - (priorities[b.priority] ?? 9) ||
            a.id.localeCompare(b.id),
        );
      return {
        data: tasks
          .slice((page - 1) * pageSize, page * pageSize)
          .map((task) =>
            this.taskView(
              task,
              data.projects.get(task.projectId)!,
              data.members.get(task.projectId),
              actor,
              today,
            ),
          ),
        meta: { total: tasks.length, page, pageSize },
      };
    });
  }
  private async notificationView(
    item: SharedNotification,
    actor: AuthContext,
    tx: StorageTransaction,
  ): Promise<NotificationView> {
    let available = false;
    const applicationMatch = /^\/app\/applications\/([\w-]+)$/.exec(item.linkPath ?? '');
    const projectMatch = /^\/app\/projects\?project=([\w-]+)$/.exec(item.linkPath ?? '');
    const calendarMatch = /^\/app\/calendar\?event=([\w-]+)$/.exec(item.linkPath ?? '');
    if (applicationMatch?.[1]) {
      const application = await this.approvals.applications.get(applicationMatch[1], tx);
      if (application && application.deletedAt === null) {
        available =
          (application.applicantId === actor.user.id &&
            actor.permissions.includes('application:read:self')) ||
          (application.status !== 'draft' &&
            permissionScopes(actor, 'application:read:all').includes('all'));
        if (!available && actor.permissions.includes('application:approve')) {
          const instance = await this.approvals.instances.getByUniqueIndex(
            'idx_workflow_instances_application',
            application.id,
            tx,
          );
          if (instance)
            available = (await this.approvals.listSteps(instance.id, tx)).some(
              (step) => step.approverId === actor.user.id && step.status !== 'waiting',
            );
        }
      }
    } else if (projectMatch?.[1] && actor.permissions.includes('project:read')) {
      const project = await this.projects.projects.get(projectMatch[1], tx);
      const member = await this.projects.members.getByUniqueIndex(
        'idx_project_members_key',
        `${projectMatch[1]}:${actor.user.id}`,
        tx,
      );
      available =
        !!project &&
        project.deletedAt === null &&
        (project.visibility === 'organization' ||
          (!!member &&
            member.deletedAt === null &&
            member.userId === actor.user.id &&
            member.projectId === project.id));
    } else if (calendarMatch?.[1] && this.calendar && actor.permissions.includes('calendar:read')) {
      const event = await this.calendar.events.get(calendarMatch[1], tx);
      if (event && event.deletedAt === null) {
        if (event.projectId) {
          const project = await this.projects.projects.get(event.projectId, tx);
          const member = await this.projects.members.getByUniqueIndex('idx_project_members_key', `${event.projectId}:${actor.user.id}`, tx);
          available = !!project && project.deletedAt === null && actor.permissions.includes('project:read') && !!member && member.deletedAt === null;
        } else {
          available = event.ownerId === actor.user.id || event.participants.some((participant) => participant.userId === actor.user.id);
        }
      }
    }
    return {
      id: item.id,
      version: item.version,
      title: available ? item.title : '内容已删除或无权访问',
      content: available ? item.content : '',
      linkPath: available ? item.linkPath : null,
      available,
      readAt: item.readAt,
      createdAt: item.createdAt,
    };
  }
  async notifications(
    context: AuthContext,
    page: number,
    pageSize: number,
    unreadOnly: boolean,
  ): Promise<{
    data: NotificationView[];
    meta: { total: number; page: number; pageSize: number; unread: number };
  }> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, tx);
      const all = (await rows(this.approvals.notifications, tx))
        .filter((item) => item.recipientId === actor.user.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const filtered = unreadOnly ? all.filter((item) => item.readAt === null) : all;
      const data: NotificationView[] = [];
      for (const item of filtered.slice((page - 1) * pageSize, page * pageSize))
        data.push(await this.notificationView(item, actor, tx));
      return {
        data,
        meta: {
          total: filtered.length,
          unread: all.filter((item) => item.readAt === null).length,
          page,
          pageSize,
        },
      };
    });
  }
  async markRead(context: AuthContext, id: string | null, version?: number): Promise<void> {
    await this.uow.run(async (tx) => {
      const actor = await this.actor(context, tx);
      const selected = id
        ? [await this.approvals.notifications.get(id, tx)]
        : (await rows(this.approvals.notifications, tx)).filter(
            (item) => item.recipientId === actor.user.id,
          );
      for (const item of selected) {
        if (!item || item.deletedAt !== null || item.recipientId !== actor.user.id)
          throw new AppError('NOT_FOUND');
        if (id && version !== item.version) throw new AppError('VERSION_CONFLICT');
        if (item.readAt === null)
          await this.approvals.notifications.update(
            item.id,
            item.version,
            (current) => ({ ...current, readAt: this.clock.now().toISOString() }),
            tx,
          );
      }
    });
  }
  async visit(context: AuthContext, id: string): Promise<void> {
    await this.uow.run(async (tx) => {
      const actor = await this.actor(context, tx);
      if (!actor.permissions.includes('project:read')) throw new AppError('FORBIDDEN');
      const project = await this.projects.projects.get(id, tx);
      const member = await this.projects.members.getByUniqueIndex(
        'idx_project_members_key',
        `${id}:${actor.user.id}`,
        tx,
      );
      if (
        !project ||
        project.deletedAt !== null ||
        !member ||
        member.deletedAt !== null ||
        member.projectId !== id ||
        member.userId !== actor.user.id
      )
        throw new AppError('NOT_FOUND');
      if (project.status === 'archived') return;
      const now = this.clock.now();
      if (
        !member.lastViewedAt ||
        localDate(new Date(member.lastViewedAt), await this.timezone(tx)) !==
          localDate(now, await this.timezone(tx))
      )
        await this.projects.members.update(
          member.id,
          member.version,
          (current) => ({ ...current, lastViewedAt: now.toISOString() }),
          tx,
        );
    });
  }
}
