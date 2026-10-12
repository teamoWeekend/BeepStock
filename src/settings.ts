import { config } from './config.js';
import { MODES, type Mode } from './control.js';
import { q } from './db.js';

/**
 * Settings that can be changed in the UI. Stored in the `settings` table; the environment variables
 * (config.ts) only provide the defaults, so nothing breaks when the table is empty.
 */
export interface AppSettings {
  /** scan mode the app falls back to after `mode_idle_minutes` without a scan */
  default_mode: Mode;
  /** 0 = never fall back */
  mode_idle_minutes: number;
  /** a pending quantity / typed digits expire after this many minutes */
  pending_minutes: number;
  /** "expires soon" threshold in days (dashboard, stock filter, colours) */
  expiring_days: number;
  /** product databases to ask, in this order: off, obf, opf, opff */
  lookup_sources: string[];
  /** put a product on the shopping list when wasting it drops the stock below its minimum */
  restock_on_waste: boolean;
  /** keep a local copy of product images instead of loading them from the Open *Facts servers each time */
  cache_images: boolean;
}

export const SOURCE_IDS = ['off', 'obf', 'opf', 'opff'] as const;
export const SOURCE_TITLES: Record<string, string> = {
  off: 'Open Food Facts (Lebensmittel)',
  obf: 'Open Beauty Facts (Kosmetik, Drogerie)',
  opf: 'Open Products Facts (Haushalt, Sonstiges)',
  opff: 'Open Pet Food Facts (Tierfutter)',
};

export function defaultSettings(): AppSettings {
  return {
    default_mode: MODES.includes(config.defaultMode as Mode) ? (config.defaultMode as Mode) : 'consume',
    mode_idle_minutes: Math.max(0, config.modeIdleMinutes || 0),
    pending_minutes: Math.max(1, config.pendingMinutes || 10),
    expiring_days: 3,
    lookup_sources: config.lookupSources.filter((s) => (SOURCE_IDS as readonly string[]).includes(s)),
    restock_on_waste: true,
    cache_images: true,
  };
}

/** Validates one value; throws an Error with a user-readable message. */
function clean(key: keyof AppSettings, v: unknown): AppSettings[keyof AppSettings] {
  const intIn = (min: number, max: number, label: string) => {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: ganze Zahl von ${min} bis ${max}`);
    return n;
  };
  switch (key) {
    case 'default_mode':
      if (!MODES.includes(v as Mode)) throw new Error('Standard-Modus unbekannt');
      return v as Mode;
    case 'mode_idle_minutes': return intIn(0, 1440, 'Leerlauf (Minuten)');
    case 'pending_minutes': return intIn(1, 240, 'Verfall von MHD/Menge (Minuten)');
    case 'expiring_days': return intIn(0, 60, '„Läuft bald ab“ (Tage)');
    case 'restock_on_waste':
    case 'cache_images': return !!v;
    case 'lookup_sources': {
      if (!Array.isArray(v)) throw new Error('Produktdatenbanken: Liste erwartet');
      const list = [...new Set(v.map(String))].filter((s) => (SOURCE_IDS as readonly string[]).includes(s));
      if (!list.length) throw new Error('Mindestens eine Produktdatenbank muss aktiv sein');
      return list;
    }
  }
}

let cache: { at: number; value: AppSettings } | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

/** For imports: keeps the valid known settings of a file and reports the rest. */
export function sanitizeSettings(raw: unknown): { values: Record<string, unknown>; warnings: string[] } {
  const values: Record<string, unknown> = {};
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { values, warnings };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { values, warnings: ['Einstellungen: Objekt erwartet, ignoriert'] };
  const known = Object.keys(defaultSettings());
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.includes(k)) { warnings.push(`Einstellung „${k}“ unbekannt, ignoriert`); continue; }
    try {
      values[k] = clean(k as keyof AppSettings, v);
    } catch (e) {
      warnings.push(`Einstellung „${k}“ ungültig (${e instanceof Error ? e.message : 'Fehler'}), Vorgabe bleibt`);
    }
  }
  return { values, warnings };
}

export async function getSettings(): Promise<AppSettings> {
  if (cache && Date.now() - cache.at < 3000) return cache.value;
  const value = defaultSettings();
  try {
    const rows = await q<{ key: string; value: unknown }>('SELECT key, value FROM settings');
    for (const r of rows) {
      if (r.key in value) {
        try {
          (value as unknown as Record<string, unknown>)[r.key] = clean(r.key as keyof AppSettings, r.value);
        } catch {
          /* ignore a corrupt stored value, keep the default */
        }
      }
    }
  } catch {
    /* table missing during startup: defaults */
  }
  cache = { at: Date.now(), value };
  return value;
}

export async function updateSettings(patch: Record<string, unknown>): Promise<AppSettings> {
  const keys = Object.keys(defaultSettings()) as (keyof AppSettings)[];
  const entries: [string, unknown][] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!keys.includes(k as keyof AppSettings)) throw new Error(`Unbekannte Einstellung: ${k}`);
    entries.push([k, clean(k as keyof AppSettings, v)]);
  }
  for (const [k, v] of entries) {
    await q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`, [k, JSON.stringify(v)]);
  }
  cache = null;
  return getSettings();
}
