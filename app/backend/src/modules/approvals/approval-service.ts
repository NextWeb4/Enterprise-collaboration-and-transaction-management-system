import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { systemClock, type Clock } from '../../shared/clock.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { AuthContext, AuthService } from '../core/auth-service.js';
import type { AuditInput, AuditService } from '../core/audit-service.js';
import type { CoreRepositories } from '../core/repositories.js';
import type { ApprovalRepositories } from './repositories.js';
import type { ApprovalRecord, Application, WorkflowInstance, WorkflowStep } from './models.js';
import { applicationSchema } from './models.js';
import { applicationAttachments, organizationDate, validateSubmission, type ApprovalDependencies } from './application-policy.js';

type Action = ApprovalRecord['action'];
type HashFields = Pick<ApprovalRecord, 'instanceId' | 'applicationId' | 'stepId' | 'seq' | 'action' | 'operatorId' | 'comment' | 'fromApproverId' | 'toApproverId' | 'previousHash' | 'createdAt'>;
export function recordHash(fields: HashFields): string {
  return createHash('sha256').update(JSON.stringify([fields.instanceId, fields.applicationId, fields.stepId, fields.seq, fields.action, fields.operatorId, fields.comment, fields.fromApproverId, fields.toApproverId, fields.previousHash, fields.createdAt])).digest('hex');
}
type AuditContext = Pick<AuditInput, 'requestId' | 'ip' | 'userAgent'>;

export class ApprovalService {
  constructor(private readonly repos: ApprovalRepositories, private readonly core: CoreRepositories, private readonly uow: UnitOfWork, private readonly auth: AuthService, private readonly audit: AuditService, private readonly clock: Clock = systemClock, private readonly dependencies: ApprovalDependencies = {}) {}

  async submit(actor: AuthContext, applicationId: string, key: string, context: AuditContext = {}): Promise<Application> {
    if (!z.string().uuid().safeParse(key).success) throw new AppError('VALIDATION_FAILED', '幂等键必须是 UUID');
    const files = await this.uow.run(async (tx) => {
      const current = await this.actor(actor, 'application:submit', tx);
      const application = await this.repos.applications.get(applicationId, tx);
      if (!application || application.deletedAt !== null || application.applicantId !== current.user.id) throw new AppError('NOT_FOUND', '申请不存在');
      if (application.status !== 'draft') return [];
      const attached = await applicationAttachments(this.repos, applicationId, tx);
      return Promise.all(attached.map(async (attachment) => {
        const file = await this.core.files.get(attachment.fileId, tx);
        if (!file) throw new AppError('FILE_MISSING');
        return file;
      }));
    });
    for (const file of files) {
      if (!this.dependencies.files) throw new AppError('FILE_INVALID', '文件能力未配置');
      await this.dependencies.files.pathFor(file);
    }
    return this.uow.run(async (tx) => {
      const current = await this.actor(actor, 'application:submit', tx);
      const requestHash = createHash('sha256').update(JSON.stringify([applicationId])).digest('hex');
      const existing = await this.repos.idempotency.getByUniqueIndex('idx_workflow_idempotency', JSON.stringify([current.user.id, key]), tx);
      if (existing && Date.parse(existing.expiresAt) > this.clock.now().getTime()) {
        if (existing.requestHash !== requestHash || existing.applicationId !== applicationId) throw new AppError('IDEMPOTENCY_KEY_REUSED');
        const original = await this.repos.applications.get(applicationId, tx);
        if (!original || original.deletedAt !== null || original.applicantId !== current.user.id) throw new AppError('STORAGE_CORRUPTED', '幂等记录无效');
        const response = applicationSchema.safeParse(existing.response);
        if (!response.success || response.data.id !== applicationId || response.data.applicantId !== current.user.id) throw new AppError('STORAGE_CORRUPTED', '幂等响应无效');
        return response.data;
      }
      if (existing) await this.repos.idempotency.softDelete(existing.id, existing.version, tx);
      const application = await this.repos.applications.get(applicationId, tx);
      if (!application || application.deletedAt !== null || application.applicantId !== current.user.id) throw new AppError('NOT_FOUND', '申请不存在');
      if (application.status !== 'draft') throw new AppError('APPLICATION_STATE_INVALID');
      await validateSubmission(application, current, this.repos, this.core, this.dependencies, this.clock.now(), tx);
      const template = await this.repos.templates.getByUniqueIndex('idx_workflow_templates_active', application.applicationType, tx);
      if (!template || template.deletedAt !== null || template.status !== 'active' || !template.activeVersionId) throw new AppError('WORKFLOW_TEMPLATE_MISSING');
      const version = await this.repos.versions.get(template.activeVersionId, tx);
      if (!version || version.deletedAt !== null || version.templateId !== template.id) throw new AppError('STORAGE_CORRUPTED', '模板版本无效');
      const resolved: Array<{ name: string; approverId: string; approverType: WorkflowStep['approverType'] }> = [];
      for (const [index, step] of version.steps.entries()) {
        if (step.stepNo !== index + 1) throw new AppError('APPROVER_UNRESOLVED', `步骤 ${index + 1} ${step.name} 序号无效`);
        let approverId = step.approverType === 'user' ? step.userId : current.user.managerId;
        if (step.approverType === 'department_manager') {
          const department = current.user.departmentId ? await this.dependencies.departments?.get(current.user.departmentId, tx) : undefined;
          approverId = department && department.deletedAt === null ? department.managerId : null;
        }
        const approver = approverId ? await this.core.users.get(approverId, tx) : undefined;
        if (!approver || approver.deletedAt !== null || approver.status !== 'active') throw new AppError('APPROVER_UNRESOLVED', `步骤 ${index + 1} ${step.name} 审批人缺失或已停用`);
        if (approver.id === current.user.id) throw new AppError('SELF_APPROVAL_FORBIDDEN', `步骤 ${index + 1} ${step.name} 不能由申请人审批`);
        if (resolved.at(-1)?.approverId !== approver.id) resolved.push({ name: step.name, approverId: approver.id, approverType: step.approverType });
      }
      const now = this.clock.now();
      const date = (await organizationDate(this.core, now, tx)).replaceAll('-', '');
      const counter = await this.repos.counters.getByUniqueIndex('idx_workflow_counter_date', date, tx);
      const next = (counter?.value ?? 0) + 1;
      if (next > 9999) throw new AppError('VERSION_CONFLICT', '当天申请编号已耗尽');
      if (counter) await this.repos.counters.update(counter.id, counter.version, (value) => ({ ...value, value: next }), tx);
      else await this.repos.counters.create({ namespace: 'approvals', date, value: next }, tx);
      const timestamp = now.toISOString();
      const updated = await this.repos.applications.update(application.id, application.version, (value) => ({ ...value, status: 'pending', applicationNo: `OA-${date}-${String(next).padStart(4, '0')}`, departmentId: current.user.departmentId, submittedAt: timestamp }), tx);
      const instance = await this.repos.instances.create({ applicationId: application.id, templateId: template.id, templateVersionId: version.id, status: 'running', currentStepNo: 1, startedAt: timestamp, completedAt: null, recordSeq: 0, recordHash: null }, tx);
      for (const [index, step] of resolved.entries()) await this.repos.steps.create({ instanceId: instance.id, stepNo: index + 1, name: step.name, approverType: step.approverType, approverId: step.approverId, status: index === 0 ? 'active' : 'waiting', activatedAt: index === 0 ? timestamp : null, completedAt: null }, tx);
      const first = resolved[0];
      if (!first) throw new AppError('APPROVER_UNRESOLVED');
      await this.notify(first.approverId, application.id, 'approval_requested', tx);
      await this.repos.idempotency.create({ namespace: 'approvals', userId: current.user.id, key, applicationId: application.id, requestHash, expiresAt: new Date(now.getTime() + 86400000).toISOString(), response: updated }, tx);
      await this.audit.append({ actorUserId: current.user.id, action: 'application.submitted', resourceType: 'application', resourceId: application.id, ...context }, tx);
      return updated;
    });
  }

  async decide(actor: AuthContext, applicationId: string, action: 'approve' | 'reject', comment: string, context: AuditContext = {}, expectedVersion?: number): Promise<void> {
    if (typeof comment !== 'string' || comment.length > 500 || (action === 'reject' && comment.trim().length < 10)) throw new AppError('VALIDATION_FAILED', '审批意见不符合要求');
    await this.uow.run(async (tx) => {
      const current = await this.actor(actor, 'application:approve', tx);
      const { application, instance, step } = await this.current(applicationId, current.user.id, false, tx);
      if (step.approverId !== current.user.id || application.applicantId === current.user.id) throw new AppError('NOT_FOUND', '申请不存在');
      if (expectedVersion !== undefined && expectedVersion !== application.version) throw new AppError('VERSION_CONFLICT');
      const head = await this.append(instance, application, step, current.user.id, action, comment, null, null, tx);
      const now = this.clock.nowIso();
      await this.repos.steps.update(step.id, step.version, (value) => ({ ...value, status: action === 'approve' ? 'approved' : 'rejected', completedAt: now }), tx);
      const next = action === 'approve' ? await this.repos.steps.getByUniqueIndex('idx_workflow_steps_number', JSON.stringify([instance.id, step.stepNo + 1]), tx) : undefined;
      if (next && next.status !== 'waiting') throw new AppError('STORAGE_CORRUPTED', '后续审批步骤状态异常');
      if (next) {
        const nextApprover = await this.core.users.get(next.approverId, tx);
        if (!nextApprover || nextApprover.deletedAt !== null || nextApprover.status !== 'active') throw new AppError('APPROVER_UNRESOLVED', '下一步骤审批人已不可用，请先转交或调整');
        await this.repos.steps.update(next.id, next.version, (value) => ({ ...value, status: 'active', activatedAt: now }), tx);
        await this.repos.instances.update(instance.id, instance.version, (value) => ({ ...value, ...head, currentStepNo: next.stepNo }), tx);
        await this.repos.applications.update(application.id, application.version, (value) => value, tx);
        await this.notify(next.approverId, application.id, 'approval_requested', tx);
      } else {
        const status = action === 'approve' ? 'approved' : 'rejected';
        await this.repos.instances.update(instance.id, instance.version, (value) => ({ ...value, ...head, status, completedAt: now }), tx);
        await this.repos.applications.update(application.id, application.version, (value) => ({ ...value, status, completedAt: now }), tx);
        await this.notify(application.applicantId, application.id, 'approval_result', tx);
      }
      await this.audit.append({ actorUserId: current.user.id, action: `approval.${action}`, resourceType: 'application', resourceId: application.id, ...context }, tx);
    });
  }

  async withdraw(actor: AuthContext, applicationId: string, reason: string, context: AuditContext = {}, expectedVersion?: number): Promise<void> {
    if (typeof reason !== 'string' || reason.length > 500) throw new AppError('VALIDATION_FAILED', '撤回原因过长');
    await this.uow.run(async (tx) => {
      const current = await this.actor(actor, 'application:withdraw', tx);
      const { application, instance, step } = await this.current(applicationId, current.user.id, false, tx);
      if (application.applicantId !== current.user.id) throw new AppError('NOT_FOUND', '申请不存在');
      if (expectedVersion !== undefined && expectedVersion !== application.version) throw new AppError('VERSION_CONFLICT');
      const records = await this.verifyHistory(instance, tx);
      if (records.some((record) => record.action === 'approve' || record.action === 'reject')) throw new AppError('APPLICATION_STATE_INVALID', '已有审批动作，不能撤回');
      const head = await this.append(instance, application, step, current.user.id, 'withdraw', reason, null, null, tx);
      const now = this.clock.nowIso();
      await this.repos.steps.update(step.id, step.version, (value) => ({ ...value, status: 'cancelled', completedAt: now }), tx);
      await this.repos.instances.update(instance.id, instance.version, (value) => ({ ...value, ...head, status: 'withdrawn', completedAt: now }), tx);
      await this.repos.applications.update(application.id, application.version, (value) => ({ ...value, status: 'withdrawn', completedAt: now }), tx);
      await this.notify(step.approverId, application.id, 'approval_result', tx);
      await this.audit.append({ actorUserId: current.user.id, action: 'approval.withdraw', resourceType: 'application', resourceId: application.id, ...context }, tx);
    });
  }

  async reassign(actor: AuthContext, applicationId: string, newApproverId: string, reason: string, context: AuditContext = {}, expectedVersion?: number): Promise<void> {
    if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 500) throw new AppError('VALIDATION_FAILED', '转交原因须为 5–500 字');
    await this.uow.run(async (tx) => {
      const current = await this.actor(actor, 'workflow:reassign', tx);
      if (!current.roles.some((role) => role.system && role.code === 'org_admin')) throw new AppError('FORBIDDEN', '只有组织管理员可以转交');
      const { application, instance, step } = await this.current(applicationId, current.user.id, true, tx);
      if (expectedVersion !== undefined && expectedVersion !== application.version) throw new AppError('VERSION_CONFLICT');
      const target = await this.core.users.get(newApproverId, tx);
      if (!target || target.deletedAt !== null || target.status !== 'active' || target.id === application.applicantId || target.id === step.approverId) throw new AppError('VALIDATION_FAILED', '新审批人无效');
      const head = await this.append(instance, application, step, current.user.id, 'reassign', reason, step.approverId, target.id, tx);
      await this.repos.steps.update(step.id, step.version, (value) => ({ ...value, approverId: target.id }), tx);
      await this.repos.instances.update(instance.id, instance.version, (value) => ({ ...value, ...head }), tx);
      await this.repos.applications.update(application.id, application.version, (value) => value, tx);
      await this.notify(target.id, application.id, 'approval_requested', tx);
      await this.audit.append({ actorUserId: current.user.id, action: 'workflow.reassigned', resourceType: 'application', resourceId: application.id, metadata: { from: step.approverId, to: target.id }, ...context }, tx);
    });
  }

  private async actor(actor: AuthContext, permission: string, tx: StorageTransaction): Promise<AuthContext> {
    const current = await this.auth.loadCurrentActor(actor, tx);
    if (current.user.mustChangePassword) throw new AppError('PASSWORD_CHANGE_REQUIRED');
    if (!current.permissions.includes(permission)) throw new AppError('FORBIDDEN', '没有执行此操作的权限');
    return current;
  }
  private async current(applicationId: string, actorId: string, admin: boolean, tx: StorageTransaction): Promise<{ application: Application; instance: WorkflowInstance; step: WorkflowStep }> {
    const application = await this.repos.applications.get(applicationId, tx);
    if (!application || application.deletedAt !== null) throw new AppError('NOT_FOUND', '申请不存在');
    const instance = await this.repos.instances.getByUniqueIndex('idx_workflow_instances_application', applicationId, tx);
    if (!instance || instance.deletedAt !== null) throw new AppError('NOT_FOUND', '申请不存在');
    const steps = await this.repos.listSteps(instance.id, tx);
    if (!admin && application.applicantId !== actorId) {
      const activeAssignee = steps.some((item) => item.status === 'active' && item.approverId === actorId);
      const history = await this.verifyHistory(instance, tx);
      const participated = history.some((record) => ['approve', 'reject'].includes(record.action) && record.operatorId === actorId);
      if (!activeAssignee && !participated) throw new AppError('NOT_FOUND', '申请不存在');
    }
    if (instance.status !== 'running' || application.status !== 'pending') throw new AppError('APPLICATION_STATE_INVALID', '申请不处于审批中');
    const step = await this.repos.steps.getByUniqueIndex('idx_workflow_steps_active', instance.id, tx);
    if (!step || step.deletedAt !== null || step.stepNo !== instance.currentStepNo || step.status !== 'active') throw new AppError('STORAGE_CORRUPTED', '当前审批步骤不一致');
    if (steps.length === 0 || steps.length > 10 || steps.some((item, index) => item.stepNo !== index + 1 || item.approverId === application.applicantId || (item.stepNo < step.stepNo && item.status !== 'approved') || (item.stepNo > step.stepNo && item.status !== 'waiting'))) throw new AppError('STORAGE_CORRUPTED', '审批步骤序列不一致');
    return { application, instance, step };
  }
  private async verifyHistory(instance: WorkflowInstance, tx: StorageTransaction): Promise<ApprovalRecord[]> {
    const records = await this.repos.records.listByInstance(instance.id, tx);
    let previousHash: string | null = null;
    for (const [index, record] of records.entries()) {
      if (record.seq !== index + 1 || record.applicationId !== instance.applicationId || record.previousHash !== previousHash || record.hash !== recordHash(record)) throw new AppError('STORAGE_CORRUPTED', '审批记录链无效');
      previousHash = record.hash;
    }
    if (instance.recordSeq !== records.length || instance.recordHash !== previousHash) throw new AppError('STORAGE_CORRUPTED', '审批记录链头无效');
    return records;
  }
  private async append(instance: WorkflowInstance, application: Application, step: WorkflowStep, operatorId: string, action: Action, comment: string, fromApproverId: string | null, toApproverId: string | null, tx: StorageTransaction): Promise<{ recordSeq: number; recordHash: string }> {
    await this.verifyHistory(instance, tx);
    const fields: HashFields = { instanceId: instance.id, applicationId: application.id, stepId: step.id, seq: instance.recordSeq + 1, action, operatorId, comment, fromApproverId, toApproverId, previousHash: instance.recordHash, createdAt: this.clock.nowIso() };
    const { createdAt, ...body } = fields;
    const hash = recordHash(fields);
    await this.repos.records.create({ ...body, hash }, tx, { createdAt });
    return { recordSeq: fields.seq, recordHash: hash };
  }
  private async notify(recipientId: string, applicationId: string, notificationType: 'approval_requested' | 'approval_result', tx: StorageTransaction): Promise<void> {
    await this.repos.notifications.create({ namespace: 'approvals', recipientId, notificationType, title: notificationType === 'approval_requested' ? '待审批申请' : '审批状态已更新', content: '', linkPath: `/app/applications/${encodeURIComponent(applicationId)}`, readAt: null }, tx);
  }
}
