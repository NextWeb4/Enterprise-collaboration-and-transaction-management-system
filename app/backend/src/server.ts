import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { LmdbStorageEngine } from './storage/engine.js';
import { UnitOfWork } from './storage/unit-of-work.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { AppError, isAppError } from './shared/errors.js';
import { systemClock } from './shared/clock.js';
import {
  AuthService,
  permissionScopes,
  type AuthContext,
  type RoleAuditContext,
} from './modules/core/auth-service.js';
import { AuditService } from './modules/core/audit-service.js';
import { FileService } from './modules/core/file-service.js';
import { BootstrapService } from './modules/core/bootstrap-service.js';
import {
  createCoreRepositories,
  seedCoreData,
  type CoreRepositories,
} from './modules/core/repositories.js';
import { publicUser } from './modules/core/repositories.js';
import {
  changePasswordRequestSchema,
  accountLifecycleRequestSchema,
  createUserRequestSchema,
  disableUserRequestSchema,
  loginRequestSchema,
  replaceUserRolesRequestSchema,
  roleCreateRequestSchema,
  roleDeleteRequestSchema,
  roleUpdateRequestSchema,
  setupAdminRequestSchema,
} from '@collab/shared/schemas.js';
import { PERMISSION_CATALOG } from '@collab/shared/permissions.js';
import type {
  BootstrapRecordDocument,
  RoleDocument,
  UserDocument,
} from './modules/core/models.js';
import { SingleInstanceLock } from './runtime/single-instance.js';
import { randomBytes } from 'node:crypto';
import { createProjectRepositories, ProjectService, type ProjectRepositories } from './modules/projects/project-service.js';
import { projectCreateSchema, projectTransitionSchema, projectUpdateSchema, taskCreateSchema, taskUpdateSchema, projectMemberCreateSchema, projectTransferOwnerSchema, projectMemberDeleteSchema, projectMemberUpdateSchema, departmentCreateSchema, departmentUpdateSchema, taskCommentCreateSchema, taskCommentUpdateSchema, taskCommentDeleteSchema, taskBoardMoveSchema } from '@collab/shared/schemas.js';
import {
  createOrganizationRepositories,
  type OrganizationRepositories,
} from './modules/organization/repositories.js';
import { DepartmentService } from './modules/organization/department-service.js';
import { createApprovalRepositories, hasCurrentApproval } from './modules/approvals/repositories.js';
import { ProjectAnalyticsService } from './modules/analytics/project-analytics-service.js';
import { ProjectAnalyticsExportService } from './modules/analytics/export-service.js';
import { registerProjectAnalyticsExportRoutes } from './modules/analytics/export-routes.js';
import { DepartmentWorkloadService } from './modules/analytics/department-workload-service.js';
import { registerDepartmentWorkloadRoutes } from './modules/analytics/department-workload-routes.js';
import { ApprovalAnalyticsService } from './modules/analytics/approval-analytics-service.js';
import { registerApprovalAnalyticsRoutes } from './modules/analytics/routes.js';
import { createDocumentRepositories } from './modules/documents/repositories.js';
import { DocumentService } from './modules/documents/document-service.js';
import { registerDocumentRoutes } from './modules/documents/routes.js';
import { createOrganizationDirectoryRepositories } from './modules/organization/directory-repositories.js';
import { OrganizationDirectoryService } from './modules/organization/directory-service.js';
import { registerOrganizationDirectoryRoutes } from './modules/organization/directory-routes.js';
import { ApplicationService } from './modules/approvals/application-service.js';
import { ApprovalService } from './modules/approvals/approval-service.js';
import { WorkflowTemplateService } from './modules/approvals/template-service.js';
import { registerApprovalRoutes } from './modules/approvals/routes.js';
import { SystemService } from './modules/system/system-service.js';
import { registerSystemRoutes } from './modules/system/system-routes.js';
import { WorkbenchService } from './modules/workbench/workbench-service.js';
import { registerWorkbenchRoutes } from './modules/workbench/routes.js';
import { createCalendarRepositories } from './modules/calendar/repositories.js';
import type { CalendarRepositories } from './modules/calendar/repositories.js';
import { CalendarService } from './modules/calendar/calendar-service.js';
import { registerCalendarRoutes } from './modules/calendar/routes.js';
import { createCalendarReminderScheduler } from './modules/calendar/reminder-scheduler.js';

declare module 'fastify' {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

export interface AppDependencies {
  readonly config: AppConfig;
  readonly engine: LmdbStorageEngine;
  readonly repos: CoreRepositories;
  readonly projectRepos: ProjectRepositories;
  readonly calendarRepos: CalendarRepositories;
  readonly organizationRepos: OrganizationRepositories;
  readonly auth: AuthService;
  readonly audit: AuditService;
  readonly files: FileService;
  readonly uow: UnitOfWork;
}

export interface BuildAppOptions {
  readonly config?: AppConfig;
  readonly dataDir?: string;
  readonly logger?: boolean;
  readonly initialize?: boolean;
  /** Tests and one-off maintenance commands can disable the in-process reminder timer. */
  readonly startReminderScheduler?: boolean;
}

interface BootstrapRecordView {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly message: string;
  readonly source: string;
}

function bootstrapRecordView(record: BootstrapRecordDocument): BootstrapRecordView {
  return {
    id: record.id,
    type: record.type,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    message: record.message,
    source: record.source,
  };
}

function defaultConfig(): AppConfig {
  return loadConfig({ ...process.env, DATA_DIR: process.env.DATA_DIR ?? './.data' });
}

/** Node may report a browser connected to an IPv4 listener as an IPv4-mapped IPv6 address. */
function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLocalInitializationRequest(request: FastifyRequest, config: AppConfig): boolean {
  return (
    config.host === '127.0.0.1' &&
    isLoopbackAddress(request.ip) &&
    request.headers.host === `127.0.0.1:${config.port}`
  );
}

function noSensitiveUser(user: UserDocument): ReturnType<typeof publicUser> {
  return publicUser(user);
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<{ app: FastifyInstance; deps: AppDependencies }> {
  const baseConfig = options.config ?? defaultConfig();
  const config = options.dataDir ? { ...baseConfig, dataDir: options.dataDir } : baseConfig;
  const engine = new LmdbStorageEngine({ path: resolve(config.dataDir, 'store', 'lmdb') });
  await mkdir(config.dataDir, { recursive: true });
  await engine.open();
  const repos = createCoreRepositories(engine, systemClock);
  const bootstrap = new BootstrapService(repos);
  if (options.initialize !== false) await seedCoreData(repos);
  const uow = new UnitOfWork(engine);
  const audit = new AuditService(repos, uow);
  const projectRepos = createProjectRepositories(engine, repos);
  const calendarRepos = createCalendarRepositories(engine, repos.registry);
  const approvalRepos = createApprovalRepositories(engine, repos.registry);
  const organizationRepos = createOrganizationRepositories(engine);
  const hasProjectOwnership = async (userId: string, tx: import('./storage/engine.js').StorageTransaction): Promise<boolean> => {
    const first = await projectRepos.projects.list({ page: 1, pageSize: 100 }, tx);
    if (first.items.some((project) => project.ownerId === userId)) return true;
    for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) {
      if ((await projectRepos.projects.list({ page, pageSize: 100 }, tx)).items.some((project) => project.ownerId === userId)) return true;
    }
    return false;
  };
  const deps: AppDependencies = {
    config,
    engine,
    repos,
    projectRepos,
    calendarRepos,
    organizationRepos,
    auth: new AuthService(
      repos,
      uow,
      audit,
      systemClock,
      config.sessionIdleMinutes,
      config.sessionAbsoluteDays,
      hasProjectOwnership,
      (userId, tx) => hasCurrentApproval(approvalRepos, userId, tx),
    ),
    audit,
    files: new FileService(config.dataDir, repos, uow, audit),
    uow,
  };
  const fileReconciliation = await deps.files.init();
  const projects = new ProjectService(projectRepos, repos, uow, deps.auth, audit);
  const analytics = new ProjectAnalyticsService(
    projectRepos,
    uow,
    deps.auth,
    () => systemClock.nowIso(),
    async (tx) =>
      (await repos.organizations.list({ page: 1, pageSize: 1 }, tx)).items[0]?.timezone ?? 'UTC',
  );
  const analyticsExport = new ProjectAnalyticsExportService(analytics, audit);
  const departmentWorkload = new DepartmentWorkloadService(
    projectRepos,
    organizationRepos.departments,
    repos,
    uow,
    deps.auth,
    () => systemClock.nowIso(),
    async (tx) =>
      (await repos.organizations.list({ page: 1, pageSize: 1 }, tx)).items[0]?.timezone ?? 'UTC',
  );
  const approvalAnalytics = new ApprovalAnalyticsService(approvalRepos, organizationRepos.departments, uow, deps.auth);
  const departments = new DepartmentService(organizationRepos.departments, repos, uow, audit);
  const directoryRepos = createOrganizationDirectoryRepositories(engine, systemClock, repos.registry);
  const directory = new OrganizationDirectoryService(directoryRepos.employees, directoryRepos.positions, organizationRepos.departments, repos, uow, audit);
  const documentRepos = createDocumentRepositories(engine, repos);
  const documents = new DocumentService(documentRepos, repos, projectRepos, organizationRepos.departments, uow, deps.auth, audit, deps.files);
  const calendar = new CalendarService(calendarRepos, repos, projectRepos, uow, deps.auth, audit);
  const approvalDependencies = { departments: organizationRepos.departments, projects: projectRepos, files: deps.files };
  const applications = new ApplicationService(approvalRepos, repos, uow, deps.auth, audit, approvalDependencies);
  const approvals = new ApprovalService(approvalRepos, repos, uow, deps.auth, audit, systemClock, approvalDependencies);
  const templates = new WorkflowTemplateService(approvalRepos, repos, uow, deps.auth, audit);
  const system = new SystemService(repos, uow, audit, systemClock);
  const workbenchService = new WorkbenchService(
    repos,
    projectRepos,
    approvalRepos,
    deps.auth,
    uow,
    systemClock,
    calendarRepos,
  );

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: [
              'req.headers.cookie',
              'req.headers.authorization',
              'res.headers["set-cookie"]',
            ],
          },
    requestIdHeader: 'x-request-id',
  });
  const reminderScheduler = createCalendarReminderScheduler(
    () => calendar.deliverDueRemindersForAllActiveUsers(),
    app.log,
  );
  await app.register(cookie);
  await app.register(cors, { origin: config.webOrigin, credentials: true });
  await app.register(helmet);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
    throwFileSizeLimit: false,
  });
  const staticRoot = resolve('app', 'frontend', 'dist');
  if (await exists(join(staticRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: staticRoot, wildcard: false });
    app.get('/login', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/app', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/app/*', async (_request, reply) => reply.sendFile('index.html'));
  }

  const requireAuth = async (request: FastifyRequest): Promise<AuthContext> => {
    const token = request.cookies[config.sessionCookieName];
    if (!token) throw new AppError('UNAUTHENTICATED', '会话已失效');
    const context = await deps.auth.loadContext(token);
    await deps.auth.touchSession(context.session);
    const allowedDuringPasswordChange = new Set([
      '/api/v1/auth/me',
      '/api/v1/auth/change-password',
      '/api/v1/auth/logout',
    ]);
    const pathname = request.url.split('?', 1)[0] ?? '';
    if (context.user.mustChangePassword && !allowedDuringPasswordChange.has(pathname)) {
      throw new AppError('PASSWORD_CHANGE_REQUIRED', '首次登录后必须先修改密码');
    }
    request.authContext = context;
    return context;
  };
  const requirePermission =
    (permission: string) =>
    async (request: FastifyRequest): Promise<void> => {
      const context = request.authContext ?? (await requireAuth(request));
      if (!context.permissions.includes(permission))
        throw new AppError('FORBIDDEN', '没有执行此操作的权限');
    };
  const ensureOrigin = (request: FastifyRequest): void => {
    const origin = request.headers.origin;
    const referer = request.headers.referer;
    const isAllowedOrigin = (value: string): boolean => {
      try {
        const candidate = new URL(value).origin;
        const configured = new URL(config.webOrigin).origin;
        return candidate === configured;
      } catch {
        return false;
      }
    };
    if (origin && !isAllowedOrigin(origin)) throw new AppError('CSRF_INVALID', '请求来源不被允许');
    if (!origin && referer) {
      if (!isAllowedOrigin(referer)) throw new AppError('CSRF_INVALID', '请求来源不被允许');
    }
    if (!origin && !referer) throw new AppError('CSRF_INVALID', '请求来源缺失');
  };
  const requireCsrf = async (request: FastifyRequest): Promise<void> => {
    ensureOrigin(request);
    const context = request.authContext ?? (await requireAuth(request));
    const headerToken = request.headers['x-csrf-token'];
    const cookieToken = request.cookies.csrf_token;
    if (
      !headerToken ||
      !cookieToken ||
      headerToken !== cookieToken ||
      headerToken !== context.session.csrfToken
    ) {
      throw new AppError('CSRF_INVALID', 'CSRF token 无效');
    }
  };
  const currentOrg = async (): Promise<
    import('./modules/core/models.js').OrganizationDocument | null
  > => (await repos.organizations.list({ page: 1, pageSize: 1 })).items[0] ?? null;
  registerOrganizationDirectoryRoutes(app, { service: directory, requireAuth, requireCsrf });
  registerDocumentRoutes(app, { service: documents, files: deps.files, requireAuth, requireCsrf, maxUploadBytes: config.maxUploadMb * 1024 * 1024 });
  registerCalendarRoutes(app, { service: calendar, core: repos, requireAuth, requireCsrf });
  registerApprovalRoutes(app, { applications, approvals, templates, requireAuth, requireCsrf });
  registerSystemRoutes(app, { service: system, requireAuth, requireCsrf });
  registerWorkbenchRoutes(app, { service: workbenchService, requireAuth, requireCsrf });
  registerApprovalAnalyticsRoutes(app, { service: approvalAnalytics, requireAuth });
  registerProjectAnalyticsExportRoutes(app, { service: analyticsExport, requireAuth });
  registerDepartmentWorkloadRoutes(app, { service: departmentWorkload, requireAuth });
  const userView = async (context: AuthContext): Promise<ReturnType<typeof Promise.resolve>> => {
    const roleInfo = await deps.auth.rolesAndPermissions(context.user);
    const organization = await currentOrg();
    return {
      user: noSensitiveUser(context.user),
      organization: organization
        ? { name: organization.name, timezone: organization.timezone }
        : null,
      roles: roleInfo.roles,
      permissions: roleInfo.permissions,
      csrfToken: context.session.csrfToken,
    };
  };

  app.get('/health/live', async () => ({ data: { status: 'live' } }));
  app.get('/api/health', async (_request, reply) => {
    const storage = await engine.healthCheck();
    if (!storage.ok) reply.code(503);
    return {
      data: {
        ok: storage.ok,
        status: storage.ok ? 'ok' : 'degraded',
        storage,
      },
    };
  });
  app.get('/health/ready', async (_request, reply) => {
    const health = await engine.healthCheck();
    const readiness = {
      ...health,
      ok: health.ok && fileReconciliation.ok,
      files: fileReconciliation,
    };
    if (!readiness.ok) return reply.code(503).send({ data: readiness });
    return { data: readiness };
  });

  app.get('/api/bootstrap/storage', async () => {
    if (config.nodeEnv !== 'development' || config.host !== '127.0.0.1') throw new AppError('NOT_FOUND', '启动测试接口不可用');
    const record = await bootstrap.latest();
    return { data: { record: record ? bootstrapRecordView(record) : null } };
  });

  app.post('/api/bootstrap/storage', async (request): Promise<{
    data: { record: BootstrapRecordView; readBack: BootstrapRecordView };
  }> => {
    if (config.nodeEnv !== 'development' || config.host !== '127.0.0.1') throw new AppError('NOT_FOUND', '启动测试接口仅在本机开发环境可用');
    ensureOrigin(request);
    const body = z
      .object({ message: z.string().trim().min(1).max(200).optional() })
      .default({})
      .parse(request.body);
    const { record, readBack } = await bootstrap.writeAndRead(body.message ?? `LMDB bootstrap ${new Date().toISOString()}`);
    return { data: { record: bootstrapRecordView(record), readBack: bootstrapRecordView(readBack) } };
  });

  app.post(
    '/api/v1/setup/admin',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      if (!isLocalInitializationRequest(request, config)) throw new AppError('FORBIDDEN', '仅限本机初始化');
      ensureOrigin(request);
      const parsed = setupAdminRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);
      await deps.auth.setupAdmin(parsed.data, roleAuditContext(request));
      return reply.code(201).send({ data: { success: true } });
    },
  );
  app.get('/api/v1/setup/status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { data: { required: isLocalInitializationRequest(request, config) && await deps.auth.isSetupRequired() } };
  });

  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      ensureOrigin(request);
      const parsed = loginRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);
      const result = await deps.auth.verifyLogin(parsed.data.email, parsed.data.password, {
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });
      reply.setCookie(config.sessionCookieName, result.token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: config.sessionAbsoluteDays * 86_400,
      });
      reply.setCookie('csrf_token', result.csrfToken, {
        httpOnly: false,
        sameSite: 'lax',
        path: '/',
        maxAge: config.sessionAbsoluteDays * 86_400,
      });
      const context = await deps.auth.loadContext(result.token);
      return { data: await userView(context) };
    },
  );

  app.get('/api/v1/auth/me', { preHandler: requireAuth }, async (request) => ({
    data: await userView(request.authContext as AuthContext),
  }));
  app.post(
    '/api/v1/auth/logout',
    { preHandler: [requireAuth, requireCsrf] },
    async (request, reply) => {
      const context = request.authContext as AuthContext;
      await deps.auth.revoke(context.session, {
        actorUserId: context.user.id,
        action: 'auth.logout',
        resourceType: 'session',
        resourceId: context.session.id,
        requestId: request.id,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      });
      reply.clearCookie(config.sessionCookieName, { path: '/' });
      reply.clearCookie('csrf_token', { path: '/' });
      return { data: { success: true } };
    },
  );
  app.post(
    '/api/v1/auth/change-password',
    { preHandler: [requireAuth, requireCsrf] },
    async (request) => {
      const parsed = changePasswordRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);
      const context = request.authContext as AuthContext;
      await deps.auth.changePassword(
        context,
        parsed.data.currentPassword,
        parsed.data.newPassword,
        {
          actorUserId: context.user.id,
          action: 'auth.password_changed',
          resourceType: 'user',
          resourceId: context.user.id,
          requestId: request.id,
          ip: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
        },
      );
      return { data: { success: true } };
    },
  );

  app.get(
    '/api/v1/workbench',
    { preHandler: [requireAuth, requirePermission('workbench:read')] },
    async (request) => {
      const context = request.authContext as AuthContext;
      const organization = await currentOrg();
      const sessions = await repos.sessions.list({ page: 1, pageSize: 100 });
      return {
        data: {
          user: noSensitiveUser(context.user),
          organization: organization
            ? { name: organization.name, timezone: organization.timezone }
            : null,
          security: {
            activeSessions: sessions.items.filter(
              (item) => item.userId === context.user.id && !item.revokedAt,
            ).length,
            lastLoginAt: context.user.lastLoginAt,
            passwordChangedAt: context.user.passwordChangedAt,
          },
          modules: [
            { key: 'workbench', name: '工作台', status: 'available' },
            { key: 'projects', name: '项目与任务', status: 'available' },
            { key: 'approvals', name: '行政审批', status: 'available' },
            { key: 'documents', name: '文档中心', status: 'available' },
            { key: 'analytics', name: '项目数据分析', status: 'available' },
          ],
        },
      };
    },
  );

  app.get(
    '/api/v1/organization/permissions',
    { preHandler: [requireAuth, requirePermission('permission:read')] },
    async () => ({ data: PERMISSION_CATALOG }),
  );
  const roleView = (role: RoleDocument): RoleDocument => ({
    id: role.id,
    type: role.type,
    schemaVersion: role.schemaVersion,
    version: role.version,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
    deletedAt: role.deletedAt,
    code: role.code,
    name: role.name,
    description: role.description,
    dataScope: role.dataScope,
    permissionCodes: role.permissionCodes,
    system: role.system,
  });
  const roleAuditContext = (request: FastifyRequest): RoleAuditContext => ({
    requestId: request.id,
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  });
  const projectAuditContext = (request: FastifyRequest): import('./modules/core/audit-service.js').AuditInput => ({
    actorUserId: (request.authContext as AuthContext).user.id, action: '', resourceType: '', ...roleAuditContext(request),
  });
  const resourceId = (request: FastifyRequest): string => z.object({id:z.string().min(1)}).parse(request.params).id;
  app.get('/api/v1/organization/departments', { preHandler: [requireAuth] }, async (request) => ({ data: await departments.list(request.authContext as AuthContext) }));
  app.post('/api/v1/organization/departments', { preHandler: [requireAuth, requireCsrf] }, async (request, reply) => {
    const parsed = departmentCreateSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const result = await departments.create(request.authContext as AuthContext, parsed.data, roleAuditContext(request));
    return reply.code(201).send({ data: result });
  });
  app.patch('/api/v1/organization/departments/:id', { preHandler: [requireAuth, requireCsrf] }, async (request) => {
    const parsed = departmentUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw validationError(parsed.error);
    const { version, ...fields } = parsed.data;
    return { data: await departments.update(request.authContext as AuthContext, resourceId(request), version, fields, roleAuditContext(request)) };
  });
  app.get('/api/v1/projects', {preHandler:[requireAuth]}, async (request) => {
    const query = z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)}).parse(request.query);
    const result = await projects.list(request.authContext as AuthContext,query.page,query.pageSize);
    return {data:result.items,meta:{page:query.page,pageSize:query.pageSize,total:result.total}};
  });
  app.get('/api/v1/analytics/project-completion', { preHandler: [requireAuth] }, async (request) => ({
    data: await analytics.projectCompletion(request.authContext as AuthContext, request.query as Record<string, string>),
  }));
  app.post('/api/v1/projects', {preHandler:[requireAuth,requireCsrf]}, async (request,reply) => {
    const input=projectCreateSchema.parse(request.body); const result=await projects.create(request.authContext as AuthContext,input,projectAuditContext(request));
    return reply.code(201).send({data:result});
  });
  app.get('/api/v1/projects/:id', {preHandler:[requireAuth]}, async (request) => ({data:await projects.detail(request.authContext as AuthContext,resourceId(request))}));
  app.patch('/api/v1/projects/:id', {preHandler:[requireAuth,requireCsrf]}, async (request) => ({data:await projects.updateProject(request.authContext as AuthContext,resourceId(request),projectUpdateSchema.parse(request.body),projectAuditContext(request))}));
  app.delete('/api/v1/projects/:id', {preHandler:[requireAuth,requireCsrf]}, async (request) => { const input = projectMemberDeleteSchema.parse(request.body); await projects.deleteProject(request.authContext as AuthContext,resourceId(request),input.version,projectAuditContext(request)); return {data:{success:true}}; });
  app.post('/api/v1/projects/:id/transition', {preHandler:[requireAuth,requireCsrf]}, async (request) => ({data:await projects.transition(request.authContext as AuthContext,resourceId(request),projectTransitionSchema.parse(request.body),projectAuditContext(request))}));
  app.post('/api/v1/projects/:id/members', {preHandler:[requireAuth,requireCsrf]}, async (request,reply) => reply.code(201).send({data:await projects.addMember(request.authContext as AuthContext,resourceId(request),projectMemberCreateSchema.parse(request.body),projectAuditContext(request))}));
  app.get('/api/v1/projects/:id/members', {preHandler:[requireAuth]}, async (request) => ({data:await projects.listMembers(request.authContext as AuthContext,resourceId(request))}));
  app.patch('/api/v1/projects/:id/members/:userId', {preHandler:[requireAuth,requireCsrf]}, async (request) => { const params=z.object({id:z.string().min(1),userId:z.string().min(1)}).parse(request.params); const input=projectMemberUpdateSchema.parse(request.body); return {data:await projects.updateMember(request.authContext as AuthContext,params.id,params.userId,input.role,input.version,projectAuditContext(request))}; });
  app.post('/api/v1/projects/:id/transfer-owner', {preHandler:[requireAuth,requireCsrf]}, async (request) => {const input=projectTransferOwnerSchema.parse(request.body); return {data:await projects.transferOwner(request.authContext as AuthContext,resourceId(request),input.userId,input.version,projectAuditContext(request))};});
  app.delete('/api/v1/projects/:id/members/:userId', {preHandler:[requireAuth,requireCsrf]}, async (request) => {const params=z.object({id:z.string().min(1),userId:z.string().min(1)}).parse(request.params); const input=projectMemberDeleteSchema.parse(request.body); await projects.removeMember(request.authContext as AuthContext,params.id,params.userId,input.version,projectAuditContext(request)); return {data:{success:true}};});
  app.get('/api/v1/projects/:id/tasks', {preHandler:[requireAuth]}, async (request) => {
    const query=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)}).parse(request.query);
    const tasks=await projects.listTasks(request.authContext as AuthContext,resourceId(request));
    return {data:tasks.slice((query.page-1)*query.pageSize,query.page*query.pageSize),meta:{page:query.page,pageSize:query.pageSize,total:tasks.length}};
  });
  app.post('/api/v1/projects/:id/tasks', {preHandler:[requireAuth,requireCsrf]}, async (request,reply) => reply.code(201).send({data:await projects.createTask(request.authContext as AuthContext,resourceId(request),taskCreateSchema.parse(request.body),projectAuditContext(request))}));
  app.patch('/api/v1/tasks/:id', {preHandler:[requireAuth,requireCsrf]}, async (request) => ({data:await projects.updateTask(request.authContext as AuthContext,resourceId(request),taskUpdateSchema.parse(request.body),projectAuditContext(request))}));
  app.get('/api/v1/tasks/:id', {preHandler:[requireAuth]}, async (request) => ({data:await projects.detailTask(request.authContext as AuthContext,resourceId(request))}));
  app.delete('/api/v1/tasks/:id', {preHandler:[requireAuth,requireCsrf]}, async (request) => { const input = projectMemberDeleteSchema.parse(request.body); await projects.deleteTask(request.authContext as AuthContext,resourceId(request),input.version,projectAuditContext(request)); return {data:{success:true}}; });
  app.patch('/api/v1/tasks/:id/board', {preHandler:[requireAuth,requireCsrf]}, async (request) => ({data:await projects.moveTask(request.authContext as AuthContext,resourceId(request),taskBoardMoveSchema.parse(request.body),projectAuditContext(request))}));
  app.get('/api/v1/tasks/:id/comments', {preHandler:[requireAuth]}, async (request) => { const query=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)}).parse(request.query); const result=await projects.listComments(request.authContext as AuthContext,resourceId(request),query.page,query.pageSize); return {data:result.items,meta:{...query,total:result.total}}; });
  app.post('/api/v1/tasks/:id/comments', {preHandler:[requireAuth,requireCsrf]}, async (request,reply) => { const input=taskCommentCreateSchema.parse(request.body); return reply.code(201).send({data:await projects.createComment(request.authContext as AuthContext,resourceId(request),input.content,projectAuditContext(request))}); });
  app.patch('/api/v1/comments/:id', {preHandler:[requireAuth,requireCsrf]}, async (request) => { const input=taskCommentUpdateSchema.parse(request.body); return {data:await projects.updateComment(request.authContext as AuthContext,resourceId(request),input.version,input.content,projectAuditContext(request))}; });
  app.delete('/api/v1/comments/:id', {preHandler:[requireAuth,requireCsrf]}, async (request) => { const input=taskCommentDeleteSchema.parse(request.body); await projects.deleteComment(request.authContext as AuthContext,resourceId(request),input.version,input.reason,projectAuditContext(request)); return {data:{success:true}}; });
  const listRoles = async (request: FastifyRequest): Promise<{
    data: RoleDocument[];
    meta: { page: number; pageSize: number; total: number };
  }> => {
    const context = request.authContext as AuthContext;
    if (!permissionScopes(context, 'role:manage').includes('all')) {
      throw new AppError('FORBIDDEN', '当前数据范围暂不支持查询角色');
    }
    const query = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    const page = await repos.roles.list(query);
    return {
      data: page.items.map(roleView),
      meta: { page: page.page, pageSize: page.pageSize, total: page.total },
    };
  };
  app.get(
    '/api/v1/roles',
    { preHandler: [requireAuth, requirePermission('role:manage')] },
    listRoles,
  );
  app.get(
    '/api/v1/organization/roles',
    { preHandler: [requireAuth, requirePermission('role:manage')] },
    listRoles,
  );
  app.post(
    '/api/v1/organization/roles',
    { preHandler: [requireAuth, requireCsrf, requirePermission('role:manage')] },
    async (request, reply) => {
      const parsed = roleCreateRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);
      const context = request.authContext as AuthContext;
      const role = await deps.auth.createRole(context, parsed.data, roleAuditContext(request));
      return reply
        .header('Location', `/api/v1/organization/roles/${role.id}`)
        .code(201)
        .send({ data: roleView(role) });
    },
  );
  app.patch(
    '/api/v1/organization/roles/:id',
    { preHandler: [requireAuth, requireCsrf, requirePermission('role:manage')] },
    async (request) => {
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      const parsed = roleUpdateRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);
      const context = request.authContext as AuthContext;
      const role = await deps.auth.updateRole(
        context,
        params.id,
        parsed.data,
        roleAuditContext(request),
      );
      return { data: roleView(role) };
    },
  );
  app.delete(
    '/api/v1/organization/roles/:id',
    { preHandler: [requireAuth, requireCsrf, requirePermission('role:manage')] },
    async (request) => {
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      const parsed = roleDeleteRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);
      const context = request.authContext as AuthContext;
      await deps.auth.deleteRole(
        context,
        params.id,
        parsed.data.version,
        roleAuditContext(request),
      );
      return { data: { success: true } };
    },
  );
  app.get(
    '/api/v1/users',
    { preHandler: [requireAuth, requirePermission('user:manage')] },
    async (request) => {
      const context = request.authContext as AuthContext;
      if (!permissionScopes(context, 'user:manage').includes('all')) {
        throw new AppError('FORBIDDEN', '当前数据范围暂不支持查询用户');
      }
      const query = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
      const page = await repos.users.list(query);
      return {
        data: page.items.map((user) => ({ ...noSensitiveUser(user), version: user.version })),
        meta: { page: page.page, pageSize: page.pageSize, total: page.total },
      };
    },
  );
  app.get(
    '/api/v1/organization/users/:id/effective-permissions',
    { preHandler: [requireAuth, requirePermission('role:manage')] },
    async (request) => {
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      const context = request.authContext as AuthContext;
      return { data: await deps.auth.getManagedUserPermissions(context, params.id) };
    },
  );
  app.post(
    '/api/v1/users',
    { preHandler: [requireAuth, requireCsrf, requirePermission('user:manage')] },
    async (request, reply) => {
      const parsed = createUserRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);
      const context = request.authContext as AuthContext;
      const temporaryPassword = parsed.data.password ?? randomTemporaryPassword();
      const passwordHash = await deps.auth.createPasswordHash(temporaryPassword);
      const user = await deps.auth.createManagedUser(
        context,
        {
          name: parsed.data.name,
          email: parsed.data.email,
          passwordHash,
          roleCodes: [parsed.data.roleCode],
        },
        roleAuditContext(request),
      );
      return reply
        .header('Location', `/api/v1/users/${user.id}`)
        .code(201)
        .send({ data: { user: noSensitiveUser(user), ...(parsed.data.password ? {} : { temporaryPassword }) } });
    },
  );
  app.post(
    '/api/v1/users/:id/disable',
    { preHandler: [requireAuth, requireCsrf, requirePermission('user:manage')] },
    async (request) => {
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      const parsed = disableUserRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);
      const context = request.authContext as AuthContext;
      const user = await deps.auth.disableUser(
        context,
        params.id,
        parsed.data.version,
        parsed.data.reason,
        roleAuditContext(request),
      );
      return { data: noSensitiveUser(user) };
    },
  );
  app.post('/api/v1/users/:id/enable', { preHandler: [requireAuth, requireCsrf, requirePermission('user:manage')] }, async (request) => {
    const input = accountLifecycleRequestSchema.parse(request.body);
    const user = await deps.auth.enableUser(request.authContext as AuthContext, resourceId(request), input.version, roleAuditContext(request));
    return { data: { ...noSensitiveUser(user), version: user.version } };
  });
  app.post('/api/v1/users/:id/reset-password', { preHandler: [requireAuth, requireCsrf, requirePermission('user:manage')] }, async (request, reply) => {
    const input = accountLifecycleRequestSchema.parse(request.body);
    const result = await deps.auth.resetManagedPassword(request.authContext as AuthContext, resourceId(request), input.version, roleAuditContext(request));
    return reply.header('Cache-Control', 'no-store').send({ data: { user: { ...noSensitiveUser(result.user), version: result.user.version }, temporaryPassword: result.temporaryPassword } });
  });
  app.post('/api/v1/users/:id/force-logout', { preHandler: [requireAuth, requireCsrf, requirePermission('session:manage')] }, async (request) => {
    const input = accountLifecycleRequestSchema.parse(request.body);
    return { data: await deps.auth.forceLogoutUser(request.authContext as AuthContext, resourceId(request), input.version, roleAuditContext(request)) };
  });
  app.put(
    '/api/v1/users/:id/roles',
    { preHandler: [requireAuth, requireCsrf, requirePermission('role:manage')] },
    async (request) => {
      const params = z.object({ id: z.string().min(1) }).parse(request.params);
      const parsed = replaceUserRolesRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationError(parsed.error);
      const context = request.authContext as AuthContext;
      const user = await deps.auth.replaceUserRoles(
        context,
        params.id,
        parsed.data.roleIds,
        parsed.data.version,
        roleAuditContext(request),
      );
      return { data: noSensitiveUser(user) };
    },
  );
  app.get(
    '/api/v1/audit-logs',
    { preHandler: [requireAuth, requirePermission('audit:read')] },
    async (request) => {
      const context = request.authContext as AuthContext;
      // Department and self audit filtering are not implemented; never expose
      // the whole audit log merely because the permission code is present.
      if (!permissionScopes(context, 'audit:read').includes('all')) {
        throw new AppError('FORBIDDEN', '当前数据范围暂不支持查询审计日志');
      }
      const page = await repos.auditLogs.list({ page: 1, pageSize: 100 });
      return {
        data: page.items.map((item) => ({
          id: item.id,
          actorUserId: item.actorUserId,
          action: item.action,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          requestId: item.requestId,
          createdAt: item.createdAt,
          metadata: item.metadata,
          hash: item.hash,
        })),
        meta: { page: page.page, pageSize: page.pageSize, total: page.total },
      };
    },
  );

  app.post(
    '/api/v1/files',
    { preHandler: [requireAuth, requireCsrf, requirePermission('document:create')] },
    async () => {
      throw new AppError('VALIDATION_FAILED', '请通过文档或申请附件接口上传文件');
    },
  );
  app.get(
    '/api/v1/files/:id/download',
    { preHandler: [requireAuth, requirePermission('document:read')] },
    async () => {
      throw new AppError('NOT_FOUND', '请通过文档或申请附件接口下载文件');
    },
  );

  app.setNotFoundHandler(async (request, reply) =>
    reply
      .code(404)
      .type('application/problem+json')
      .send({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
        detail: '请求资源不存在',
        requestId: request.id,
        instance: request.url,
      }),
  );
  app.setErrorHandler((error, request, reply) => {
    if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 429) {
      return reply.code(429).type('application/problem+json').send(new AppError('RATE_LIMITED', '请求过于频繁，请稍后重试').toProblem(request.id, request.url));
    }
    if (isAppError(error))
      return reply
        .code(error.status)
        .type('application/problem+json')
        .send(error.toProblem(request.id, request.url));
    if (error instanceof ZodError)
      return reply
        .code(422)
        .type('application/problem+json')
        .send(validationError(error).toProblem(request.id, request.url));
    request.log.error({ err: error }, 'unhandled request error');
    return reply
      .code(500)
      .type('application/problem+json')
      .send(new AppError('INTERNAL_ERROR', '服务器内部错误').toProblem(request.id, request.url));
  });
  if (options.startReminderScheduler !== false) reminderScheduler.start();
  app.addHook('onClose', async () => {
    reminderScheduler.stop();
    await engine.close();
  });
  return { app, deps };
}

function validationError(error: ZodError): AppError {
  return new AppError(
    'VALIDATION_FAILED',
    '请求参数校验失败',
    error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}

function randomTemporaryPassword(): string {
  return `Tmp-${randomBytes(12).toString('base64url')}!`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await import('node:fs/promises').then(({ access }) => access(path));
    return true;
  } catch {
    return false;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) ===
    resolve(new URL(import.meta.url).pathname.replace(/^\//, '').replaceAll('/', '\\'))
) {
  const config = loadConfig({ ...process.env, DATA_DIR: process.env.DATA_DIR ?? './.data' });
  const lock = new SingleInstanceLock(config.dataDir);
  await lock.acquire();
  let app: FastifyInstance | null = null;
  try {
    app = (await buildApp({ config })).app;
    app.addHook('onClose', async () => {
      await lock.release();
    });
    const stop = async (): Promise<void> => {
      if (app) await app.close();
    };
    const requestStop = (): void => {
      void stop().catch(() => {
        process.exitCode = 1;
        void lock.release();
      });
    };
    process.once('SIGINT', requestStop);
    process.once('SIGTERM', requestStop);
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    if (app) await app.close().catch(() => undefined);
    await lock.release().catch(() => undefined);
    throw error;
  }
}

