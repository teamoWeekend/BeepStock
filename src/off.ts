import { config } from './config.js';
import { getSettings } from './settings.js';

export interface OffProduct {
  name: string;
  brand: string | null;
  quantity_text: string | null;
  categories: string | null;
  image_url: string | null;
  nutriscore: string | null;
  nova_group: number | null;
  ecoscore: string | null;
  nutriments: Record<string, number | string>;
  ingredients: string | null;
  allergens: string | null;
  serving_size: string | null;
  source: string; // off | obf | opf | opff
  categories_tags: string[];
  conservation: string | null;
}

export type OffResult = { status: 'found'; product: OffProduct } | { status: 'not_found' } | { status: 'error'; error: string };

const FIELDS = [
  'code',
  'product_name',
  'product_name_de',
  'generic_name_de',
  'brands',
  'quantity',
  'categories',
  'categories_tags',
  'conservation_conditions',
  'conservation_conditions_de',
  'image_front_small_url',
  'image_front_url',
  'nutriscore_grade',
  'nova_group',
  'ecoscore_grade',
  'nutriments',
  'ingredients_text_de',
  'ingredients_text',
  'allergens_tags',
  'serving_size',
].join(',');

// Nutriment keys worth keeping (per 100 g/ml); the rest of the huge OFF blob is dropped.
const NUTRIENT_KEYS = [
  'energy-kcal',
  'energy-kj',
  'fat',
  'saturated-fat',
  'carbohydrates',
  'sugars',
  'fiber',
  'proteins',
  'salt',
  'sodium',
];

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function mapOff(p: any, source = 'off'): OffProduct | null {
  if (!p || typeof p !== 'object') return null;
  const name = clean(p.product_name_de) ?? clean(p.product_name) ?? clean(p.generic_name_de);
  const brand = clean(p.brands)?.split(',')[0]?.trim() ?? null;
  if (!name && !brand) return null;
  const n = p.nutriments ?? {};
  const nutriments: Record<string, number | string> = {};
  for (const k of NUTRIENT_KEYS) {
    const v = n[`${k}_100g`];
    if (typeof v === 'number' && Number.isFinite(v)) nutriments[k] = v;
  }
  if (typeof n['energy-kcal_unit'] === 'string') nutriments['energy-kcal_unit'] = n['energy-kcal_unit'];
  const grade = (v: unknown) => (typeof v === 'string' && /^[a-e]$/i.test(v) ? v.toLowerCase() : null);
  const allergens = Array.isArray(p.allergens_tags)
    ? p.allergens_tags.map((a: string) => a.replace(/^[a-z]{2}:/, '')).join(', ')
    : null;
  const nova = typeof p.nova_group === 'number' ? p.nova_group : parseInt(p.nova_group ?? '', 10);
  return {
    name: name ?? brand ?? 'Unbenannt',
    brand,
    quantity_text: clean(p.quantity),
    categories: clean(p.categories),
    image_url: clean(p.image_front_small_url) ?? clean(p.image_front_url),
    nutriscore: grade(p.nutriscore_grade),
    nova_group: Number.isFinite(nova) ? nova : null,
    ecoscore: grade(p.ecoscore_grade),
    nutriments,
    ingredients: clean(p.ingredients_text_de) ?? clean(p.ingredients_text),
    allergens: allergens || null,
    serving_size: clean(p.serving_size),
    source,
    categories_tags: Array.isArray(p.categories_tags) ? p.categories_tags.filter((t: unknown) => typeof t === 'string').slice(0, 60) : [],
    conservation: clean(p.conservation_conditions_de) ?? clean(p.conservation_conditions),
  };
}

export const SOURCE_LABEL: Record<string, string> = {
  off: 'Open Food Facts',
  obf: 'Open Beauty Facts',
  opf: 'Open Products Facts',
  opff: 'Open Pet Food Facts',
};

function sourceBase(id: string): string | null {
  switch (id) {
    case 'off': return config.offBase;
    case 'obf': return config.obfBase;
    case 'opf': return config.opfBase;
    case 'opff': return config.opffBase;
    default: return null;
  }
}

async function fetchOne(id: string, base: string, barcode: string): Promise<OffResult> {
  const candidates = [barcode];
  if (barcode.length === 13 && barcode.startsWith('0')) candidates.push(barcode.slice(1));
  try {
    for (const code of candidates) {
      const url = `${base}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': config.offUserAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) continue;
      if (!res.ok) return { status: 'error', error: `${SOURCE_LABEL[id] ?? id}: HTTP ${res.status}` };
      const body: any = await res.json();
      if (body?.status !== 1) continue;
      const product = mapOff(body.product, id);
      if (product) return { status: 'found', product };
    }
    return { status: 'not_found' };
  } catch (e) {
    return { status: 'error', error: `${SOURCE_LABEL[id] ?? id}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Asks the configured databases one after another (food, cosmetics/drugstore, general products, pet food). */
export async function fetchOff(barcode: string): Promise<OffResult> {
  let firstError: string | null = null;
  for (const id of (await getSettings()).lookup_sources) {
    const base = sourceBase(id);
    if (!base) continue;
    const r = await fetchOne(id, base, barcode);
    if (r.status === 'found') return r;
    if (r.status === 'error' && !firstError) firstError = r.error;
  }
  // only report an error when nothing was found AND a source could not be reached
  return firstError ? { status: 'error', error: firstError } : { status: 'not_found' };
}
