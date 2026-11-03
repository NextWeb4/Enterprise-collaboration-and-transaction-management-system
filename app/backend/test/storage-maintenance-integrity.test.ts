import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LmdbStorageEngine } from '../src/storage/engine.js';
import { createCoreRepositories } from '../src/modules/core/repositories.js';
import { createOrganizationDirectoryRepositories } from '../src/modules/organization/directory-repositories.js';
import { inspectDirectoryStorage } from '../src/modules/organization/maintenance.js';
import { createApprovalRepositories } from '../src/modules/approvals/repositories.js';
import { inspectApprovalStorage } from '../src/modules/approvals/maintenance.js';
import { inspectCoreStorage } from '../src/modules/core/file-reference-maintenance.js';

const engines: LmdbStorageEngine[] = [];
const directories: string[] = [];

async function fixture(): Promise<{
  engine: LmdbStorageEngine;
  core: ReturnType<typeof createCoreRepositories>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'collab-maintenance-integrity-'));
  directories.push(directory);
  const engine = new LmdbStorageEngine({ path: join(directory, 'store', 'lmdb') });
  engines.push(engine);
  await engine.open();
  return { engine, core: createCoreRepositories(engine) };
}

afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) await engine.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function userInput(name: string, email: string): {
  name: string; email: string; passwordHash: string; status: 'active'; mustChangePassword: boolean;
  lastLoginAt: null; passwordChangedAt: null; failedLoginCount: number; lockedUntil: null;
  roleIds: string[]; departmentId: null;
} {
  return { name, email, passwordHash: 'x'.repeat(30), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [], departmentId: null };
}

describe('maintenance integrity inspection', () => {
  it('detects an inactive employee account and a cyclic manager relation from primary records', async () => {
    const { engine, core } = await fixture();
    const directory = createOrganizationDirectoryRepositories(engine);
    const employeeUser = await core.users.create(userInput('员工', 'employee.account'));
    const employee = await directory.employees.create({ userId: employeeUser.id, employeeNo: null, phone: null, departmentId: null, positionId: null, hireDate: null, avatarFileId: null });
    const firstManager = await core.users.create(userInput('负责人甲', 'manager.one'));
    const secondManager = await core.users.create(userInput('负责人乙', 'manager.two'));
    const changedFirst = await core.users.update(firstManager.id, firstManager.version, (user) => ({ ...user, managerId: secondManager.id }));
    await core.users.update(secondManager.id, secondManager.version, (user) => ({ ...user, managerId: changedFirst.id }));
    await core.users.update(employeeUser.id, employeeUser.version, (user) => ({ ...user, status: 'disabled' }));

    const inspection = await engine.transaction((tx) => inspectDirectoryStorage(tx));
    expect(inspection.issues).toContain(`employees: ${employee.id} 关联用户不存在或已停用`);
    expect(inspection.issues.some((issue) => issue.includes('直属上级关系存在循环'))).toBe(true);
  });

  it('detects approval records that reference missing primary documents', async () => {
    const { engine, core } = await fixture();
    const approvals = createApprovalRepositories(engine, core.registry);
    const attachment = await approvals.attachments.create({ applicationId: 'missing-application', fileId: 'missing-file', fileName: 'evidence.txt', mime: 'text/plain', size: 1, sha256: 'a'.repeat(64), uploadedBy: 'user-1' });

    const inspection = await engine.transaction((tx) => inspectApprovalStorage(tx));
    expect(inspection.issues).toContain(`application_attachments: ${attachment.id} 引用不存在的申请 missing-application`);
  });

  it('validates core primary records independently of index state', async () => {
    const { engine, core } = await fixture();
    const user = await core.users.create(userInput('待损坏用户', 'invalid.core'));
    await engine.transaction((tx) => tx.put('users', user.id, { ...user, passwordHash: 'too-short' }));

    const inspection = await engine.transaction((tx) => inspectCoreStorage(tx));
    expect(inspection.issues).toContain(`users: ${user.id} schema 或主键无效`);
  });
});
