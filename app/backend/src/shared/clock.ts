/** 时间注入：测试用 FakeClock 控制会话过期/编辑窗口等（docs/04-development/testing-strategy.md §4） */
export interface Clock {
  now(): Date;
  nowIso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowIso(): string {
    return this.now().toISOString();
  }
}

export const systemClock: Clock = new SystemClock();

export class FakeClock implements Clock {
  private current: Date;

  constructor(startIso: string) {
    this.current = new Date(startIso);
  }

  now(): Date {
    return this.current;
  }

  nowIso(): string {
    return this.current.toISOString();
  }

  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}
