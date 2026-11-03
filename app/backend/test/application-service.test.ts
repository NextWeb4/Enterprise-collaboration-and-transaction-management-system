import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApplicationDraftRequest } from '@collab/shared/schemas.js';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';
import type { AuthContext } from '../src/modules/core/auth-service.js';
import type { RoleDocument } from '../src/modules/core/models.js';
import { createApprovalRepositories } from '../src/modules/approvals/repositories.js';
import { createOrganizationRepositories } from '../src/modules/organization/repositories.js';
import { ApplicationService } from '../src/modules/approvals/application-service.js';
import { ApprovalService } from '../src/modules/approvals/approval-service.js';
import { WorkflowTemplateService } from '../src/modules/approvals/template-service.js';
import { systemClock } from '../src/shared/clock.js';

type TestActor = AuthContext & { token: string };
interface Fixture {
  dir: string;
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  deps: Awaited<ReturnType<typeof buildApp>>['deps'];
  repos: ReturnType<typeof createApprovalRepositories>;
  departments: ReturnType<typeof createOrganizationRepositories>['departments'];
  dependencies: import('../src/modules/approvals/application-policy.js').ApprovalDependencies;
  service: ApplicationService;
  approvals: ApprovalService;
  templates: WorkflowTemplateService;
  actor: (name: string, role?: RoleDocument) => Promise<TestActor>;
  owner: TestActor;
  first: TestActor;
  second: TestActor;
  admin: TestActor;
  auditor: TestActor;
  department: import('../src/modules/organization/models.js').DepartmentDocument;
  memberRole: RoleDocument;
  publish: (type?: ApplicationDraftRequest['applicationType'], ids?: string[]) => Promise<void>;
  headers: (who?: TestActor) => { cookie: string; origin: string; 'x-csrf-token': string };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const permissions = [
  'application:create',
  'application:read:self',
  'application:submit',
  'application:withdraw',
  'application:approve',
  'project:read',
];
const general: ApplicationDraftRequest = {
  applicationType: 'general',
  title: '行政事务申请',
  formData: { subject: '行政事务', content: '请协助处理这项日常行政事务' },
  startAt: null,
  endAt: null,
  projectId: null,
};
const leave: ApplicationDraftRequest = {
  applicationType: 'leave',
  title: '年度假期申请',
  formData: { leaveType: 'annual', durationDays: 1, reason: '家中有重要事务需要请假处理' },
  startAt: '2090-01-01T00:00:00.000Z',
  endAt: '2090-01-02T00:00:00.000Z',
  projectId: null,
};
const seal: ApplicationDraftRequest = {
  applicationType: 'seal',
  title: '文件用印申请',
  formData: {
    documentName: '证明文件',
    sealType: 'company',
    copies: 1,
    purpose: '本文件用于内部行政手续办理',
    expectedDate: '2090-01-01',
    recipient: '申请人员',
  },
  startAt: null,
  endAt: null,
  projectId: null,
};
const pdf = (text = 'approval evidence'): AsyncGenerator<Buffer> =>
  (async function* (): AsyncGenerator<Buffer> {
    yield Buffer.from(`%PDF-1.7\n${text}\n%%EOF`);
  })();

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-applications-'));
  const config = loadConfig({
    NODE_ENV: 'development',
    DATA_DIR: dir,
    HOST: '127.0.0.1',
    PORT: '3319',
    WEB_ORIGIN: 'http://127.0.0.1:5173',
  });
  const { app, deps } = await buildApp({ config, logger: false });
  cleanups.push(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const repos = createApprovalRepositories(deps.engine, deps.repos.registry);
  const departments = createOrganizationRepositories(deps.engine).departments;
  const dependencies = { departments, files: deps.files, projects: deps.projectRepos };
  const service = new ApplicationService(
    repos,
    deps.repos,
    deps.uow,
    deps.auth,
    deps.audit,
    dependencies,
  );
  const approvals = new ApprovalService(
    repos,
    deps.repos,
    deps.uow,
    deps.auth,
    deps.audit,
    systemClock,
    dependencies,
  );
  const templates = new WorkflowTemplateService(repos, deps.repos, deps.uow, deps.auth, deps.audit);
  const memberRole = await deps.repos.roles.create({
    code: 'approval_test',
    name: '测试申请角色',
    description: '',
    dataScope: 'self',
    permissionCodes: permissions,
    system: false,
  });
  async function actor(
    name: string,
    role: RoleDocument = memberRole,
  ): Promise<AuthContext & { token: string }> {
    const user = await deps.repos.users.create({
      name,
      email: `approval.${name}`,
      passwordHash: 'x'.repeat(30),
      status: 'active',
      mustChangePassword: false,
      lastLoginAt: null,
      passwordChangedAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      roleIds: [role.id],
      departmentId: null,
    });
    const token = `approval-token-${name}`;
    const session = await deps.repos.sessions.create({
      userId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      csrfToken: 'a'.repeat(32),
      idleExpiresAt: '2099-01-01T00:00:00.000Z',
      absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
      revokedAt: null,
    });
    return { user, session, roles: [role], permissions: role.permissionCodes, token };
  }
  const orgAdmin = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
  const auditorRole = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'auditor');
  if (!orgAdmin || !auditorRole) throw new Error('Missing seeded system roles');
  let owner = await actor('owner');
  const first = await actor('first');
  const second = await actor('second');
  const admin = await actor('admin', orgAdmin);
  const auditor = await actor('auditor', auditorRole);
  const department = await departments.create({
    parentId: null,
    name: '测试部门',
    code: 'APPROVAL',
    managerId: first.user.id,
    description: '',
    sortOrder: 0,
  });
  owner = {
    ...owner,
    user: await deps.repos.users.update(owner.user.id, owner.user.version, (value) => ({
      ...value,
      departmentId: department.id,
      managerId: first.user.id,
    })),
  };
  async function publish(
    type: ApplicationDraftRequest['applicationType'] = 'general',
    ids = [first.user.id, second.user.id],
  ): Promise<void> {
    const template = await templates.create(admin, {
      name: `${type}审批模板`,
      applicationType: type,
      steps: ids.map((userId, index) => ({
        stepNo: index + 1,
        name: `审批步骤${index + 1}`,
        approverType: 'user',
        userId,
      })),
    });
    await templates.publish(admin, template.id, template.version);
  }
  const headers = (who = owner): { cookie: string; origin: string; 'x-csrf-token': string } => ({
    cookie: `${config.sessionCookieName}=${who.token}; csrf_token=${who.session.csrfToken}`,
    origin: config.webOrigin,
    'x-csrf-token': who.session.csrfToken,
  });
  return {
    dir,
    app,
    deps,
    repos,
    departments,
    dependencies,
    service,
    approvals,
    templates,
    actor,
    owner,
    first,
    second,
    admin,
    auditor,
    department,
    memberRole,
    publish,
    headers,
  };
}

describe('OA applications with real isolated LMDB', () => {
  it('keeps drafts private and immutable after submission, hides waiting approvers, and redacts audit summaries', async () => {
    const f = await fixture();
    await f.publish();
    const draft = await f.service.create(f.owner, general);
    await expect(f.service.detail(f.admin, draft.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.service.update(f.first, draft.id, draft.version, general)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    expect((await f.service.list(f.admin, { page: 1, pageSize: 20, view: 'all' })).meta.total).toBe(
      0,
    );
    const submitted = await f.approvals.submit(f.owner, draft.id, randomUUID());
    await expect(
      f.service.update(f.owner, draft.id, submitted.version, general),
    ).rejects.toMatchObject({ code: 'APPLICATION_STATE_INVALID' });
    await expect(f.service.detail(f.second, draft.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const detail = await f.service.detail(f.first, draft.id);
    expect(detail.history.steps[1]?.approverId).toBeNull();
    expect(detail.history.steps[1]?.approverName).toBeNull();
    expect(detail.actions.approve).toBe(true);
    const summary = await f.service.detail(f.auditor, draft.id);
    expect(summary).toMatchObject({
      title: '申请摘要',
      redacted: true,
      formData: null,
      attachments: [],
      projectId: null,
    });
    await expect(
      f.approvals.decide(f.first, draft.id, 'approve', '同意', {}, draft.version),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await f.approvals.decide(
      f.first,
      draft.id,
      'approve',
      '包含私密信息的审批意见',
      {},
      submitted.version,
    );
    expect((await f.service.detail(f.auditor, draft.id)).history.records[0]?.comment).toBeNull();
    expect((await f.service.detail(f.first, draft.id)).history.records[0]?.comment).toBe(
      '包含私密信息的审批意见',
    );
    expect((await f.service.detail(f.second, draft.id)).actions.approve).toBe(true);
    expect(await f.deps.audit.verifyChain()).toBe(true);
  });

  it('resolves dynamic approvers at submit, merges adjacent duplicates, and preserves snapshots', async () => {
    const f = await fixture();
    expect(await f.templates.initializeDefaults(f.admin)).toHaveLength(5);
    expect(await f.templates.initializeDefaults(f.admin)).toHaveLength(0);
    const draft = await f.service.create(f.owner, leave);
    await f.approvals.submit(f.owner, draft.id, randomUUID());
    const instance = await f.repos.instances.getByUniqueIndex(
      'idx_workflow_instances_application',
      draft.id,
    );
    if (!instance) throw new Error('Missing submitted workflow');
    expect(
      (await f.deps.uow.run((tx) => f.repos.listSteps(instance.id, tx))).map(
        (step) => step.approverId,
      ),
    ).toEqual([f.first.user.id]);
    const owner = await f.deps.repos.users.require(f.owner.user.id);
    await f.deps.repos.users.update(owner.id, owner.version, (value) => ({
      ...value,
      managerId: f.second.user.id,
    }));
    await f.departments.update(f.department.id, f.department.version, (value) => ({
      ...value,
      managerId: f.second.user.id,
    }));
    expect((await f.deps.uow.run((tx) => f.repos.listSteps(instance.id, tx)))[0]?.approverId).toBe(
      f.first.user.id,
    );
    const unresolved = await f.service.create(f.first, general);
    await expect(f.approvals.submit(f.first, unresolved.id, randomUUID())).rejects.toMatchObject({
      code: 'APPROVER_UNRESOLVED',
    });
    expect((await f.repos.applications.require(unresolved.id)).status).toBe('draft');
    expect(
      await f.repos.instances.getByUniqueIndex('idx_workflow_instances_application', unresolved.id),
    ).toBeUndefined();
    const fresh = await f.deps.repos.users.require(f.owner.user.id);
    await f.deps.repos.users.update(fresh.id, fresh.version, (value) => ({
      ...value,
      managerId: fresh.id,
    }));
    const self = await f.service.create(f.owner, {
      ...leave,
      startAt: '2090-02-01T00:00:00.000Z',
      endAt: '2090-02-02T00:00:00.000Z',
    });
    await expect(f.approvals.submit(f.owner, self.id, randomUUID())).rejects.toMatchObject({
      code: 'SELF_APPROVAL_FORBIDDEN',
    });
  });

  it('validates all five forms and rejects invalid ranges, handover users and expected dates without partial writes', async () => {
    const f = await fixture();
    const forms: ApplicationDraftRequest[] = [
      general,
      leave,
      {
        ...general,
        applicationType: 'travel',
        formData: {
          destination: '上海',
          purpose: '前往客户现场完成项目实施工作',
          transport: 'train',
          estimatedCost: 100.25,
        },
        startAt: leave.startAt,
        endAt: leave.endAt,
      },
      {
        ...general,
        applicationType: 'field',
        formData: { location: '客户现场', purpose: '到客户现场检查设备运行状况' },
        startAt: leave.startAt,
        endAt: leave.endAt,
      },
      seal,
    ];
    for (const form of forms) {
      await f.publish(form.applicationType, [f.first.user.id]);
      const draft = await f.service.create(f.owner, form);
      if (form.applicationType === 'seal')
        await f.service.attach(f.owner, draft.id, draft.version, {
          filename: 'proof.pdf',
          mimetype: 'application/pdf',
          stream: pdf(),
        });
      expect((await f.approvals.submit(f.owner, draft.id, randomUUID())).status).toBe('pending');
    }
    const incomplete = await f.service.create(f.owner, { ...general, formData: {} });
    await expect(f.approvals.submit(f.owner, incomplete.id, randomUUID())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const invalids: ApplicationDraftRequest[] = [
      { ...leave, endAt: leave.startAt },
      { ...forms[3]!, endAt: '2090-02-01T00:00:00.000Z' },
      { ...general, formData: { ...general.formData, expectedDate: '2000-01-01' } },
      { ...leave, formData: { ...leave.formData, handoverUserId: f.owner.user.id } },
      { ...general, startAt: leave.startAt, endAt: leave.endAt },
      seal,
    ];
    for (const form of invalids) {
      const draft = await f.service.create(f.owner, form);
      await expect(f.approvals.submit(f.owner, draft.id, randomUUID())).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      expect((await f.repos.applications.require(draft.id)).status).toBe('draft');
      expect(
        await f.repos.instances.getByUniqueIndex('idx_workflow_instances_application', draft.id),
      ).toBeUndefined();
    }
    await expect(
      f.service.create(f.owner, { ...general, formData: { subject: '事项', unexpected: true } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('serializes overlapping leave submissions and permits adjoining half-open intervals', async () => {
    const f = await fixture();
    await f.publish('leave', [f.first.user.id]);
    const first = await f.service.create(f.owner, leave);
    const second = await f.service.create(f.owner, leave);
    const results = await Promise.allSettled([
      f.approvals.submit(f.owner, first.id, randomUUID()),
      f.approvals.submit(f.owner, second.id, randomUUID()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'APPLICATION_STATE_INVALID' },
    });
    const next = await f.service.create(f.owner, {
      ...leave,
      startAt: leave.endAt,
      endAt: '2090-01-03T00:00:00.000Z',
    });
    await expect(f.approvals.submit(f.owner, next.id, randomUUID())).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('atomically binds attachments and copies rejected applications without granting file access by hash', async () => {
    const f = await fixture();
    await f.publish('seal', [f.first.user.id]);
    const draft = await f.service.create(f.owner, seal);
    const attachment = await f.service.attach(f.owner, draft.id, draft.version, {
      filename: 'proof.pdf',
      mimetype: 'application/pdf',
      stream: pdf(),
    });
    await expect(
      f.service.attach(f.owner, draft.id, draft.version, {
        filename: 'stale.pdf',
        mimetype: 'application/pdf',
        stream: pdf('stale'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await f.deps.repos.files.list({ page: 1, pageSize: 100 })).total).toBe(1);
    const submitted = await f.approvals.submit(f.owner, draft.id, randomUUID());
    expect(
      await readFile((await f.service.download(f.first, draft.id, attachment.id)).path, 'utf8'),
    ).toContain('%PDF');
    await expect(f.service.download(f.second, draft.id, attachment.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(f.service.download(f.auditor, draft.id, attachment.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await f.approvals.decide(
      f.first,
      draft.id,
      'reject',
      '缺少必要资料请补充完整后重新申请',
      {},
      submitted.version,
    );
    const copy = await f.service.copy(f.owner, draft.id);
    expect(copy.status).toBe('draft');
    expect(copy.applicationNo).toBeNull();
    const copiedAttachment = (await f.service.detail(f.owner, copy.id)).attachments[0];
    expect(copiedAttachment?.fileId).toBe(attachment.fileId);
    expect((await f.deps.repos.files.require(attachment.fileId)).refCount).toBe(2);
    if (!copiedAttachment) throw new Error('Missing copied attachment');
    await f.service.removeAttachment(f.owner, copy.id, copiedAttachment.id, copy.version);
    expect((await f.deps.repos.files.require(attachment.fileId)).refCount).toBe(1);
    expect((await f.service.detail(f.owner, draft.id)).attachments).toHaveLength(1);
    expect((await f.deps.files.verify()).ok).toBe(true);
    expect(await f.deps.audit.verifyChain()).toBe(true);
  });

  it('rolls back competing attachment writes at the application version boundary', async () => {
    const f = await fixture();
    const draft = await f.service.create(f.owner, general);
    const results = await Promise.allSettled([
      f.service.attach(f.owner, draft.id, draft.version, {
        filename: 'a.pdf',
        mimetype: 'application/pdf',
        stream: pdf('first'),
      }),
      f.service.attach(f.owner, draft.id, draft.version, {
        filename: 'b.pdf',
        mimetype: 'application/pdf',
        stream: pdf('second'),
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'VERSION_CONFLICT' },
    });
    expect((await f.service.detail(f.owner, draft.id)).attachments).toHaveLength(1);
    expect((await f.deps.repos.files.list({ page: 1, pageSize: 100 })).total).toBe(1);
    expect((await f.deps.files.verify()).ok).toBe(true);
  });

  it('limits governance to the permission-granting role scope and protects private projects', async () => {
    const f = await fixture();
    await f.publish('general', [f.first.user.id]);
    const draft = await f.service.create(f.owner, general);
    await f.approvals.submit(f.owner, draft.id, randomUUID());
    const scopeRole = await f.deps.repos.roles.create({
      code: 'department_application',
      name: '部门申请查看',
      description: '',
      dataScope: 'department',
      permissionCodes: ['application:read:all'],
      system: false,
    });
    const unrelatedRole = await f.deps.repos.roles.create({
      code: 'unrelated_all',
      name: '不相关全局权限',
      description: '',
      dataScope: 'all',
      permissionCodes: ['project:read'],
      system: false,
    });
    let viewer = await f.actor('viewer', scopeRole);
    viewer = {
      ...viewer,
      user: await f.deps.repos.users.update(viewer.user.id, viewer.user.version, (value) => ({
        ...value,
        roleIds: [scopeRole.id, unrelatedRole.id],
      })),
    };
    await expect(f.service.detail(viewer, draft.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    viewer = {
      ...viewer,
      user: await f.deps.repos.users.update(viewer.user.id, viewer.user.version, (value) => ({
        ...value,
        departmentId: f.department.id,
      })),
    };
    expect((await f.service.detail(viewer, draft.id)).redacted).toBe(false);
    const project = await f.deps.projectRepos.projects.create({
      name: '私有项目',
      key: 'PRIV',
      description: '',
      visibility: 'private',
      status: 'active',
      ownerId: f.first.user.id,
      statusReason: null,
      taskSeq: 0,
      startDate: null,
      dueDate: null,
    });
    await expect(
      f.service.create(f.owner, { ...general, projectId: project.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await f.deps.projectRepos.members.create({
      projectId: project.id,
      userId: f.owner.user.id,
      role: 'member',
      membershipKey: `${project.id}:${f.owner.user.id}`,
    });
    await expect(
      f.service.create(f.owner, { ...general, projectId: project.id }),
    ).resolves.toMatchObject({ projectId: project.id });
  });

  it('exposes authenticated API creation, submission, decision and history with CSRF and optimistic locking', async () => {
    const f = await fixture();
    await f.publish('general', [f.first.user.id]);
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/v1/applications', payload: general }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/applications',
          headers: { cookie: f.headers().cookie, origin: f.headers().origin },
          payload: general,
        })
      ).statusCode,
    ).toBe(403);
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      headers: f.headers(),
      payload: general,
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<{ data: { id: string; version: number } }>().data;
    const url = `/api/v1/applications/${draft.id}`;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${url}/submit`,
          headers: f.headers(),
          payload: {},
        })
      ).statusCode,
    ).toBe(422);
    const headers = { ...f.headers(), 'idempotency-key': randomUUID() };
    const submitted = await f.app.inject({
      method: 'POST',
      url: `${url}/submit`,
      headers,
      payload: {},
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(
      (await f.app.inject({ method: 'POST', url: `${url}/submit`, headers, payload: {} })).json(),
    ).toEqual(submitted.json());
    const version = submitted.json<{ data: { version: number } }>().data.version;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${url}/approve`,
          headers: f.headers(f.second),
          payload: { version, comment: '' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${url}/approve`,
          headers: f.headers(f.first),
          payload: { version: draft.version, comment: '' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${url}/approve`,
          headers: f.headers(f.first),
          payload: { version, comment: '通过' },
        })
      ).statusCode,
    ).toBe(200);
    const detail = await f.app.inject({ method: 'GET', url, headers: f.headers() });
    expect(detail.json()).toMatchObject({
      data: { status: 'approved', history: { records: [{ action: 'approve' }] } },
    });
    expect(detail.body).not.toContain('tokenHash');
    expect(detail.body).not.toContain('passwordHash');
    expect(detail.body).not.toContain(f.dir.replaceAll('\\', '\\\\'));
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: '/api/v1/applications?view=mine&page=1&pageSize=1',
          headers: f.headers(),
        })
      ).json(),
    ).toMatchObject({ meta: { total: 1, page: 1, pageSize: 1 } });
  });
});
