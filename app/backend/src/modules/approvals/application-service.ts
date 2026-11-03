import type { ApplicationDraftRequest } from '@collab/shared/schemas.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { AuthContext, AuthService } from '../core/auth-service.js';
import type { CoreRepositories } from '../core/repositories.js';
import type { AuditInput, AuditService } from '../core/audit-service.js';
import type { UploadInput } from '../core/file-service.js';
import { scopesForPermission } from '../core/permission-scopes.js';
import { AppError } from '../../shared/errors.js';
import type { ApprovalRepositories } from './repositories.js';
import type {
  Application,
  ApplicationAttachment,
  ApprovalRecord,
  WorkflowInstance,
  WorkflowStep,
} from './models.js';
import { recordHash } from './approval-service.js';
import {
  allRows,
  applicationAttachments,
  parseDraft,
  validateApplicationProject,
  type ApprovalDependencies,
} from './application-policy.js';

type AuditContext = Pick<AuditInput, 'requestId' | 'ip' | 'userAgent'>;
type Access = 'full' | 'summary' | null;
export interface ApplicationSummary {
  id: string;
  version: number;
  applicationNo: string | null;
  applicationType: Application['applicationType'];
  title: string;
  applicantId: string;
  applicantName: string;
  departmentId: string | null;
  departmentName: string | null;
  status: Application['status'];
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  redacted: boolean;
}
export interface ApplicationHistory {
  submittedAt: string | null;
  steps: Array<
    Omit<WorkflowStep, 'approverId'> & { approverId: string | null; approverName: string | null }
  >;
  records: Array<
    Pick<
      ApprovalRecord,
      'id' | 'stepId' | 'action' | 'operatorId' | 'createdAt' | 'fromApproverId' | 'toApproverId'
    > & {
      operatorName: string;
      fromApproverName: string | null;
      toApproverName: string | null;
      comment: string | null;
    }
  >;
}
export interface ApplicationDetail extends ApplicationSummary {
  formSchemaVersion: number;
  formData: Record<string, unknown> | null;
  startAt: string | null;
  endAt: string | null;
  projectId: string | null;
  attachments: ApplicationAttachment[];
  history: ApplicationHistory;
  actions: {
    edit: boolean;
    submit: boolean;
    withdraw: boolean;
    approve: boolean;
    reassign: boolean;
    copy: boolean;
  };
}
export interface ApplicationListQuery {
  page: number;
  pageSize: number;
  view: 'mine' | 'involved' | 'all' | 'pending';
  status?: Application['status'];
  applicationType?: Application['applicationType'];
  q?: string;
}

export class ApplicationService {
  constructor(
    private readonly repos: ApprovalRepositories,
    private readonly core: CoreRepositories,
    private readonly uow: UnitOfWork,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly dependencies: ApprovalDependencies = {},
  ) {}

  async create(
    actor: AuthContext,
    input: ApplicationDraftRequest,
    context: AuditContext = {},
  ): Promise<Application> {
    const data = parseDraft(input);
    return this.uow.run(async (tx) => {
      const current = await this.actor(actor, 'application:create', tx);
      await validateApplicationProject(current, data.projectId, this.dependencies, tx);
      const application = await this.repos.applications.create(
        {
          ...data,
          applicationNo: null,
          formSchemaVersion: 1,
          status: 'draft',
          applicantId: current.user.id,
          departmentId: current.user.departmentId,
          submittedAt: null,
          completedAt: null,
        },
        tx,
      );
      await this.log(current, 'application.created', application.id, context, tx);
      return application;
    });
  }

  async update(
    actor: AuthContext,
    id: string,
    version: number,
    input: ApplicationDraftRequest,
    context: AuditContext = {},
  ): Promise<Application> {
    const data = parseDraft(input);
    return this.uow.run(async (tx) => {
      const current = await this.actor(actor, 'application:create', tx);
      const application = await this.ownDraft(current, id, tx);
      if (application.applicationType !== data.applicationType)
        throw new AppError('VALIDATION_FAILED', '申请类型不可更改，请新建草稿');
      await validateApplicationProject(current, data.projectId, this.dependencies, tx);
      const result = await this.repos.applications.update(
        id,
        version,
        (value) => ({ ...value, ...data }),
        tx,
      );
      await this.log(current, 'application.updated', id, context, tx);
      return result;
    });
  }

  async remove(
    actor: AuthContext,
    id: string,
    version: number,
    context: AuditContext = {},
  ): Promise<void> {
    await this.uow.run(async (tx) => {
      const current = await this.actor(actor, 'application:create', tx);
      await this.ownDraft(current, id, tx);
      // Preserve attachment references and bytes for deleted draft retention; no physical cleanup in R1.
      await this.repos.applications.softDelete(id, version, tx);
      await this.log(current, 'application.deleted', id, context, tx);
    });
  }

  async copy(actor: AuthContext, id: string, context: AuditContext = {}): Promise<Application> {
    return this.uow.run(async (tx) => {
      const current = await this.actor(actor, 'application:create', tx);
      const source = await this.repos.applications.get(id, tx);
      if (!source || source.deletedAt !== null || source.applicantId !== current.user.id)
        throw new AppError('NOT_FOUND', '申请不存在');
      if (!['rejected', 'withdrawn'].includes(source.status))
        throw new AppError('APPLICATION_STATE_INVALID', '只能复制已驳回或已撤回申请');
      const result = await this.repos.applications.create(
        {
          applicationType: source.applicationType,
          title: source.title,
          formData: source.formData,
          formSchemaVersion: source.formSchemaVersion,
          startAt: source.startAt,
          endAt: source.endAt,
          projectId: source.projectId ?? null,
          applicationNo: null,
          applicantId: current.user.id,
          departmentId: current.user.departmentId,
          status: 'draft',
          submittedAt: null,
          completedAt: null,
        },
        tx,
      );
      for (const attachment of await applicationAttachments(this.repos, source.id, tx)) {
        const file = await this.core.files.get(attachment.fileId, tx);
        if (!file || file.status !== 'active' || file.deletedAt !== null)
          throw new AppError('FILE_MISSING');
        await this.core.files.update(
          file.id,
          file.version,
          (value) => ({ ...value, refCount: value.refCount + 1 }),
          tx,
        );
        await this.repos.attachments.create(
          {
            applicationId: result.id,
            fileId: file.id,
            fileName: attachment.fileName,
            mime: attachment.mime,
            size: attachment.size,
            sha256: attachment.sha256,
            uploadedBy: current.user.id,
          },
          tx,
        );
      }
      await this.log(current, 'application.copied', result.id, context, tx);
      return result;
    });
  }

  async list(
    actor: AuthContext,
    query: ApplicationListQuery,
    context: AuditContext = {},
  ): Promise<{
    data: ApplicationSummary[];
    meta: { page: number; pageSize: number; total: number };
  }> {
    if (
      !Number.isInteger(query.page) ||
      query.page < 1 ||
      !Number.isInteger(query.pageSize) ||
      query.pageSize < 1 ||
      query.pageSize > 100
    )
      throw new AppError('VALIDATION_FAILED');
    return this.uow.run(async (tx) => {
      const current = await this.actor(actor, null, tx);
      this.requireReadPermission(current);
      const found: ApplicationSummary[] = [];
      for (const application of await allRows(this.repos.applications, tx)) {
        if (query.view === 'mine' && application.applicantId !== current.user.id) continue;
        if (query.status && query.status !== application.status) continue;
        if (query.applicationType && query.applicationType !== application.applicationType)
          continue;
        const access = await this.access(current, application, tx);
        if (!access) continue;
        if (query.view === 'pending' || query.view === 'involved') {
          const instance = await this.instance(application.id, tx);
          if (!instance) continue;
          const steps = await this.repos.listSteps(instance.id, tx);
          const active =
            instance.status === 'running' &&
            steps.some((step) => step.status === 'active' && step.approverId === current.user.id);
          const participated =
            query.view === 'involved' &&
            (await this.repos.records.listByInstance(instance.id, tx)).some(
              (record) =>
                ['approve', 'reject'].includes(record.action) &&
                record.operatorId === current.user.id,
            );
          if (!active && !participated) continue;
        }
        const summary = await this.summary(application, access, tx);
        if (
          query.q &&
          !`${summary.title} ${summary.applicationNo ?? ''}`
            .toLocaleLowerCase()
            .includes(query.q.toLocaleLowerCase())
        )
          continue;
        found.push(summary);
      }
      found.sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      );
      if (query.view === 'all') await this.log(current, 'application.listed', null, context, tx);
      return {
        data: found.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
        meta: { page: query.page, pageSize: query.pageSize, total: found.length },
      };
    });
  }

  async detail(
    actor: AuthContext,
    id: string,
    context: AuditContext = {},
  ): Promise<ApplicationDetail> {
    return this.uow.run(async (tx) => {
      const current = await this.actor(actor, null, tx);
      this.requireReadPermission(current);
      const application = await this.repos.applications.get(id, tx);
      const access =
        application && application.deletedAt === null
          ? await this.access(current, application, tx)
          : null;
      if (!application || !access) throw new AppError('NOT_FOUND', '申请不存在');
      const history = await this.historyInTransaction(application, access, tx);
      const owner = application.applicantId === current.user.id;
      const active = history.steps.find((step) => step.status === 'active');
      if (!owner) await this.log(current, 'application.viewed', id, context, tx);
      return {
        ...(await this.summary(application, access, tx)),
        formSchemaVersion: application.formSchemaVersion,
        formData: access === 'full' ? application.formData : null,
        startAt: access === 'full' ? application.startAt : null,
        endAt: access === 'full' ? application.endAt : null,
        projectId: access === 'full' ? (application.projectId ?? null) : null,
        attachments: access === 'full' ? await applicationAttachments(this.repos, id, tx) : [],
        history,
        actions: {
          edit:
            owner &&
            application.status === 'draft' &&
            current.permissions.includes('application:create'),
          submit:
            owner &&
            application.status === 'draft' &&
            current.permissions.includes('application:submit'),
          withdraw:
            owner &&
            application.status === 'pending' &&
            !history.records.some(
              (record) => record.action === 'approve' || record.action === 'reject',
            ) &&
            current.permissions.includes('application:withdraw'),
          approve:
            application.status === 'pending' &&
            active?.approverId === current.user.id &&
            !owner &&
            current.permissions.includes('application:approve'),
          reassign:
            application.status === 'pending' &&
            current.permissions.includes('workflow:reassign') &&
            current.roles.some((role) => role.system && role.code === 'org_admin'),
          copy:
            owner &&
            ['rejected', 'withdrawn'].includes(application.status) &&
            current.permissions.includes('application:create'),
        },
      };
    });
  }

  async history(
    actor: AuthContext,
    id: string,
    context: AuditContext = {},
  ): Promise<ApplicationHistory> {
    return (await this.detail(actor, id, context)).history;
  }

  async attach(
    actor: AuthContext,
    id: string,
    version: number,
    input: Omit<UploadInput, 'uploadedBy' | 'maxBytes'>,
    context: AuditContext = {},
  ): Promise<ApplicationAttachment> {
    const files = this.dependencies.files;
    if (!files) throw new AppError('FILE_INVALID', '文件能力未配置');
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(input.mimetype))
      throw new AppError('FILE_TYPE_UNSUPPORTED');
    await this.uow.run(async (tx) => {
      await this.ownDraft(await this.actor(actor, 'application:create', tx), id, tx);
    });
    const staged = await files.stage({
      ...input,
      uploadedBy: actor.user.id,
      maxBytes: 10 * 1024 * 1024,
    });
    const metadata = files.metadata(staged, actor.user.id);
    return files.bind(staged, actor.user.id, async (file, tx) => {
      const current = await this.actor(actor, 'application:create', tx);
      const application = await this.ownDraft(current, id, tx);
      const attachments = await applicationAttachments(this.repos, id, tx);
      if (attachments.length >= (application.applicationType === 'seal' ? 1 : 5))
        throw new AppError('VALIDATION_FAILED', '附件数量已达到上限');
      await this.repos.applications.update(id, version, (value) => value, tx);
      const result = await this.repos.attachments.create(
        { applicationId: id, fileId: file.id, ...metadata, uploadedBy: current.user.id },
        tx,
      );
      await this.log(current, 'application.attachment_added', id, context, tx);
      return result;
    });
  }

  async removeAttachment(
    actor: AuthContext,
    id: string,
    attachmentId: string,
    version: number,
    context: AuditContext = {},
  ): Promise<void> {
    const files = this.dependencies.files;
    if (!files) throw new AppError('FILE_INVALID');
    const attachment = await this.uow.run(async (tx) => {
      await this.ownDraft(await this.actor(actor, 'application:create', tx), id, tx);
      return this.requireAttachment(id, attachmentId, tx);
    });
    await files.releaseWithMutation(attachment.fileId, async (_file, tx) => {
      const current = await this.actor(actor, 'application:create', tx);
      await this.ownDraft(current, id, tx);
      const existing = await this.requireAttachment(id, attachmentId, tx);
      await this.repos.applications.update(id, version, (value) => value, tx);
      await this.repos.attachments.softDelete(existing.id, existing.version, tx);
      await this.log(current, 'application.attachment_removed', id, context, tx);
    });
  }

  async download(
    actor: AuthContext,
    id: string,
    attachmentId: string,
    context: AuditContext = {},
  ): Promise<{ path: string; fileName: string; mime: string }> {
    const authorized = await this.uow.run(async (tx) => {
      const current = await this.actor(actor, null, tx);
      this.requireReadPermission(current);
      const application = await this.repos.applications.get(id, tx);
      if (
        !application ||
        application.deletedAt !== null ||
        (await this.access(current, application, tx)) !== 'full'
      )
        throw new AppError('NOT_FOUND');
      const attachment = await this.requireAttachment(id, attachmentId, tx);
      const file = await this.core.files.get(attachment.fileId, tx);
      if (
        !file ||
        file.deletedAt !== null ||
        file.status !== 'active' ||
        file.sha256 !== attachment.sha256
      )
        throw new AppError('FILE_MISSING');
      await this.log(current, 'application.attachment_downloaded', id, context, tx);
      return { attachment, file };
    });
    if (!this.dependencies.files) throw new AppError('FILE_MISSING');
    return {
      path: await this.dependencies.files.pathFor(authorized.file),
      fileName: authorized.attachment.fileName,
      mime: authorized.attachment.mime,
    };
  }

  private async actor(
    actor: AuthContext,
    permission: string | null,
    tx: StorageTransaction,
  ): Promise<AuthContext> {
    const current = await this.auth.loadCurrentActor(actor, tx);
    if (current.user.mustChangePassword) throw new AppError('PASSWORD_CHANGE_REQUIRED');
    if (permission && !current.permissions.includes(permission)) throw new AppError('FORBIDDEN');
    return current;
  }
  private requireReadPermission(actor: AuthContext): void {
    if (
      !actor.permissions.some((permission) =>
        ['application:read:self', 'application:read:all', 'application:approve'].includes(
          permission,
        ),
      ) &&
      !this.auditor(actor)
    )
      throw new AppError('FORBIDDEN');
  }
  private auditor(actor: AuthContext): boolean {
    return (
      actor.roles.some((role) => role.system && role.code === 'auditor') &&
      scopesForPermission(actor.roles, 'audit:read').includes('all')
    );
  }
  private async ownDraft(
    actor: AuthContext,
    id: string,
    tx: StorageTransaction,
  ): Promise<Application> {
    const application = await this.repos.applications.get(id, tx);
    if (!application || application.deletedAt !== null || application.applicantId !== actor.user.id)
      throw new AppError('NOT_FOUND');
    if (application.status !== 'draft')
      throw new AppError('APPLICATION_STATE_INVALID', '提交后不能修改或删除申请');
    return application;
  }
  private async requireAttachment(
    id: string,
    attachmentId: string,
    tx: StorageTransaction,
  ): Promise<ApplicationAttachment> {
    const attachment = await this.repos.attachments.get(attachmentId, tx);
    if (!attachment || attachment.deletedAt !== null || attachment.applicationId !== id)
      throw new AppError('NOT_FOUND');
    return attachment;
  }
  private async instance(
    id: string,
    tx: StorageTransaction,
  ): Promise<WorkflowInstance | undefined> {
    return this.repos.instances.getByUniqueIndex('idx_workflow_instances_application', id, tx);
  }
  private async access(
    actor: AuthContext,
    application: Application,
    tx: StorageTransaction,
  ): Promise<Access> {
    if (
      application.applicantId === actor.user.id &&
      actor.permissions.includes('application:read:self')
    )
      return 'full';
    if (application.status === 'draft') return null;
    if (actor.permissions.includes('application:approve')) {
      const instance = await this.instance(application.id, tx);
      if (instance) {
        const steps = await this.repos.listSteps(instance.id, tx);
        if (
          instance.status === 'running' &&
          steps.some((step) => step.status === 'active' && step.approverId === actor.user.id)
        )
          return 'full';
        const records = await this.repos.records.listByInstance(instance.id, tx);
        if (
          records.some(
            (record) =>
              ['approve', 'reject'].includes(record.action) && record.operatorId === actor.user.id,
          )
        )
          return 'full';
      }
    }
    const scopes = scopesForPermission(actor.roles, 'application:read:all');
    if (
      scopes.includes('all') ||
      (scopes.includes('self') && application.applicantId === actor.user.id)
    )
      return 'full';
    if (application.departmentId && actor.user.departmentId && this.dependencies.departments) {
      const ownDepartment = await this.dependencies.departments.get(actor.user.departmentId, tx);
      if (ownDepartment && ownDepartment.deletedAt === null) {
        if (scopes.includes('department') && application.departmentId === ownDepartment.id)
          return 'full';
        if (scopes.includes('department_tree')) {
          const visited = new Set<string>();
          let cursor: string | null = application.departmentId;
          while (cursor && !visited.has(cursor)) {
            visited.add(cursor);
            const department = await this.dependencies.departments.get(cursor, tx);
            if (!department || department.deletedAt !== null) break;
            if (department.id === ownDepartment.id) return 'full';
            cursor = department.parentId;
          }
        }
      }
    }
    return this.auditor(actor) ? 'summary' : null;
  }
  private async userName(id: string | null, tx: StorageTransaction): Promise<string | null> {
    if (!id) return null;
    const user = await this.core.users.get(id, tx);
    return user
      ? `${user.name}${user.status !== 'active' || user.deletedAt !== null ? '（已停用）' : ''}`
      : '已移除用户';
  }
  private async summary(
    application: Application,
    access: Exclude<Access, null>,
    tx: StorageTransaction,
  ): Promise<ApplicationSummary> {
    const department = application.departmentId
      ? await this.dependencies.departments?.get(application.departmentId, tx)
      : undefined;
    return {
      id: application.id,
      version: application.version,
      applicationNo: application.applicationNo,
      applicationType: application.applicationType,
      title: access === 'full' ? application.title : '申请摘要',
      applicantId: application.applicantId,
      applicantName: (await this.userName(application.applicantId, tx)) ?? '未知用户',
      departmentId: application.departmentId,
      departmentName: department?.name ?? null,
      status: application.status,
      createdAt: application.createdAt,
      submittedAt: application.submittedAt,
      completedAt: application.completedAt,
      redacted: access === 'summary',
    };
  }
  private async historyInTransaction(
    application: Application,
    access: Exclude<Access, null>,
    tx: StorageTransaction,
  ): Promise<ApplicationHistory> {
    const instance = await this.instance(application.id, tx);
    if (!instance) {
      if (application.status !== 'draft') throw new AppError('STORAGE_CORRUPTED', '审批实例缺失');
      return { submittedAt: null, steps: [], records: [] };
    }
    const records = await this.repos.records.listByInstance(instance.id, tx);
    let previousHash: string | null = null;
    for (const [index, record] of records.entries()) {
      if (
        record.seq !== index + 1 ||
        record.applicationId !== application.id ||
        record.previousHash !== previousHash ||
        record.hash !== recordHash(record)
      )
        throw new AppError('STORAGE_CORRUPTED', '审批历史校验失败');
      previousHash = record.hash;
    }
    if (instance.recordHash !== previousHash || instance.recordSeq !== records.length)
      throw new AppError('STORAGE_CORRUPTED', '审批历史链头校验失败');
    return {
      submittedAt: application.submittedAt,
      steps: await Promise.all(
        (await this.repos.listSteps(instance.id, tx)).map(async (step) => ({
          ...step,
          approverId: step.status === 'waiting' ? null : step.approverId,
          approverName: step.status === 'waiting' ? null : await this.userName(step.approverId, tx),
        })),
      ),
      records: await Promise.all(
        records.map(async (record) => ({
          id: record.id,
          stepId: record.stepId,
          action: record.action,
          operatorId: record.operatorId,
          operatorName: (await this.userName(record.operatorId, tx)) ?? '未知用户',
          createdAt: record.createdAt,
          fromApproverId: record.fromApproverId,
          toApproverId: record.toApproverId,
          fromApproverName: await this.userName(record.fromApproverId, tx),
          toApproverName: await this.userName(record.toApproverId, tx),
          comment: access === 'full' ? record.comment : null,
        })),
      ),
    };
  }
  private async log(
    actor: AuthContext,
    action: string,
    id: string | null,
    context: AuditContext,
    tx: StorageTransaction,
  ): Promise<void> {
    await this.audit.append(
      {
        actorUserId: actor.user.id,
        action,
        resourceType: 'application',
        resourceId: id,
        ...context,
      },
      tx,
    );
  }
}
