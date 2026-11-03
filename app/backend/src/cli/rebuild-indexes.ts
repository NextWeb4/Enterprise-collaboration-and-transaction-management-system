import { resolve } from 'node:path';
import { loadConfig } from '../config/env.js';
import { LmdbStorageEngine } from '../storage/engine.js';
import { CORE_UNIQUE_INDEXES, createCoreRepositories } from '../modules/core/repositories.js';
import { AuditService } from '../modules/core/audit-service.js';
import { FileService } from '../modules/core/file-service.js';
import { UnitOfWork } from '../storage/unit-of-work.js';
import { SingleInstanceLock } from '../runtime/single-instance.js';
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
import {
  inspectCoreStorage,
  inspectFileReferences,
} from '../modules/core/file-reference-maintenance.js';

const config = loadConfig({ ...process.env, DATA_DIR: process.env.DATA_DIR ?? './.data' });
const NON_UNIQUE_INDEX_NAMES = new Set([
  'idx_workflow_applicant',
  'idx_workflow_steps_approver_status',
  'idx_application_attachments_application',
  'idx_employees_department',
  'idx_employees_position',
  'idx_documents_owner',
  'idx_documents_project',
  'idx_doc_versions_document',
  'idx_acl_document',
  'idx_document_tags_document',
]);
const lock = new SingleInstanceLock(config.dataDir);
await lock.acquire();
const engine = new LmdbStorageEngine({ path: resolve(config.dataDir, 'store', 'lmdb') });
try {
  await engine.open();
  engine.setMaintenance(true);
  const repos = createCoreRepositories(engine);
  createProjectRepositories(engine, repos);
  createOrganizationRepositories(engine);
  createOrganizationDirectoryRepositories(engine);
  createApprovalRepositories(engine, repos.registry);
  createDocumentRepositories(engine, repos);
  const uow = new UnitOfWork(engine);
  const audit = new AuditService(repos, uow);
  if (!(await audit.verifyChain())) throw new Error('无法重建索引，审计哈希链无效');
  const fileReconciliation = await new FileService(config.dataDir, repos, uow, audit).verify();
  if (!fileReconciliation.ok)
    throw new Error(`无法重建索引，文件系统校验未通过: ${JSON.stringify(fileReconciliation)}`);
  await engine.transaction((tx) => {
    const inspections = [
      inspectApprovalStorage(tx),
      inspectDirectoryStorage(tx),
      inspectDocumentStorage(tx),
    ];
    const issues = [
      ...inspectCoreStorage(tx).issues,
      ...inspections.flatMap((inspection) => inspection.issues),
      ...inspectFileReferences(tx).issues,
    ];
    const expectedIndexes = new Map<string, Map<string, string>>();
    const addExpected = (name: string, key: string, owner: string, unique: boolean): void => {
      const expected = expectedIndexes.get(name) ?? new Map<string, string>();
      const existing = expected.get(key);
      if (unique && existing !== undefined && existing !== owner)
        issues.push(`${name}: 唯一键 ${key} 同时属于 ${existing} 与 ${owner}`);
      expected.set(key, owner);
      expectedIndexes.set(name, expected);
    };
    for (const inspection of inspections) {
      for (const [name, expected] of inspection.expected) {
        const unique = !NON_UNIQUE_INDEX_NAMES.has(name);
        for (const [key, owner] of expected) addExpected(name, key, owner, unique);
      }
    }
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
    // Build every core/project index from validated primary records before the
    // first index mutation. A conflict or malformed record must leave all
    // indexes exactly as found, not merely rely on transaction rollback.
    for (const mapping of CORE_UNIQUE_INDEXES) {
      for (const entry of tx.range<Record<string, unknown>>(mapping.source, {})) {
        const doc = entry.value;
        if (doc.deletedAt !== null && doc.deletedAt !== undefined) continue;
        const key = doc[mapping.field];
        if (typeof key !== 'string') {
          issues.push(`${mapping.indexStore}: ${entry.key} 缺少 ${mapping.field}`);
          continue;
        }
        addExpected(mapping.indexStore, key, entry.key, true);
      }
    }
    for (const mapping of PROJECT_NONUNIQUE_INDEXES) {
      for (const entry of tx.range<Record<string, unknown>>(mapping.source, {})) {
        const doc = entry.value;
        if (doc.deletedAt !== null && doc.deletedAt !== undefined) continue;
        const key = doc[mapping.field];
        if (typeof key !== 'string') {
          issues.push(`${mapping.indexStore}: ${entry.key} 缺少 ${mapping.field}`);
          continue;
        }
        addExpected(mapping.indexStore, indexStoreKey(key, entry.key), entry.key, false);
      }
    }
    if (issues.length)
      throw new Error(`无法重建索引，主记录、唯一键或引用无效: ${issues.join('; ')}`);

    for (const [name, expected] of expectedIndexes) {
      for (const entry of tx.range<unknown>(name, {})) tx.remove(name, entry.key);
      for (const [key, owner] of expected) tx.put(name, key, owner);
    }
  });
  console.log('索引已重建');
} finally {
  try {
    await engine.close();
  } finally {
    await lock.release();
  }
}
