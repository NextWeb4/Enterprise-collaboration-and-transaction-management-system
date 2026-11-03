import { describe, expect, it, vi } from 'vitest';
import { createCalendarReminderScheduler } from '../src/modules/calendar/reminder-scheduler.js';

describe('calendar reminder scheduler', () => {
  it('runs immediately, prevents overlapping delivery, retries on the next interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      let resolveFirst: (() => void) | undefined;
      const deliver = vi
        .fn<() => Promise<number>>()
        .mockImplementationOnce(
          () =>
            new Promise<number>((resolve) => {
              resolveFirst = () => resolve(0);
            }),
        )
        .mockRejectedValueOnce(new Error('temporary storage failure'))
        .mockResolvedValue(1);
      const logger = { error: vi.fn() };
      const scheduler = createCalendarReminderScheduler(deliver, logger, 60_000);

      scheduler.start();
      expect(deliver).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(deliver).toHaveBeenCalledTimes(1);

      resolveFirst?.();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deliver).toHaveBeenCalledTimes(2);
      await vi.runAllTicks();
      expect(logger.error).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(deliver).toHaveBeenCalledTimes(3);
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(deliver).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
