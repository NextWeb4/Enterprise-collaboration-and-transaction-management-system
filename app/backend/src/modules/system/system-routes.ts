import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import type { AuthContext } from '../core/auth-service.js';
import type { SystemService } from './system-service.js';

type AuthenticatedRequest = FastifyRequest & { authContext?: AuthContext };
export interface SystemRouteOptions { readonly service: SystemService; readonly requireAuth: preHandlerHookHandler; readonly requireCsrf: preHandlerHookHandler; }
const page = z.coerce.number().int().min(1).default(1); const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const loginFilter = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), email: z.string().max(120).optional(), result: z.enum(['success', 'failure']).optional(), ip: z.string().max(128).optional(), page, pageSize }).strict();
const auditFilter = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), actorUserId: z.string().max(128).optional(), action: z.string().max(128).optional(), resourceType: z.string().max(128).optional(), result: z.enum(['success', 'failure']).optional(), requestId: z.string().max(128).optional(), page, pageSize }).strict();
const settingsUpdate = z.object({ version: z.number().int().min(1), displayName: z.string(), timezone: z.string() }).strict();
function actor(request: FastifyRequest): AuthContext { const context = (request as AuthenticatedRequest).authContext; if (!context) throw new AppError('UNAUTHENTICATED', '会话已失效'); return context; }

export function registerSystemRoutes(app: FastifyInstance, options: SystemRouteOptions): void {
  app.get('/api/v1/system/settings', { preHandler: [options.requireAuth] }, async (request) => ({ data: await options.service.settings(actor(request)) }));
  app.patch('/api/v1/system/settings', { preHandler: [options.requireAuth, options.requireCsrf] }, async (request) => ({ data: await options.service.updateSettings(actor(request), settingsUpdate.parse(request.body), { requestId: request.id, ip: request.ip ?? null, userAgent: request.headers['user-agent'] ?? null }) }));
  app.get('/api/v1/system/login-records', { preHandler: [options.requireAuth] }, async (request) => { const result = await options.service.loginRecords(actor(request), loginFilter.parse(request.query)); return { data: result.items, meta: { page: result.page, pageSize: result.pageSize, total: result.total } }; });
  app.get('/api/v1/system/operation-logs', { preHandler: [options.requireAuth] }, async (request) => { const result = await options.service.auditLogs(actor(request), auditFilter.parse(request.query)); return { data: result.items, meta: { page: result.page, pageSize: result.pageSize, total: result.total } }; });
}
