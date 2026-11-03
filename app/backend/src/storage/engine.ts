/**
 * LMDB 存储引擎适配器 —— 全工程唯一允许 import lmdb 的文件（AGENTS.md §4.1 / TD-04）。
 * 业务模块只能依赖 StorageEngine/StorageTransaction/Repository/UnitOfWork。
 * 配置依据：docs/03-technical/data-storage-design.md §5（encoding json / maxDbs 128 / mapSize 2GB / 无 noSync/useWritemap/加密）。
 */
import { open, type Database, type RootDatabase } from 'lmdb';
import { mkdirSync } from 'node:fs';
import { AppError } from '../shared/errors.js';
import { STORE_NAMES, isIndexStoreName, isStoreName } from './store-names.js';

/** 全局 schema 版本（meta 子库），升级由 storage:migrate 负责 */
export const GLOBAL_SCHEMA_VERSION = 1;
export const META_SCHEMA_VERSION_KEY = 'schemaVersion';

export interface RangeOptions {
  readonly start?: string;
  readonly end?: string;
  readonly reverse?: boolean;
  readonly limit?: number;
}

export interface RangeEntry<T> {
  readonly key: string;
  readonly value: T;
}

/**
 * 事务上下文：事务内写立即可见、随事务提交/回滚。
 * store 参数为运行时校验的子库名（实体库或 idx_ 索引库）。
 */
export interface StorageTransaction {
  get<T>(store: string, key: string): T | undefined;
  put<T>(store: string, key: string, value: T): void;
  remove(store: string, key: string): void;
  range<T>(store: string, options: RangeOptions): RangeEntry<T>[];
  count(store: string): number;
}

export interface StorageHealth {
  readonly ok: boolean;
  readonly schemaVersion: number;
  readonly writable: boolean;
}

export interface StorageEngine {
  open(options?: StorageOpenOptions): Promise<void>;
  close(): Promise<void>;
  /** 由 Repository 在 schema 注册时调用，确保子库句柄在事务外创建。 */
  ensureStore(name: string): void;
  transaction<T>(fn: (tx: StorageTransaction) => Promise<T> | T): Promise<T>;
  healthCheck(): Promise<StorageHealth>;
}

export interface StorageOpenOptions {
  /**
   * 仅供受控迁移/校验工具读取旧数据。业务启动必须使用默认值 false，
   * 以避免把旧 schema 当作当前 schema 继续写入。
   */
  readonly allowSchemaMismatch?: boolean;
}

export interface LmdbEngineOptions {
  readonly path: string;
  readonly mapSize?: number;
  readonly maxDbs?: number;
}

const DEFAULT_MAP_SIZE = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_DBS = 128;
const MAX_RANGE_SCAN = 200_000;

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class LmdbStorageEngine implements StorageEngine {
  private root: RootDatabase | null = null;
  private readonly dbs = new Map<string, Database>();
  private maintenanceMode = false;

  constructor(private readonly options: LmdbEngineOptions) {}

  async open(options: StorageOpenOptions = {}): Promise<void> {
    if (this.root) {
      return;
    }
    mkdirSync(this.options.path, { recursive: true });
    let root: RootDatabase;
    try {
      root = open(this.options.path, {
        encoding: 'json',
        maxDbs: this.options.maxDbs ?? DEFAULT_MAX_DBS,
        mapSize: this.options.mapSize ?? DEFAULT_MAP_SIZE,
      });
    } catch (error) {
      throw new AppError('STORAGE_UNAVAILABLE', `LMDB 打开失败: ${describeError(error)}`);
    }
    this.root = root;
    try {
      for (const name of STORE_NAMES) this.store(name);
      await this.initMeta(options.allowSchemaMismatch === true);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const root = this.root;
    this.root = null;
    this.dbs.clear();
    if (root) {
      try {
        await root.close();
      } catch (error) {
        throw new AppError('STORAGE_UNAVAILABLE', `LMDB 关闭失败: ${describeError(error)}`);
      }
    }
  }

  async transaction<T>(fn: (tx: StorageTransaction) => Promise<T> | T): Promise<T> {
    const root = this.requireRoot();
    // LMDB 3.5.9's ordinary transaction() does not reliably abort on callback
    // failure. childTransaction is abortable for both throws and rejections.
    return root.childTransaction(() => fn(this.createTxContext()));
  }

  async healthCheck(): Promise<StorageHealth> {
    const root = this.root;
    if (!root) {
      return { ok: false, schemaVersion: 0, writable: false };
    }
    try {
      const version = this.store('meta').get(META_SCHEMA_VERSION_KEY) as number | undefined;
      return {
        ok: version === GLOBAL_SCHEMA_VERSION,
        schemaVersion: version ?? 0,
        writable: !this.maintenanceMode,
      };
    } catch {
      return { ok: false, schemaVersion: 0, writable: false };
    }
  }

  setMaintenance(on: boolean): void {
    this.maintenanceMode = on;
  }

  ensureStore(name: string): void {
    this.store(name);
  }

  isMaintenance(): boolean {
    return this.maintenanceMode;
  }

  /** 仅供存储层内部与 scripts/（verify/rebuild/migrate）使用；业务模块禁止调用。@internal */
  maintenanceDb(name: string): Database {
    return this.store(name);
  }

  /** 仅供 scripts/ 使用。@internal */
  maintenanceRoot(): RootDatabase | null {
    return this.root;
  }

  private requireRoot(): RootDatabase {
    const root = this.root;
    if (!root) {
      throw new AppError('STORAGE_UNAVAILABLE', '存储引擎未打开');
    }
    return root;
  }

  private async initMeta(allowSchemaMismatch: boolean): Promise<void> {
    const root = this.requireRoot();
    await root.childTransaction(() => {
      const meta = this.store('meta');
      const current: unknown = meta.get(META_SCHEMA_VERSION_KEY);
      // Maintenance tools inspect the original value, including missing or
      // malformed versions, without initializing or relabelling existing data.
      if (allowSchemaMismatch) return;
      if (current === undefined) {
        const hasData = STORE_NAMES.some((name) => {
          for (const _entry of this.store(name).getRange({})) return true;
          return false;
        });
        if (hasData) {
          throw new AppError(
            'STORAGE_UNAVAILABLE',
            '数据缺少 meta.schemaVersion；拒绝将既有数据初始化为当前版本',
          );
        }
        meta.put(META_SCHEMA_VERSION_KEY, GLOBAL_SCHEMA_VERSION);
        return;
      }
      if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 1) {
        throw new AppError(
          'STORAGE_UNAVAILABLE',
          'meta.schemaVersion 无效；请保留现场并检查数据版本',
        );
      }
      if (current > GLOBAL_SCHEMA_VERSION) {
        throw new AppError(
          'STORAGE_UNAVAILABLE',
          '数据 schema 版本高于当前程序，请运行 storage:migrate',
        );
      }
      if (current < GLOBAL_SCHEMA_VERSION) {
        throw new AppError(
          'STORAGE_UNAVAILABLE',
          '数据 schema 版本低于当前程序，请运行 storage:migrate',
        );
      }
    });
  }

  private store(name: string): Database {
    const root = this.requireRoot();
    if (!isStoreName(name) && !isIndexStoreName(name)) {
      throw new AppError('INTERNAL_ERROR', `非法子库名: ${name}`);
    }
    const cached = this.dbs.get(name);
    if (cached) {
      return cached;
    }
    const db = root.openDB(name, { encoding: 'json' });
    this.dbs.set(name, db);
    return db;
  }

  private createTxContext(): StorageTransaction {
    return {
      get: <T>(store: string, key: string): T | undefined =>
        this.store(store).get(key) as T | undefined,
      put: <T>(store: string, key: string, value: T): void => {
        this.store(store).put(key, value);
      },
      remove: (store: string, key: string): void => {
        this.store(store).remove(key);
      },
      range: <T>(store: string, options: RangeOptions): RangeEntry<T>[] => {
        const db = this.store(store);
        const result: RangeEntry<T>[] = [];
        const requestedLimit = options.limit;
        const limit = requestedLimit ?? MAX_RANGE_SCAN;
        const query: { start?: string; end?: string; reverse?: boolean } = {};
        if (options.start !== undefined) {
          query.start = options.start;
        }
        if (options.end !== undefined) {
          query.end = options.end;
        }
        if (options.reverse !== undefined) {
          query.reverse = options.reverse;
        }
        let scanned = 0;
        for (const entry of db.getRange(query)) {
          scanned += 1;
          if (scanned > MAX_RANGE_SCAN) {
            throw new AppError('INTERNAL_ERROR', '范围扫描超出安全上限');
          }
          result.push({ key: entry.key as string, value: entry.value as T });
          // An explicit limit is a deliberate bounded page. An implicit range
          // is expected to be complete; do not silently return a truncated
          // inventory at MAX_RANGE_SCAN, because callers may use it as the
          // source of truth for reconciliation or validation.
          if (requestedLimit !== undefined && result.length >= limit) {
            break;
          }
        }
        return result;
      },
      count: (store: string): number => {
        const db = this.store(store);
        let total = 0;
        for (const _entry of db.getRange({})) {
          total += 1;
          if (total > MAX_RANGE_SCAN) {
            throw new AppError('INTERNAL_ERROR', '计数扫描超出安全上限');
          }
        }
        return total;
      },
    };
  }
}
