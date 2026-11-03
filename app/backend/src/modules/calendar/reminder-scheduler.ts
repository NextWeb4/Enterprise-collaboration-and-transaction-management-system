export interface ReminderSchedulerLogger {
  error(details: { err: unknown }, message: string): void;
}

export interface ReminderSchedulerTimers {
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export interface ReminderScheduler {
  start(): void;
  stop(): void;
}

const defaultTimers: ReminderSchedulerTimers = {
  setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
  clearInterval: (handle) => globalThis.clearInterval(handle),
};

/** Runs reminder delivery in the single application process without overlap. */
export function createCalendarReminderScheduler(
  deliver: () => Promise<number>,
  logger: ReminderSchedulerLogger,
  intervalMs = 60_000,
  timers: ReminderSchedulerTimers = defaultTimers,
): ReminderScheduler {
  let handle: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await deliver();
    } catch (error) {
      logger.error({ err: error }, 'calendar reminder delivery failed; the next tick will retry');
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (handle) return;
      stopped = false;
      void tick();
      handle = timers.setInterval(() => {
        void tick();
      }, intervalMs);
      handle.unref?.();
    },
    stop(): void {
      stopped = true;
      if (handle) timers.clearInterval(handle);
      handle = null;
    },
  };
}
