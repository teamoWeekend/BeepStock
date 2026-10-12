import { describe, expect, it } from 'vitest';
import { deriveStorage, guessKindFromName } from '../src/storage.js';

const d = (tags: string[] | null, conservation: string | null = null, source: string | null = 'off') => deriveStorage({ tags, conservation, source });

describe('deriveStorage', () => {
  it('frozen category -> freezer', () => {
    expect(d(['en:frozen-foods', 'en:pizzas']).kind).toBe('freezer');
    expect(d(['en:ice-creams']).kind).toBe('freezer');
  });
  it('frozen by storage text', () => {
    expect(d([], 'Bei -18 °C lagern').kind).toBe('freezer');
    expect(d([], 'Tiefgekühlt lagern. Nach dem Auftauen nicht wieder einfrieren.').kind).toBe('freezer');
  });
  it('"do not freeze" alone is not a freezer hint', () => {
    expect(d(['en:sauces'], 'Nicht einfrieren.').kind).toBe('pantry');
  });
  it('fresh dairy/meat -> fridge', () => {
    expect(d(['en:dairies', 'en:yogurts']).kind).toBe('fridge');
    expect(d(['en:meats', 'en:sausages']).kind).toBe('fridge');
    expect(d(['en:plant-based-foods', 'en:fresh-foods']).kind).toBe('fridge');
  });
  it('shelf-stable dairy/fish stays in the pantry', () => {
    expect(d(['en:dairies', 'en:uht-milks']).kind).toBe('pantry');
    expect(d(['en:fishes', 'en:canned-fishes']).kind).toBe('pantry');
  });
  it('sauces and condiments: pantry, move to fridge when opened', () => {
    const r = d(['en:condiments', 'en:sauces', 'en:ketchup']);
    expect(r).toMatchObject({ kind: 'pantry', moveOnOpen: true });
  });
  it('dry goods: pantry and stay there when opened', () => {
    expect(d(['en:pastas', 'en:cereals-and-potatoes'])).toMatchObject({ kind: 'pantry', moveOnOpen: false });
    expect(d(['en:confectionary-based-spreads'])).toMatchObject({ kind: 'pantry', moveOnOpen: false });
  });
  it('"after opening keep cool" -> pantry now, fridge after opening', () => {
    expect(d(['en:dairies'], 'Ungeöffnet bei Raumtemperatur. Nach dem Öffnen kühl lagern und innerhalb von 3 Tagen verbrauchen.')).toMatchObject({ kind: 'pantry', moveOnOpen: true });
  });
  it('cool and dry is a pantry hint, plain "kühl lagern" is a fridge hint', () => {
    expect(d(['en:sauces'], 'Kühl und trocken lagern').kind).toBe('pantry');
    expect(d([], 'Kühl lagern bei +2 °C bis +7 °C').kind).toBe('fridge');
  });
  it('drugstore / household / pet food -> pantry, no fridge move', () => {
    expect(d([], null, 'obf')).toMatchObject({ kind: 'pantry', moveOnOpen: false });
    expect(d(['en:dairies'], null, 'opff').kind).toBe('pantry');
  });
  it('no data -> undecided', () => {
    expect(d(null).kind).toBeNull();
    expect(d([]).kind).toBeNull();
  });
});

describe('guessKindFromName', () => {
  it('maps the default locations', () => {
    expect(guessKindFromName('Kühlschrank')).toBe('fridge');
    expect(guessKindFromName('Tiefkühler')).toBe('freezer');
    expect(guessKindFromName('Gefrierschrank')).toBe('freezer');
    expect(guessKindFromName('Vorratsschrank')).toBe('pantry');
    expect(guessKindFromName('Keller')).toBe('other');
  });
});
