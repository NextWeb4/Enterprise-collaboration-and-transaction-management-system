import { z } from 'zod';
import { systemClock } from '../../shared/clock.js';
import { AppError } from '../../shared/errors.js';
import type { DocumentEnvelope } from '../../storage/envelope.js';
import { BaseRepository, type Repository, type ListQuery } from '../../storage/repository.js';
import type { StorageEngine, StorageTransaction } from '../../storage/engine.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { CoreRepositories } from '../core/repositories.js';
import type { AuthContext, AuthService } from '../core/auth-service.js';
import type { AuditService, AuditInput } from '../core/audit-service.js';
import { createSharedRecordRepositories, type SharedNotification } from '../core/shared-records.js';
import type {
  projectCreateSchema,
  projectTransitionSchema,
  taskCreateSchema,
  taskUpdateSchema,
  projectMemberCreateSchema,
  projectUpdateSchema,
  taskBoardMoveSchema,
} from '@collab/shared/schemas.js';

const envelope = {
  id: z.string(),
  type: z.string(),
  schemaVersion: z.literal(1),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
};
export const projectSchema = z
  .object({
    ...envelope,
    type: z.literal('project'),
    name: z.string().min(2).max(120),
    key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
    description: z.string().max(10000),
    visibility: z.enum(['private', 'organization']),
    status: z.enum(['planning', 'active', 'on_hold', 'completed', 'cancelled', 'archived']),
    ownerId: z.string(),
    statusReason: z.string().max(500).nullable(),
    taskSeq: z.number().int().nonnegative().safe(),
    startDate: z.string().nullable(),
    dueDate: z.string().nullable(),
  })
  .strict();
export const memberSchema = z
  .object({
    ...envelope,
    type: z.literal('project_member'),
    projectId: z.string(),
    userId: z.string(),
    role: z.enum(['owner', 'manager', 'member', 'viewer']),
    membershipKey: z.string(),
    lastViewedAt: z.string().datetime().optional(),
  })
  .strict();
export const taskSchema = z
  .object({
    ...envelope,
    type: z.literal('task'),
    projectId: z.string(),
    taskNo: z.number().int().positive(),
    taskKey: z.string(),
    title: z.string().min(2).max(120),
    description: z.string().max(10000),
    status: z.enum(['todo', 'in_progress', 'in_review', 'done', 'cancelled']),
    progress: z.number().int().min(0).max(100),
    priority: z.enum(['low', 'medium', 'high', 'urgent']),
    assigneeId: z.string().nullable(),
    createdBy: z.string(),
    startDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    completedAt: z.string().datetime().nullable(),
    boardOrder: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
export const taskCommentSchema = z
  .object({
    ...envelope,
    type: z.literal('task_comment'),
    taskId: z.string(),
    authorId: z.string(),
    content: z.string().max(2000),
    editedAt: z.string().datetime().nullable(),
    removedAt: z.string().datetime().nullable(),
  })
  .strict();
export type Project = z.infer<typeof projectSchema> & DocumentEnvelope;
export type ProjectMember = z.infer<typeof memberSchema> & DocumentEnvelope;
export type Task = z.infer<typeof taskSchema> & DocumentEnvelope;
export type TaskComment = z.infer<typeof taskCommentSchema> & DocumentEnvelope;
type CreateProject = z.infer<typeof projectCreateSchema>;
type TransitionProject = z.infer<typeof projectTransitionSchema>;
type CreateTask = z.infer<typeof taskCreateSchema>;
type UpdateTask = z.infer<typeof taskUpdateSchema>;
type CreateMember = z.infer<typeof projectMemberCreateSchema>;
type UpdateProject = z.infer<typeof projectUpdateSchema>;
type BoardMove = z.infer<typeof taskBoardMoveSchema>;
export interface ProjectRepositories {
  projects: Repository<Project>;
  members: Repository<ProjectMember>;
  tasks: Repository<Task>;
  comments: Repository<TaskComment>;
  notifications: Repository<SharedNotification>;
}
export const PROJECT_NONUNIQUE_INDEXES = [
  { source: 'projects', indexStore: 'idx_projects_visibility', field: 'visibility' },
  { source: 'projects', indexStore: 'idx_projects_owner', field: 'ownerId' },
  { source: 'project_members', indexStore: 'idx_project_members_user', field: 'userId' },
  { source: 'project_members', indexStore: 'idx_project_members_project', field: 'projectId' },
  { source: 'tasks', indexStore: 'idx_tasks_project', field: 'projectId' },
] as const;
export function createProjectRepositories(
  engine: StorageEngine,
  core: CoreRepositories,
): ProjectRepositories {
  const projects = new BaseRepository<Project>(
    {
      store: 'projects',
      type: 'project',
      schemaVersion: 1,
      schema: projectSchema,
      clock: systemClock,
      indexes: [
        {
          name: 'idx_projects_key',
          source: 'projects',
          unique: true,
          indexKeys: (doc) => [doc.key],
          conflictCode: 'PROJECT_KEY_TAKEN',
        },
        {
          name: 'idx_projects_visibility',
          source: 'projects',
          unique: false,
          indexKeys: (doc) => [doc.visibility],
        },
        {
          name: 'idx_projects_owner',
          source: 'projects',
          unique: false,
          indexKeys: (doc) => [doc.ownerId],
        },
      ],
    },
    core.registry,
    engine,
  );
  const members = new BaseRepository<ProjectMember>(
    {
      store: 'project_members',
      type: 'project_member',
      schemaVersion: 1,
      schema: memberSchema,
      clock: systemClock,
      indexes: [
        {
          name: 'idx_project_members_key',
          source: 'project_members',
          unique: true,
          indexKeys: (doc) => [doc.membershipKey],
        },
        {
          name: 'idx_project_members_user',
          source: 'project_members',
          unique: false,
          indexKeys: (doc) => [doc.userId],
        },
        {
          name: 'idx_project_members_project',
          source: 'project_members',
          unique: false,
          indexKeys: (doc) => [doc.projectId],
        },
      ],
    },
    core.registry,
    engine,
  );
  const tasks = new BaseRepository<Task>(
    {
      store: 'tasks',
      type: 'task',
      schemaVersion: 1,
      schema: taskSchema,
      clock: systemClock,
      indexes: [
        { name: 'idx_tasks_key', source: 'tasks', unique: true, indexKeys: (doc) => [doc.taskKey] },
        {
          name: 'idx_tasks_project',
          source: 'tasks',
          unique: false,
          indexKeys: (doc) => [doc.projectId],
        },
      ],
    },
    core.registry,
    engine,
  );
  const comments = new BaseRepository<TaskComment>(
    {
      store: 'task_comments',
      type: 'task_comment',
      schemaVersion: 1,
      schema: taskCommentSchema,
      clock: systemClock,
      indexes: [],
    },
    core.registry,
    engine,
  );
  return { projects, members, tasks, comments, notifications: createSharedRecordRepositories(engine, core.registry).notifications };
}
async function all<T extends DocumentEnvelope>(
  repo: Repository<T>,
  tx: StorageTransaction,
  query: ListQuery,
): Promise<T[]> {
  const first = await repo.list({ ...query, page: 1, pageSize: 100 }, tx);
  const result = [...first.items];
  for (let page = 2; page <= Math.ceil(first.total / 100); page++)
    result.push(...(await repo.list({ ...query, page, pageSize: 100 }, tx)).items);
  return result;
}
const open = new Set(['todo', 'in_progress', 'in_review']);
const transitions: Record<Task['status'], readonly Task['status'][]> = {
  todo: ['in_progress', 'done', 'cancelled'],
  in_progress: ['in_review', 'done', 'cancelled'],
  in_review: ['in_progress', 'done', 'cancelled'],
  done: ['todo', 'in_progress'],
  cancelled: [],
};
const projectTransitions: Record<Project['status'], readonly Project['status'][]> = {
  planning: ['active', 'cancelled'],
  active: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['active', 'cancelled'],
  completed: ['archived'],
  cancelled: ['archived'],
  archived: [],
};
export class ProjectService {
  constructor(
    private readonly repos: ProjectRepositories,
    private readonly core: CoreRepositories,
    private readonly uow: UnitOfWork,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}
  private async actor(
    context: AuthContext,
    permission: string,
    tx: StorageTransaction,
  ): Promise<AuthContext> {
    const actor = await this.auth.loadCurrentActor(context, tx);
    if (!actor.permissions.includes(permission))
      throw new AppError('FORBIDDEN', '没有执行此操作的权限');
    return actor;
  }
  async updateProject(
    context: AuthContext,
    id: string,
    input: UpdateProject,
    ctx: AuditInput,
  ): Promise<Project> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'project:update', tx);
      const { project, member } = await this.project(id, actor, tx);
      this.requireWrite(project, member, ['owner', 'manager']);
      const startDate = input.startDate === undefined ? project.startDate : input.startDate;
      const dueDate = input.dueDate === undefined ? project.dueDate : input.dueDate;
      if (startDate && dueDate && startDate > dueDate)
        throw new AppError('VALIDATION_FAILED', '截止日期不能早于开始日期');
      const updated = await this.repos.projects.update(
        id,
        input.version,
        (current) => ({ ...current, ...input, version: current.version, startDate, dueDate }),
        tx,
      );
      await this.log(actor, 'project.updated', 'project', id, ctx, tx);
      return updated;
    });
  }
  async detailTask(context: AuthContext, id: string): Promise<Task> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'task:read', tx);
      const task = await this.repos.tasks.get(id, tx);
      if (!task || task.deletedAt !== null) throw new AppError('NOT_FOUND', '任务不存在');
      await this.project(task.projectId, actor, tx);
      return task;
    });
  }
  private async commentAccess(
    actor: AuthContext,
    taskId: string,
    tx: StorageTransaction,
  ): Promise<{ task: Task; project: Project; member?: ProjectMember }> {
    const task = await this.repos.tasks.get(taskId, tx);
    if (!task || task.deletedAt !== null) throw new AppError('NOT_FOUND', '任务不存在');
    return { task, ...(await this.project(task.projectId, actor, tx)) };
  }
  async listComments(
    context: AuthContext,
    taskId: string,
    page: number,
    pageSize: number,
  ): Promise<{ items: TaskComment[]; total: number }> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'task:read', tx);
      await this.commentAccess(actor, taskId, tx);
      const comments = (await all(this.repos.comments, tx, {}))
        .filter((item) => item.taskId === taskId && item.deletedAt === null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return {
        items: comments.slice((page - 1) * pageSize, page * pageSize),
        total: comments.length,
      };
    });
  }
  async createComment(
    context: AuthContext,
    taskId: string,
    content: string,
    ctx: AuditInput,
  ): Promise<TaskComment> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'task:comment', tx);
      const { project, member } = await this.commentAccess(actor, taskId, tx);
      this.requireWrite(project, member, ['owner', 'manager', 'member']);
      const comment = await this.repos.comments.create(
        { taskId, authorId: actor.user.id, content, editedAt: null, removedAt: null },
        tx,
      );
      await this.log(actor, 'task.comment_created', 'task_comment', comment.id, ctx, tx);
      return comment;
    });
  }
  async updateComment(
    context: AuthContext,
    id: string,
    version: number,
    content: string,
    ctx: AuditInput,
  ): Promise<TaskComment> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'task:comment', tx);
      const comment = await this.repos.comments.get(id, tx);
      if (!comment || comment.deletedAt !== null || comment.removedAt !== null)
        throw new AppError('NOT_FOUND', '评论不存在');
      const { project, member } = await this.commentAccess(actor, comment.taskId, tx);
      this.requireWrite(project, member, ['owner', 'manager', 'member']);
      if (comment.authorId !== actor.user.id) throw new AppError('FORBIDDEN', '只能编辑自己的评论');
      if (Date.now() - Date.parse(comment.createdAt) > 15 * 60 * 1000)
        throw new AppError('COMMENT_EDIT_WINDOW_EXPIRED', '评论已超过编辑时限');
      const updated = await this.repos.comments.update(
        id,
        version,
        (current) => ({ ...current, content, editedAt: new Date().toISOString() }),
        tx,
      );
      await this.log(actor, 'task.comment_updated', 'task_comment', id, ctx, tx);
      return updated;
    });
  }
  async deleteComment(
    context: AuthContext,
    id: string,
    version: number,
    reason: string | undefined,
    ctx: AuditInput,
  ): Promise<void> {
    return this.uow.run(async (tx) => {
      const actor = await this.auth.loadCurrentActor(context, tx);
      const comment = await this.repos.comments.get(id, tx);
      if (!comment || comment.deletedAt !== null || comment.removedAt !== null)
        throw new AppError('NOT_FOUND', '评论不存在');
      const { project, member } = await this.commentAccess(actor, comment.taskId, tx);
      this.requireWrite(project, member, ['owner', 'manager', 'member']);
      if (actor.user.id === comment.authorId) {
        if (!actor.permissions.includes('task:comment'))
          throw new AppError('FORBIDDEN', '没有评论权限');
      } else {
        if (
          !actor.permissions.includes('task:comment:moderate') ||
          !member ||
          (!['owner', 'manager'].includes(member.role) &&
            !actor.roles.some((role) => role.system && role.code === 'org_admin'))
        )
          throw new AppError('FORBIDDEN', '没有删除他人评论的权限');
        if (!reason) throw new AppError('VALIDATION_FAILED', '删除他人评论需要原因');
      }
      await this.repos.comments.update(
        id,
        version,
        (current) => ({ ...current, content: '', removedAt: new Date().toISOString() }),
        tx,
      );
      await this.log(
        actor,
        'task.comment_deleted',
        'task_comment',
        id,
        {
          ...ctx,
          metadata: { ...ctx.metadata, ...(reason ? { reason } : {}) },
        },
        tx,
      );
    });
  }
  async moveTask(
    context: AuthContext,
    id: string,
    input: BoardMove,
    ctx: AuditInput,
  ): Promise<{ task: Task; columns: Partial<Record<Task['status'], Task[]>> }> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'task:update', tx);
      const task = await this.repos.tasks.get(id, tx);
      if (!task || task.deletedAt !== null) throw new AppError('NOT_FOUND', '任务不存在');
      const { project, member } = await this.project(task.projectId, actor, tx);
      this.requireWrite(project, member, ['owner', 'manager', 'member']);
      const manager = member?.role === 'owner' || member?.role === 'manager';
      const creator = task.createdBy === actor.user.id;
      const assignee = task.assigneeId === actor.user.id;
      if (!manager && !creator && !assignee)
        throw new AppError('FORBIDDEN', '没有更新任务状态的权限');
      if (task.version !== input.version)
        throw new AppError('VERSION_CONFLICT', '任务已被其他操作更新');
      const status = input.targetStatus;
      if (
        task.status === 'cancelled' ||
        (status !== task.status && !transitions[task.status].includes(status))
      )
        throw new AppError('TASK_STATE_INVALID', '不允许此任务状态变更');
      if (
        status !== task.status &&
        (task.status === 'done' || (task.status === 'in_review' && status === 'in_progress')) &&
        !manager &&
        !assignee
      )
        throw new AppError('FORBIDDEN', '没有重新打开或退回任务的权限');
      const progress =
        status === 'done'
          ? 100
          : task.status === 'done'
            ? (input.progress ?? 0)
            : (input.progress ?? task.progress);
      if (
        (status === 'done' && input.progress !== undefined && input.progress !== 100) ||
        (status !== 'done' && progress === 100) ||
        (status === 'in_review' && progress === 0)
      )
        throw new AppError('TASK_PROGRESS_INVALID', '状态与进度不一致');
      const allTasks = (await all(this.repos.tasks, tx, {})).filter(
        (item) => item.projectId === project.id && item.deletedAt === null,
      );
      const order = (a: Task, b: Task): number =>
        (a.boardOrder ?? 0) - (b.boardOrder ?? 0) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id);
      const destination = allTasks
        .filter((item) => item.status === status && item.id !== id)
        .sort(order);
      const anchor=input.beforeTaskId ?? input.afterTaskId;
      const anchorIndex=anchor ? destination.findIndex((item)=>item.id===anchor) : -1;
      if (anchor && anchorIndex<0) throw new AppError('VERSION_CONFLICT','相邻任务已变化，请刷新看板');
      const insertion=anchor ? anchorIndex+(input.afterTaskId ? 1 : 0) : input.targetIndex;
      if (insertion > destination.length)
        throw new AppError('VALIDATION_FAILED', '目标位置超出列范围');
      const moved = await this.repos.tasks.update(
        id,
        input.version,
        (current) => ({
          ...current,
          status,
          progress,
          completedAt: status === 'done' ? (current.completedAt ?? new Date().toISOString()) : null,
        }),
        tx,
      );
      destination.splice(insertion, 0, moved);
      const columns: Partial<Record<Task['status'], Task[]>> = {};
      const sequences: { status: Task['status']; items: Task[] }[] = [
        { status, items: destination },
      ];
      if (task.status !== status)
        sequences.push({
          status: task.status,
          items: allTasks
            .filter((item) => item.status === task.status && item.id !== id)
            .sort(order),
        });
      let result = moved;
      for (const sequence of sequences) {
        const saved: Task[] = [];
        for (const [index, item] of sequence.items.entries()) {
          const boardOrder = (index + 1) * 1024;
          const next =
            item.boardOrder === boardOrder
              ? item
              : await this.repos.tasks.update(
                  item.id,
                  item.version,
                  (current) => ({ ...current, boardOrder }),
                  tx,
                );
          saved.push(next);
          if (next.id === id) result = next;
        }
        columns[sequence.status] = saved;
      }
      await this.log(actor, 'task.board_moved', 'task', id, ctx, tx);
      return { task: result, columns };
    });
  }
  async deleteProject(
    context: AuthContext,
    id: string,
    version: number,
    ctx: AuditInput,
  ): Promise<void> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'project:delete', tx);
      const { project, member } = await this.project(id, actor, tx);
      if (!member || !actor.roles.some((role) => role.system && role.code === 'org_admin'))
        throw new AppError('FORBIDDEN', '只有项目成员中的组织管理员可删除项目');
      if (
        (await all(this.repos.tasks, tx, {})).some(
          (task) => task.projectId === project.id && open.has(task.status),
        )
      )
        throw new AppError('PROJECT_HAS_OPEN_TASKS', '项目仍有未完成任务');
      await this.repos.projects.softDelete(id, version, tx);
      await this.log(actor, 'project.deleted', 'project', id, ctx, tx);
    });
  }
  async updateMember(
    context: AuthContext,
    id: string,
    userId: string,
    role: 'manager' | 'member' | 'viewer',
    version: number,
    ctx: AuditInput,
  ): Promise<ProjectMember> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'project:member:manage', tx);
      const { project, member } = await this.project(id, actor, tx);
      this.requireWrite(project, member, ['owner', 'manager']);
      const target = await this.repos.members.getByUniqueIndex(
        'idx_project_members_key',
        `${id}:${userId}`,
        tx,
      );
      if (
        !target ||
        target.deletedAt !== null ||
        target.projectId !== id ||
        target.userId !== userId
      )
        throw new AppError('NOT_FOUND', '项目成员不存在');
      if (target.role === 'owner' || project.ownerId === userId)
        throw new AppError('FORBIDDEN', '项目负责人必须通过转让修改');
      if (member?.role === 'manager' && (target.role === 'manager' || role === 'manager'))
        throw new AppError('FORBIDDEN', '经理不能修改或任命经理');
      const updated = await this.repos.members.update(
        target.id,
        version,
        (current) => ({ ...current, role }),
        tx,
      );
      await this.log(actor, 'project.member_updated', 'project', id, ctx, tx);
      await this.notify(actor, userId, id, 'project_member_updated', '你的项目角色已更新', tx);
      return updated;
    });
  }
  async deleteTask(
    context: AuthContext,
    id: string,
    version: number,
    ctx: AuditInput,
  ): Promise<void> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'task:delete', tx);
      const task = await this.repos.tasks.get(id, tx);
      if (!task || task.deletedAt !== null) throw new AppError('NOT_FOUND', '任务不存在');
      const { project, member } = await this.project(task.projectId, actor, tx);
      this.requireWrite(project, member, ['owner', 'manager']);
      await this.repos.tasks.softDelete(id, version, tx);
      await this.log(actor, 'task.deleted', 'task', id, ctx, tx);
    });
  }
  private async project(
    id: string,
    actor: AuthContext,
    tx: StorageTransaction,
  ): Promise<{ project: Project; member?: ProjectMember }> {
    const project = await this.repos.projects.get(id, tx);
    if (!project || project.deletedAt !== null) throw new AppError('NOT_FOUND', '项目不存在');
    const indexedMember = await this.repos.members.getByUniqueIndex(
      'idx_project_members_key',
      `${id}:${actor.user.id}`,
      tx,
    );
    const member =
      indexedMember &&
      indexedMember.deletedAt === null &&
      indexedMember.projectId === id &&
      indexedMember.userId === actor.user.id
        ? indexedMember
        : undefined;
    if (project.visibility === 'private' && !member) throw new AppError('NOT_FOUND', '项目不存在');
    return { project, ...(member ? { member } : {}) };
  }
  private requireWrite(
    project: Project,
    member: ProjectMember | undefined,
    roles: readonly ProjectMember['role'][],
  ): void {
    if (!member || !roles.includes(member.role))
      throw new AppError('FORBIDDEN', '项目角色无权执行此操作');
    if (['completed', 'cancelled', 'archived'].includes(project.status))
      throw new AppError('PROJECT_STATE_INVALID', '项目已处于只读状态');
  }
  private async log(
    actor: AuthContext,
    action: string,
    resourceType: string,
    resourceId: string,
    ctx: AuditInput,
    tx: StorageTransaction,
  ): Promise<void> {
    await this.audit.append(
      { ...ctx, actorUserId: actor.user.id, action, resourceType, resourceId },
      tx,
    );
  }
  private async notify(actor: AuthContext, recipientId: string | null, projectId: string, notificationType: string, title: string, tx: StorageTransaction): Promise<void> {
    if (!recipientId || recipientId === actor.user.id) return;
    const user = await this.core.users.get(recipientId, tx);
    if (!user || user.deletedAt !== null || user.status !== 'active') return;
    const permissions = new Set<string>();
    for (const roleId of user.roleIds) {
      const role = await this.core.roles.get(roleId, tx);
      if (role && role.deletedAt === null) for (const code of role.permissionCodes) permissions.add(code);
    }
    if (!permissions.has('project:read') || !permissions.has('workbench:read')) return;
    await this.repos.notifications.create({ namespace: 'projects', recipientId, notificationType, title, content: '', linkPath: `/app/projects?project=${projectId}`, readAt: null }, tx);
  }
  async list(
    context: AuthContext,
    page: number,
    pageSize: number,
  ): Promise<{ items: Project[]; total: number }> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'project:read', tx);
      const members = await all(this.repos.members, tx, {
        indexName: 'idx_project_members_user',
        prefix: actor.user.id,
      });
      const visible = await all(this.repos.projects, tx, {
        indexName: 'idx_projects_visibility',
        prefix: 'organization',
      });
      const byId = new Map(
        visible
          .filter((p) => p.deletedAt === null && p.visibility === 'organization')
          .map((p) => [p.id, p]),
      );
      for (const member of members) {
        if (member.deletedAt !== null || member.userId !== actor.user.id) continue;
        const project = await this.repos.projects.get(member.projectId, tx);
        if (project && project.deletedAt === null) byId.set(project.id, project);
      }
      const filtered = [...byId.values()]
        .filter((p) => p.status !== 'archived')
        .sort((a, b) => a.id.localeCompare(b.id));
      return {
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
        total: filtered.length,
      };
    });
  }
  async detail(context: AuthContext, id: string): Promise<Project> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'project:read', tx);
      return (await this.project(id, actor, tx)).project;
    });
  }
  async create(context: AuthContext, input: CreateProject, ctx: AuditInput): Promise<Project> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'project:create', tx);
      if (await this.repos.projects.existsStored((item) => item.key === input.key, tx))
        throw new AppError('PROJECT_KEY_TAKEN', '项目短键已被使用，删除后也不可复用');
      const project = await this.repos.projects.create(
        {
          name: input.name,
          key: input.key,
          description: input.description ?? '',
          visibility: input.visibility,
          status: 'planning',
          ownerId: actor.user.id,
          statusReason: null,
          taskSeq: 0,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
        },
        tx,
      );
      await this.repos.members.create(
        {
          projectId: project.id,
          userId: actor.user.id,
          role: 'owner',
          membershipKey: `${project.id}:${actor.user.id}`,
        },
        tx,
      );
      await this.log(actor, 'project.created', 'project', project.id, ctx, tx);
      return project;
    });
  }
  async transition(
    context: AuthContext,
    id: string,
    input: TransitionProject,
    ctx: AuditInput,
  ): Promise<Project> {
    return this.uow.run(async (tx) => {
      const permission = ['cancelled', 'archived'].includes(input.targetStatus)
        ? 'project:archive'
        : 'project:update';
      const actor = await this.actor(context, permission, tx);
      const { project, member } = await this.project(id, actor, tx);
      const orgAdmin = actor.roles.some((role) => role.system && role.code === 'org_admin');
      if (
        !member ||
        (!(
          ['cancelled', 'archived'].includes(input.targetStatus) ? ['owner'] : ['owner', 'manager']
        ).includes(member.role) &&
          !orgAdmin)
      )
        throw new AppError('FORBIDDEN', '项目角色无权执行此操作');
      if (!projectTransitions[project.status].includes(input.targetStatus))
        throw new AppError('PROJECT_STATE_INVALID', '不允许此状态变更');
      if (['cancelled', 'on_hold'].includes(input.targetStatus) && !input.reason)
        throw new AppError('VALIDATION_FAILED', '请填写变更原因');
      if (
        input.targetStatus === 'completed' &&
        (await all(this.repos.tasks, tx, {})).some(
          (task) => task.projectId === id && open.has(task.status),
        )
      )
        throw new AppError('PROJECT_HAS_OPEN_TASKS', '项目仍有未完成任务');
      const updated = await this.repos.projects.update(
        id,
        input.version,
        (p) => ({ ...p, status: input.targetStatus, statusReason: input.reason ?? null }),
        tx,
      );
      await this.log(actor, 'project.transitioned', 'project', id, ctx, tx);
      return updated;
    });
  }
  async listTasks(context: AuthContext, id: string): Promise<Task[]> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'task:read', tx);
      await this.project(id, actor, tx);
      return (await all(this.repos.tasks, tx, { indexName: 'idx_tasks_project', prefix: id }))
        .filter((task) => task.projectId === id && task.deletedAt === null)
        .sort(
          (a, b) =>
            (a.boardOrder ?? 0) - (b.boardOrder ?? 0) ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        );
    });
  }
  async createTask(
    context: AuthContext,
    id: string,
    input: CreateTask,
    ctx: AuditInput,
  ): Promise<Task> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'task:create', tx);
      const { project, member } = await this.project(id, actor, tx);
      this.requireWrite(project, member, ['owner', 'manager', 'member']);
      if (project.status !== 'active')
        throw new AppError('PROJECT_STATE_INVALID', '只有进行中的项目可以创建任务');
      if (input.assigneeId) {
        if (
          !member ||
          !['owner', 'manager'].includes(member.role) ||
          !actor.permissions.includes('task:assign')
        )
          throw new AppError('FORBIDDEN', '没有分配任务的权限');
        await this.activeMember(id, input.assigneeId, tx);
      }
      if (!Number.isSafeInteger(project.taskSeq + 1))
        throw new AppError('STORAGE_CORRUPTED', '任务序号已耗尽');
      const next = await this.repos.projects.update(
        id,
        project.version,
        (p) => ({ ...p, taskSeq: p.taskSeq + 1 }),
        tx,
      );
      const task = await this.repos.tasks.create(
        {
          projectId: id,
          taskNo: next.taskSeq,
          taskKey: `${project.key}-${next.taskSeq}`,
          title: input.title,
          description: input.description ?? '',
          status: 'todo',
          progress: 0,
          priority: input.priority ?? 'medium',
          assigneeId: input.assigneeId ?? null,
          createdBy: actor.user.id,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          completedAt: null,
        },
        tx,
      );
      await this.log(actor, 'task.created', 'task', task.id, ctx, tx);
      await this.notify(actor, task.assigneeId, id, 'task_assigned', '你有新的项目任务', tx);
      return task;
    });
  }
  private async activeMember(
    projectId: string,
    userId: string,
    tx: StorageTransaction,
  ): Promise<void> {
    const member = await this.repos.members.getByUniqueIndex(
      'idx_project_members_key',
      `${projectId}:${userId}`,
      tx,
    );
    const user = await this.core.users.get(userId, tx);
    if (
      !member ||
      member.deletedAt !== null ||
      member.projectId !== projectId ||
      member.userId !== userId ||
      !user ||
      user.deletedAt !== null ||
      user.status !== 'active'
    )
      throw new AppError('VALIDATION_FAILED', '负责人必须为有效项目成员');
  }
  async updateTask(
    context: AuthContext,
    id: string,
    input: UpdateTask,
    ctx: AuditInput,
  ): Promise<Task> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'task:update', tx);
      const task = await this.repos.tasks.get(id, tx);
      if (!task || task.deletedAt !== null) throw new AppError('NOT_FOUND', '任务不存在');
      const { project, member } = await this.project(task.projectId, actor, tx);
      this.requireWrite(project, member, ['owner', 'manager', 'member']);
      const manager = member?.role === 'owner' || member?.role === 'manager';
      const creator = task.createdBy === actor.user.id;
      const assigned = task.assigneeId === actor.user.id;
      if (
        (input.title !== undefined ||
          input.description !== undefined ||
          input.priority !== undefined ||
          input.startDate !== undefined ||
          input.dueDate !== undefined) &&
        !manager &&
        !creator
      )
        throw new AppError('FORBIDDEN', '没有编辑任务字段的权限');
      if (
        (input.status !== undefined || input.progress !== undefined) &&
        !manager &&
        !creator &&
        !assigned
      )
        throw new AppError('FORBIDDEN', '没有更新任务状态的权限');
      if (input.assigneeId !== undefined) {
        if (!manager || !actor.permissions.includes('task:assign'))
          throw new AppError('FORBIDDEN', '没有分配任务的权限');
        if (input.assigneeId) await this.activeMember(project.id, input.assigneeId, tx);
      }
      const status = input.status ?? task.status;
      if (status !== task.status && !transitions[task.status].includes(status))
        throw new AppError('TASK_STATE_INVALID', '不允许此任务状态变更');
      if (
        status !== task.status &&
        (task.status === 'done' || (task.status === 'in_review' && status === 'in_progress')) &&
        !manager &&
        !assigned
      )
        throw new AppError('FORBIDDEN', '没有重新打开或退回任务的权限');
      if (task.status === 'cancelled')
        throw new AppError('TASK_STATE_INVALID', '已取消的任务不可修改');
      const progress =
        status === 'done'
          ? 100
          : task.status === 'done'
            ? (input.progress ?? 0)
            : (input.progress ?? task.progress);
      if (
        (status === 'done' && input.progress !== undefined && input.progress !== 100) ||
        (status !== 'done' && status !== 'cancelled' && progress === 100) ||
        (status === 'in_review' && progress === 0) ||
        (status === 'cancelled' && input.progress !== undefined && input.progress !== task.progress)
      )
        throw new AppError('TASK_PROGRESS_INVALID', '状态与进度不一致');
      const startDate = input.startDate === undefined ? task.startDate : input.startDate;
      const dueDate = input.dueDate === undefined ? task.dueDate : input.dueDate;
      if (startDate && dueDate && startDate > dueDate)
        throw new AppError('VALIDATION_FAILED', '截止日期不能早于开始日期');
      const updated = await this.repos.tasks.update(
        id,
        input.version,
        (t) => ({
          ...t,
          ...input,
          version: t.version,
          status,
          progress,
          startDate,
          dueDate,
          completedAt: status === 'done' ? (t.completedAt ?? new Date().toISOString()) : null,
        }),
        tx,
      );
      await this.log(actor, 'task.updated', 'task', id, ctx, tx);
      if (updated.assigneeId !== task.assigneeId) await this.notify(actor, updated.assigneeId, task.projectId, 'task_assigned', '你有新的项目任务', tx);
      if (updated.status !== task.status) await this.notify(actor, task.createdBy, task.projectId, 'task_status_changed', '项目任务状态已更新', tx);
      return updated;
    });
  }
  async addMember(
    context: AuthContext,
    id: string,
    input: CreateMember,
    ctx: AuditInput,
  ): Promise<ProjectMember> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'project:member:manage', tx);
      const { project, member } = await this.project(id, actor, tx);
      this.requireWrite(project, member, ['owner', 'manager']);
      if (member?.role === 'manager' && input.role === 'manager')
        throw new AppError('FORBIDDEN', '经理不能添加经理');
      const user = await this.core.users.get(input.userId, tx);
      if (!user || user.deletedAt !== null || user.status !== 'active')
        throw new AppError('VALIDATION_FAILED', '成员必须是有效用户');
      const existing = await this.repos.members.getByUniqueIndex(
        'idx_project_members_key',
        `${id}:${input.userId}`,
        tx,
      );
      if (existing) return existing;
      const created = await this.repos.members.create(
        {
          projectId: id,
          userId: input.userId,
          role: input.role,
          membershipKey: `${id}:${input.userId}`,
        },
        tx,
      );
      await this.log(actor, 'project.member_added', 'project', id, ctx, tx);
      await this.notify(actor, input.userId, id, 'project_member_added', '你已加入一个项目', tx);
      return created;
    });
  }
  async listMembers(
    context: AuthContext,
    id: string,
  ): Promise<{ userId: string; name: string; role: ProjectMember['role']; version: number }[]> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'project:read', tx);
      await this.project(id, actor, tx);
      const results: {
        userId: string;
        name: string;
        role: ProjectMember['role'];
        version: number;
      }[] = [];
      for (const member of await all(this.repos.members, tx, {
        indexName: 'idx_project_members_project',
        prefix: id,
      })) {
        if (member.deletedAt !== null || member.projectId !== id) continue;
        const user = await this.core.users.get(member.userId, tx);
        if (user && user.deletedAt === null)
          results.push({
            userId: user.id,
            name: user.name,
            role: member.role,
            version: member.version,
          });
      }
      return results;
    });
  }
  async transferOwner(
    context: AuthContext,
    id: string,
    userId: string,
    version: number,
    ctx: AuditInput,
  ): Promise<Project> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'project:owner:transfer', tx);
      const { project, member } = await this.project(id, actor, tx);
      this.requireWrite(project, member, ['owner', 'manager', 'member', 'viewer']);
      if (
        member?.role !== 'owner' &&
        !actor.roles.some((role) => role.code === 'org_admin' && role.system)
      )
        throw new AppError('FORBIDDEN', '只有项目负责人或组织管理员可以转让');
      if (userId === project.ownerId)
        throw new AppError('VALIDATION_FAILED', '新负责人必须与当前负责人不同');
      await this.activeMember(id, userId, tx);
      const nextMember = await this.repos.members.getByUniqueIndex(
        'idx_project_members_key',
        `${id}:${userId}`,
        tx,
      );
      const oldMember = await this.repos.members.getByUniqueIndex(
        'idx_project_members_key',
        `${id}:${project.ownerId}`,
        tx,
      );
      if (!oldMember || !nextMember || oldMember.role !== 'owner')
        throw new AppError('STORAGE_CORRUPTED', '项目负责人关系不一致');
      const updated = await this.repos.projects.update(
        id,
        version,
        (p) => ({ ...p, ownerId: userId }),
        tx,
      );
      await this.repos.members.update(
        oldMember.id,
        oldMember.version,
        (m) => ({ ...m, role: 'manager' }),
        tx,
      );
      await this.repos.members.update(
        nextMember.id,
        nextMember.version,
        (m) => ({ ...m, role: 'owner' }),
        tx,
      );
      await this.log(actor, 'project.owner_transferred', 'project', id, ctx, tx);
      return updated;
    });
  }
  async removeMember(
    context: AuthContext,
    id: string,
    userId: string,
    version: number,
    ctx: AuditInput,
  ): Promise<void> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'project:member:manage', tx);
      const { project, member } = await this.project(id, actor, tx);
      this.requireWrite(project, member, ['owner', 'manager']);
      const target = await this.repos.members.getByUniqueIndex(
        'idx_project_members_key',
        `${id}:${userId}`,
        tx,
      );
      if (!target) throw new AppError('NOT_FOUND', '项目成员不存在');
      if (target.role === 'owner' || project.ownerId === userId)
        throw new AppError('FORBIDDEN', '项目负责人不能直接移除');
      if (member?.role === 'manager' && target.role === 'manager')
        throw new AppError('FORBIDDEN', '经理不能移除经理');
      if (
        (await all(this.repos.tasks, tx, {})).some(
          (task) => task.projectId === id && task.assigneeId === userId && open.has(task.status),
        )
      )
        throw new AppError('VERSION_CONFLICT', '成员仍有未完成任务');
      await this.repos.members.softDelete(target.id, version, tx);
      await this.log(actor, 'project.member_removed', 'project', id, ctx, tx);
      await this.notify(actor, userId, id, 'project_member_removed', '你的项目成员关系已变更', tx);
    });
  }
}
