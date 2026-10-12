import { describe, expect, it } from 'vitest';
import { BackupError, normalizeBackup } from '../src/backup.js';

const base = () => ({
  app: 'Beepstock',
  format: 1,
  locations: [{ id: 1, name: 'Kühlschrank', kind: 'fridge' }, { id: 3, name: 'Vorrat', kind: 'pantry' }],
  stores: [{ id: 2, name: 'Rewe', sort: 1 }],
  products: [
    { barcode: '111111', name: 'Ketchup', location_id: 3, store_id: 2, min_stock: 2, nutriments: { fat: 1 }, categories_tags: ['en:sauces'], image_url: '/img/111111.jpg?v=abc', image_source_url: 'https://images.openfoodfacts.org/x.jpg', image_file: '111111.jpg' },
    { barcode: '222222', name: 'Butter', location_id: 99, store_id: 77 },
  ],
  stock_items: [
    { id: 1, barcode: '111111', status: 'in_stock', best_before: '2027-01-31T00:00:00.000Z', location_id: 3 },
    { id: 2, barcode: '999999', status: 'in_stock' }, // product missing
    { id: 3, barcode: '222222', status: 'wasted', finished_at: '2026-10-01T10:00:00Z', location_id: 42 },
  ],
  shopping_items: [{ id: 5, barcode: '555555', name: 'Milch', qty: 2, store_id: 2 }],
  settings: { expiring_days: 5, bogus: 1, default_mode: 'nonsense' },
});

describe('normalizeBackup', () => {
  it('accepts a valid file and keeps its data', () => {
    const n = normalizeBackup(base());
    expect(n.locations).toHaveLength(2);
    expect(n.products).toHaveLength(2);
    expect(n.products[0]).toMatchObject({ barcode: '111111', min_stock: 2, location_id: 3, store_id: 2 });
    expect(n.stock_items[0]).toMatchObject({ best_before: '2027-01-31' });
  });
  it('still accepts backups made under the old name (PantryScan)', () => {
    expect(normalizeBackup({ ...base(), app: 'PantryScan' }).products).toHaveLength(2);
  });
  it('rejects files that are not a Beepstock backup', () => {
    expect(() => normalizeBackup(null)).toThrow(BackupError);
    expect(() => normalizeBackup([])).toThrow(BackupError);
    expect(() => normalizeBackup({ app: 'Other' })).toThrow(/keine Beepstock/);
    expect(() => normalizeBackup({ app: 'Beepstock', format: 99 })).toThrow(/format/i);
  });
  it('rejects structurally broken tables', () => {
    expect(() => normalizeBackup({ ...base(), products: 'x' })).toThrow(/Liste/);
    expect(() => normalizeBackup({ ...base(), products: [{ name: 'no barcode' }] })).toThrow(/barcode/);
    expect(() => normalizeBackup({ ...base(), locations: [{ id: 1 }] })).toThrow(/name/);
  });
  it('removes dangling references instead of failing', () => {
    const n = normalizeBackup(base());
    const butter = n.products.find((p) => p.barcode === '222222')!;
    expect(butter.location_id).toBeNull();
    expect(butter.store_id).toBeNull();
    expect(n.stock_items.find((s) => s.id === 3)!.location_id).toBeNull();
    expect(n.shopping_items[0]!.barcode).toBeNull(); // unknown product, entry stays
    expect(n.warnings.join(' ')).toMatch(/Verweise/);
  });
  it('skips stock without a product and reports it', () => {
    const n = normalizeBackup(base());
    expect(n.stock_items.map((s) => s.id)).toEqual([1, 3]);
    expect(n.warnings.join(' ')).toMatch(/ohne zugehöriges Produkt/);
  });
  it('does not import cached image paths (the cache is not part of the file)', () => {
    const p = normalizeBackup(base()).products[0]!;
    expect(p.image_url).toBe('https://images.openfoodfacts.org/x.jpg');
    expect(p.image_source_url).toBeNull();
    expect('image_file' in p).toBe(false);
  });
  it('keeps valid settings, drops invalid or unknown ones with a warning', () => {
    const n = normalizeBackup(base());
    expect(n.settings).toEqual({ expiring_days: 5 });
    expect(n.warnings.join(' ')).toMatch(/bogus/);
    expect(n.warnings.join(' ')).toMatch(/default_mode/);
  });
  it('ignores duplicates and clamps hostile values', () => {
    const n = normalizeBackup({ ...base(), products: [...base().products, { barcode: '111111', name: 'dup' }, { barcode: '333333', name: 'x'.repeat(5000), min_stock: 99999, status: 'x' }] });
    expect(n.products.filter((p) => p.barcode === '111111')).toHaveLength(1);
    expect((n.products.find((p) => p.barcode === '333333')!.name as string).length).toBe(300);
    expect(n.products.find((p) => p.barcode === '333333')!.min_stock).toBe(0);
  });
  it('treats missing tables as empty', () => {
    expect(normalizeBackup({ app: 'Beepstock' }).products).toEqual([]);
  });
});
