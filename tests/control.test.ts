import { describe, expect, it } from 'vitest';
import { normalizeBarcode, parseControl, resolveDigits } from '../src/control.js';
import { interpretDigits } from '../src/dates.js';
import { mapOff } from '../src/off.js';

const NOW = new Date(2026, 9, 11); // 2026-10-11

describe('parseControl', () => {
  it('parses modes', () => {
    expect(parseControl('PCADD')).toEqual({ type: 'mode', mode: 'add' });
    expect(parseControl('pcconsume')).toEqual({ type: 'mode', mode: 'consume' });
  });
  it('plus 3 days', () => {
    expect(parseControl('PCD3', NOW)).toMatchObject({ type: 'date', date: '2026-10-14' });
  });
  it('weeks, months, years', () => {
    expect(parseControl('PCW2', NOW)).toMatchObject({ date: '2026-10-25' });
    expect(parseControl('PCM1', NOW)).toMatchObject({ date: '2026-11-11' });
    expect(parseControl('PCJ1', NOW)).toMatchObject({ date: '2027-10-11' });
  });
  it('month end clamps', () => {
    expect(parseControl('PCM1', new Date(2026, 0, 31))).toMatchObject({ date: '2026-02-28' });
  });
  it('fixed date, rejects invalid', () => {
    expect(parseControl('PCT20261231')).toMatchObject({ date: '2026-12-31' });
    expect(parseControl('PCT20261331')).toBeNull();
  });
  it('digits and qty', () => {
    expect(parseControl('PCN7')).toEqual({ type: 'digit', digit: '7' });
    expect(parseControl('PCQ3')).toEqual({ type: 'qty', qty: 3 });
    expect(parseControl('PCQ0')).toBeNull();
  });
  it('inventory mode', () => {
    expect(parseControl('PCINV')).toEqual({ type: 'mode', mode: 'count' });
  });
  it('locations', () => {
    expect(parseControl('PCLOC2')).toEqual({ type: 'location', id: 2 });
    expect(parseControl('PCLOC')).toBeNull();
  });
  it('ignores normal barcodes and garbage', () => {
    expect(parseControl('4006381333931')).toBeNull();
    expect(parseControl('PCFOO')).toBeNull();
  });
});

describe('digit date entry', () => {
  it('days', () => expect(interpretDigits('3', NOW)).toBe('2026-10-14'));
  it('DDMM picks next occurrence', () => {
    expect(interpretDigits('2412', NOW)).toBe('2026-12-24');
    expect(interpretDigits('0103', NOW)).toBe('2027-03-01');
  });
  it('DDMMYY and DDMMYYYY', () => {
    expect(resolveDigits('241226', NOW)).toBe('2026-12-24');
    expect(resolveDigits('24122026', NOW)).toBe('2026-12-24');
  });
  it('invalid', () => {
    expect(interpretDigits('3113', NOW)).toBeNull();
    expect(interpretDigits('12345', NOW)).toBeNull();
    expect(interpretDigits('', NOW)).toBeNull();
  });
});

describe('normalizeBarcode', () => {
  it('pads UPC-A', () => expect(normalizeBarcode('036000291452')).toBe('0036000291452'));
  it('keeps EAN-13 / EAN-8', () => {
    expect(normalizeBarcode('4006381333931')).toBe('4006381333931');
    expect(normalizeBarcode('40170725')).toBe('40170725');
  });
  it('rejects non-numeric / too short', () => {
    expect(normalizeBarcode('abc')).toBeNull();
    expect(normalizeBarcode('123')).toBeNull();
  });
});

describe('mapOff', () => {
  it('maps German name and nutriments', () => {
    const p = mapOff({
      product_name: 'Hazelnut spread',
      product_name_de: 'Nuss-Nugat-Creme',
      brands: 'Ferrero,Nutella',
      nutriscore_grade: 'e',
      nova_group: 4,
      nutriments: { 'energy-kcal_100g': 539, sugars_100g: 56.3, junk_100g: 1 },
      allergens_tags: ['en:milk', 'en:nuts'],
    });
    expect(p?.name).toBe('Nuss-Nugat-Creme');
    expect(p?.brand).toBe('Ferrero');
    expect(p?.nutriscore).toBe('e');
    expect(p?.nutriments).toEqual({ 'energy-kcal': 539, sugars: 56.3 });
    expect(p?.allergens).toBe('milk, nuts');
  });
  it('returns null for empty products', () => {
    expect(mapOff({})).toBeNull();
    expect(mapOff(null)).toBeNull();
  });
});
