import { describe, expect, it } from 'vitest';
import { cellsToBraille, maskToChar, paginate, translate } from '../src/braille/translator';

describe('translate', () => {
  it('kot -> 5,21,30', () => {
    const t = translate('kot');
    expect(t.cells).toEqual([5, 21, 30]);
    expect(t.unknown).toEqual([]);
  });

  it('żaba -> 47,1,3,1', () => {
    expect(translate('żaba').cells).toEqual([47, 1, 3, 1]);
  });

  it('normalises to NFC (z + combining dot above = ż)', () => {
    const decomposed = 'żaba';
    expect(decomposed.length).toBe(5);
    const t = translate(decomposed);
    expect(t.normalized).toBe('żaba');
    expect(t.cells).toEqual([47, 1, 3, 1]);
  });

  it('2026 -> number sign once, then b j b f', () => {
    expect(translate('2026').cells).toEqual([60, 3, 26, 3, 11]);
  });

  it('a new number sign after a non-digit', () => {
    expect(translate('1 2').cells).toEqual([60, 1, 0, 60, 3]);
    expect(translate('1-2').cells).toEqual([60, 1, 36, 60, 3]);
  });

  it('lower-cases by default without a capital sign', () => {
    const t = translate('Kot');
    expect(t.cells).toEqual([5, 21, 30]);
    expect(t.warnings).toEqual([]);
  });

  it('optional capital sign: single before a capital, double for an all-caps word', () => {
    expect(translate('Ala', { capitalSign: true }).cells).toEqual([40, 1, 7, 1]);
    expect(translate('KOT', { capitalSign: true }).cells).toEqual([40, 40, 5, 21, 30]);
    expect(translate('A', { capitalSign: true }).cells).toEqual([40, 1]);
    const t = translate('Ala', { capitalSign: true });
    // Dots 4-6 are confirmed, so the capital sign no longer raises a warning.
    expect(t.warnings.some((w) => w.includes('wielkiej litery'))).toBe(false);
  });

  it('handles Polish upper-case diacritics', () => {
    expect(translate('ŻÓŁW').cells).toEqual([47, 44, 35, 58]);
  });

  it('collapses whitespace to one blank cell and trims the ends', () => {
    expect(translate('  ala   ma \n kota ').cells).toEqual([1, 7, 1, 0, 13, 1, 0, 5, 21, 30, 1]);
  });

  it('reports unknown characters instead of dropping them silently', () => {
    const t = translate('a@b€');
    expect(t.cells).toEqual([1, 3]);
    expect(t.unknown).toEqual([
      { char: '@', index: 1 },
      { char: '€', index: 3 },
    ]);
  });

  it('reports unknown astral characters by code point index', () => {
    const t = translate('a😀b');
    expect(t.unknown).toEqual([{ char: '😀', index: 1 }]);
    expect(t.cells).toEqual([1, 3]);
  });

  it('translates basic punctuation and warns that it is unverified', () => {
    const t = translate('tak, nie.');
    expect(t.cells).toEqual([30, 1, 5, 2, 0, 29, 10, 17, 4]);
    expect(t.warnings.length).toBe(1);
  });

  it('warns about a-j right after a digit (separator sign not implemented)', () => {
    const t = translate('5a');
    expect(t.cells).toEqual([60, 17, 1]);
    expect(t.warnings.some((w) => w.includes('po cyfrze'))).toBe(true);
    expect(translate('5 a').warnings).toEqual([]);
  });

  it('empty input gives no cells', () => {
    expect(translate('').cells).toEqual([]);
    expect(translate('   ').cells).toEqual([]);
  });

  it('segments map every cell back to its source', () => {
    const t = translate('a1');
    expect(t.segments.map((s) => [s.kind, s.label, s.cells])).toEqual([
      ['letter', 'a', [1]],
      ['sign', 'znak liczby', [60]],
      ['digit', '1', [1]],
    ]);
  });
});

describe('paginate', () => {
  it('splits into pages of 5 cells', () => {
    const cells = translate('ala ma kota').cells; // 11 cells
    expect(paginate(cells, 5)).toEqual([
      [1, 7, 1, 0, 13],
      [1, 0, 5, 21, 30],
      [1],
    ]);
  });

  it('defaults to 5 and returns no pages for no cells', () => {
    expect(paginate([1, 2, 3, 4, 5, 6])).toEqual([[1, 2, 3, 4, 5], [6]]);
    expect(paginate([])).toEqual([]);
  });

  it('rejects invalid page sizes', () => {
    expect(() => paginate([1], 0)).toThrow(RangeError);
  });
});

describe('Unicode helpers', () => {
  it('maskToChar = U+2800 + mask', () => {
    expect(maskToChar(0)).toBe('⠀');
    expect(maskToChar(63)).toBe('⠿');
    expect(cellsToBraille([5, 21, 30])).toBe('⠅⠕⠞');
    expect(() => maskToChar(64)).toThrow(RangeError);
  });
});
