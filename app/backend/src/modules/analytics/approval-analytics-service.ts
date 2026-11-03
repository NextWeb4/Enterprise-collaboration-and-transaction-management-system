import { z } from 'zod';
import type { StorageTransaction } from '../../storage/engine.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { Repository } from '../../storage/repository.js';
import type { AuthContext, AuthService } from '../core/auth-service.js';
import { permissionScopes } from '../core/auth-service.js';
import type { DepartmentDocument } from '../organization/models.js';
import type { ApprovalRepositories } from '../approvals/repositories.js';
import type { Application } from '../approvals/models.js';
import { AppError } from '../../shared/errors.js';

const approvalTimingFilterSchema = z.object({
  applicationType: z.enum(['leave', 'travel', 'field', 'seal', 'general']).optional(),
  departmentId: z.string().min(1).max(64).optional(),
  templateId: z.string().min(1).max(64).optional(),
}).strict();

export type ApprovalTimingFilter = z.infer<typeof approvalTimingFilterSchema>;
export interface ApprovalTimingDimension { readonly id: string; readonly name: string }
export interface ApprovalTimingReport {
  readonly generatedAt: string;
  readonly filter: ApprovalTimingFilter;
  readonly sampleCount: number;
  readonly medianHours: number | null;
  readonly p90Hours: number | null;
  readonly options: {
    readonly applicationTypes: readonly string[];
    readonly departments: readonly ApprovalTimingDimension[];
    readonly templates: readonly ApprovalTimingDimension[];
  };
}

interface CompletedApproval {
  readonly application: Application;
  readonly templateId: string;
  readonly durationHours: number;
}

type ListRepository<T> = { list(query: { page: number; pageSize: number }, tx: StorageTransaction): Promise<{ items: readonly T[]; total: number }> };
async function allRows<T extends { readonly id: string; readonly deletedAt: string | null }>(
  repository: ListRepository<T>,
  tx: StorageTransaction,
): Promise<T[]> {
  const first = await repository.list({ page: 1, pageSize: 100 }, tx);
  const rows = [...first.items];
  for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) rows.push(...(await repository.list({ page, pageSize: 100 }, tx)).items);
  return rows;
}

function percentile(sorted: readonly number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

function roundedHours(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

function assertAccess(actor: AuthContext): void {
  if (!actor.permissions.includes('analytics:read:all') || !permissionScopes(actor, 'analytics:read:all').includes('all')) {
    throw new AppError('FORBIDDEN', '审批耗时分析仅支持全量经营分析权限');
  }
  if (!actor.permissions.includes('application:read:all') || !permissionScopes(actor, 'application:read:all').includes('all')) {
    throw new AppError('FORBIDDEN', '没有读取全部审批申请的权限');
  }
}

export class ApprovalAnalyticsService {
  constructor(
    private readonly approvals: ApprovalRepositories,
    private readonly departments: Repository<DepartmentDocument>,
    private readonly uow: UnitOfWork,
    private readonly auth: AuthService,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async approvalTiming(requestContext: AuthContext, input: ApprovalTimingFilter = {}): Promise<ApprovalTimingReport> {
    const parsed = approvalTimingFilterSchema.safeParse(input);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', '审批耗时筛选条件无效');
    const filter = parsed.data;
    return this.uow.run(async (tx) => {
      const actor = await this.auth.loadCurrentActor(requestContext, tx);
      assertAccess(actor);
      const applications = await allRows(this.approvals.applications, tx);
      const instances = await allRows(this.approvals.instances, tx);
      const instanceByApplication = new Map(instances.filter((instance) => instance.deletedAt === null).map((instance) => [instance.applicationId, instance]));
      const completed: CompletedApproval[] = [];
      for (const application of applications) {
        if (application.deletedAt !== null || !['approved', 'rejected', 'withdrawn'].includes(application.status) || !application.submittedAt || !application.completedAt) continue;
        const instance = instanceByApplication.get(application.id);
        const start = Date.parse(application.submittedAt);
        const end = Date.parse(application.completedAt);
        if (!instance || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
        completed.push({ application, templateId: instance.templateId, durationHours: (end - start) / 3_600_000 });
      }
      const applicationTypes = [...new Set(completed.map((item) => item.application.applicationType))].sort();
      const departmentIds = [...new Set(completed.map((item) => item.application.departmentId).filter((id): id is string => Boolean(id)))];
      const departments = (await Promise.all(departmentIds.map(async (id) => {
        const department = await this.departments.get(id, tx);
        return department && department.deletedAt === null ? { id: department.id, name: department.name } : null;
      }))).filter((item): item is ApprovalTimingDimension => item !== null).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      const templateIds = [...new Set(completed.map((item) => item.templateId))];
      const templates = (await Promise.all(templateIds.map(async (id) => {
        const template = await this.approvals.templates.get(id, tx);
        return template && template.deletedAt === null ? { id: template.id, name: template.name } : null;
      }))).filter((item): item is ApprovalTimingDimension => item !== null).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      const filtered = completed.filter((item) => (
        (!filter.applicationType || item.application.applicationType === filter.applicationType) &&
        (!filter.departmentId || item.application.departmentId === filter.departmentId) &&
        (!filter.templateId || item.templateId === filter.templateId)
      ));
      const values = filtered.map((item) => item.durationHours).sort((left, right) => left - right);
      return {
        generatedAt: this.now(), filter, sampleCount: values.length,
        medianHours: roundedHours(percentile(values, 0.5)), p90Hours: roundedHours(percentile(values, 0.9)),
        options: { applicationTypes, departments, templates },
      };
    });
  }
}
