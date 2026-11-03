import type { StorageEngine, StorageTransaction } from './engine.js';

export type UnitOfWorkFn<T> = (tx: StorageTransaction) => Promise<T> | T;

/**
 * UnitOfWork：关键写操作的唯一事务边界（docs/03-technical/data-storage-design.md §6.1）。
 * - 事务内不做文件/网络 IO（文件协议见 FileService）；
 * - 服务层在一个 run() 内完成多实体写 + 索引 + 审计 + 通知；
 * - 抛出异常整体回滚。
 */
export class UnitOfWork {
  constructor(private readonly engine: StorageEngine) {}

  run<T>(fn: UnitOfWorkFn<T>): Promise<T> {
    return this.engine.transaction(fn);
  }
}