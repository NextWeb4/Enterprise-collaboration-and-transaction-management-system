/**
 * 统一存储仓储（docs/03-technical/data-storage-design.md §6.1/§13；TD-04）。
 * - 全部读写走 StorageTransaction；无事务参数时自动开启单操作事务。
 * - 信封（id/type/schemaVersion/version/createdAt/updatedAt/deletedAt）由仓储统一管理。
 * - 唯一约束经唯一索引实现，冲突 409；软删除移除全部索引条目。
 * - 索引可重建、不是唯一数据源；禁止业务模块绕过本层。
 */
import type { ZodType } from 'zod';
import { AppError } from '../shared/errors.js';
import type { Clock } from '../shared/clock.js';
import { KEY_SEP, newId, assertValidKeyPart } from '../shared/ids.js';
import type { DocumentEnvelope } from './envelope.js';
import {
  entityIdFromIndexStoreKey,
  indexStoreKey,
  type IndexDefinition,
} from './index-registry.js';
import { assertSafeValue, type SchemaRegistry } from './schema-registry.js';
import type { RangeOptions, StorageEngine, StorageTransaction } from './engine.js';
import type { StoreName } from './store-names.js';

export interface ListQuery {
  /** 走指定索引列表（推荐）；缺省时按主键范围 */
  readonly indexName?: string;
  /** 非唯一索引前缀过滤 */
  readonly prefix?: string;
  readonly startKey?: string;
  readonly endKey?: string;
  readonly reverse?: boolean;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface CreateOptions {
  readonly createdAt?: string;
}

export interface RepositoryDefinition<T> {
  readonly store: StoreName;
  readonly type: string;
  readonly schemaVersion: number;
  /** 完整文档 schema（信封 + 业务字段，strict） */
  readonly schema: ZodType<T>;
  readonly indexes: readonly IndexDefinition<T>[];
  /** list() 缺省索引；其键空间必须覆盖全部活跃文档 */
  readonly defaultIndexName?: string;
  readonly clock: Clock;
}

export interface Repository<T extends DocumentEnvelope> {
  get(id: string, tx?: StorageTransaction): Promise<T | undefined>;
  require(id: string, tx?: StorageTransaction): Promise<T>;
  create(
    input: Omit<T, keyof DocumentEnvelope>,
    tx?: StorageTransaction,
    options?: CreateOptions,
  ): Promise<T>;
  update(
    id: string,
    expectedVersion: number,
    mutate: (current: T) => T,
    tx?: StorageTransaction,
  ): Promise<T>;
  replace(doc: T, tx?: StorageTransaction): Promise<T>;
  softDelete(id: string, expectedVersion: number, tx?: StorageTransaction): Promise<T>;
  remove(id: string, tx?: StorageTransaction): Promise<void>;
  getByUniqueIndex(
    indexName: string,
    indexKey: string,
    tx?: StorageTransaction,
  ): Promise<T | undefined>;
  list(query: ListQuery, tx?: StorageTransaction): Promise<Page<T>>;
  countAll(tx?: StorageTransaction): Promise<number>;
  countStored(tx?: StorageTransaction): Promise<number>;
  /** 包含软删除文档的历史存在性检查，用于不可重用标识。 */
  existsStored(predicate: (doc: T) => boolean, tx?: StorageTransaction): Promise<boolean>;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const EMPTY_KEYS: readonly string[] = [];

export class BaseRepository<T extends DocumentEnvelope> implements Repository<T> {
  private readonly indexByName = new Map<string, IndexDefinition<T>>();

  constructor(
    private readonly def: RepositoryDefinition<T>,
    private readonly registry: SchemaRegistry,
    private readonly engine: StorageEngine,
  ) {
    for (const index of def.indexes) {
      if (this.indexByName.has(index.name)) {
        throw new AppError('INTERNAL_ERROR', `索引定义重复: ${index.name}`);
      }
      engine.ensureStore(index.name);
      this.indexByName.set(index.name, index);
    }
    if (def.defaultIndexName && !this.indexByName.has(def.defaultIndexName)) {
      throw new AppError('INTERNAL_ERROR', `默认索引未定义: ${def.defaultIndexName}`);
    }
    this.registry.register({
      store: def.store,
      type: def.type,
      schemaVersion: def.schemaVersion,
      schema: def.schema,
    });
  }

  async get(id: string, tx?: StorageTransaction): Promise<T | undefined> {
    return this.withTx(tx, (t) => this.parseIfPresent(t.get(this.def.store, id)));
  }

  async require(id: string, tx?: StorageTransaction): Promise<T> {
    const doc = await this.get(id, tx);
    if (!doc) {
      throw new AppError('NOT_FOUND', `${this.def.type} 不存在`);
    }
    return doc;
  }

  async create(
    input: Omit<T, keyof DocumentEnvelope>,
    tx?: StorageTransaction,
    options?: CreateOptions,
  ): Promise<T> {
    return this.withTx(tx, (t) => {
      const now = options?.createdAt ?? this.def.clock.nowIso();
      const envelope: DocumentEnvelope = {
        id: newId(),
        type: this.def.type,
        schemaVersion: this.def.schemaVersion,
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      const candidate = { ...input, ...envelope } as unknown as T;
      return this.writeNew(t, candidate);
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    mutate: (current: T) => T,
    tx?: StorageTransaction,
  ): Promise<T> {
    return this.withTx(tx, (t) => {
      const current = this.loadCurrent(t, id);
      if (current.version !== expectedVersion) {
        throw new AppError('VERSION_CONFLICT', `${this.def.type} 已被其他操作更新，请刷新后重试`);
      }
      const mutated = mutate(current);
      const next: T = {
        ...mutated,
        id: current.id,
        type: current.type,
        schemaVersion: this.def.schemaVersion,
        createdAt: current.createdAt,
        version: current.version + 1,
        updatedAt: this.def.clock.nowIso(),
      };
      return this.writeExisting(t, current, next);
    });
  }

  async replace(doc: T, tx?: StorageTransaction): Promise<T> {
    return this.withTx(tx, (t) => {
      const current = this.loadCurrent(t, doc.id);
      if (current.version !== doc.version) {
        throw new AppError('VERSION_CONFLICT', `${this.def.type} 已被其他操作更新，请刷新后重试`);
      }
      const next: T = {
        ...doc,
        id: current.id,
        type: current.type,
        schemaVersion: this.def.schemaVersion,
        createdAt: current.createdAt,
        version: current.version + 1,
        updatedAt: this.def.clock.nowIso(),
      };
      return this.writeExisting(t, current, next);
    });
  }

  async softDelete(id: string, expectedVersion: number, tx?: StorageTransaction): Promise<T> {
    return this.withTx(tx, (t) => {
      const current = this.loadCurrent(t, id);
      if (current.version !== expectedVersion) {
        throw new AppError('VERSION_CONFLICT', `${this.def.type} 已被其他操作更新，请刷新后重试`);
      }
      if (current.deletedAt !== null) {
        throw new AppError('VERSION_CONFLICT', `${this.def.type} 已处于删除状态`);
      }
      const next: T = {
        ...current,
        deletedAt: this.def.clock.nowIso(),
        version: current.version + 1,
        updatedAt: this.def.clock.nowIso(),
      };
      return this.writeExisting(t, current, next);
    });
  }

  async remove(id: string, tx?: StorageTransaction): Promise<void> {
    return this.withTx(tx, (t) => {
      const raw = t.get<T>(this.def.store, id);
      if (raw === undefined) {
        return;
      }
      const current = this.parseIfPresent(raw);
      if (current === undefined) {
        return;
      }
      this.dropIndexes(t, current);
      t.remove(this.def.store, id);
    });
  }

  async getByUniqueIndex(
    indexName: string,
    indexKey: string,
    tx?: StorageTransaction,
  ): Promise<T | undefined> {
    return this.withTx(tx, (t) => {
      const def = this.requireIndexDef(indexName);
      if (!def.unique) {
        throw new AppError('INTERNAL_ERROR', `非唯一索引不支持点查: ${indexName}`);
      }
      assertValidKeyPart(indexKey);
      const owner = t.get<string>(def.name, indexKey);
      if (owner === undefined) {
        return undefined;
      }
      return this.parseIfPresent(t.get(this.def.store, owner));
    });
  }

  async list(query: ListQuery, tx?: StorageTransaction): Promise<Page<T>> {
    return this.withTx(tx, (t) => {
      const page = Math.max(1, Math.floor(query.page ?? 1));
      const pageSize = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, Math.floor(query.pageSize ?? DEFAULT_PAGE_SIZE)),
      );
      const ids = this.collectIds(t, query);
      const total = ids.length;
      const skip = (page - 1) * pageSize;
      const items: T[] = [];
      for (const id of ids.slice(skip, skip + pageSize)) {
        const doc = this.parseIfPresent(t.get(this.def.store, id));
        if (doc !== undefined) {
          items.push(doc);
        }
      }
      return { items, total, page, pageSize };
    });
  }

  async countAll(tx?: StorageTransaction): Promise<number> {
    return this.withTx(tx, (t) => {
      if (this.def.defaultIndexName) {
        return t.count(this.def.defaultIndexName);
      }
      return t.count(this.def.store);
    });
  }

  async countStored(tx?: StorageTransaction): Promise<number> {
    return this.withTx(tx, (t) => t.count(this.def.store));
  }

  async existsStored(predicate: (doc: T) => boolean, tx?: StorageTransaction): Promise<boolean> {
    return this.withTx(tx, (t) =>
      t.range<unknown>(this.def.store, {}).some((entry) => {
        const doc = this.parseIfPresent(entry.value);
        return doc !== undefined && predicate(doc);
      }),
    );
  }

  // ---------- 内部实现 ----------

  private collectIds(t: StorageTransaction, query: ListQuery): string[] {
    const indexName = query.indexName ?? this.def.defaultIndexName;
    if (indexName !== undefined) {
      const def = this.requireIndexDef(indexName);
      const rangeOptions = this.indexRangeOptions(def, query);
      const entries = t.range<string>(def.name, rangeOptions);
      return entries.map((entry) =>
        def.unique ? (entry.value as string) : entityIdFromIndexStoreKey(entry.key),
      );
    }
    const rangeOptions: { start?: string; end?: string; reverse?: boolean } = {};
    if (query.startKey !== undefined) {
      rangeOptions.start = query.startKey;
    }
    if (query.endKey !== undefined) {
      rangeOptions.end = query.endKey;
    }
    if (query.reverse !== undefined) {
      rangeOptions.reverse = query.reverse;
    }
    const entries = t.range<T>(this.def.store, rangeOptions);
    return entries
      .filter((entry) => entry.value?.deletedAt == null)
      .map((entry) => entry.value.id as string);
  }

  private indexRangeOptions(def: IndexDefinition<T>, query: ListQuery): RangeOptions {
    const options: { start?: string; end?: string; reverse?: boolean } = {};
    if (query.prefix !== undefined) {
      assertValidKeyPart(query.prefix);
      if (def.unique) {
        options.start = query.prefix;
        options.end = `${query.prefix}\uffff`;
      } else {
        options.start = `${query.prefix}${KEY_SEP}`;
        options.end = `${query.prefix}${KEY_SEP}\uffff`;
      }
    } else {
      if (query.startKey !== undefined) {
        options.start = query.startKey;
      }
      if (query.endKey !== undefined) {
        options.end = query.endKey;
      }
    }
    if (query.reverse !== undefined) {
      options.reverse = query.reverse;
    }
    return options;
  }

  private loadCurrent(t: StorageTransaction, id: string): T {
    const raw = t.get<T>(this.def.store, id);
    if (raw === undefined) {
      throw new AppError('NOT_FOUND', `${this.def.type} 不存在`);
    }
    const parsed = this.parseIfPresent(raw);
    if (parsed === undefined) {
      throw new AppError('NOT_FOUND', `${this.def.type} 不存在`);
    }
    return parsed;
  }

  private writeNew(t: StorageTransaction, candidate: T): T {
    const parsed = this.validate(candidate);
    assertSafeValue(parsed);
    this.applyIndexes(t, undefined, parsed);
    t.put(this.def.store, parsed.id, parsed);
    return parsed;
  }

  private writeExisting(t: StorageTransaction, previous: T, next: T): T {
    const parsed = this.validate(next);
    assertSafeValue(parsed);
    this.applyIndexes(t, previous, parsed);
    t.put(this.def.store, parsed.id, parsed);
    return parsed;
  }

  private applyIndexes(t: StorageTransaction, previous: T | undefined, next: T | undefined): void {
    for (const def of this.def.indexes) {
      const oldKeys =
        previous && previous.deletedAt === null ? def.indexKeys(previous) : EMPTY_KEYS;
      const newKeys = next && next.deletedAt === null ? def.indexKeys(next) : EMPTY_KEYS;
      for (const key of oldKeys) {
        if (!newKeys.includes(key)) {
          assertValidKeyPart(key);
          if (previous) t.remove(def.name, indexStoreKeyFor(def, key, previous.id));
        }
      }
      for (const key of newKeys) {
        if (oldKeys.includes(key)) {
          continue;
        }
        assertValidKeyPart(key);
        if (!next) continue;
        const newStoreKey = indexStoreKeyFor(def, key, next.id);
        if (def.unique) {
          const owner = t.get<string>(def.name, newStoreKey);
          if (owner !== undefined && owner !== next.id) {
            throw new AppError(
              def.conflictCode ?? 'VERSION_CONFLICT',
              def.conflictMessage ?? '唯一约束冲突',
            );
          }
        }
        t.put(def.name, newStoreKey, next.id);
      }
    }
  }

  private dropIndexes(t: StorageTransaction, doc: T): void {
    for (const def of this.def.indexes) {
      for (const key of def.indexKeys(doc)) {
        if (def.unique) {
          if (t.get<string>(def.name, key) === doc.id) t.remove(def.name, key);
        } else {
          t.remove(def.name, indexStoreKeyFor(def, key, doc.id));
        }
      }
    }
  }

  private requireIndexDef(name: string): IndexDefinition<T> {
    const def = this.indexByName.get(name);
    if (def === undefined) {
      throw new AppError('INTERNAL_ERROR', `索引未定义: ${name}`);
    }
    return def;
  }

  private parseIfPresent(raw: unknown): T | undefined {
    if (raw === undefined) {
      return undefined;
    }
    try {
      return this.def.schema.parse(raw) as T;
    } catch {
      throw new AppError('STORAGE_CORRUPTED', `${this.def.type} 文档损坏或 schema 不兼容`);
    }
  }

  private validate(doc: unknown): T {
    try {
      return this.def.schema.parse(doc) as T;
    } catch {
      throw new AppError('VALIDATION_FAILED', `${this.def.type} 文档校验失败`);
    }
  }

  private withTx<R>(
    tx: StorageTransaction | undefined,
    fn: (t: StorageTransaction) => R,
  ): Promise<R> {
    if (tx !== undefined) {
      return Promise.resolve(fn(tx));
    }
    return this.engine.transaction(fn);
  }
}

function indexStoreKeyFor<T>(def: IndexDefinition<T>, indexKey: string, entityId: string): string {
  return def.unique ? indexKey : indexStoreKey(indexKey, entityId);
}
