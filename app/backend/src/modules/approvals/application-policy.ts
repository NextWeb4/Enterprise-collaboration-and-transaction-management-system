import {
  approvalFormSchemas,
  applicationDraftRequestSchema,
  type ApplicationDraftRequest,
} from '@collab/shared/schemas.js';
import type { DocumentEnvelope } from '../../storage/envelope.js';
import type { Repository } from '../../storage/repository.js';
import type { StorageTransaction } from '../../storage/engine.js';
import { AppError } from '../../shared/errors.js';
import type { AuthContext } from '../core/auth-service.js';
import type { CoreRepositories } from '../core/repositories.js';
import type { FileService } from '../core/file-service.js';
import type { DepartmentDocument } from '../organization/models.js';
import type { ProjectRepositories } from '../projects/project-service.js';
import type { ApprovalRepositories } from './repositories.js';
import type { Application, ApplicationAttachment } from './models.js';

export interface ApprovalDependencies {
  departments?: Repository<DepartmentDocument>;
  projects?: ProjectRepositories;
  files?: FileService;
}

export async function allRows<T extends DocumentEnvelope>(
  repository: Pick<Repository<T>, 'list'>,
  tx: StorageTransaction,
): Promise<T[]> {
  const first = await repository.list({ page: 1, pageSize: 100 }, tx);
  const rows = [...first.items];
  for (let page = 2; page <= Math.ceil(first.total / 100); page += 1)
    rows.push(...(await repository.list({ page, pageSize: 100 }, tx)).items);
  return rows;
}

export async function applicationAttachments(
  repos: ApprovalRepositories,
  id: string,
  tx: StorageTransaction,
): Promise<ApplicationAttachment[]> {
  return (await allRows(repos.attachments, tx)).filter((row) => row.applicationId === id);
}

export function parseDraft(input: ApplicationDraftRequest): ApplicationDraftRequest {
  const parsed = applicationDraftRequestSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '申请字段无效');
  const form = approvalFormSchemas[parsed.data.applicationType]
    .partial()
    .safeParse(parsed.data.formData);
  if (!form.success)
    throw new AppError(
      'VALIDATION_FAILED',
      form.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'),
    );
  return {
    ...parsed.data,
    formData: form.data,
    startAt: parsed.data.startAt ? new Date(parsed.data.startAt).toISOString() : null,
    endAt: parsed.data.endAt ? new Date(parsed.data.endAt).toISOString() : null,
  };
}

export async function validateApplicationProject(
  actor: AuthContext,
  projectId: string | null | undefined,
  dependencies: ApprovalDependencies,
  tx: StorageTransaction,
): Promise<void> {
  if (!projectId) return;
  if (!dependencies.projects) throw new AppError('VALIDATION_FAILED', '项目能力尚未配置');
  const project = await dependencies.projects.projects.get(projectId, tx);
  if (!project || project.deletedAt !== null || project.status === 'archived')
    throw new AppError('VALIDATION_FAILED', '项目不可用或已归档');
  const member = await dependencies.projects.members.getByUniqueIndex(
    'idx_project_members_key',
    `${projectId}:${actor.user.id}`,
    tx,
  );
  if (
    !actor.permissions.some(
      (permission) => permission === 'project:read' || permission === 'project:read:all',
    ) ||
    (project.visibility === 'private' &&
      (!member ||
        member.deletedAt !== null ||
        member.userId !== actor.user.id ||
        member.projectId !== projectId))
  )
    throw new AppError('VALIDATION_FAILED', '关联项目不可访问');
}

export async function organizationDate(
  core: CoreRepositories,
  now: Date,
  tx: StorageTransaction,
): Promise<string> {
  const organizations = await core.organizations.list({ page: 1, pageSize: 2 }, tx);
  if (organizations.total !== 1 || !organizations.items[0])
    throw new AppError('STORAGE_CORRUPTED', '组织配置无效');
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: organizations.items[0].timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    return ['year', 'month', 'day']
      .map((part) => parts.find((item) => item.type === part)?.value ?? '')
      .join('-');
  } catch {
    throw new AppError('STORAGE_CORRUPTED', '组织时区无效');
  }
}

export async function validateSubmission(
  application: Application,
  actor: AuthContext,
  repos: ApprovalRepositories,
  core: CoreRepositories,
  dependencies: ApprovalDependencies,
  now: Date,
  tx: StorageTransaction,
): Promise<void> {
  const form = approvalFormSchemas[application.applicationType].safeParse(application.formData);
  if (application.formSchemaVersion !== 1 || !form.success)
    throw new AppError('VALIDATION_FAILED', '申请必填字段或表单版本无效');
  const rangeLimits: Partial<Record<Application['applicationType'], number>> = {
    leave: 365,
    travel: 180,
    field: 7,
  };
  const maxDays = rangeLimits[application.applicationType];
  if (maxDays) {
    const start = Date.parse(application.startAt ?? '');
    const end = Date.parse(application.endAt ?? '');
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      end - start > maxDays * 86400000
    )
      throw new AppError('VALIDATION_FAILED', `起止时间无效或超过 ${maxDays} 天`);
  } else if (application.startAt !== null || application.endAt !== null)
    throw new AppError('VALIDATION_FAILED', '此申请类型不接受起止时间');
  const expectedDate = application.formData.expectedDate;
  if (typeof expectedDate === 'string' && expectedDate < (await organizationDate(core, now, tx)))
    throw new AppError('VALIDATION_FAILED', '期望日期不得早于今天');
  const handover = application.formData.handoverUserId;
  if (typeof handover === 'string') {
    const user = await core.users.get(handover, tx);
    if (!user || user.deletedAt !== null || user.status !== 'active' || user.id === actor.user.id)
      throw new AppError('VALIDATION_FAILED', '交接人必须是其他在职员工');
  }
  await validateApplicationProject(actor, application.projectId, dependencies, tx);
  const attachments = await applicationAttachments(repos, application.id, tx);
  if (
    attachments.length > 5 ||
    (application.applicationType === 'seal' && attachments.length !== 1)
  )
    throw new AppError('VALIDATION_FAILED', '附件数量无效：用印须恰好一个文件，其他申请最多五个');
  for (const attachment of attachments) {
    const file = await core.files.get(attachment.fileId, tx);
    if (
      !dependencies.files ||
      !file ||
      file.deletedAt !== null ||
      file.status !== 'active' ||
      file.refCount < 1 ||
      file.sha256 !== attachment.sha256 ||
      file.size !== attachment.size ||
      attachment.uploadedBy !== application.applicantId ||
      attachment.size > 10 * 1024 * 1024 ||
      !['application/pdf', 'image/jpeg', 'image/png'].includes(attachment.mime)
    )
      throw new AppError('FILE_INVALID', '申请附件无效或不可用');
  }
  if (application.applicationType === 'leave') {
    const conflict = (await allRows(repos.applications, tx)).find(
      (row) =>
        row.id !== application.id &&
        row.applicantId === actor.user.id &&
        row.applicationType === 'leave' &&
        ['pending', 'approved'].includes(row.status) &&
        row.startAt &&
        row.endAt &&
        Date.parse(row.startAt) < Date.parse(application.endAt!) &&
        Date.parse(application.startAt!) < Date.parse(row.endAt),
    );
    if (conflict)
      throw new AppError(
        'APPLICATION_STATE_INVALID',
        `请假时间与 ${conflict.startAt} 至 ${conflict.endAt} 重叠`,
      );
  }
}
