import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { systemClock, type Clock } from '../../shared/clock.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { AuthContext, AuthService } from '../core/auth-service.js';
import type { CoreRepositories } from '../core/repositories.js';
import type { AuditInput, AuditService } from '../core/audit-service.js';
import { templateStepSchema, type WorkflowTemplate, type WorkflowVersion } from './models.js';
import type { ApprovalRepositories } from './repositories.js';

const templateInputSchema = z.object({ name: z.string().trim().min(2).max(50), applicationType: z.enum(['leave', 'travel', 'field', 'seal', 'general']), steps: z.array(templateStepSchema).min(1).max(10) }).strict();
export type TemplateInput = z.infer<typeof templateInputSchema>;
type AuditContext = Pick<AuditInput, 'requestId' | 'ip' | 'userAgent'>;

export class WorkflowTemplateService {
  constructor(private readonly repos: ApprovalRepositories, private readonly core: CoreRepositories, private readonly uow: UnitOfWork, private readonly auth: AuthService, private readonly audit: AuditService, private readonly clock: Clock = systemClock) {}

  async create(actor: AuthContext, input: TemplateInput, context: AuditContext = {}): Promise<WorkflowTemplate> {
    const data = this.parse(input);
    return this.uow.run(async (tx) => {
      const current = await this.actor(actor, tx);
      await this.validateSteps(data.steps, tx);
      const template = await this.repos.templates.create({ name: data.name, applicationType: data.applicationType, status: 'draft', activeVersionId: null, lastVersionNo: 0, draftSteps: data.steps }, tx);
      await this.audit.append({ actorUserId: current.user.id, action: 'workflow.template_created', resourceType: 'workflow_template', resourceId: template.id, ...context }, tx);
      return template;
    });
  }

  async updateDraft(actor: AuthContext, id: string, version: number, input: TemplateInput, context: AuditContext = {}): Promise<WorkflowTemplate> {
    const data = this.parse(input);
    return this.uow.run(async (tx) => {
      const current = await this.actor(actor, tx);
      const template = await this.requireTemplate(id, tx);
      if (template.applicationType !== data.applicationType) throw new AppError('VALIDATION_FAILED', '模板类型不可更改');
      await this.validateSteps(data.steps, tx);
      const updated = await this.repos.templates.update(id, version, (value) => ({ ...value, name: data.name, draftSteps: data.steps }), tx);
      await this.audit.append({ actorUserId: current.user.id, action: 'workflow.template_updated', resourceType: 'workflow_template', resourceId: id, ...context }, tx);
      return updated;
    });
  }

  async publish(actor: AuthContext, id: string, version: number, context: AuditContext = {}): Promise<{ template: WorkflowTemplate; published: WorkflowVersion }> {
    return this.uow.run(async (tx) => {
      const current = await this.actor(actor, tx);
      const template = await this.requireTemplate(id, tx);
      if (template.version !== version) throw new AppError('VERSION_CONFLICT');
      await this.validateSteps(template.draftSteps, tx);
      const published = await this.repos.versions.create({ templateId: id, versionNo: template.lastVersionNo + 1, steps: template.draftSteps, createdBy: current.user.id, publishedAt: this.clock.nowIso() }, tx);
      const updated = await this.repos.templates.update(id, version, (value) => ({ ...value, status: 'active', activeVersionId: published.id, lastVersionNo: published.versionNo }), tx);
      await this.audit.append({ actorUserId: current.user.id, action: 'workflow.template_published', resourceType: 'workflow_template', resourceId: id, metadata: { versionNo: published.versionNo }, ...context }, tx);
      return { template: updated, published };
    });
  }

  async deactivate(actor: AuthContext, id: string, version: number, context: AuditContext = {}): Promise<WorkflowTemplate> {
    return this.uow.run(async (tx) => {
      const current = await this.actor(actor, tx);
      const template = await this.requireTemplate(id, tx);
      if (template.status !== 'active') throw new AppError('VERSION_CONFLICT', '模板未启用');
      const updated = await this.repos.templates.update(id, version, (value) => ({ ...value, status: 'inactive' }), tx);
      await this.audit.append({ actorUserId: current.user.id, action: 'workflow.template_deactivated', resourceType: 'workflow_template', resourceId: id, ...context }, tx);
      return updated;
    });
  }

  async list(actor: AuthContext): Promise<WorkflowTemplate[]> {
    return this.uow.run(async (tx) => {
      await this.actor(actor, tx);
      const first = await this.repos.templates.list({ page: 1, pageSize: 100 }, tx);
      const all = [...first.items];
      for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) all.push(...(await this.repos.templates.list({ page, pageSize: 100 }, tx)).items);
      return all;
    });
  }

  async versions(actor: AuthContext, id: string): Promise<WorkflowVersion[]> {
    return this.uow.run(async (tx) => {
      await this.actor(actor, tx);
      await this.requireTemplate(id, tx);
      const first = await this.repos.versions.list({ page: 1, pageSize: 100 }, tx);
      const rows = [...first.items];
      for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) rows.push(...(await this.repos.versions.list({ page, pageSize: 100 }, tx)).items);
      return rows.filter((row) => row.templateId === id).sort((a, b) => b.versionNo - a.versionNo);
    });
  }

  async initializeDefaults(actor: AuthContext, context: AuditContext = {}): Promise<WorkflowTemplate[]> {
    return this.uow.run(async (tx) => {
      const current = await this.actor(actor, tx);
      const first = await this.repos.templates.list({ page: 1, pageSize: 100 }, tx);
      const existing = [...first.items];
      for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) existing.push(...(await this.repos.templates.list({ page, pageSize: 100 }, tx)).items);
      const defaults = [
        { applicationType: 'leave', name: '请假审批', approvers: ['direct_manager', 'department_manager'] },
        { applicationType: 'travel', name: '出差审批', approvers: ['direct_manager', 'department_manager'] },
        { applicationType: 'field', name: '外勤审批', approvers: ['direct_manager'] },
        { applicationType: 'seal', name: '用印审批', approvers: ['department_manager'] },
        { applicationType: 'general', name: '通用事务审批', approvers: ['department_manager'] },
      ] as const;
      const created: WorkflowTemplate[] = [];
      for (const definition of defaults) {
        if (existing.some((item) => item.applicationType === definition.applicationType)) continue;
        const steps = definition.approvers.map((approverType, index) => ({ stepNo: index + 1, name: approverType === 'direct_manager' ? '直属上级审批' : '部门负责人审批', approverType, userId: null }));
        const template = await this.repos.templates.create({ name: definition.name, applicationType: definition.applicationType, status: 'draft', activeVersionId: null, lastVersionNo: 0, draftSteps: steps }, tx);
        const published = await this.repos.versions.create({ templateId: template.id, versionNo: 1, steps, createdBy: current.user.id, publishedAt: this.clock.nowIso() }, tx);
        created.push(await this.repos.templates.update(template.id, template.version, (value) => ({ ...value, status: 'active', activeVersionId: published.id, lastVersionNo: 1 }), tx));
        await this.audit.append({ actorUserId: current.user.id, action: 'workflow.template_initialized', resourceType: 'workflow_template', resourceId: template.id, ...context }, tx);
      }
      return created;
    });
  }

  private parse(input: TemplateInput): TemplateInput {
    const parsed = templateInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '审批模板无效');
    return parsed.data;
  }
  private async actor(actor: AuthContext, tx: StorageTransaction): Promise<AuthContext> {
    const current = await this.auth.loadCurrentActor(actor, tx);
    if (current.user.mustChangePassword) throw new AppError('PASSWORD_CHANGE_REQUIRED');
    if (!current.permissions.includes('workflow:template:manage') || !current.roles.some((role) => role.system && role.code === 'org_admin')) throw new AppError('FORBIDDEN', '只有组织管理员可以管理模板');
    return current;
  }
  private async requireTemplate(id: string, tx: StorageTransaction): Promise<WorkflowTemplate> {
    const template = await this.repos.templates.get(id, tx);
    if (!template || template.deletedAt !== null) throw new AppError('NOT_FOUND', '审批模板不存在');
    return template;
  }
  private async validateSteps(steps: TemplateInput['steps'], tx: StorageTransaction): Promise<void> {
    for (const [index, step] of steps.entries()) {
      if (step.stepNo !== index + 1 || !step.name.trim()) throw new AppError('VALIDATION_FAILED', '审批步骤序号须从 1 开始连续');
      if (step.approverType === 'user') {
        if (!step.userId) throw new AppError('VALIDATION_FAILED', '固定审批人不能为空');
        const user = await this.core.users.get(step.userId, tx);
        if (!user || user.deletedAt !== null || user.status !== 'active') throw new AppError('APPROVER_UNRESOLVED', `步骤 ${index + 1} 审批人无效`);
      } else if (step.userId !== null) throw new AppError('VALIDATION_FAILED', '动态审批步骤不能指定固定用户');
    }
  }
}
