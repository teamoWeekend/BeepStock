import { addDays, addMonths, fmt, interpretDigits, ymd } from './dates.js';

export type Mode = 'add' | 'consume' | 'open' | 'waste' | 'shop' | 'info' | 'count';
export const MODES: Mode[] = ['add', 'consume', 'open', 'waste', 'shop', 'info', 'count'];

export type Control =
  | { type: 'mode'; mode: Mode }
  | { type: 'date'; date: string; label: string }
  | { type: 'digit'; digit: string }
  | { type: 'digits-ok' }
  | { type: 'digits-clear' }
  | { type: 'location'; id: number }
  | { type: 'qty'; qty: number }
  | { type: 'undo' }
  | { type: 'clear' };

/**
 * Control barcodes use only letters/digits without Y and Z, so they survive
 * keyboard-layout mismatches (QWERTZ vs QWERTY) on HID scanners.
 *
 *   PCADD PCCONSUME PCOPEN PCWASTE PCSHOP PCINFO PCINV   modes (PCINV = inventory count)
 *   PCLOC<id>                                       storage location (sticky until another one is scanned)
 *   PCD3  PCW2  PCM1  PCJ1                          best-before = today +3 days / +2 weeks / +1 month / +1 year;
 *   PCT20261231                                     fixed date (YYYYMMDD); both applied to the item(s) just added
 *   PCN0..PCN9 PCNOK PCNCLR                         number pad (days, DDMM, DDMMYY, DDMMYYYY)
 *   PCQ2                                            quantity for the next scan
 *   PCUNDO PCCLEAR                                  undo last action / reset pending quantity
 */
export const CONTROL_PREFIX = 'PC';

const MODE_CODES: Record<string, Mode> = {
  PCADD: 'add',
  PCCONSUME: 'consume',
  PCOPEN: 'open',
  PCWASTE: 'waste',
  PCSHOP: 'shop',
  PCINFO: 'info',
  PCINV: 'count',
};

export function parseControl(raw: string, now = new Date()): Control | null {
  const code = raw.trim().toUpperCase();
  if (!code.startsWith(CONTROL_PREFIX)) return null;
  const mode = MODE_CODES[code];
  if (mode) return { type: 'mode', mode };
  if (code === 'PCUNDO') return { type: 'undo' };
  if (code === 'PCCLEAR') return { type: 'clear' };
  if (code === 'PCNOK') return { type: 'digits-ok' };
  if (code === 'PCNCLR') return { type: 'digits-clear' };

  let m = /^PCLOC(\d{1,6})$/.exec(code);
  if (m) return { type: 'location', id: parseInt(m[1]!, 10) };

  m = /^PCN(\d)$/.exec(code);
  if (m) return { type: 'digit', digit: m[1]! };

  m = /^PCQ(\d{1,2})$/.exec(code);
  if (m) {
    const qty = parseInt(m[1]!, 10);
    return qty >= 1 ? { type: 'qty', qty } : null;
  }

  m = /^PC([DWMJ])(\d{1,3})$/.exec(code);
  if (m) {
    const n = parseInt(m[2]!, 10);
    const unit = m[1]!;
    const d =
      unit === 'D' ? addDays(now, n) : unit === 'W' ? addDays(now, n * 7) : unit === 'M' ? addMonths(now, n) : addMonths(now, n * 12);
    const unitLabel = { D: 'Tag(e)', W: 'Woche(n)', M: 'Monat(e)', J: 'Jahr(e)' }[unit];
    return { type: 'date', date: fmt(d), label: `+${n} ${unitLabel}` };
  }

  m = /^PCT(\d{8})$/.exec(code);
  if (m) {
    const s = m[1]!;
    const iso = ymd(parseInt(s.slice(0, 4), 10), parseInt(s.slice(4, 6), 10), parseInt(s.slice(6), 10));
    return iso ? { type: 'date', date: iso, label: iso } : null;
  }
  return null;
}

export function resolveDigits(digits: string, now = new Date()): string | null {
  return interpretDigits(digits, now);
}

/** Normalises product barcodes: digits only, UPC-A (12) padded to EAN-13. */
export function normalizeBarcode(raw: string): string | null {
  const digits = raw.trim().replace(/\s+/g, '');
  if (!/^\d{6,14}$/.test(digits)) return null;
  return digits.length === 12 ? `0${digits}` : digits;
}

export type SheetGroup = { key: 'location' | 'mode' | 'date' | 'digits' | 'misc'; group: string; items: { code: string; label: string }[] };

export function controlSheet(locations: { id: number; name: string }[]): SheetGroup[] {
  return [
    {
      key: 'location',
      group: 'Lagerort (gilt für alle folgenden Produkte, bis ein anderer gescannt wird)',
      items: locations.map((l) => ({ code: `PCLOC${l.id}`, label: l.name })),
    },
    ...STATIC_SHEET,
  ];
}

const STATIC_SHEET: SheetGroup[] = [
  {
    key: 'mode',
    group: 'Modus',
    items: [
      { code: 'PCADD', label: 'Einlagern' },
      { code: 'PCCONSUME', label: 'Verbrauchen' },
      { code: 'PCOPEN', label: 'Anbrechen' },
      { code: 'PCWASTE', label: 'Wegwerfen' },
      { code: 'PCSHOP', label: 'Auf Einkaufsliste' },
      { code: 'PCINFO', label: 'Nur Info' },
      { code: 'PCINV', label: 'Inventur' },
    ],
  },
  {
    key: 'date',
    group: 'MHD relativ (optional, direkt NACH dem Produkt scannen)',
    items: [
      { code: 'PCD1', label: 'Heute + 1 Tag' },
      { code: 'PCD2', label: 'Heute + 2 Tage' },
      { code: 'PCD3', label: 'Heute + 3 Tage' },
      { code: 'PCD5', label: 'Heute + 5 Tage' },
      { code: 'PCD7', label: 'Heute + 7 Tage' },
      { code: 'PCW2', label: 'Heute + 2 Wochen' },
      { code: 'PCW4', label: 'Heute + 4 Wochen' },
      { code: 'PCM3', label: 'Heute + 3 Monate' },
      { code: 'PCM6', label: 'Heute + 6 Monate' },
      { code: 'PCJ1', label: 'Heute + 1 Jahr' },
    ],
  },
  {
    key: 'digits',
    group: 'MHD eintippen (Ziffern, dann OK)',
    items: [
      ...'0123456789'.split('').map((d) => ({ code: `PCN${d}`, label: d })),
      { code: 'PCNOK', label: 'OK' },
      { code: 'PCNCLR', label: 'Löschen' },
    ],
  },
  {
    key: 'misc',
    group: 'Sonstiges',
    items: [
      { code: 'PCQ2', label: 'Menge x2' },
      { code: 'PCQ3', label: 'Menge x3' },
      { code: 'PCQ4', label: 'Menge x4' },
      { code: 'PCQ6', label: 'Menge x6' },
      { code: 'PCUNDO', label: 'Rückgängig' },
      { code: 'PCCLEAR', label: 'Menge zurücksetzen' },
    ],
  },
];
