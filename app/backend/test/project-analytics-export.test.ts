import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import type { Project, ProjectMember, Task } from '../src/modules/projects/project-service.js';
import type { DocumentEnvelope } from '../src/storage/envelope.js';
import { buildApp } from '../src/server.js';

const password = 'AnalyticsExportStrongPassword42!';

describe('project analytics CSV export with isolated LMDB', () => {
  it('exports only authorized project metrics, neutralizes spreadsheet formulas, and audits successful downloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-project-analytics-export-'));
    const config = loadConfig({
      NODE_ENV: 'development',
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      PORT: '3319',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
    });
    const { app, deps } = await buildApp({ config, logger: false });
    try {
      await deps.auth.setupAdmin(
        { name: '导出管理员', email: 'analytics.export.admin', password },
        { requestId: null, ip: null, userAgent: null },
      );
      const loggedIn = await deps.auth.verifyLogin('analytics.export.admin', password, {
        ip: null,
        userAgent: null,
      });
      const actor = await deps.auth.loadContext(loggedIn.token);
      const sessionCookie = `${config.sessionCookieName}=${loggedIn.token}`;

      const project = await deps.projectRepos.projects.create(
        {
          name: '  =HYPERLINK("malicious")',
          key: 'CSVSAFE',
          description: 'not exported',
          visibility: 'organization',
          status: 'active',
          ownerId: actor.user.id,
          statusReason: null,
          taskSeq: 0,
          startDate: null,
          dueDate: null,
        } satisfies Omit<Project, keyof DocumentEnvelope>,
        undefined,
        { createdAt: '2026-01-15T00:00:00.000Z' },
      );
      await deps.projectRepos.members.create({
        projectId: project.id,
        userId: actor.user.id,
        role: 'owner',
        membershipKey: `${project.id}:${actor.user.id}`,
      } satisfies Omit<ProjectMember, keyof DocumentEnvelope>);
      await deps.projectRepos.tasks.create({
        projectId: project.id,
        taskNo: 1,
        taskKey: 'CSVSAFE-1',
        title: 'secret task title is not exported',
        description: 'secret task body is not exported',
        status: 'done',
        progress: 100,
        priority: 'high',
        assigneeId: actor.user.id,
        createdBy: actor.user.id,
        startDate: null,
        dueDate: null,
        completedAt: '2026-02-01T00:00:00.000Z',
      } satisfies Omit<Task, keyof DocumentEnvelope>);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/analytics/project-completion/export?createdFrom=2026-01-01T00%3A00%3A00.000Z&createdTo=2026-02-01T00%3A00%3A00.000Z',
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="project-completion.csv"',
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.startsWith('\uFEFF')).toBe(true);
      expect(response.body).toContain('"\'  =HYPERLINK(""malicious"")"');
      expect(response.body).toContain('"CSVSAFE","\'  =HYPERLINK');
      expect(response.body).toContain('"1","1","0","1","0","100"');
      expect(response.body).not.toContain('secret task title');
      expect(response.body).not.toContain('secret task body');
      expect(response.body).not.toContain(actor.user.id);
      expect(response.body).toContain('企业协同与事务管理平台');

      const auditPage = await deps.repos.auditLogs.list({ page: 1, pageSize: 100 });
      const exportAudit = auditPage.items.find((item) => item.action === 'analytics.exported');
      expect(exportAudit?.metadata).toMatchObject({ format: 'csv', rowCount: 1 });
      expect(JSON.stringify(exportAudit?.metadata)).not.toContain('HYPERLINK');
      expect(await deps.audit.verifyChain()).toBe(true);

      const adminRole = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
      if (!adminRole) throw new Error('org_admin role missing');
      await deps.repos.roles.update(adminRole.id, adminRole.version, (role) => ({
        ...role,
        dataScope: 'department',
      }));
      const forbidden = await app.inject({
        method: 'GET',
        url: '/api/v1/analytics/project-completion/export',
        headers: { cookie: sessionCookie },
      });
      expect(forbidden.statusCode).toBe(403);
      const auditsAfterForbidden = await deps.repos.auditLogs.list({ page: 1, pageSize: 100 });
      expect(
        auditsAfterForbidden.items.filter((item) => item.action === 'analytics.exported'),
      ).toHaveLength(1);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
