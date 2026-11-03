/** Isolated fixtures only; refuses existing/non-temporary data directories. */
import { hash } from '@node-rs/argon2';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { loadConfig } from '../app/backend/src/config/env.js';
import { buildApp } from '../app/backend/src/server.js';
import { createApprovalRepositories } from '../app/backend/src/modules/approvals/repositories.js';

async function main(): Promise<void> {
  const dataDir = resolve(process.env.DATA_DIR ?? '');
  if (dirname(dataDir).toLocaleLowerCase() !== resolve(tmpdir()).toLocaleLowerCase() || !basename(dataDir).startsWith('collab-e2e-approval-') || (await readdir(dataDir)).length !== 0) throw new Error('Refusing non-empty or non-isolated E2E data directory');
  const password = process.env.APPROVAL_E2E_PASSWORD;
  if (!password || password.length < 16) throw new Error('Missing temporary E2E password');
  const { app, deps } = await buildApp({ config: loadConfig({ ...process.env, DATA_DIR: dataDir }), logger: false });
  try {
    const role = await deps.repos.roles.create({ code: 'approval_e2e', name: '审批端到端测试角色', description: '', dataScope: 'self', permissionCodes: ['application:create', 'application:read:self', 'application:submit', 'application:withdraw', 'application:approve'], system: false });
    const passwordHash = await hash(password, { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    const fields = { passwordHash, status: 'active' as const, mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null };
    const applicant = await deps.repos.users.create({ ...fields, name: '隔离申请人', email: 'e2e-applicant' });
    const approver = await deps.repos.users.create({ ...fields, name: '隔离审批人', email: 'e2e-approver' });
    const repos = createApprovalRepositories(deps.engine, deps.repos.registry);
    const steps = [{ stepNo: 1, name: '指定审批人审批', approverType: 'user' as const, userId: approver.id }];
    const template = await repos.templates.create({ name: '端到端通用事务', applicationType: 'general', status: 'draft', activeVersionId: null, lastVersionNo: 0, draftSteps: steps });
    const version = await repos.versions.create({ templateId: template.id, versionNo: 1, steps, createdBy: applicant.id, publishedAt: new Date().toISOString() });
    await repos.templates.update(template.id, template.version, (value) => ({ ...value, status: 'active', activeVersionId: version.id, lastVersionNo: 1 }));
    console.log('PASS: isolated two-account and immutable-template fixture seeded');
  } finally { await app.close(); }
}
await main();
