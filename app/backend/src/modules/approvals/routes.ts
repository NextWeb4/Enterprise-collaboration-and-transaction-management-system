import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  applicationDraftRequestSchema,
  applicationUpdateRequestSchema,
  applicationVersionRequestSchema,
  applicationWithdrawRequestSchema,
  approvalDecisionRequestSchema,
  approvalReassignRequestSchema,
  workflowTemplateRequestSchema,
  workflowTemplateVersionRequestSchema,
  approvalListQuerySchema,
} from '@collab/shared/schemas.js';
import type { AuthContext } from '../core/auth-service.js';
import { AppError } from '../../shared/errors.js';
import type { ApplicationService } from './application-service.js';
import type { ApprovalService } from './approval-service.js';
import type { WorkflowTemplateService } from './template-service.js';

export interface ApprovalRouteOptions {
  applications: ApplicationService;
  approvals: ApprovalService;
  templates: WorkflowTemplateService;
  requireAuth: (request: FastifyRequest) => Promise<AuthContext>;
  requireCsrf: (request: FastifyRequest) => Promise<void>;
}

export function registerApprovalRoutes(app: FastifyInstance, options: ApprovalRouteOptions): void {
  const { applications, approvals, templates } = options;
  const actor = async (request: FastifyRequest): Promise<AuthContext> =>
    request.authContext ?? options.requireAuth(request);
  const auth = async (request: FastifyRequest): Promise<void> => {
    await options.requireAuth(request);
  };
  const read = { preHandler: [auth] };
  const write = { preHandler: [auth, options.requireCsrf] };
  const context = (
    request: FastifyRequest,
  ): { requestId: string; ip: string; userAgent: string | undefined } => ({
    requestId: request.id,
    ip: request.ip,
    userAgent: request.headers['user-agent'],
  });
  const id = (request: FastifyRequest): string =>
    z.object({ id: z.string().min(1) }).parse(request.params).id;
  const versioned = z.object({ version: z.number().int().positive() });
  app.get('/api/v1/applications', read, async (request) =>
    applications.list(
      await actor(request),
      approvalListQuerySchema.parse(request.query),
      context(request),
    ),
  );
  app.post('/api/v1/applications', write, async (request, reply) =>
    reply
      .code(201)
      .send({
        data: await applications.create(
          await actor(request),
          applicationDraftRequestSchema.parse(request.body),
          context(request),
        ),
      }),
  );
  app.get('/api/v1/applications/:id', read, async (request) => ({
    data: await applications.detail(await actor(request), id(request), context(request)),
  }));
  app.patch('/api/v1/applications/:id', write, async (request) => {
    const { version, ...input } = applicationUpdateRequestSchema.parse(request.body);
    return {
      data: await applications.update(
        await actor(request),
        id(request),
        version,
        input,
        context(request),
      ),
    };
  });
  app.delete('/api/v1/applications/:id', write, async (request) => {
    await applications.remove(
      await actor(request),
      id(request),
      applicationVersionRequestSchema.parse(request.body).version,
      context(request),
    );
    return { data: { success: true } };
  });
  app.post('/api/v1/applications/:id/copy', write, async (request, reply) =>
    reply
      .code(201)
      .send({ data: await applications.copy(await actor(request), id(request), context(request)) }),
  );
  app.post('/api/v1/applications/:id/submit', write, async (request) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string')
      throw new AppError('VALIDATION_FAILED', '提交必须提供 Idempotency-Key');
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return {
      data: await approvals.submit(await actor(request), id(request), key, context(request)),
    };
  });
  app.get('/api/v1/applications/:id/history', read, async (request) => ({
    data: await applications.history(await actor(request), id(request), context(request)),
  }));
  for (const action of ['approve', 'reject'] as const)
    app.post(`/api/v1/applications/:id/${action}`, write, async (request) => {
      const input = approvalDecisionRequestSchema.merge(versioned).strict().parse(request.body);
      await approvals.decide(
        await actor(request),
        id(request),
        action,
        input.comment,
        context(request),
        input.version,
      );
      return { data: { success: true } };
    });
  app.post('/api/v1/applications/:id/withdraw', write, async (request) => {
    const input = applicationWithdrawRequestSchema.merge(versioned).strict().parse(request.body);
    await approvals.withdraw(
      await actor(request),
      id(request),
      input.reason,
      context(request),
      input.version,
    );
    return { data: { success: true } };
  });
  app.post('/api/v1/applications/:id/reassign', write, async (request) => {
    const input = approvalReassignRequestSchema.merge(versioned).strict().parse(request.body);
    await approvals.reassign(
      await actor(request),
      id(request),
      input.newApproverId,
      input.reason,
      context(request),
      input.version,
    );
    return { data: { success: true } };
  });
  app.post('/api/v1/applications/:id/attachments', write, async (request, reply) => {
    const version = z
      .object({ version: z.coerce.number().int().positive() })
      .strict()
      .parse(request.query).version;
    const part = await request.file({
      limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 0 },
    });
    if (!part) throw new AppError('VALIDATION_FAILED', '请选择文件');
    const attachment = await applications.attach(
      await actor(request),
      id(request),
      version,
      { filename: part.filename, mimetype: part.mimetype, stream: part.file, ...context(request) },
      context(request),
    );
    return reply.code(201).send({ data: attachment });
  });
  app.delete('/api/v1/applications/:id/attachments/:attachmentId', write, async (request) => {
    const parameters = z
      .object({ id: z.string().min(1), attachmentId: z.string().min(1) })
      .parse(request.params);
    await applications.removeAttachment(
      await actor(request),
      parameters.id,
      parameters.attachmentId,
      applicationVersionRequestSchema.parse(request.body).version,
      context(request),
    );
    return { data: { success: true } };
  });
  app.get(
    '/api/v1/applications/:id/attachments/:attachmentId/download',
    read,
    async (request, reply) => {
      const parameters = z
        .object({ id: z.string().min(1), attachmentId: z.string().min(1) })
        .parse(request.params);
      const download = await applications.download(
        await actor(request),
        parameters.id,
        parameters.attachmentId,
        context(request),
      );
      return reply
        .header('Content-Type', download.mime)
        .header(
          'Content-Disposition',
          `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(download.fileName).replaceAll("'", '%27')}`,
        )
        .header('Cache-Control', 'no-store')
        .send(createReadStream(download.path));
    },
  );
  app.get('/api/v1/workflow/templates', read, async (request) => ({
    data: await templates.list(await actor(request)),
  }));
  app.post('/api/v1/workflow/templates', write, async (request, reply) =>
    reply
      .code(201)
      .send({
        data: await templates.create(
          await actor(request),
          workflowTemplateRequestSchema.parse(request.body),
          context(request),
        ),
      }),
  );
  app.patch('/api/v1/workflow/templates/:id', write, async (request) => {
    const { version, ...input } = workflowTemplateRequestSchema
      .merge(versioned)
      .strict()
      .parse(request.body);
    return {
      data: await templates.updateDraft(
        await actor(request),
        id(request),
        version,
        input,
        context(request),
      ),
    };
  });
  app.post('/api/v1/workflow/templates/:id/publish', write, async (request) => ({
    data: await templates.publish(
      await actor(request),
      id(request),
      workflowTemplateVersionRequestSchema.parse(request.body).version,
      context(request),
    ),
  }));
  app.post('/api/v1/workflow/templates/:id/deactivate', write, async (request) => ({
    data: await templates.deactivate(
      await actor(request),
      id(request),
      workflowTemplateVersionRequestSchema.parse(request.body).version,
      context(request),
    ),
  }));
  app.get('/api/v1/workflow/templates/:id/versions', read, async (request) => ({
    data: await templates.versions(await actor(request), id(request)),
  }));
  app.post('/api/v1/workflow/templates/defaults', write, async (request) => ({
    data: await templates.initializeDefaults(await actor(request), context(request)),
  }));
}
