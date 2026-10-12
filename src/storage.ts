/**
 * Derives where a product is usually kept (fridge / freezer / pantry) from Open *Facts data:
 * category tags (e.g. "en:frozen-foods", "en:dairies") and the free-text storage hint
 * ("conservation_conditions"). This is a heuristic: the result is a default that the user can change per product.
 */

export type Kind = 'fridge' | 'freezer' | 'pantry' | 'other';
export const KINDS: Kind[] = ['fridge', 'freezer', 'pantry', 'other'];

/** Guesses the type of a user-defined storage location from its name (Kühlschrank, Tiefkühler, Vorratsschrank, ...). */
export function guessKindFromName(name: string): Kind {
  const n = name.toLowerCase();
  if (/tief|gefrier|froster|freezer|eis(?!en)/.test(n)) return 'freezer'; // first: "Tiefkühler" also contains "kühl"
  if (/k(ü|ue|u)hl/.test(n)) return 'fridge';
  if (/vorrat|speisekammer|schrank|regal|pantry/.test(n)) return 'pantry';
  return 'other';
}

export interface DeriveInput {
  tags: string[] | null;
  conservation: string | null;
  /** off | obf | opf | opff */
  source: string | null;
}

export interface Derived {
  kind: 'fridge' | 'freezer' | 'pantry' | null;
  /** pantry item that should move to the fridge once opened (ketchup yes, rice no) */
  moveOnOpen: boolean;
  reason: string;
}

const FROZEN_TAG = /(^|:)(frozen|frozen-foods|frozen-.+|ice-creams?|ice-cream-and-sorbets|surgeles?|tiefgekuehlt.*)$/;
const PANTRY_OVERRIDE_TAG = /canned|preserved|dried|dehydrated|shelf-stable|uht|long-life|appertized|jarred|pickled|sterilized/;
const FRIDGE_TAG = /(^|:)(dairies|milks|yogh?urts|cheeses|butters|creams|fermented-milk-products|dairy-desserts|meats|prepared-meats|sausages|poultries|fishes|seafood|eggs|fresh-foods|fresh-.+|chilled-.+|delicatessen|tofu|hummus|spreadable-fats|fresh-pastas?)$/;
const DRY_TAG = /pasta|rice|flour|cereal|sugar|spice|salt|chocolate|biscuit|cookie|snack|coffee|(^|:)tea|legume|noodle|crisp|nut|candy|confection|bread-?crumb|(^|:)oils?$/;

export function deriveStorage(i: DeriveInput): Derived {
  const tags = (i.tags ?? []).map((t) => t.toLowerCase());
  const has = (re: RegExp) => tags.some((t) => re.test(t));
  const text = (i.conservation ?? '').toLowerCase().replace(/nicht\s+(wieder\s+)?(ein)?frier\w*|do not (re)?freeze/g, '');
  const moveOnOpen = !has(DRY_TAG);

  if (i.source && i.source !== 'off') return { kind: 'pantry', moveOnOpen: false, reason: 'Drogerie/Haushalt/Tierfutter' };

  if (has(FROZEN_TAG) || /tiefgek|tiefk(ü|ue)hl|gefrier|frozen|surgel|[-−–]\s?18\s?°/.test(text)) {
    return { kind: 'freezer', moveOnOpen: false, reason: 'tiefgekühlt' };
  }
  // "ungeöffnet trocken lagern, nach dem Öffnen kühlen" -> pantry now, fridge once opened
  if (/(nach\s+(dem\s+)?(öffnen|oeffnen|anbruch)|nach\s+geöffnet|after\s+opening|once\s+opened)[^.]*?(k(ü|ue)hl|gek(ü|ue)hlt|refrigerat|\+?\s?[1-9]\s?°)/.test(text)) {
    return { kind: 'pantry', moveOnOpen: true, reason: 'nach dem Öffnen kühlen' };
  }
  const coolDry = /k(ü|ue)hl\s*(,|und)?\s*(und\s+)?trocken|trocken\s*(,|und)?\s*(und\s+)?k(ü|ue)hl|cool\s*(,|and)?\s*dry|dunkel/.test(text);
  if (!coolDry && /(k(ü|ue)hl|gek(ü|ue)hlt|refrigerat|\+\s?[1-9]\s?°|bei\s+max\.?\s*\+?\s?\d+\s?°)/.test(text)) {
    return { kind: 'fridge', moveOnOpen: false, reason: 'Lagerhinweis: kühl' };
  }
  if (has(PANTRY_OVERRIDE_TAG)) return { kind: 'pantry', moveOnOpen, reason: 'haltbar (Konserve/getrocknet/UHT)' };
  if (has(FRIDGE_TAG)) return { kind: 'fridge', moveOnOpen: false, reason: 'Kategorie: Frischware' };
  if (tags.length > 0 || text) return { kind: 'pantry', moveOnOpen, reason: 'Standard: Vorrat' };
  return { kind: null, moveOnOpen: true, reason: 'keine Daten' };
}
