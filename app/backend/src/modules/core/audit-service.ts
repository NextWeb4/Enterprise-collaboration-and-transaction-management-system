import { AppError } from '../../shared/errors.js';
import { systemClock, type Clock } from '../../shared/clock.js';
import { auditHash, type CoreRepositories } from './repositories.js';
import type { AuditLogDocument } from './models.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';

export interface AuditInput {
  readonly actorUserId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly result?: 'success' | 'failure';
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
  readonly metadata?: Record<string, string | number | boolean | null>;
}

export class AuditService {
  constructor(
    private readonly repos: CoreRepositories,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock = systemClock,
  ) {}

  async append(input: AuditInput, tx?: StorageTransaction): Promise<AuditLogDocument> {
    const appendInTransaction = async (transaction: StorageTransaction): Promise<AuditLogDocument> => {
      const storedSeq = transaction.get<number>('meta', 'auditSeq');
      const currentSeq = storedSeq ?? 0;
      const previousHash = transaction.get<string>('meta', 'auditLastHash') ?? null;
      const missingHead = storedSeq === undefined && (await this.repos.auditLogs.countAll(transaction)) > 0;
      if (
        missingHead ||
        !Number.isSafeInteger(currentSeq) ||
        currentSeq < 0 ||
        (currentSeq === 0 && previousHash !== null) ||
        (currentSeq > 0 && previousHash === null)
      ) {
        throw new AppError('STORAGE_CORRUPTED', '审计链头与记录数不一致；需先执行经审查的数据迁移');
      }
      if (!Number.isSafeInteger(currentSeq + 1)) {
        throw new AppError('STORAGE_CORRUPTED', '审计序号已超出安全范围');
      }
      const seq = currentSeq + 1;
      const createdAt = this.clock.nowIso();
      const body = {
        seq,
        actorUserId: input.actorUserId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        result: input.result ?? 'success',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
        metadata: input.metadata ?? {},
      };
      const hash = auditHash({
        seq,
        actorId: body.actorUserId,
        action: body.action,
        resourceType: body.resourceType,
        resourceId: body.resourceId,
        result: body.result,
        ip: body.ip,
        userAgent: body.userAgent,
        requestId: body.requestId,
        metadata: body.metadata,
        createdAt,
        prevHash: previousHash,
      });
      const created = await this.repos.auditLogs.create(
        { ...body, previousHash, hash },
        transaction,
        { createdAt },
      );
      transaction.put('meta', 'auditSeq', seq);
      transaction.put('meta', 'auditLastHash', hash);
      return created;
    };
    return tx ? appendInTransaction(tx) : this.uow.run(appendInTransaction);
  }

  async verifyChain(): Promise<boolean> {
    return this.uow.run(async (tx) => {
      const firstPage = await this.repos.auditLogs.list({ page: 1, pageSize: 1 }, tx);
      const pageCount = Math.ceil(firstPage.total / 100);
      const entries: AuditLogDocument[] = [];
      for (let page = 1; page <= pageCount; page += 1) {
        const result = await this.repos.auditLogs.list({ page, pageSize: 100 }, tx);
        entries.push(...result.items);
      }
      entries.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
      let previousHash: string | null = null;
      for (const [index, entry] of entries.entries()) {
        const expectedSeq = index + 1;
        if (entry.seq !== expectedSeq || entry.result === undefined || entry.ip === undefined || entry.userAgent === undefined) return false;
        if (entry.previousHash !== previousHash) return false;
        const calculated = auditHash({
          seq: entry.seq,
          actorId: entry.actorUserId,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          result: entry.result,
          ip: entry.ip,
          userAgent: entry.userAgent,
          requestId: entry.requestId,
          metadata: entry.metadata,
          createdAt: entry.createdAt,
          prevHash: entry.previousHash,
        });
        if (calculated !== entry.hash) return false;
        previousHash = entry.hash;
      }
      const auditSeq = tx.get<number>('meta', 'auditSeq') ?? 0;
      const auditLastHash = tx.get<string>('meta', 'auditLastHash') ?? null;
      return auditSeq === entries.length && auditLastHash === previousHash;
    });
  }
}
