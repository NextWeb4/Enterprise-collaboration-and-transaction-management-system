import { AppError } from '../../shared/errors.js';
import { systemClock, type Clock } from '../../shared/clock.js';
import type { DocumentEnvelope } from '../../storage/envelope.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { AuthContext, AuthService } from '../core/auth-service.js';
import type { AuditInput, AuditService } from '../core/audit-service.js';
import type { CoreRepositories } from '../core/repositories.js';
import type { Project, ProjectMember, ProjectRepositories } from '../projects/project-service.js';
import type { CalendarEvent } from './models.js';
import type { CalendarRepositories } from './repositories.js';

export interface CalendarInput {
  readonly kind: CalendarEvent['kind'];
  readonly projectId?: string | null;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly reminderMinutes?: CalendarEvent['reminderMinutes'];
  readonly participantIds?: readonly string[];
}

export interface CalendarConflict {
  readonly userId: string;
  readonly startAt: string;
  readonly endAt: string;
}
export type CalendarAuditContext = Pick<AuditInput, 'requestId' | 'ip' | 'userAgent'>;

async function all<T extends DocumentEnvelope>(
  repository: { list(query: { page: number; pageSize: number }, tx: StorageTransaction): Promise<{ items: readonly T[]; total: number }> },
  tx: StorageTransaction,
): Promise<T[]> {
  const first = await repository.list({ page: 1, pageSize: 100 }, tx);
  const result = [...first.items];
  for (let page = 2; page <= Math.ceil(first.total / 100); page++) result.push(...(await repository.list({ page, pageSize: 100 }, tx)).items);
  return result;
}

export class CalendarService {
  constructor(
    private readonly repos: CalendarRepositories,
    private readonly core: CoreRepositories,
    private readonly projects: ProjectRepositories,
    private readonly uow: UnitOfWork,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly clock: Clock = systemClock,
  ) {}

  private async actor(context: AuthContext, permission: string, tx: StorageTransaction): Promise<AuthContext> {
    const actor = await this.auth.loadCurrentActor(context, tx);
    if (!actor.permissions.includes(permission)) throw new AppError('FORBIDDEN', '没有执行此操作的权限');
    return actor;
  }

  private async projectMember(
    projectId: string,
    userId: string,
    tx: StorageTransaction,
  ): Promise<{ project: Project; member: ProjectMember }> {
    const project = await this.projects.projects.get(projectId, tx);
    const member = await this.projects.members.getByUniqueIndex('idx_project_members_key', `${projectId}:${userId}`, tx);
    if (!project || project.deletedAt !== null || !member || member.deletedAt !== null) throw new AppError('NOT_FOUND', '项目日程不存在或无权访问');
    return { project, member };
  }

  private async canReadEvent(event: CalendarEvent, actor: AuthContext, tx: StorageTransaction): Promise<boolean> {
    if (event.projectId) {
      if (!actor.permissions.includes('project:read')) return false;
      try { await this.projectMember(event.projectId, actor.user.id, tx); } catch { return false; }
    }
    if (event.ownerId === actor.user.id || event.participants.some((participant) => participant.userId === actor.user.id)) return true;
    return !!event.projectId;
  }

  private async requireReadable(eventId: string, actor: AuthContext, tx: StorageTransaction): Promise<CalendarEvent> {
    const event = await this.repos.events.get(eventId, tx);
    if (!event || event.deletedAt !== null || !await this.canReadEvent(event, actor, tx)) throw new AppError('NOT_FOUND', '日程不存在或无权访问');
    if (event.projectId && !actor.permissions.includes('project:read')) throw new AppError('NOT_FOUND', '日程不存在或无权访问');
    return event;
  }

  private async requireWritable(event: CalendarEvent, actor: AuthContext, tx: StorageTransaction): Promise<void> {
    if (event.ownerId === actor.user.id) return;
    if (event.projectId && actor.permissions.includes('project:update')) {
      const { project, member } = await this.projectMember(event.projectId, actor.user.id, tx);
      if (project.status !== 'archived' && ['owner', 'manager'].includes(member.role)) return;
    }
    throw new AppError('FORBIDDEN', '仅组织者或项目管理者可修改此日程');
  }

  private async validateProject(input: CalendarInput, actor: AuthContext, tx: StorageTransaction): Promise<void> {
    if (!input.projectId) return;
    if (!actor.permissions.includes('project:read')) throw new AppError('FORBIDDEN');
    const { project } = await this.projectMember(input.projectId, actor.user.id, tx);
    if (project.status === 'archived' || project.status === 'completed' || project.status === 'cancelled') throw new AppError('VERSION_CONFLICT', '已结束或归档项目的日程只读');
  }

  private async validateParticipants(ids: readonly string[], actor: AuthContext, projectId: string | null, tx: StorageTransaction): Promise<void> {
    if (ids.length > 50 || new Set(ids).size !== ids.length || ids.includes(actor.user.id)) throw new AppError('VALIDATION_FAILED', '参与人列表无效');
    if (ids.length > 0 && !actor.permissions.includes('calendar:invite')) throw new AppError('FORBIDDEN', '没有邀请会议参与人的权限');
    for (const userId of ids) {
      const user = await this.core.users.get(userId, tx);
      if (!user || user.deletedAt !== null || user.status !== 'active') throw new AppError('VALIDATION_FAILED', '参与人必须是有效的内部账号');
      if (projectId) {
        try { await this.projectMember(projectId, userId, tx); } catch { throw new AppError('VALIDATION_FAILED', '项目会议参与人必须是项目成员'); }
      }
    }
  }

  private async conflicts(startAt: string, endAt: string, userIds: readonly string[], exceptId: string | null, tx: StorageTransaction): Promise<CalendarConflict[]> {
    const relevant = new Set(userIds);
    const events = await all(this.repos.events, tx);
    const conflicts: CalendarConflict[] = [];
    for (const event of events) {
      if (event.deletedAt !== null || event.id === exceptId || Date.parse(event.startAt) >= Date.parse(endAt) || Date.parse(event.endAt) <= Date.parse(startAt)) continue;
      const attending = [event.ownerId, ...event.participants.filter((participant) => participant.response !== 'declined').map((participant) => participant.userId)];
      for (const userId of attending) if (relevant.has(userId)) conflicts.push({ userId, startAt: event.startAt, endAt: event.endAt });
    }
    return conflicts;
  }

  private async notify(recipientId: string, event: CalendarEvent, type: string, tx: StorageTransaction): Promise<void> {
    await this.repos.notifications.create({ namespace: 'calendar', recipientId, notificationType: type, title: type === 'calendar_invitation' ? '会议邀请' : type === 'calendar_response' ? '会议响应已更新' : '日程提醒', content: '', linkPath: `/app/calendar?event=${encodeURIComponent(event.id)}`, readAt: null }, tx);
  }

  private async writeAudit(actor: AuthContext, action: string, event: CalendarEvent, audit: CalendarAuditContext, tx: StorageTransaction): Promise<void> {
    await this.audit.append({ ...audit, actorUserId: actor.user.id, action, resourceType: 'calendar_event', resourceId: event.id, metadata: { kind: event.kind, hasProject: !!event.projectId } }, tx);
  }

  async list(context: AuthContext, range: { from: string; to: string; projectId?: string }): Promise<{ data: CalendarEvent[]; conflicts: CalendarConflict[]; timezone: string }> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'calendar:read', tx);
      if (!Number.isFinite(Date.parse(range.from)) || !Number.isFinite(Date.parse(range.to)) || Date.parse(range.from) >= Date.parse(range.to) || Date.parse(range.to) - Date.parse(range.from) > 93 * 86_400_000) throw new AppError('VALIDATION_FAILED', '日历范围无效（最多 93 天）');
      const organizations = await this.core.organizations.list({ page: 1, pageSize: 1 }, tx);
      const timezone = organizations.items[0]?.timezone;
      if (!timezone) throw new AppError('STORAGE_CORRUPTED', '组织时区配置不存在');
      await this.deliverDueReminders(actor, tx);
      const events = (await all(this.repos.events, tx)).filter((event) => event.deletedAt === null && Date.parse(event.startAt) < Date.parse(range.to) && Date.parse(event.endAt) > Date.parse(range.from) && (!range.projectId || event.projectId === range.projectId) && (!event.projectId || actor.permissions.includes('project:read')) && this.eventAudience(event, actor.user.id));
      const visible: CalendarEvent[] = [];
      for (const event of events) if (await this.canReadEvent(event, actor, tx)) visible.push(event);
      return { data: visible.sort((a, b) => a.startAt.localeCompare(b.startAt)), conflicts: [], timezone };
    });
  }

  private eventAudience(event: CalendarEvent, userId: string): boolean {
    return event.ownerId === userId || event.participants.some((participant) => participant.userId === userId) || event.projectId !== null;
  }

  private reminderIsDue(event: CalendarEvent, now: number): boolean {
    if (event.deletedAt !== null || event.reminderMinutes === null) return false;
    const startAt = Date.parse(event.startAt);
    const reminderAt = startAt - event.reminderMinutes * 60_000;
    return Number.isFinite(startAt) && now >= reminderAt && now < startAt;
  }

  private reminderRecipients(event: CalendarEvent): string[] {
    return [
      event.ownerId,
      ...event.participants
        .filter((participant) => participant.response !== 'declined')
        .map((participant) => participant.userId),
    ];
  }

  private async recipientCanReadReminder(
    event: CalendarEvent,
    recipientId: string,
    tx: StorageTransaction,
  ): Promise<boolean> {
    const user = await this.core.users.get(recipientId, tx);
    if (!user || user.deletedAt !== null || user.status !== 'active') return false;

    const roles = await Promise.all(user.roleIds.map((roleId) => this.core.roles.get(roleId, tx)));
    const activeRoles = roles.filter(
      (role): role is Exclude<typeof role, undefined> => role !== undefined && role.deletedAt === null,
    );
    const permissions = new Set(
      activeRoles.flatMap((role) => role.permissionCodes),
    );
    if (!permissions.has('calendar:read')) return false;
    if (!event.projectId) return true;
    if (!permissions.has('project:read')) return false;

    const project = await this.projects.projects.get(event.projectId, tx);
    const member = await this.projects.members.getByUniqueIndex(
      'idx_project_members_key',
      `${event.projectId}:${recipientId}`,
      tx,
    );
    return !!project && project.deletedAt === null && !!member && member.deletedAt === null;
  }

  private async deliverReminder(
    event: CalendarEvent,
    recipientId: string,
    tx: StorageTransaction,
  ): Promise<boolean> {
    if (!this.reminderIsDue(event, this.clock.now().getTime())) return false;
    if (!this.reminderRecipients(event).includes(recipientId)) return false;
    if (!await this.recipientCanReadReminder(event, recipientId, tx)) return false;

    const deliveryKey = `${event.id}:${recipientId}:${event.startAt}:${event.reminderMinutes}`;
    if (await this.repos.reminders.getByUniqueIndex('idx_calendar_reminder_delivery_key', deliveryKey, tx)) return false;
    await this.repos.reminders.create(
      { deliveryKey, eventId: event.id, recipientId } as Omit<import('./models.js').ReminderDelivery, keyof DocumentEnvelope>,
      tx,
    );
    await this.notify(recipientId, event, 'calendar_reminder', tx);
    await this.audit.append(
      {
        actorUserId: null,
        action: 'calendar.reminder_delivered',
        resourceType: 'calendar_event',
        resourceId: event.id,
        metadata: {
          reminderMinutes: event.reminderMinutes,
          recipientIsOwner: event.ownerId === recipientId,
        },
      },
      tx,
    );
    return true;
  }

  /**
   * Delivers all currently due reminders. Every candidate is committed in its
   * own transaction so one bad record cannot prevent later reminders from
   * being retried by the next scheduler tick.
   */
  async deliverDueRemindersForAllActiveUsers(): Promise<number> {
    const candidates = await this.uow.run(async (tx) => {
      const now = this.clock.now().getTime();
      const events = await all(this.repos.events, tx);
      return events
        .filter((event) => this.reminderIsDue(event, now))
        .flatMap((event) => this.reminderRecipients(event).map((recipientId) => ({ eventId: event.id, recipientId })));
    });

    let delivered = 0;
    let failures = 0;
    for (const candidate of candidates) {
      try {
        const wasDelivered = await this.uow.run(async (tx) => {
          const event = await this.repos.events.get(candidate.eventId, tx);
          if (!event) return false;
          return this.deliverReminder(event, candidate.recipientId, tx);
        });
        if (wasDelivered) delivered += 1;
      } catch {
        failures += 1;
      }
    }
    if (failures > 0) throw new Error(`calendar reminder delivery failed for ${failures} candidate(s)`);
    return delivered;
  }

  private async deliverDueReminders(actor: AuthContext, tx: StorageTransaction): Promise<void> {
    const events = await all(this.repos.events, tx);
    for (const event of events) {
      if (!await this.canReadEvent(event, actor, tx)) continue;
      await this.deliverReminder(event, actor.user.id, tx);
    }
  }

  async create(context: AuthContext, input: CalendarInput, audit: CalendarAuditContext): Promise<{ data: CalendarEvent; conflicts: CalendarConflict[] }> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'calendar:create', tx);
      await this.validateProject(input, actor, tx);
      if (input.kind !== 'meeting' && (input.participantIds?.length ?? 0) > 0) throw new AppError('VALIDATION_FAILED', '只有会议可以邀请参与人');
      const participantIds = input.participantIds ?? [];
      await this.validateParticipants(participantIds, actor, input.projectId ?? null, tx);
      const event = await this.repos.events.create({ ownerId: actor.user.id, projectId: input.projectId ?? null, kind: input.kind, title: input.title, description: input.description ?? '', location: input.location ?? '', startAt: input.startAt, endAt: input.endAt, reminderMinutes: input.reminderMinutes ?? null, participants: participantIds.map((userId) => ({ userId, response: 'pending' as const, respondedAt: null })) } as Omit<CalendarEvent, keyof DocumentEnvelope>, tx);
      for (const userId of participantIds) await this.notify(userId, event, 'calendar_invitation', tx);
      const conflicts = await this.conflicts(event.startAt, event.endAt, [actor.user.id, ...participantIds], event.id, tx);
      await this.writeAudit(actor, 'calendar.created', event, audit, tx);
      return { data: event, conflicts };
    });
  }

  async detail(context: AuthContext, eventId: string): Promise<CalendarEvent> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'calendar:read', tx);
      return this.requireReadable(eventId, actor, tx);
    });
  }

  async update(context: AuthContext, eventId: string, version: number, input: CalendarInput, audit: CalendarAuditContext): Promise<{ data: CalendarEvent; conflicts: CalendarConflict[] }> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'calendar:update', tx);
      const current = await this.requireReadable(eventId, actor, tx);
      await this.requireWritable(current, actor, tx);
      await this.validateProject(input, actor, tx);
      if ((input.projectId ?? null) !== current.projectId) throw new AppError('VALIDATION_FAILED', '日程创建后不可更改关联项目');
      if (input.kind !== 'meeting' && (input.participantIds?.length ?? 0) > 0) throw new AppError('VALIDATION_FAILED', '只有会议可以邀请参与人');
      const participantIds = input.participantIds ?? current.participants.filter((participant) => participant.response !== 'declined').map((participant) => participant.userId);
      await this.validateParticipants(participantIds, actor, current.projectId, tx);
      const prior = new Map(current.participants.map((participant) => [participant.userId, participant]));
      const event = await this.repos.events.update(eventId, version, (value) => ({ ...value, kind: input.kind, title: input.title, description: input.description ?? '', location: input.location ?? '', startAt: input.startAt, endAt: input.endAt, reminderMinutes: input.reminderMinutes ?? null, participants: participantIds.map((userId) => prior.get(userId) ?? { userId, response: 'pending' as const, respondedAt: null }) }), tx);
      for (const userId of participantIds) if (!prior.has(userId)) await this.notify(userId, event, 'calendar_invitation', tx);
      const conflicts = await this.conflicts(event.startAt, event.endAt, [actor.user.id, ...participantIds], event.id, tx);
      await this.writeAudit(actor, 'calendar.updated', event, audit, tx);
      return { data: event, conflicts };
    });
  }

  async remove(context: AuthContext, eventId: string, version: number, audit: CalendarAuditContext): Promise<void> {
    await this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'calendar:delete', tx);
      const event = await this.requireReadable(eventId, actor, tx);
      await this.requireWritable(event, actor, tx);
      const deleted = await this.repos.events.softDelete(eventId, version, tx);
      await this.writeAudit(actor, 'calendar.deleted', deleted, audit, tx);
    });
  }

  async respond(context: AuthContext, eventId: string, version: number, response: 'accepted' | 'declined' | 'tentative', audit: CalendarAuditContext): Promise<CalendarEvent> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'calendar:respond', tx);
      const event = await this.requireReadable(eventId, actor, tx);
      const participant = event.participants.find((item) => item.userId === actor.user.id);
      if (!participant) throw new AppError('NOT_FOUND', '会议邀请不存在');
      const updated = await this.repos.events.update(eventId, version, (current) => ({ ...current, participants: current.participants.map((item) => item.userId === actor.user.id ? { ...item, response, respondedAt: this.clock.now().toISOString() } : item) }), tx);
      await this.notify(updated.ownerId, updated, 'calendar_response', tx);
      await this.writeAudit(actor, `calendar.${response}`, updated, audit, tx);
      return updated;
    });
  }
}
