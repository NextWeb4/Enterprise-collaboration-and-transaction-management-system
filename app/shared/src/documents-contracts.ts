import { z } from 'zod';

const text = z.string().trim().refine((value) => [...value].every((char) => { const code = char.charCodeAt(0); return code !== 127 && (code >= 32 || code === 9 || code === 10 || code === 13); }), '文本包含非法字符');
const id = z.string().uuid();
export const documentVisibilitySchema = z.enum(['restricted', 'project', 'organization']);
export const documentTagColors = ['blue', 'cyan', 'green', 'gold', 'orange', 'red', 'magenta', 'purple'] as const;
export const documentFieldsSchema = z.object({ title: text.pipe(z.string().min(2).max(100)), description: text.pipe(z.string().max(1000)).default(''), categoryId: id.nullable().default(null), tagIds: z.array(id).max(10).default([]), projectId: id.nullable().default(null), visibility: documentVisibilitySchema.default('restricted') }).strict();
export const documentCreateSchema = documentFieldsSchema.extend({ versionNote: text.pipe(z.string().max(200)).default('') });
export const documentUpdateSchema = documentFieldsSchema.omit({ projectId: true }).extend({ version: z.number().int().positive() });
export const documentVersionInputSchema = z.object({ version: z.number().int().positive(), note: text.pipe(z.string().max(200)).default('') }).strict();
export const documentGrantSchema = z.object({ subjectType: z.enum(['user', 'role', 'department']), subjectId: id, permission: z.enum(['view', 'edit', 'manage']), includeDescendants: z.boolean().default(false) }).strict();
export const documentCategorySchema = z.object({ name: text.pipe(z.string().min(2).max(50)), parentId: id.nullable().default(null), sortOrder: z.number().int().min(0).max(1000000).default(0) }).strict();
export const documentTagSchema = z.object({ name: text.pipe(z.string().min(1).max(20)), color: z.enum(documentTagColors).default('blue') }).strict();
export const documentSearchSchema = z.object({ q: text.pipe(z.string().max(100)).default(''), categoryId: id.optional(), tagIds: z.array(id).max(10).default([]), projectId: id.optional(), ownerId: id.optional(), visibility: documentVisibilitySchema.optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), archived: z.boolean().default(false), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(20) }).strict().refine((value) => !value.from || !value.to || value.from <= value.to, '更新时间范围无效');
export type DocumentCreateInput = z.input<typeof documentCreateSchema>;
export type DocumentUpdateInput = z.input<typeof documentUpdateSchema>;
export type DocumentSearchInput = z.input<typeof documentSearchSchema>;
export type DocumentGrantInput = z.input<typeof documentGrantSchema>;
export type DocumentCategoryInput = z.input<typeof documentCategorySchema>;
export type DocumentTagInput = z.input<typeof documentTagSchema>;
export interface DocumentView { id: string; title: string; description: string; categoryId: string | null; projectId: string | null; ownerId: string; visibility: 'restricted' | 'project' | 'organization'; status: 'active' | 'archived'; currentVersionId: string | null; versionCount: number; version: number; updatedAt: string; createdAt: string; tagIds: string[]; level: 'view' | 'edit' | 'manage'; readOnly: boolean; currentFile: { fileName: string; size: number; mime: string } | null }
export interface DocumentVersionView { id: string; documentId: string; versionNo: number; fileName: string; mime: string; size: number; sha256: string; versionNote: string; uploadedBy: string; createdAt: string }
export interface DocumentGrantView { id: string; version: number; subjectType: 'user' | 'role' | 'department'; subjectId: string; permission: 'view' | 'edit' | 'manage'; includeDescendants: boolean }
export interface DocumentCategoryView { id: string; version: number; name: string; parentId: string | null; sortOrder: number }
export interface DocumentTagView { id: string; version: number; name: string; color: typeof documentTagColors[number] }

const documentBatchItemSchema = z.object({ id, version: z.number().int().positive() }).strict();
const documentBatchItemsSchema = z.array(documentBatchItemSchema).min(1).max(100)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, '批量文档不可重复');
export const documentBatchRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('move_category'), categoryId: id.nullable(), items: documentBatchItemsSchema }).strict(),
  z.object({ operation: z.literal('add_tags'), tagIds: z.array(id).min(1).max(10).refine((ids) => new Set(ids).size === ids.length, '标签不可重复'), items: documentBatchItemsSchema }).strict(),
  z.object({ operation: z.literal('archive'), items: documentBatchItemsSchema }).strict(),
]);
export type DocumentBatchRequest = z.infer<typeof documentBatchRequestSchema>;
export const documentBatchItemResultSchema = z.discriminatedUnion('success', [
  z.object({ id, success: z.literal(true), version: z.number().int().positive() }).strict(),
  z.object({ id, success: z.literal(false), code: z.string().min(1), message: z.string().min(1) }).strict(),
]);
export const documentBatchResponseSchema = z.object({
  results: z.array(documentBatchItemResultSchema),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
}).strict();
export type DocumentBatchResponse = z.infer<typeof documentBatchResponseSchema>;
