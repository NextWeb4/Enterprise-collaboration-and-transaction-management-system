import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';
import type { AuthContext } from '../src/modules/core/auth-service.js';
import { createApprovalRepositories } from '../src/modules/approvals/repositories.js';
import { WorkflowTemplateService } from '../src/modules/approvals/template-service.js';

describe('workflow template versions', () => {
  it('rechecks authority and publishes immutable snapshots atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-template-'));
    const config = loadConfig({ NODE_ENV: 'development', DATA_DIR: dir, HOST: '127.0.0.1', PORT: '3313', WEB_ORIGIN: 'http://127.0.0.1:5173' });
    const { app, deps } = await buildApp({ config, logger: false });
    try {
      const role = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
      if (!role) throw new Error('missing role');
      const user = await deps.repos.users.create({ name: '管理员', email: 'template.admin', passwordHash: 'x'.repeat(30), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null });
      const session = await deps.repos.sessions.create({ userId: user.id, tokenHash: 'a'.repeat(64), csrfToken: 'a'.repeat(32), idleExpiresAt: '2099-01-01T00:00:00.000Z', absoluteExpiresAt: '2099-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', revokedAt: null });
      const actor: AuthContext = { user, session, roles: [role], permissions: role.permissionCodes };
      const repos = createApprovalRepositories(deps.engine, deps.repos.registry);
      const service = new WorkflowTemplateService(repos, deps.repos, deps.uow, deps.auth, deps.audit);
      const input = { name: '通用事务', applicationType: 'general' as const, steps: [{ stepNo: 1, name: '固定审批', approverType: 'user' as const, userId: user.id }] };
      await expect(service.create(actor, { ...input, steps: [{ ...input.steps[0]!, stepNo: 2 }] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(service.create(actor, { ...input, steps: [{ ...input.steps[0]!, userId: 'missing' }] })).rejects.toMatchObject({ code: 'APPROVER_UNRESOLVED' });
      const template = await service.create(actor, input);
      const first = await service.publish(actor, template.id, template.version);
      expect(first.published.versionNo).toBe(1);
      const changed = await service.updateDraft(actor, template.id, first.template.version, { ...input, steps: [{ ...input.steps[0]!, name: '新审批名称' }] });
      expect((await repos.versions.get(first.published.id))?.steps[0]?.name).toBe('固定审批');
      const second = await service.publish(actor, template.id, changed.version);
      expect(second.published.versionNo).toBe(2);
      expect((await repos.versions.get(first.published.id))?.steps[0]?.name).toBe('固定审批');
      expect((await repos.versions.get(second.published.id))?.steps[0]?.name).toBe('新审批名称');
      const other = await service.create(actor, { ...input, name: '冲突模板' });
      await expect(service.publish(actor, other.id, other.version)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect((await repos.templates.require(other.id)).lastVersionNo).toBe(0);
      await service.deactivate(actor, template.id, second.template.version);
      expect((await service.publish(actor, other.id, other.version)).published.versionNo).toBe(1);
      await deps.repos.sessions.update(session.id, session.version, (value) => ({ ...value, revokedAt: new Date().toISOString() }));
      await expect(service.list(actor)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(await deps.audit.verifyChain()).toBe(true);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
