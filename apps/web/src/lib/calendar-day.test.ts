import { describe, expect, it } from 'vitest';
import { calendarDay, untilNextDay } from './calendar-day.js';

describe('reader calendar day', () => {
  it('uses local midnight, including month and year rollover', () => {
    const before = new Date(2026, 11, 31, 23, 59, 59, 900);
    expect(calendarDay(before)).toBe('2026-12-31');
    expect(untilNextDay(before)).toBe(100);
    expect(calendarDay(new Date(before.getTime() + 100))).toBe('2027-01-01');
  });
  it('schedules the next calendar midnight instead of adding 24 hours', () => {
    const now = new Date(2026, 2, 8, 0, 0);
    const next = new Date(now.getTime() + untilNextDay(now));
    expect(calendarDay(next)).toBe('2026-03-09');
    expect(next.getHours()).toBe(0);
  });
});
