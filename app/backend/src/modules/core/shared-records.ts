import { z } from 'zod';
import { BaseRepository, type Repository } from '../../storage/repository.js';
import type { SchemaRegistry } from '../../storage/schema-registry.js';
import type { StorageEngine } from '../../storage/engine.js';
import { systemClock } from '../../shared/clock.js';
import { AppError } from '../../shared/errors.js';

// Namespace is optional only for previously created approval records; omission means "approvals".
const namespace = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/u).optional();
const envelope = { id: z.string().min(1), schemaVersion: z.literal(1), version: z.number().int().positive(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), deletedAt: z.string().datetime().nullable() };
export const sharedNotificationSchema = z.object({ ...envelope, type: z.literal('notification'), namespace, recipientId: z.string().min(1), notificationType: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/u), title: z.string().min(1).max(120), content: z.string().max(500), linkPath: z.string().nullable(), readAt: z.string().datetime().nullable() }).strict();
export const sharedCounterSchema = z.object({ ...envelope, type: z.literal('workflow_counter'), namespace, date: z.string().min(1).max(100).refine((value) => [...value].every((character) => (character.codePointAt(0) ?? 0) >= 32 && character.codePointAt(0) !== 127)), value: z.number().int().nonnegative().safe() }).strict().refine((doc) => (doc.namespace && doc.namespace !== 'approvals') || (/^\d{8}$/u.test(doc.date) && doc.value <= 9999), '审批编号计数器无效');
export const sharedIdempotencySchema = z.object({ ...envelope, type: z.literal('workflow_idempotency'), namespace, userId: z.string().min(1), key: z.string().uuid(), applicationId: z.string().min(1), requestHash: z.string().length(64), expiresAt: z.string().datetime(), response: z.record(z.unknown()) }).strict();
export type SharedNotification = z.infer<typeof sharedNotificationSchema>;
export type SharedCounter = z.infer<typeof sharedCounterSchema>;
export type SharedIdempotency = z.infer<typeof sharedIdempotencySchema>;
export function counterIndexKey(doc: Pick<SharedCounter, 'namespace' | 'date'>): string { return !doc.namespace || doc.namespace === 'approvals' ? doc.date : JSON.stringify([doc.namespace, doc.date]); }
export function idempotencyIndexKey(doc: Pick<SharedIdempotency, 'namespace' | 'userId' | 'key'>): string { return !doc.namespace || doc.namespace === 'approvals' ? JSON.stringify([doc.userId, doc.key]) : JSON.stringify([doc.namespace, doc.userId, doc.key]); }

export interface SharedRecordRepositories { notifications: Repository<SharedNotification>; counters: Repository<SharedCounter>; idempotency: Repository<SharedIdempotency> }
const instances = new WeakMap<SchemaRegistry, { engine: StorageEngine; repositories: SharedRecordRepositories }>();
/** One registry and one engine share one set of repositories across all modules. */
export function createSharedRecordRepositories(engine: StorageEngine, registry: SchemaRegistry): SharedRecordRepositories {
  const existing = instances.get(registry);
  if (existing) {
    if (existing.engine !== engine) throw new AppError('INTERNAL_ERROR', '共享仓储不能跨存储引擎复用');
    return existing.repositories;
  }
  const notifications = new BaseRepository<SharedNotification>({ store: 'notifications', type: 'notification', schemaVersion: 1, schema: sharedNotificationSchema, clock: systemClock, indexes: [] }, registry, engine);
  const counters = new BaseRepository<SharedCounter>({ store: 'counters', type: 'workflow_counter', schemaVersion: 1, schema: sharedCounterSchema, clock: systemClock, indexes: [{ name: 'idx_workflow_counter_date', source: 'counters', unique: true, indexKeys: (doc) => [counterIndexKey(doc)] }] }, registry, engine);
  const idempotency = new BaseRepository<SharedIdempotency>({ store: 'idempotency', type: 'workflow_idempotency', schemaVersion: 1, schema: sharedIdempotencySchema, clock: systemClock, indexes: [{ name: 'idx_workflow_idempotency', source: 'idempotency', unique: true, indexKeys: (doc) => [idempotencyIndexKey(doc)] }] }, registry, engine);
  const repositories = { notifications, counters, idempotency };
  instances.set(registry, { engine, repositories });
  return repositories;
}
