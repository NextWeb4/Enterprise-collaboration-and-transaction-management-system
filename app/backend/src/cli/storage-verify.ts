import { resolve } from 'node:path';
import { loadConfig } from '../config/env.js';
import { LmdbStorageEngine } from '../storage/engine.js';
import { CORE_UNIQUE_INDEXES, createCoreRepositories } from '../modules/core/repositories.js';
import { AuditService } from '../modules/core/audit-service.js';
import { FileService } from '../modules/core/file-service.js';
import { UnitOfWork } from '../storage/unit-of-work.js';
import {
  createProjectRepositories,
  PROJECT_NONUNIQUE_INDEXES,
  projectSchema,
  memberSchema,
  taskSchema,
  taskCommentSchema,
} from '../modules/projects/project-service.js';
import { indexStoreKey } from '../storage/index-registry.js';
import { createOrganizationRepositories } from '../modules/organization/repositories.js';
import { createOrganizationDirectoryRepositories } from '../modules/organization/directory-repositories.js';
import { inspectDirectoryStorage } from '../modules/organization/maintenance.js';
import { createApprovalRepositories } from '../modules/approvals/repositories.js';
import { inspectApprovalStorage } from '../modules/approvals/maintenance.js';
import { createDocumentRepositories } from '../modules/documents/repositories.js';
import { inspectDocumentStorage } from '../modules/documents/maintenance.js';
import { inspectCoreStorage, inspectFileReferences } from '../modules/core/file-reference-maintenance.js';

const config = loadConfig({ ...process.env, DATA_DIR: process.env.DATA_DIR ?? './.data' });
const engine = new LmdbStorageEngine({ path: resolve(config.dataDir, 'store', 'lmdb') });
try {
  // Keep a missing or malformed schema marker unchanged while inspecting it.
  await engine.open({ allowSchemaMismatch: true });
  const repos = createCoreRepositories(engine);
  createProjectRepositories(engine, repos);
  const organization = createOrganizationRepositories(engine);
  createOrganizationDirectoryRepositories(engine);
  createApprovalRepositories(engine, repos.registry);
  createDocumentRepositories(engine, repos);
  const health = await engine.healthCheck();
  if (!health.ok) throw new Error(`存储未就绪: ${JSON.stringify(health)}`);
  const indexIssues = await engine.transaction((tx) => {
    const issues: string[] = [...inspectCoreStorage(tx).issues];
    for (const inspection of [inspectApprovalStorage(tx), inspectDirectoryStorage(tx), inspectDocumentStorage(tx)]) {
      issues.push(...inspection.issues);
      for (const [name, expected] of inspection.expected) {
        for (const [key, owner] of expected) if (tx.get<string>(name, key) !== owner) issues.push(`${name}: owner 不匹配`);
        for (const entry of tx.range<string>(name, {})) if (expected.get(entry.key) !== entry.value) issues.push(`${name}: 存在陈旧索引`);
      }
    }
    issues.push(...inspectFileReferences(tx).issues);
    for (const [source, schema] of [
      ['projects', projectSchema],
      ['project_members', memberSchema],
      ['tasks', taskSchema],
      ['task_comments', taskCommentSchema],
    ] as const) {
      for (const entry of tx.range<unknown>(source, {})) {
        const parsed = schema.safeParse(entry.value);
        if (!parsed.success || parsed.data.id !== entry.key)
          issues.push(`${source}: ${entry.key} schema 或主键无效`);
      }
    }
    for (const mapping of CORE_UNIQUE_INDEXES) {
      const expected = new Map<string, string>();
      for (const entry of tx.range<Record<string, unknown>>(mapping.source, {})) {
        const doc = entry.value;
        if (doc.deletedAt !== null && doc.deletedAt !== undefined) continue;
        const key = doc[mapping.field];
        if (typeof key !== 'string') {
          issues.push(`${mapping.indexStore}: ${entry.key} 缺少 ${mapping.field}`);
          continue;
        }
        if (expected.has(key)) issues.push(`${mapping.indexStore}: 唯一键 ${key} 重复`);
        expected.set(key, entry.key);
        if (tx.get<string>(mapping.indexStore, key) !== entry.key)
          issues.push(`${mapping.indexStore}: ${key} owner 不匹配`);
      }
      for (const entry of tx.range<string>(mapping.indexStore, {})) {
        if (expected.get(entry.key) !== entry.value)
          issues.push(`${mapping.indexStore}: ${entry.key} 是陈旧索引`);
      }
    }
    for (const mapping of PROJECT_NONUNIQUE_INDEXES) {
      const expected = new Map<string, string>();
      for (const entry of tx.range<Record<string, unknown>>(mapping.source, {})) {
        const doc = entry.value;
        if (doc.deletedAt !== null && doc.deletedAt !== undefined) continue;
        const key = doc[mapping.field];
        if (typeof key !== 'string') {
          issues.push(`${mapping.indexStore}: ${entry.key} 缺少 ${mapping.field}`);
          continue;
        }
        const indexKey = indexStoreKey(key, entry.key);
        expected.set(indexKey, entry.key);
        if (tx.get<string>(mapping.indexStore, indexKey) !== entry.key)
          issues.push(`${mapping.indexStore}: ${indexKey} owner 不匹配`);
      }
      for (const entry of tx.range<string>(mapping.indexStore, {}))
        if (expected.get(entry.key) !== entry.value)
          issues.push(`${mapping.indexStore}: ${entry.key} 是陈旧索引`);
    }
    return issues;
  });
  if (indexIssues.length > 0) {
    console.log(JSON.stringify({ health, counts: null, auditChainValid: null, indexIssues, fileReconciliation: null }, null, 2));
    throw new Error('存储校验未通过');
  }
  const counts = {
    users: (await repos.users.list({ page: 1, pageSize: 1 })).total,
    roles: (await repos.roles.list({ page: 1, pageSize: 1 })).total,
    permissions: (await repos.permissions.list({ page: 1, pageSize: 1 })).total,
    files: (await repos.files.list({ page: 1, pageSize: 1 })).total,
    departments: (await organization.departments.list({ page: 1, pageSize: 1 })).total,
  };
  const uow = new UnitOfWork(engine);
  const audit = new AuditService(repos, uow);
  const auditChainValid = await audit.verifyChain();
  const fileReconciliation = await new FileService(config.dataDir, repos, uow, audit).verify();
  const report = { health, counts, auditChainValid, indexIssues, fileReconciliation };
  console.log(JSON.stringify(report, null, 2));
  if (!auditChainValid || !fileReconciliation.ok)
    throw new Error('存储校验未通过');
} finally {
  await engine.close();
}
