import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import type { AuthContext } from '../core/auth-service.js';
import type { CalendarAuditContext, CalendarService } from './calendar-service.js';
import type { CoreRepositories } from '../core/repositories.js';

const participantIds = z.array(z.string().uuid()).max(50).optional();
const eventInput = z.object({
  kind: z.enum(['personal', 'milestone', 'meeting']),
  projectId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  location: z.string().max(160).optional(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  reminderMinutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]).nullable().optional(),
  participantIds,
}).strict();
const versionSchema = z.object({ version: z.number().int().positive() }).strict();

export function registerCalendarRoutes(app: FastifyInstance, options: {
  service: CalendarService;
  core: CoreRepositories;
  requireAuth: preHandlerHookHandler;
  requireCsrf: preHandlerHookHandler;
}): void {
  const read = { preHandler: [options.requireAuth] };
  const write = { preHandler: [options.requireAuth, options.requireCsrf] };
  const actor = (request: FastifyRequest): AuthContext => {
    if (!request.authContext) throw new AppError('UNAUTHENTICATED');
    return request.authContext;
  };
  const eventId = (request: FastifyRequest): string => z.object({ id: z.string().uuid() }).parse(request.params).id;
  const audit = (request: FastifyRequest): CalendarAuditContext => ({
    requestId: request.id,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  });

  app.get('/api/v1/calendar/participants', read, async (request) => {
    const query = z.object({ search: z.string().trim().max(100).default('') }).strict().parse(request.query);
    const current = actor(request);
    if (!current.permissions.includes('organization:directory:read')) throw new AppError('FORBIDDEN');
    const result = await options.core.users.list({ page: 1, pageSize: 100 });
    const search = query.search.toLocaleLowerCase();
    return { data: result.items.filter((user) => user.status === 'active' && user.deletedAt === null && (user.name.toLocaleLowerCase().includes(search) || user.email.toLocaleLowerCase().includes(search))).slice(0, 50).map((user) => ({ id: user.id, name: user.name })) };
  });
  app.get('/api/v1/calendar/events', read, async (request) => {
    const query = z.object({ from: z.string().datetime(), to: z.string().datetime(), projectId: z.string().uuid().optional() }).strict().parse(request.query);
    return options.service.list(actor(request), query);
  });
  app.post('/api/v1/calendar/events', write, async (request, reply) => {
    const result = await options.service.create(actor(request), eventInput.parse(request.body), audit(request));
    return reply.code(201).send({ data: result.data, conflicts: result.conflicts });
  });
  app.get('/api/v1/calendar/events/:id', read, async (request) => ({ data: await options.service.detail(actor(request), eventId(request)) }));
  app.patch('/api/v1/calendar/events/:id', write, async (request) => {
    const input = eventInput.merge(versionSchema).strict().parse(request.body);
    const { version, ...event } = input;
    const result = await options.service.update(actor(request), eventId(request), version, event, audit(request));
    return { data: result.data, conflicts: result.conflicts };
  });
  app.delete('/api/v1/calendar/events/:id', write, async (request) => {
    await options.service.remove(actor(request), eventId(request), versionSchema.parse(request.body).version, audit(request));
    return { data: { success: true } };
  });
  app.post('/api/v1/calendar/events/:id/response', write, async (request) => {
    const input = versionSchema.extend({ response: z.enum(['accepted', 'declined', 'tentative']) }).strict().parse(request.body);
    return { data: await options.service.respond(actor(request), eventId(request), input.version, input.response, audit(request)) };
  });
}
