import type { StorageTransaction } from '../../storage/engine.js';
import { indexStoreKey } from '../../storage/index-registry.js';
import { recordHash } from './approval-service.js';
import { applicationSchema, attachmentSchema, counterSchema, idempotencySchema, instanceSchema, notificationSchema, recordSchema, stepSchema, templateSchema, templateVersionSchema } from './models.js';
import type { ApprovalRecord, WorkflowInstance } from './models.js';
import { counterIndexKey, idempotencyIndexKey } from '../core/shared-records.js';

export const APPROVAL_INDEX_NAMES = ['idx_application_no', 'idx_workflow_applicant', 'idx_workflow_instances_application', 'idx_workflow_steps_number', 'idx_workflow_steps_active', 'idx_workflow_steps_approver_status', 'idx_approval_records_seq', 'idx_approval_records_decision', 'idx_approval_records_withdraw', 'idx_application_attachments_application', 'idx_workflow_templates_active', 'idx_workflow_versions_number', 'idx_workflow_idempotency', 'idx_workflow_counter_date'] as const;

/** Reconstruct solely from validated primary documents; never repair a broken history chain. */
export function inspectApprovalStorage(tx: StorageTransaction): { issues: string[]; expected: Map<string, Map<string, string>> } {
  const issues: string[] = [];
  const expected = new Map<string, Map<string, string>>(APPROVAL_INDEX_NAMES.map((name) => [name, new Map()]));
  const nonUnique = new Set(['idx_workflow_applicant', 'idx_workflow_steps_approver_status', 'idx_application_attachments_application']);
  const add = (index: string, key: string, id: string): void => {
    const entries = expected.get(index);
    if (!entries) throw new Error('审批索引配置错误');
    if (entries.has(key) && !nonUnique.has(index)) issues.push(`${index}: 唯一键重复`);
    // Non-unique indexes are represented by a deterministic composite key in
    // the rebuild checker; the actual repository index may contain many IDs.
    entries.set(nonUnique.has(index) ? indexStoreKey(key, id) : key, id);
  };
  const instances = new Map<string, WorkflowInstance>();
  const records = new Map<string, ApprovalRecord[]>();
  const applications = new Set<string>();
  const steps = new Map<string, { instanceId: string }>();
  const schemas = [
    ['applications', applicationSchema], ['application_attachments', attachmentSchema], ['workflow_templates', templateSchema], ['workflow_versions', templateVersionSchema], ['workflow_instances', instanceSchema], ['workflow_steps', stepSchema], ['approval_records', recordSchema], ['notifications', notificationSchema], ['idempotency', idempotencySchema], ['counters', counterSchema],
  ] as const;
  for (const [store, schema] of schemas) for (const entry of tx.range<unknown>(store, {})) {
    const parsed = schema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) { issues.push(`${store}: ${entry.key} schema 或主键无效`); continue; }
    const doc = parsed.data;
    if (doc.type === 'approval_record' && doc.deletedAt !== null) { issues.push(`approval_records: ${entry.key} 禁止删除`); continue; }
    if (doc.deletedAt !== null) continue;
    switch (doc.type) {
      case 'application': applications.add(doc.id); if (doc.applicationNo !== null) add('idx_application_no', doc.applicationNo, doc.id); add('idx_workflow_applicant', doc.applicantId, doc.id); break;
      case 'workflow_instance': instances.set(doc.id, doc); add('idx_workflow_instances_application', doc.applicationId, doc.id); break;
      case 'workflow_step': steps.set(doc.id, { instanceId: doc.instanceId }); add('idx_workflow_steps_number', JSON.stringify([doc.instanceId, doc.stepNo]), doc.id); if (doc.status === 'active') add('idx_workflow_steps_active', doc.instanceId, doc.id); add('idx_workflow_steps_approver_status', JSON.stringify([doc.approverId, doc.status]), doc.id); break;
      case 'approval_record': {
        add('idx_approval_records_seq', JSON.stringify([doc.instanceId, doc.seq]), doc.id);
        if (doc.action === 'approve' || doc.action === 'reject') add('idx_approval_records_decision', doc.stepId, doc.id);
        if (doc.action === 'withdraw') add('idx_approval_records_withdraw', doc.instanceId, doc.id);
        const entries = records.get(doc.instanceId) ?? []; entries.push(doc); records.set(doc.instanceId, entries); break;
      }
      case 'application_attachment': add('idx_application_attachments_application', doc.applicationId, doc.id); if (!applications.has(doc.applicationId)) issues.push(`application_attachments: ${doc.id} 引用不存在的申请 ${doc.applicationId}`); break;
      case 'workflow_template': if (doc.status === 'active') add('idx_workflow_templates_active', doc.applicationType, doc.id); break;
      case 'workflow_version': add('idx_workflow_versions_number', JSON.stringify([doc.templateId, doc.versionNo]), doc.id); break;
      case 'workflow_idempotency': add('idx_workflow_idempotency', idempotencyIndexKey(doc), doc.id); break;
      case 'workflow_counter': add('idx_workflow_counter_date', counterIndexKey(doc), doc.id); break;
    }
  }
  for (const [id, instance] of instances) if (!applications.has(instance.applicationId)) issues.push(`workflow_instances: ${id} 引用不存在的申请 ${instance.applicationId}`);
  for (const [id, step] of steps) if (!instances.has(step.instanceId)) issues.push(`workflow_steps: ${id} 引用不存在的实例 ${step.instanceId}`);
  for (const [id, entries] of records) if (!instances.has(id) && entries.length) issues.push(`approval_records: 实例 ${id} 不存在`);
  for (const [id, instance] of instances) {
    const entries = (records.get(id) ?? []).sort((a, b) => a.seq - b.seq);
    let previous: string | null = null;
    for (const [index, record] of entries.entries()) {
      if (record.seq !== index + 1 || record.applicationId !== instance.applicationId || record.previousHash !== previous || record.hash !== recordHash(record)) issues.push(`approval_records: 实例 ${id} 哈希链无效`);
      const step = steps.get(record.stepId);
      if (!step || step.instanceId !== id) issues.push(`approval_records: ${record.id} 引用的审批步骤无效`);
      previous = record.hash;
    }
    if (instance.recordSeq !== entries.length || instance.recordHash !== previous) issues.push(`workflow_instances: ${id} 审批链头无效`);
  }
  return { issues, expected };
}
