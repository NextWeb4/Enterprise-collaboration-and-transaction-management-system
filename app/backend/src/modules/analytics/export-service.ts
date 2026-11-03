import type { AuditService } from '../core/audit-service.js';
import type { AuthContext } from '../core/auth-service.js';
import { AppError } from '../../shared/errors.js';
import type {
  ProjectAnalyticsFilterInput,
  ProjectAnalyticsService,
} from './project-analytics-service.js';
import { singleSheetXlsx, type SpreadsheetValue } from './xlsx-writer.js';

const MAX_EXPORT_ROWS = 10_000;
const EXPORT_SOURCE = '企业协同与事务管理平台';
const COMPLETION_SEMANTICS = '当前快照；按项目创建时间筛选；已取消任务不计入有效任务';
const PROJECT_COMPLETION_HEADER = [
  '项目键',
  '项目名称',
  '项目状态',
  '项目创建时间',
  '任务数',
  '已完成任务数',
  '已取消任务数',
  '有效任务数',
  '未完成任务数',
  '完成率(%)',
  '统计口径',
  '生成时间',
  '数据来源',
] as const;

export interface ExportAuditContext {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

function csvCell(value: string | number): string {
  let text = String(value);
  let firstSignificant = 0;
  let hasLeadingControl = false;
  while (firstSignificant < text.length) {
    const character = text[firstSignificant]!;
    const code = text.charCodeAt(firstSignificant);
    if (character.trim() !== '' && code > 31 && (code < 127 || code > 159)) break;
    if (code <= 31 || (code >= 127 && code <= 159)) hasLeadingControl = true;
    firstSignificant += 1;
  }
  if (hasLeadingControl || /^[=+\-@]/u.test(text.slice(firstSignificant))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvRow(values: readonly (string | number)[]): string {
  return values.map(csvCell).join(',');
}

type ProjectCompletionReport = Awaited<ReturnType<ProjectAnalyticsService['projectCompletion']>>;

function projectRows(report: ProjectCompletionReport): SpreadsheetValue[][] {
  return report.projects.map((project) => [
    project.projectKey,
    project.projectName,
    project.projectStatus,
    project.projectCreatedAt,
    project.taskCount,
    project.completedTaskCount,
    project.cancelledTaskCount,
    project.effectiveTaskCount,
    project.openTaskCount,
    project.completionRate,
    COMPLETION_SEMANTICS,
    report.generatedAt,
    EXPORT_SOURCE,
  ]);
}

export class ProjectAnalyticsExportService {
  constructor(
    private readonly analytics: Pick<ProjectAnalyticsService, 'projectCompletion'>,
    private readonly audit: AuditService,
  ) {}

  async projectCompletionCsv(
    actor: AuthContext,
    filter: ProjectAnalyticsFilterInput,
    context: ExportAuditContext,
  ): Promise<string> {
    const report = await this.projectCompletion(actor, filter);
    const csv = `\uFEFF${[csvRow(PROJECT_COMPLETION_HEADER), ...projectRows(report).map(csvRow)].join('\r\n')}\r\n`;
    await this.recordExport(actor, filter, context, 'csv', report.projects.length);
    return csv;
  }

  async projectCompletionXlsx(
    actor: AuthContext,
    filter: ProjectAnalyticsFilterInput,
    context: ExportAuditContext,
  ): Promise<Buffer> {
    const report = await this.projectCompletion(actor, filter);
    const workbook = singleSheetXlsx('项目完成情况', [PROJECT_COMPLETION_HEADER, ...projectRows(report)]);
    await this.recordExport(actor, filter, context, 'xlsx', report.projects.length);
    return workbook;
  }

  private async projectCompletion(
    actor: AuthContext,
    filter: ProjectAnalyticsFilterInput,
  ): Promise<ProjectCompletionReport> {
    const report = await this.analytics.projectCompletion(actor, filter);
    if (report.projects.length > MAX_EXPORT_ROWS) {
      throw new AppError('VALIDATION_FAILED', `导出项目数超过上限 ${MAX_EXPORT_ROWS}`);
    }
    return report;
  }

  private async recordExport(
    actor: AuthContext,
    filter: ProjectAnalyticsFilterInput,
    context: ExportAuditContext,
    format: 'csv' | 'xlsx',
    rowCount: number,
  ): Promise<void> {
    await this.audit.append({
      actorUserId: actor.user.id,
      action: 'analytics.exported',
      resourceType: 'analytics_report',
      resourceId: 'project_completion',
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      metadata: {
        format,
        rowCount,
        createdFrom: filter.createdFrom ?? null,
        createdTo: filter.createdTo ?? null,
        projectId: filter.projectId ?? null,
      },
    });
  }
}
