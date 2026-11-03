import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService, type AuthContext } from '../src/modules/core/auth-service.js';
import type { UserDocument } from '../src/modules/core/models.js';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';
import { createApprovalRepositories } from '../src/modules/approvals/repositories.js';
import { ApprovalService } from '../src/modules/approvals/approval-service.js';

const paths: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-office-user-disable-'));
  paths.push(dir);
  const config = loadConfig({
    ...process.env,
    DATA_DIR: dir,
    WEB_ORIGIN: 'http://localhost:5173',
    HOST: '127.0.0.1',
    PORT: '3000',
  });
  const built = await buildApp({ config, logger: false });
  cleanups.push(() => built.app.close());
  return built;
}

async function createUser(
  deps: Awaited<ReturnType<typeof buildApp>>['deps'],
  roleCode: string,
  name: string,
  email: string,
  password: string,
): Promise<UserDocument> {
  const role = await deps.repos.roles.getByUniqueIndex('idx_roles_code', roleCode);
  if (!role) throw new Error(`missing role ${roleCode}`);
  return deps.repos.users.create({
    name,
    email,
    passwordHash: await deps.auth.createPasswordHash(password),
    status: 'active',
    mustChangePassword: false,
    lastLoginAt: null,
    passwordChangedAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    roleIds: [role.id],
    departmentId: null,
  } as Omit<UserDocument, keyof import('../src/storage/envelope.js').DocumentEnvelope>);
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  deps: Awaited<ReturnType<typeof buildApp>>['deps'],
  email: string,
  password: string,
): Promise<{ cookies: string; csrf: string; token: string; context: AuthContext }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: 'http://localhost:5173' },
    payload: { email, password },
  });
  expect(response.statusCode, response.body).toBe(200);
  const cookies = (response.headers['set-cookie'] as string[])
    .map((value) => value.split(';')[0])
    .join('; ');
  const csrf = cookies.match(/csrf_token=([^;]+)/)?.[1];
  const token = cookies.match(/collab_session=([^;]+)/)?.[1];
  if (!csrf || !token) throw new Error('login cookies missing');
  return { cookies, csrf, token, context: await deps.auth.loadContext(token) };
}

describe('user disable lifecycle', () => {
  it('protects every current approver atomically, fails closed on broken state, and permits disable after reassignment', async () => {
    const { app, deps } = await fixture();
    const admin = await createUser(deps, 'org_admin', '管理员', 'approval-admin@example.test', 'ApproverAdminPass42!');
    const target = await createUser(deps, 'member', '当前审批人', 'approval-target@example.test', 'ApproverTargetPass42!');
    const replacement = await createUser(deps, 'member', '新审批人', 'approval-replacement@example.test', 'ApproverNextPass42!');
    const requester = await createUser(deps, 'member', '申请人', 'approval-requester@example.test', 'ApproverApplicantPass42!');
    const adminLogin = await login(app, deps, admin.email, 'ApproverAdminPass42!');
    const headers = { cookie: adminLogin.cookies, origin: 'http://localhost:5173', 'x-csrf-token': adminLogin.csrf };
    const repos = createApprovalRepositories(deps.engine, deps.repos.registry);
    const service = new ApprovalService(repos, deps.repos, deps.uow, deps.auth, deps.audit);
    const missingGuard = new AuthService(deps.repos, deps.uow, deps.audit, undefined, undefined, undefined, async () => false);
    await expect(missingGuard.disableUser(adminLogin.context, target.id, target.version, '离职', {})).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const makePending = async (suffix: string): Promise<{ applicationId: string; instanceId: string }> => {
      const application = await repos.applications.create({ applicationNo: `OA-TEST-${suffix}`, applicationType: 'general', title: '测试申请', formSchemaVersion: 1, formData: {}, startAt: null, endAt: null, status: 'pending', applicantId: requester.id, departmentId: null, submittedAt: '2026-01-01T00:00:00.000Z', completedAt: null });
      const instance = await repos.instances.create({ applicationId: application.id, templateId: 't', templateVersionId: 'v', status: 'running', currentStepNo: 1, startedAt: '2026-01-01T00:00:00.000Z', completedAt: null, recordSeq: 0, recordHash: null });
      await repos.steps.create({ instanceId: instance.id, stepNo: 1, name: '审批', approverType: 'user', approverId: target.id, status: 'active', activatedAt: '2026-01-01T00:00:00.000Z', completedAt: null });
      return { applicationId: application.id, instanceId: instance.id };
    };
    const first = await makePending('1');
    const second = await makePending('2');
    const disable = async (): Promise<Awaited<ReturnType<typeof app.inject>>> => app.inject({ method: 'POST', url: `/api/v1/users/${target.id}/disable`, headers, payload: { version: target.version, reason: '离职' } });
    const blocked = await disable();
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('CURRENT_APPROVER_ACTIVE');
    await service.reassign(adminLogin.context, first.applicationId, replacement.id, '原审批人将要离职');
    expect((await disable()).json().code).toBe('CURRENT_APPROVER_ACTIVE');
    await deps.engine.transaction((tx) => tx.remove('idx_workflow_steps_active', second.instanceId));
    expect((await disable()).statusCode).toBe(503);
    const steps = await deps.uow.run((tx) => repos.listSteps(second.instanceId, tx));
    await deps.engine.transaction((tx) => tx.put('idx_workflow_steps_active', second.instanceId, steps[0]!.id));
    const concurrent = await Promise.all([disable(), service.reassign(adminLogin.context, second.applicationId, replacement.id, '原审批人将要离职')]);
    expect([200, 409]).toContain(concurrent[0].statusCode);
    if (concurrent[0].statusCode === 409) expect((await disable()).statusCode).toBe(200);
    expect((await deps.repos.users.require(target.id)).status).toBe('disabled');
    const nextApp = await repos.applications.create({ applicationNo: 'OA-TEST-3', applicationType: 'general', title: '下一步骤校验', formSchemaVersion: 1, formData: {}, startAt: null, endAt: null, status: 'pending', applicantId: requester.id, departmentId: null, submittedAt: '2026-01-01T00:00:00.000Z', completedAt: null });
    const nextInstance = await repos.instances.create({ applicationId: nextApp.id, templateId: 't', templateVersionId: 'v', status: 'running', currentStepNo: 1, startedAt: '2026-01-01T00:00:00.000Z', completedAt: null, recordSeq: 0, recordHash: null });
    const nextCurrent = await repos.steps.create({ instanceId: nextInstance.id, stepNo: 1, name: '当前', approverType: 'user', approverId: replacement.id, status: 'active', activatedAt: '2026-01-01T00:00:00.000Z', completedAt: null });
    await repos.steps.create({ instanceId: nextInstance.id, stepNo: 2, name: '下一步', approverType: 'user', approverId: target.id, status: 'waiting', activatedAt: null, completedAt: null });
    const replacementLogin = await login(app, deps, replacement.email, 'ApproverNextPass42!');
    await expect(service.decide(replacementLogin.context, nextApp.id, 'approve', '')).rejects.toMatchObject({ code: 'APPROVER_UNRESOLVED' });
    expect((await repos.steps.require(nextCurrent.id)).status).toBe('active');
    expect(await deps.audit.verifyChain()).toBe(true);
  });
  it('disables another user atomically, revokes sessions, audits the action, and protects self/last-admin cases', async () => {
    const { app, deps } = await fixture();
    const actor = await createUser(
      deps,
      'org_admin',
      '组织管理员',
      'disable-actor@example.test',
      'DisableActorPassword12!',
    );
    const target = await createUser(
      deps,
      'member',
      '待停用用户',
      'disable-target@example.test',
      'DisableTargetPassword12!',
    );
    const actorLogin = await login(app, deps, actor.email, 'DisableActorPassword12!');
    const targetLogin1 = await login(app, deps, target.email, 'DisableTargetPassword12!');
    const targetLogin2 = await login(app, deps, target.email, 'DisableTargetPassword12!');
    const mutationHeaders = {
      cookie: actorLogin.cookies,
      origin: 'http://localhost:5173',
      'x-csrf-token': actorLogin.csrf,
    };

    const memberAttempt = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${actor.id}/disable`,
      headers: {
        cookie: targetLogin1.cookies,
        origin: 'http://localhost:5173',
        'x-csrf-token': targetLogin1.csrf,
      },
      payload: { version: actor.version },
    });
    expect(memberAttempt.statusCode).toBe(403);

    const missingCsrf = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${target.id}/disable`,
      headers: { cookie: actorLogin.cookies, origin: 'http://localhost:5173' },
      payload: { version: target.version },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect((await deps.repos.users.require(target.id)).status).toBe('active');

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${target.id}/disable`,
      headers: mutationHeaders,
      payload: { version: 999, reason: 'stale request' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('VERSION_CONFLICT');

    const currentTarget = await deps.repos.users.require(target.id);
    const disabled = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${target.id}/disable`,
      headers: mutationHeaders,
      payload: { version: currentTarget.version, reason: '离职' },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json().data.passwordHash).toBeUndefined();
    expect(disabled.json().data.status).toBe('disabled');
    expect((await deps.repos.users.require(target.id)).status).toBe('disabled');
    expect(
      (await deps.repos.sessions.require(targetLogin1.context.session.id)).revokedAt,
    ).not.toBeNull();
    expect(
      (await deps.repos.sessions.require(targetLogin2.context.session.id)).revokedAt,
    ).not.toBeNull();
    await expect(deps.auth.loadContext(targetLogin1.token)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    const audits = await deps.repos.auditLogs.list({ page: 1, pageSize: 100 });
    expect(
      audits.items.filter(
        (item) => item.action === 'session.revoked' && item.metadata.userId === target.id,
      ),
    ).toHaveLength(2);
    expect(
      audits.items.some(
        (item) =>
          item.action === 'user.disabled' &&
          item.resourceId === target.id &&
          item.metadata.reason === '离职',
      ),
    ).toBe(true);
    expect(await deps.audit.verifyChain()).toBe(true);

    const self = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${actor.id}/disable`,
      headers: mutationHeaders,
      payload: { version: actor.version },
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().code).toBe('VERSION_CONFLICT');
    expect((await deps.repos.users.require(actor.id)).status).toBe('active');

    const systemAdmin = await createUser(
      deps,
      'system_admin',
      '系统管理员',
      'disable-system@example.test',
      'DisableSystemPassword12!',
    );
    const deletedOrgAdmin = await createUser(
      deps,
      'org_admin',
      '已删除组织管理员',
      'disable-deleted-admin@example.test',
      'DeletedAdminPassword12!',
    );
    await deps.repos.users.softDelete(deletedOrgAdmin.id, deletedOrgAdmin.version);
    const systemLogin = await login(app, deps, systemAdmin.email, 'DisableSystemPassword12!');
    const currentActor = await deps.repos.users.require(actor.id);
    const lastAdmin = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${actor.id}/disable`,
      headers: {
        cookie: systemLogin.cookies,
        origin: 'http://localhost:5173',
        'x-csrf-token': systemLogin.csrf,
      },
      payload: { version: currentActor.version },
    });
    expect(lastAdmin.statusCode).toBe(409);
    expect(lastAdmin.json().code).toBe('LAST_ADMIN_PROTECTED');
    expect((await deps.repos.users.require(actor.id)).status).toBe('active');
  });

  it('serializes concurrent last-admin disables so one succeeds and one is protected', async () => {
    const { app, deps } = await fixture();
    const systemOne = await createUser(
      deps,
      'system_admin',
      '系统管理员一',
      'disable-system-one@example.test',
      'DisableSystemOnePassword12!',
    );
    const systemTwo = await createUser(
      deps,
      'system_admin',
      '系统管理员二',
      'disable-system-two@example.test',
      'DisableSystemTwoPassword12!',
    );
    const adminOne = await createUser(
      deps,
      'org_admin',
      '组织管理员一',
      'disable-admin-one@example.test',
      'DisableAdminOnePassword12!',
    );
    const adminTwo = await createUser(
      deps,
      'org_admin',
      '组织管理员二',
      'disable-admin-two@example.test',
      'DisableAdminTwoPassword12!',
    );
    const contextOne = (await login(app, deps, systemOne.email, 'DisableSystemOnePassword12!'))
      .context;
    const contextTwo = (await login(app, deps, systemTwo.email, 'DisableSystemTwoPassword12!'))
      .context;
    const results = await Promise.allSettled([
      deps.auth.disableUser(contextOne, adminOne.id, adminOne.version, '并发停用一', {}),
      deps.auth.disableUser(contextTwo, adminTwo.id, adminTwo.version, '并发停用二', {}),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toMatchObject({ code: 'LAST_ADMIN_PROTECTED' });
    const statuses = [
      await deps.repos.users.require(adminOne.id),
      await deps.repos.users.require(adminTwo.id),
    ].map((user) => user.status);
    expect(statuses.sort()).toEqual(['active', 'disabled']);
    expect(await deps.audit.verifyChain()).toBe(true);
  });
});
