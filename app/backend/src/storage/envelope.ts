/**
 * 文档信封（docs/03-technical/data-storage-design.md §7）：
 * id/type/schemaVersion/version/createdAt/updatedAt/deletedAt 由 Repository 统一维护。
 */
import { z } from 'zod';
import type { Clock } from '../shared/clock.js';
import { newId } from '../shared/ids.js';

export interface DocumentEnvelope {
  id: string;
  type: string;
  schemaVersion: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** 新建文档信封 */
export function createEnvelope(type: string, schemaVersion: number, clock: Clock): DocumentEnvelope {
  const now = clock.nowIso();
  return {
    id: newId(),
    type,
    schemaVersion,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

/** 供各模块 Zod schema 展开的信封字段；type 与 schemaVersion 由模块用字面量收窄 */
export function envelopeShape(schemaVersion: number): Record<string, z.ZodTypeAny> {
  return {
    id: z.string().min(1).max(64),
    type: z.string().min(1).max(64),
    schemaVersion: z.number().int().min(1).max(schemaVersion),
    version: z.number().int().min(1),
    createdAt: isoStringSchema(),
    updatedAt: isoStringSchema(),
    deletedAt: z.string().datetime({ offset: false }).nullable(),
  };
}

export function isoStringSchema(): z.ZodString {
  return z.string().datetime({ offset: false });
}