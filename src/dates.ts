/** Date helpers. All dates are local calendar dates formatted YYYY-MM-DD. */

export function fmt(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function today(now = new Date()): string {
  return fmt(now);
}

export function addDays(base: Date, n: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

export function addMonths(base: Date, n: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

export function isValidYmd(y: number, m: number, d: number): boolean {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function ymd(y: number, m: number, d: number): string | null {
  return isValidYmd(y, m, d) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
}

/**
 * Interprets a digit sequence typed via the number-pad control codes:
 *  1-3 digits  -> days from today
 *  4 digits    -> DDMM (next occurrence, today allowed)
 *  6 digits    -> DDMMYY
 *  8 digits    -> DDMMYYYY (YYYYMMDD is accepted when it starts with 20)
 */
export function interpretDigits(digits: string, now = new Date()): string | null {
  if (!/^\d+$/.test(digits)) return null;
  const n = digits.length;
  if (n >= 1 && n <= 3) return fmt(addDays(now, parseInt(digits, 10)));
  if (n === 4) {
    const dd = parseInt(digits.slice(0, 2), 10);
    const mm = parseInt(digits.slice(2), 10);
    const thisYear = ymd(now.getFullYear(), mm, dd);
    if (thisYear && thisYear >= today(now)) return thisYear;
    return ymd(now.getFullYear() + 1, mm, dd);
  }
  if (n === 6) return ymd(2000 + parseInt(digits.slice(4), 10), parseInt(digits.slice(2, 4), 10), parseInt(digits.slice(0, 2), 10));
  if (n === 8) {
    if (digits.startsWith('20')) {
      const iso = ymd(parseInt(digits.slice(0, 4), 10), parseInt(digits.slice(4, 6), 10), parseInt(digits.slice(6), 10));
      if (iso) return iso;
    }
    return ymd(parseInt(digits.slice(4), 10), parseInt(digits.slice(2, 4), 10), parseInt(digits.slice(0, 2), 10));
  }
  return null;
}
