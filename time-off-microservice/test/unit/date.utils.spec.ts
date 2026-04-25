/**
 * Unit Tests — date.utils
 *
 * Covers every branch of calculateWorkingDays and isValidDateRange.
 */
import { calculateWorkingDays, isValidDateRange } from '../src/utils/date.utils';
describe('calculateWorkingDays', () => {
  // ── Single days ────────────────────────────────────────────────────────────
  it('counts a single Monday as 1 working day', () => {
    expect(calculateWorkingDays('2025-07-07', '2025-07-07')).toBe(1);
  });

  it('counts a single Friday as 1 working day', () => {
    expect(calculateWorkingDays('2025-07-11', '2025-07-11')).toBe(1);
  });

  it('returns 0 for a single Saturday', () => {
    expect(calculateWorkingDays('2025-07-05', '2025-07-05')).toBe(0);
  });

  it('returns 0 for a single Sunday', () => {
    expect(calculateWorkingDays('2025-07-06', '2025-07-06')).toBe(0);
  });

  // ── Full weeks ─────────────────────────────────────────────────────────────
  it('counts Mon–Fri as 5 working days', () => {
    expect(calculateWorkingDays('2025-07-07', '2025-07-11')).toBe(5);
  });

  it('counts Mon–Sun as 5 working days (weekend excluded)', () => {
    expect(calculateWorkingDays('2025-07-07', '2025-07-13')).toBe(5);
  });

  it('counts two full weeks (Mon–Fri × 2) as 10 working days', () => {
    expect(calculateWorkingDays('2025-07-07', '2025-07-18')).toBe(10);
  });

  // ── Weekend-only ranges ────────────────────────────────────────────────────
  it('returns 0 for a Saturday–Sunday range', () => {
    expect(calculateWorkingDays('2025-07-05', '2025-07-06')).toBe(0);
  });

  // ── Cross-month range ──────────────────────────────────────────────────────
  it('handles a range that crosses a month boundary', () => {
    // Mon 28 Jul – Fri 1 Aug 2025 = 5 days
    expect(calculateWorkingDays('2025-07-28', '2025-08-01')).toBe(5);
  });

  // ── Invalid / edge ranges ──────────────────────────────────────────────────
  it('returns 0 when endDate is before startDate', () => {
    expect(calculateWorkingDays('2025-07-11', '2025-07-07')).toBe(0);
  });

  it('returns 0 for same-day weekend (boundary edge)', () => {
    expect(calculateWorkingDays('2025-07-12', '2025-07-12')).toBe(0); // Saturday
  });

  // ── Mid-week start/end ─────────────────────────────────────────────────────
  it('counts Wed–Thu as 2 working days', () => {
    expect(calculateWorkingDays('2025-07-09', '2025-07-10')).toBe(2);
  });

  it('counts Thu–Mon (spanning weekend) as 3 working days', () => {
    expect(calculateWorkingDays('2025-07-10', '2025-07-14')).toBe(3);
  });
});

describe('isValidDateRange', () => {
  it('returns true for a valid forward range', () => {
    expect(isValidDateRange('2025-07-01', '2025-07-05')).toBe(true);
  });

  it('returns true when start and end are the same day', () => {
    expect(isValidDateRange('2025-07-01', '2025-07-01')).toBe(true);
  });

  it('returns false when end is before start', () => {
    expect(isValidDateRange('2025-07-10', '2025-07-01')).toBe(false);
  });

  it('returns false for an invalid start date string', () => {
    expect(isValidDateRange('not-a-date', '2025-07-01')).toBe(false);
  });

  it('returns false for an invalid end date string', () => {
    expect(isValidDateRange('2025-07-01', 'bad')).toBe(false);
  });

  it('returns false when both dates are invalid', () => {
    expect(isValidDateRange('foo', 'bar')).toBe(false);
  });
});
