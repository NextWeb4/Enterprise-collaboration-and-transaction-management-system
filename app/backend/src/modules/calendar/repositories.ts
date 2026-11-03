import { BaseRepository, type Repository } from '../../storage/repository.js';
import type { StorageEngine } from '../../storage/engine.js';
import type { SchemaRegistry } from '../../storage/schema-registry.js';
import { systemClock } from '../../shared/clock.js';
import type { CalendarEvent, ReminderDelivery } from './models.js';
import { calendarEventSchema, reminderDeliverySchema } from './models.js';
import { createSharedRecordRepositories, type SharedNotification } from '../core/shared-records.js';

export interface CalendarRepositories {
  readonly events: Repository<CalendarEvent>;
  readonly reminders: Repository<ReminderDelivery>;
  readonly notifications: Repository<SharedNotification>;
}

export function createCalendarRepositories(engine: StorageEngine, registry: SchemaRegistry): CalendarRepositories {
  const events = new BaseRepository<CalendarEvent>({
    store: 'events', type: 'calendar_event', schemaVersion: 1, schema: calendarEventSchema, clock: systemClock,
    indexes: [
      { name: 'idx_calendar_events_owner', source: 'events', unique: false, indexKeys: (event) => [event.ownerId] },
      { name: 'idx_calendar_events_project', source: 'events', unique: false, indexKeys: (event) => event.projectId ? [event.projectId] : [] },
      { name: 'idx_calendar_events_start', source: 'events', unique: false, indexKeys: (event) => [event.startAt] },
    ],
  }, registry, engine);
  const reminders = new BaseRepository<ReminderDelivery>({
    store: 'event_reminders', type: 'calendar_reminder_delivery', schemaVersion: 1, schema: reminderDeliverySchema, clock: systemClock,
    indexes: [{ name: 'idx_calendar_reminder_delivery_key', source: 'event_reminders', unique: true, indexKeys: (reminder) => [reminder.deliveryKey] }],
  }, registry, engine);
  return { events, reminders, notifications: createSharedRecordRepositories(engine, registry).notifications };
}
