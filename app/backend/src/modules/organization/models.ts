import { z } from 'zod';
import type { DocumentEnvelope } from '../../storage/envelope.js';

export interface DepartmentDocument extends DocumentEnvelope {
  type: 'department';
  parentId: string | null;
  name: string;
  code: string | null;
  managerId: string | null;
  description: string;
  sortOrder: number;
}

const safeText = z.string().trim().refine((value) => [...value].every((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code >= 32 && code !== 127;
}), '不允许控制字符');
export const departmentFieldsSchema = z.object({
  parentId: z.string().min(1).max(64).nullable(),
  name: safeText.pipe(z.string().min(1).max(80)),
  code: safeText.pipe(z.string().min(1).max(64)).nullable(),
  managerId: z.string().min(1).max(64).nullable(),
  description: safeText.pipe(z.string().max(300)),
  sortOrder: z.number().int().min(0).max(1000000),
}).strict();

export const departmentSchema = departmentFieldsSchema.extend({
  id: z.string().min(1).max(64), type: z.literal('department'), schemaVersion: z.literal(1),
  version: z.number().int().min(1), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
}).strict();

export type DepartmentInput = z.infer<typeof departmentFieldsSchema>;
