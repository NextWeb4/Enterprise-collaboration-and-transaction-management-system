import type { ErrorCode } from '@collab/shared/errors.js';
import { AppError } from '../shared/errors.js';
import { KEY_SEP } from '../shared/ids.js';
import type { StoreName } from './store-names.js';

export interface IndexDefinition<T> {
  /** 索引子库全名，如 idx_users_email */
  readonly name: string;
  /** 所属实体库 */
  readonly source: StoreName;
  readonly unique: boolean;
  /** 唯一冲突时返回的业务错误码（如 USER_EMAIL_TAKEN） */
  readonly conflictCode?: ErrorCode;
  readonly conflictMessage?: string;
  /**
   * 计算文档索引键集合（可多值，如 roleIds）；空数组表示不参与该索引。
   * 索引键必须来自服务端受控字段，禁止原始用户输入直接拼键。
   */
  readonly indexKeys: (document: T) => readonly string[];
}

/** 非唯一索引存储键：索引键 + 实体 ID 后缀，保证键唯一且可稳定排序 */
export function indexStoreKey(indexKey: string, entityId: string): string {
  return `${indexKey}${KEY_SEP}${entityId}`;
}

/** 从非唯一索引存储键中还原实体 ID（实体 ID 为 UUID，不含分隔符） */
export function entityIdFromIndexStoreKey(storeKey: string): string {
  const pos = storeKey.lastIndexOf(KEY_SEP);
  if (pos < 0) {
    throw new AppError('STORAGE_CORRUPTED', `索引键缺少实体 ID 后缀: ${storeKey}`);
  }
  return storeKey.slice(pos + KEY_SEP.length);
}
