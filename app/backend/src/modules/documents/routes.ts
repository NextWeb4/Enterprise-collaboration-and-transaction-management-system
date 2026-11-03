import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { documentBatchRequestSchema, documentCategorySchema, documentCreateSchema, documentGrantSchema, documentSearchSchema, documentTagSchema, documentUpdateSchema, documentVersionInputSchema } from '@collab/shared/schemas.js';
import { AppError } from '../../shared/errors.js';
import type { AuthContext } from '../core/auth-service.js';
import type { FileService, StagedUpload } from '../core/file-service.js';
import type { DocumentService } from './document-service.js';

export interface DocumentRouteOptions {
  readonly service: DocumentService;
  readonly files: FileService;
  readonly requireAuth: preHandlerHookHandler;
  readonly requireCsrf: preHandlerHookHandler;
  readonly maxUploadBytes: number;
}
function actor(request: FastifyRequest): AuthContext {
  const context = (request as FastifyRequest & { authContext?: AuthContext }).authContext;
  if (!context) throw new AppError('UNAUTHENTICATED', '会话已失效');
  return context;
}
function ids(request: FastifyRequest): { id: string; childId?: string } {
  return z.object({ id: z.string().uuid(), childId: z.string().uuid().optional() }).parse(request.params);
}
const versionBody = z.object({ version: z.number().int().positive() }).strict();
function auditContext(request: FastifyRequest): { requestId: string; ip: string; userAgent: string | null } {
  return { requestId: request.id, ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}
async function upload<T>(request: FastifyRequest, options: DocumentRouteOptions, schema: z.ZodType<T>, execute: (staged: StagedUpload, input: T) => Promise<unknown>): Promise<unknown> {
  let staged: StagedUpload | null = null; let metadata: unknown;
  try {
    for await (const part of request.parts({ limits: { files: 1, fields: 1, parts: 2, fieldSize: 20_000, fileSize: options.maxUploadBytes } })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file') throw new AppError('VALIDATION_FAILED', '文件字段必须为 file');
        staged = await options.files.stage({ stream: part.file, filename: part.filename, mimetype: part.mimetype, uploadedBy: actor(request).user.id, maxBytes: options.maxUploadBytes, ...auditContext(request) });
      } else {
        if (part.fieldname !== 'metadata' || typeof part.value !== 'string' || part.valueTruncated) throw new AppError('VALIDATION_FAILED', '上传元数据无效');
        try { metadata = JSON.parse(part.value) as unknown; } catch { throw new AppError('VALIDATION_FAILED', '上传元数据必须为 JSON'); }
      }
    }
    if (!staged) throw new AppError('VALIDATION_FAILED', '请选择文件');
    return await execute(staged, schema.parse(metadata));
  } finally {
    if (staged) await options.files.discard(staged, actor(request).user.id).catch(() => undefined);
  }
}
export function registerDocumentRoutes(app: FastifyInstance, options: DocumentRouteOptions): void {
  const read = { preHandler: [options.requireAuth] };
  const write = { preHandler: [options.requireAuth, options.requireCsrf] };
  const service = options.service;
  app.get('/api/v1/documents', read, async (request) => {
    const input = z.object({ q: z.string().optional(), categoryId: z.string().optional(), tagIds: z.string().optional(), projectId: z.string().optional(), ownerId: z.string().optional(), visibility: z.enum(['restricted', 'project', 'organization']).optional(), from: z.string().optional(), to: z.string().optional(), archived: z.enum(['true', 'false']).optional(), page: z.coerce.number().optional(), pageSize: z.coerce.number().optional() }).strict().parse(request.query);
    return service.search(actor(request), documentSearchSchema.parse({ ...input, tagIds: input.tagIds ? input.tagIds.split(',') : [], archived: input.archived === 'true' }));
  });
  app.get('/api/v1/documents/classifications', read, async (request) => ({ data: await service.classifications(actor(request)) }));
  app.post('/api/v1/documents', write, async (request, reply) => reply.code(201).send({ data: await upload(request, options, documentCreateSchema, async (staged, fields) => {
    const result = await service.create(actor(request), staged, fields, auditContext(request));
    return service.get(actor(request), result.document.id);
  }) }));
  app.get('/api/v1/documents/:id', read, async (request) => ({ data: await service.get(actor(request), ids(request).id) }));
  app.patch('/api/v1/documents/:id', write, async (request) => ({ data: await service.update(actor(request), ids(request).id, documentUpdateSchema.parse(request.body), auditContext(request)) }));
  app.post('/api/v1/documents/:id/archive', write, async (request) => ({ data: await service.archive(actor(request), ids(request).id, versionBody.parse(request.body).version, auditContext(request)) }));
  app.post('/api/v1/documents/batch', write, async (request) => ({ data: await service.batch(actor(request), documentBatchRequestSchema.parse(request.body), auditContext(request)) }));
  app.delete('/api/v1/documents/:id', write, async (request) => {
    await service.remove(actor(request), ids(request).id, versionBody.parse(request.body).version, auditContext(request)); return { data: { success: true } };
  });
  app.get('/api/v1/documents/:id/versions', read, async (request) => ({ data: (await service.versions(actor(request), ids(request).id)).map(({ id, documentId, versionNo, fileName, mime, size, sha256, versionNote, uploadedBy, createdAt }) => ({ id, documentId, versionNo, fileName, mime, size, sha256, versionNote, uploadedBy, createdAt })) }));
  app.post('/api/v1/documents/:id/versions', write, async (request, reply) => reply.code(201).send({ data: await upload(request, options, documentVersionInputSchema, async (staged, fields) => {
    await service.appendVersion(actor(request), ids(request).id, staged, fields, auditContext(request)); return service.get(actor(request), ids(request).id);
  }) }));
  app.post('/api/v1/documents/:id/versions/:childId/restore', write, async (request, reply) => {
    const { id, childId } = ids(request);
    return reply.code(201).send({ data: await service.restoreVersion(actor(request), id, childId!, z.object({ version: z.number().int().positive(), note: z.string().max(200).optional() }).strict().parse(request.body), auditContext(request)) });
  });
  for (const path of ['/api/v1/documents/:id/download', '/api/v1/documents/:id/versions/:childId/download']) {
    app.get(path, read, async (request, reply) => {
      const { id, childId } = ids(request); const result = await service.download(actor(request), id, childId ?? null, auditContext(request));
      return reply.type(result.mime).header('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(result.fileName).replace(/['()*]/gu, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())).header('Content-Length', result.size).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').send(createReadStream(result.path));
    });
  }
  for (const path of ['/api/v1/documents/:id/preview', '/api/v1/documents/:id/versions/:childId/preview']) {
    app.get(path, read, async (request, reply) => {
      const { id, childId } = ids(request); const result = await service.preview(actor(request), id, childId ?? null, auditContext(request));
      return reply.type(result.mime).header('Content-Disposition', "inline; filename*=UTF-8''" + encodeURIComponent(result.fileName).replace(/['()*]/gu, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())).header('Content-Length', result.size).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'").send(createReadStream(result.path));
    });
  }
  app.get('/api/v1/documents/:id/acl', read, async (request) => ({ data: await service.grants(actor(request), ids(request).id) }));
  app.get('/api/v1/documents/:id/acl-subjects', read, async (request) => ({ data: await service.grantSubjects(actor(request), ids(request).id) }));
  app.put('/api/v1/documents/:id/acl', write, async (request) => ({ data: await service.putGrant(actor(request), ids(request).id, documentGrantSchema.parse(request.body), auditContext(request)) }));
  app.delete('/api/v1/documents/:id/acl/:childId', write, async (request) => {
    const { id, childId } = ids(request); await service.revokeGrant(actor(request), id, childId!, auditContext(request)); return { data: { success: true } };
  });
  app.post('/api/v1/document-categories', write, async (request, reply) => reply.code(201).send({ data: await service.saveCategory(actor(request), null, null, documentCategorySchema.parse(request.body), auditContext(request)) }));
  app.patch('/api/v1/document-categories/:id', write, async (request) => {
    const { version, ...fields } = documentCategorySchema.extend({ version: z.number().int().positive() }).parse(request.body);
    return { data: await service.saveCategory(actor(request), ids(request).id, version, fields, auditContext(request)) };
  });
  app.delete('/api/v1/document-categories/:id', write, async (request) => {
    await service.deleteCategory(actor(request), ids(request).id, versionBody.parse(request.body).version, auditContext(request)); return { data: { success: true } };
  });
  app.post('/api/v1/document-tags', write, async (request, reply) => reply.code(201).send({ data: await service.saveTag(actor(request), null, null, documentTagSchema.parse(request.body), auditContext(request)) }));
  app.patch('/api/v1/document-tags/:id', write, async (request) => {
    const { version, ...fields } = documentTagSchema.extend({ version: z.number().int().positive() }).parse(request.body);
    return { data: await service.saveTag(actor(request), ids(request).id, version, fields, auditContext(request)) };
  });
  app.delete('/api/v1/document-tags/:id', write, async (request) => {
    await service.deleteTag(actor(request), ids(request).id, versionBody.parse(request.body).version, auditContext(request)); return { data: { success: true } };
  });
}
