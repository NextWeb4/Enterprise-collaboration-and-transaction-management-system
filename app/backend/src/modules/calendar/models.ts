import { z } from 'zod';

const envelope = {
  id: z.string().min(1),
  type: z.string(),
  schemaVersion: z.literal(1),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
};

export const calendarParticipantSchema = z.object({
  userId: z.string().min(1),
  response: z.enum(['pending', 'accepted', 'declined', 'tentative']),
  respondedAt: z.string().datetime().nullable(),
}).strict();

export const calendarEventSchema = z.object({
  ...envelope,
  type: z.literal('calendar_event'),
  ownerId: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  kind: z.enum(['personal', 'milestone', 'meeting']),
  title: z.string().min(1).max(120),
  description: z.string().max(2000),
  location: z.string().max(160),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  reminderMinutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]).nullable(),
  participants: z.array(calendarParticipantSchema).max(50),
}).strict().superRefine((event, context) => {
  if (Date.parse(event.endAt) <= Date.parse(event.startAt)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['endAt'], message: '结束时间必须晚于开始时间' });
  if (event.participants.some((participant) => participant.userId === event.ownerId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['participants'], message: '组织者不能重复作为参与人' });
  if (new Set(event.participants.map((participant) => participant.userId)).size !== event.participants.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['participants'], message: '参与人不能重复' });
  if (event.kind !== 'meeting' && event.participants.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ['participants'], message: '仅会议可以邀请参与人' });
}).readonly();

export const reminderDeliverySchema = z.object({
  ...envelope,
  type: z.literal('calendar_reminder_delivery'),
  deliveryKey: z.string().min(1),
  eventId: z.string().min(1),
  recipientId: z.string().min(1),
}).strict();

export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export type ReminderDelivery = z.infer<typeof reminderDeliverySchema>;
