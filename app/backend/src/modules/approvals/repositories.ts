import { BaseRepository, type Repository } from '../../storage/repository.js';
import type { StorageEngine, StorageTransaction } from '../../storage/engine.js';
import type { SchemaRegistry } from '../../storage/schema-registry.js';
import { systemClock } from '../../shared/clock.js';
import type { DocumentEnvelope } from '../../storage/envelope.js';
import { AppError } from '../../shared/errors.js';
import { createSharedRecordRepositories } from '../core/shared-records.js';
import { applicationSchema, instanceSchema, stepSchema, recordSchema, templateSchema, templateVersionSchema, attachmentSchema, type Application, type WorkflowInstance, type WorkflowStep, type ApprovalRecord, type Notification, type WorkflowTemplate, type WorkflowVersion, type WorkflowIdempotency, type WorkflowCounter, type ApplicationAttachment } from './models.js';

export interface AppendOnlyRecords {
  create(input: Omit<ApprovalRecord, keyof DocumentEnvelope>, tx: StorageTransaction, options?: { createdAt?: string }): Promise<ApprovalRecord>;
  listByInstance(instanceId: string, tx: StorageTransaction): Promise<ApprovalRecord[]>;
}
export interface ApprovalRepositories {
  applications: Repository<Application>; instances: Repository<WorkflowInstance>; steps: Repository<WorkflowStep>;
  records: AppendOnlyRecords; notifications: Repository<Notification>; listSteps(instanceId: string, tx: StorageTransaction): Promise<WorkflowStep[]>;
  templates: Repository<WorkflowTemplate>; versions: Pick<Repository<WorkflowVersion>, 'create' | 'get' | 'list'>; idempotency: Repository<WorkflowIdempotency>;
  counters: Repository<WorkflowCounter>;
  attachments: Pick<Repository<ApplicationAttachment>, 'list' | 'get' | 'create' | 'softDelete'>;
}
const repositoryInstances = new WeakMap<SchemaRegistry, { engine: StorageEngine; repositories: ApprovalRepositories }>();
export function createApprovalRepositories(engine: StorageEngine, registry: SchemaRegistry): ApprovalRepositories {
  const existing = repositoryInstances.get(registry);
  if (existing) {
    if (existing.engine !== engine) throw new Error('审批仓储不能跨存储引擎复用');
    return existing.repositories;
  }
  const applications = new BaseRepository<Application>({ store: 'applications', type: 'application', schemaVersion: 1, schema: applicationSchema, clock: systemClock, indexes: [
    { name: 'idx_application_no', source: 'applications', unique: true, indexKeys: (doc) => doc.applicationNo === null ? [] : [doc.applicationNo], conflictCode: 'VERSION_CONFLICT' },
    { name: 'idx_workflow_applicant', source: 'applications', unique: false, indexKeys: (doc) => [doc.applicantId] },
  ] }, registry, engine);
  const instances = new BaseRepository<WorkflowInstance>({ store: 'workflow_instances', type: 'workflow_instance', schemaVersion: 1, schema: instanceSchema, clock: systemClock, indexes: [{ name: 'idx_workflow_instances_application', source: 'workflow_instances', unique: true, indexKeys: (doc) => [doc.applicationId] }] }, registry, engine);
  const steps = new BaseRepository<WorkflowStep>({ store: 'workflow_steps', type: 'workflow_step', schemaVersion: 1, schema: stepSchema, clock: systemClock, indexes: [
    { name: 'idx_workflow_steps_number', source: 'workflow_steps', unique: true, indexKeys: (doc) => [JSON.stringify([doc.instanceId, doc.stepNo])] },
    { name: 'idx_workflow_steps_active', source: 'workflow_steps', unique: true, indexKeys: (doc) => doc.status === 'active' ? [doc.instanceId] : [] },
    { name: 'idx_workflow_steps_approver_status', source: 'workflow_steps', unique: false, indexKeys: (doc) => [JSON.stringify([doc.approverId, doc.status])] },
  ] }, registry, engine);
  const rawRecords = new BaseRepository<ApprovalRecord>({ store: 'approval_records', type: 'approval_record', schemaVersion: 1, schema: recordSchema, clock: systemClock, indexes: [
    { name: 'idx_approval_records_seq', source: 'approval_records', unique: true, indexKeys: (doc) => [JSON.stringify([doc.instanceId, doc.seq])] },
    { name: 'idx_approval_records_decision', source: 'approval_records', unique: true, indexKeys: (doc) => ['approve', 'reject'].includes(doc.action) ? [doc.stepId] : [] },
    { name: 'idx_approval_records_withdraw', source: 'approval_records', unique: true, indexKeys: (doc) => doc.action === 'withdraw' ? [doc.instanceId] : [] },
  ] }, registry, engine);
  const { notifications, counters, idempotency } = createSharedRecordRepositories(engine, registry);
  const templates = new BaseRepository<WorkflowTemplate>({ store: 'workflow_templates', type: 'workflow_template', schemaVersion: 1, schema: templateSchema, clock: systemClock, indexes: [{ name: 'idx_workflow_templates_active', source: 'workflow_templates', unique: true, indexKeys: (doc) => doc.status === 'active' ? [doc.applicationType] : [] }] }, registry, engine);
  const versions = new BaseRepository<WorkflowVersion>({ store: 'workflow_versions', type: 'workflow_version', schemaVersion: 1, schema: templateVersionSchema, clock: systemClock, indexes: [{ name: 'idx_workflow_versions_number', source: 'workflow_versions', unique: true, indexKeys: (doc) => [JSON.stringify([doc.templateId, doc.versionNo])] }] }, registry, engine);
  const attachments = new BaseRepository<ApplicationAttachment>({ store: 'application_attachments', type: 'application_attachment', schemaVersion: 1, schema: attachmentSchema, clock: systemClock, indexes: [
    { name: 'idx_application_attachments_application', source: 'application_attachments', unique: false, indexKeys: (doc) => [doc.applicationId] },
  ] }, registry, engine);
  const records: AppendOnlyRecords = {
    create: (input, tx, options) => rawRecords.create(input, tx, options),
    listByInstance: async (instanceId, tx) => {
      const first = await rawRecords.list({ page: 1, pageSize: 100 }, tx);
      const all = [...first.items];
      for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) all.push(...(await rawRecords.list({ page, pageSize: 100 }, tx)).items);
      return all.filter((item) => item.instanceId === instanceId).sort((a, b) => a.seq - b.seq);
    },
  };
  const listSteps = async (instanceId: string, tx: StorageTransaction): Promise<WorkflowStep[]> => {
    const first = await steps.list({ page: 1, pageSize: 100 }, tx);
    const all = [...first.items];
    for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) all.push(...(await steps.list({ page, pageSize: 100 }, tx)).items);
    return all.filter((step) => step.instanceId === instanceId).sort((left, right) => left.stepNo - right.stepNo);
  };
  const repositories = { applications, instances, steps, records, notifications, listSteps, templates, versions: { create: versions.create.bind(versions), get: versions.get.bind(versions), list: versions.list.bind(versions) }, idempotency, counters, attachments: { list: attachments.list.bind(attachments), get: attachments.get.bind(attachments), create: attachments.create.bind(attachments), softDelete: attachments.softDelete.bind(attachments) } };
  repositoryInstances.set(registry, { engine, repositories });
  return repositories;
}

/** Fail closed when a running instance cannot be proven to have exactly one consistent current step. */
export async function hasCurrentApproval(repos: ApprovalRepositories, userId: string, tx: StorageTransaction): Promise<boolean> {
  const first = await repos.instances.list({ page: 1, pageSize: 100 }, tx);
  const instances = [...first.items];
  for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) instances.push(...(await repos.instances.list({ page, pageSize: 100 }, tx)).items);
  let found = false;
  for (const instance of instances) {
    if (instance.status !== 'running') continue;
    const app = await repos.applications.get(instance.applicationId, tx);
    const steps = await repos.listSteps(instance.id, tx);
    const active = steps.filter((step) => step.status === 'active');
    const indexed = await repos.steps.getByUniqueIndex('idx_workflow_steps_active', instance.id, tx);
    if (!app || app.deletedAt !== null || app.status !== 'pending' || active.length !== 1 || !active[0] || active[0].stepNo !== instance.currentStepNo || indexed?.id !== active[0].id) throw new AppError('STORAGE_CORRUPTED', '进行中审批的当前步骤不一致');
    if (active[0].approverId === userId) found = true;
  }
  return found;
}
