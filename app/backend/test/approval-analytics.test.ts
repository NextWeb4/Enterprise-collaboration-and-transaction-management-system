import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';
import { createApprovalRepositories } from '../src/modules/approvals/repositories.js';
import { createOrganizationRepositories } from '../src/modules/organization/repositories.js';
import { ApprovalAnalyticsService } from '../src/modules/analytics/approval-analytics-service.js';
import type { Application } from '../src/modules/approvals/models.js';

describe('approval timing analytics', () => {
  it('calculates natural-hour median/P90, supports type/department/template filters, and fails closed without all approval access', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-approval-analytics-'));
    const config = loadConfig({ NODE_ENV: 'development', DATA_DIR: dir, HOST: '127.0.0.1', PORT: '3320', WEB_ORIGIN: 'http://127.0.0.1:5173' });
    const { app, deps } = await buildApp({ config, logger: false });
    try {
      await deps.auth.setupAdmin({ name: '分析管理员', email: 'approval.analytics.admin', password: 'ApprovalAnalyticsStrong123!' }, { requestId: null, ip: null, userAgent: null });
      const login = await deps.auth.verifyLogin('approval.analytics.admin', 'ApprovalAnalyticsStrong123!', { ip: null, userAgent: null });
      const actor = await deps.auth.loadContext(login.token);
      const approvalRepos = createApprovalRepositories(deps.engine, deps.repos.registry);
      const departments = createOrganizationRepositories(deps.engine).departments;
      const service = new ApprovalAnalyticsService(approvalRepos, departments, deps.uow, deps.auth, () => '2026-11-03T00:00:00.000Z');
      const departmentA = await departments.create({ parentId: null, name: '研发部', code: 'RND', managerId: actor.user.id, description: '', sortOrder: 1 });
      const departmentB = await departments.create({ parentId: null, name: '运营部', code: 'OPS', managerId: actor.user.id, description: '', sortOrder: 2 });
      const templateA = await approvalRepos.templates.create({ name: '标准模板', applicationType: 'general', status: 'active', activeVersionId: 'version-a', lastVersionNo: 1, draftSteps: [{ stepNo: 1, name: '审批', approverType: 'user', userId: actor.user.id }] });
      const templateB = await approvalRepos.templates.create({ name: '请假模板', applicationType: 'leave', status: 'inactive', activeVersionId: null, lastVersionNo: 1, draftSteps: [{ stepNo: 1, name: '审批', approverType: 'user', userId: actor.user.id }] });
      const create = async (input: Pick<Application, 'applicationType' | 'status' | 'departmentId' | 'submittedAt' | 'completedAt'>, templateId: string): Promise<Application> => {
        const application = await approvalRepos.applications.create({ applicationNo: null, title: `${input.applicationType}申请`, formSchemaVersion: 1, formData: {}, startAt: null, endAt: null, applicantId: actor.user.id, projectId: null, ...input });
        const instanceStatus = input.status === 'approved' || input.status === 'rejected' || input.status === 'withdrawn' ? input.status : 'running';
        await approvalRepos.instances.create({ templateId, templateVersionId: 'version-a', applicationId: application.id, status: instanceStatus, currentStepNo: 1, startedAt: input.submittedAt ?? '2026-01-01T00:00:00.000Z', completedAt: input.completedAt, recordSeq: 0, recordHash: null });
        return application;
      };
      await create({ applicationType: 'general', status: 'approved', departmentId: departmentA.id, submittedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T02:00:00.000Z' }, templateA.id);
      await create({ applicationType: 'general', status: 'rejected', departmentId: departmentA.id, submittedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T04:00:00.000Z' }, templateA.id);
      await create({ applicationType: 'general', status: 'approved', departmentId: departmentB.id, submittedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T08:00:00.000Z' }, templateA.id);
      await create({ applicationType: 'leave', status: 'withdrawn', departmentId: departmentB.id, submittedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T10:00:00.000Z' }, templateB.id);
      await create({ applicationType: 'general', status: 'pending', departmentId: departmentA.id, submittedAt: '2026-01-01T00:00:00.000Z', completedAt: null }, templateA.id);
      const all = await service.approvalTiming(actor);
      expect(all).toMatchObject({ sampleCount: 4, medianHours: 6, p90Hours: 9.4, filter: {}, generatedAt: '2026-11-03T00:00:00.000Z' });
      expect(all.options.departments).toEqual(expect.arrayContaining([{ id: departmentA.id, name: '研发部' }, { id: departmentB.id, name: '运营部' }]));
      expect(all.options.templates).toEqual(expect.arrayContaining([{ id: templateA.id, name: '标准模板' }, { id: templateB.id, name: '请假模板' }]));
      expect((await service.approvalTiming(actor, { applicationType: 'general' })).sampleCount).toBe(3);
      expect((await service.approvalTiming(actor, { departmentId: departmentA.id })).sampleCount).toBe(2);
      expect((await service.approvalTiming(actor, { templateId: templateB.id })).medianHours).toBe(10);
      const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/analytics/approval-timing' });
      expect(unauthenticated.statusCode).toBe(401);
      const apiLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: config.webOrigin }, payload: { email: 'approval.analytics.admin', password: 'ApprovalAnalyticsStrong123!' } });
      expect(apiLogin.statusCode, apiLogin.body).toBe(200);
      const setCookie = apiLogin.headers['set-cookie'];
      const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter((value): value is string => typeof value === 'string').map((value) => value.split(';')[0]).join('; ');
      const routeReport = await app.inject({ method: 'GET', url: '/api/v1/analytics/approval-timing', headers: { cookie: cookies } });
      expect(routeReport.statusCode, routeReport.body).toBe(200);
      expect((routeReport.json() as { data: { sampleCount: number } }).data.sampleCount).toBe(4);
      const role = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
      if (!role) throw new Error('org_admin role missing');
      await deps.repos.roles.update(role.id, role.version, (value) => ({ ...value, dataScope: 'self' }));
      const narrowed = await deps.auth.loadContext(login.token);
      await expect(service.approvalTiming(narrowed)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const narrowedRoute = await app.inject({ method: 'GET', url: '/api/v1/analytics/approval-timing', headers: { cookie: cookies } });
      expect(narrowedRoute.statusCode).toBe(403);
      await expect(service.approvalTiming(actor, { applicationType: 'invalid' as never })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
