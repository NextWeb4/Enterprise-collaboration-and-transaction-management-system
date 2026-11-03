import { describe, expect, it } from 'vitest';
import { greetingForTime } from './greeting';

describe('greetingForTime', () => {
  it.each([
    [0, '晚上好'], [4, '晚上好'], [5, '早上好'], [10, '早上好'],
    [11, '中午好'], [12, '中午好'], [13, '下午好'], [17, '下午好'],
    [18, '晚上好'], [23, '晚上好'],
  ])('uses the local hour %i to show %s', (hour, expected) => {
    expect(greetingForTime(new Date(2026, 10, 2, hour))).toBe(expected);
  });
});
