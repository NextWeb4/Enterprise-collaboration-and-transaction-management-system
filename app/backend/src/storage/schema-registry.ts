import type { ZodType } from 'zod';
import { AppError } from '../shared/errors.js';
import { STORE_NAMES, type StoreName } from './store-names.js';

export interface RegisteredSchema {
  readonly store: StoreName;
  /** 信封 type 字段（如 'user'） */
  readonly type: string;
  /** 实体 schema 版本 */
  readonly schemaVersion: number;
  /** 完整文档 schema（信封 + 业务字段，strict） */
  readonly schema: ZodType<unknown>;
}

/** SchemaRegistry：存储层统一维护（docs/03-technical/data-storage-design.md §6.1） */
export class SchemaRegistry {
  private readonly schemas = new Map<StoreName, RegisteredSchema>();

  register(def: RegisteredSchema): void {
    if (!STORE_NAMES.includes(def.store)) {
      throw new AppError('INTERNAL_ERROR', `未知子库: ${def.store}`);
    }
    if (this.schemas.has(def.store)) {
      throw new AppError('INTERNAL_ERROR', `子库 schema 重复注册: ${def.store}`);
    }
    this.schemas.set(def.store, def);
  }

  require(store: StoreName): RegisteredSchema {
    const found = this.schemas.get(store);
    if (!found) {
      throw new AppError('INTERNAL_ERROR', `子库 schema 未注册: ${store}`);
    }
    return found;
  }

  all(): RegisteredSchema[] {
    return [...this.schemas.values()];
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 原型污染防护：递归拒绝危险属性名（docs/03-technical/data-storage-design.md §20） */
export function assertSafeValue(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeValue(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new AppError('VALIDATION_FAILED', `禁止的属性名: ${path}.${key}`);
    }
    assertSafeValue(child, `${path}.${key}`);
  }
}