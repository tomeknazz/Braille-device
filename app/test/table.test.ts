import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPITAL_SIGN,
  NUMBER_SIGN,
  charToMask,
  dotsToMask,
  letterByChar,
  maskToChar,
  maskToDots,
  table,
} from '../src/braille/table';

const allEntries = [
  ...table.letters.map((e) => ({ group: 'letters', key: e.char, ...e })),
  ...table.signs.map((e) => ({ group: 'signs', key: e.id, ...e })),
  ...table.digits.map((e) => ({ group: 'digits', key: e.char, ...e })),
  ...table.punctuation.map((e) => ({ group: 'punctuation', key: e.char, ...e })),
];

describe('pl-braille.json', () => {
  it.each(allEntries)('$group "$key": mask equals the sum of 2^(dot-1)', (e) => {
    expect(e.dots.length).toBeGreaterThan(0);
    expect([...e.dots].sort((a, b) => a - b)).toEqual(e.dots); // ascending
    expect(new Set(e.dots).size).toBe(e.dots.length); // no duplicates
    for (const d of e.dots) expect(d >= 1 && d <= 6).toBe(true);
    expect(e.mask).toBe(e.dots.reduce((s, d) => s + 2 ** (d - 1), 0));
    expect(dotsToMask(e.dots)).toBe(e.mask);
    expect(maskToDots(e.mask)).toEqual(e.dots);
    expect(typeof e.verified).toBe('boolean');
  });

  it('has a-z and the nine Polish diacritics, all verified', () => {
    const chars = table.letters.map((l) => l.char).join('');
    expect(chars).toBe('abcdefghijklmnopqrstuvwxyząćęłńóśźż');
    expect(table.letters.every((l) => l.verified)).toBe(true);
  });

  it('letter masks are unique', () => {
    const masks = table.letters.map((l) => l.mask);
    expect(new Set(masks).size).toBe(masks.length);
  });

  it('uses exactly the diacritic masks from PROPOZYCJA.md §5', () => {
    const expected: Record<string, number> = { ą: 33, ć: 41, ę: 49, ł: 35, ń: 57, ó: 44, ś: 42, ź: 46, ż: 47 };
    for (const [ch, mask] of Object.entries(expected)) expect(letterByChar.get(ch)?.mask).toBe(mask);
  });

  it('signs: number sign 3456 = 60 (verified), capital sign 46 = 40 (unverified)', () => {
    expect(NUMBER_SIGN.mask).toBe(60);
    expect(NUMBER_SIGN.verified).toBe(true);
    expect(CAPITAL_SIGN.mask).toBe(40);
    expect(CAPITAL_SIGN.verified).toBe(false);
  });

  it('signs and punctuation do not collide with letters or with each other', () => {
    const letterMasks = new Set(table.letters.map((l) => l.mask));
    const others = [...table.signs, ...table.punctuation].map((e) => e.mask);
    for (const m of others) expect(letterMasks.has(m)).toBe(false);
    expect(new Set(others).size).toBe(others.length);
  });

  it('punctuation is marked unverified', () => {
    expect(table.punctuation.length).toBeGreaterThan(0);
    expect(table.punctuation.every((p) => !p.verified)).toBe(true);
  });

  it('digits 1-9,0 reuse the cells of a-j and are verified', () => {
    const letters = 'abcdefghij';
    for (const d of table.digits) {
      const idx = d.char === '0' ? 9 : Number(d.char) - 1;
      expect(d.letter).toBe(letters[idx]);
      expect(d.mask).toBe(letterByChar.get(d.letter)?.mask);
      expect(d.verified).toBe(true);
    }
    expect(table.digits.map((d) => d.char).sort().join('')).toBe('0123456789');
  });

  it('matches Unicode braille (U+2800 + mask) for known glyphs', () => {
    const glyphs: Record<string, string> = { a: '⠁', m: '⠍', w: '⠺', ż: '⠯', ó: '⠬', ł: '⠣' };
    for (const [ch, glyph] of Object.entries(glyphs)) {
      const mask = letterByChar.get(ch)!.mask;
      expect(maskToChar(mask)).toBe(glyph);
      expect(charToMask(glyph)).toBe(mask);
    }
    expect(maskToChar(NUMBER_SIGN.mask)).toBe('⠼');
    expect(charToMask('a')).toBeNull();
  });

  // Cross-check a-z against the firmware table so the app and the device's own
  // `<letter>` command never disagree. Skipped if main.cpp is not next to app/.
  const mainCpp = fileURLToPath(new URL('../../src/main.cpp', import.meta.url));
  const rowRe =
    /\{\s*([01])\s*,\s*([01])\s*,\s*([01])\s*,\s*([01])\s*,\s*([01])\s*,\s*([01])\s*\}\s*,?\s*\/\/\s*([A-Z])\b/g;
  const rows = existsSync(mainCpp) ? [...readFileSync(mainCpp, 'utf8').matchAll(rowRe)] : [];
  it.runIf(rows.length === 26)('a-z match braille_alphabet in src/main.cpp', () => {
    for (const r of rows) {
      const bits = r.slice(1, 7).map(Number);
      const mask = bits.reduce((s, b, i) => s + (b << i), 0);
      expect(letterByChar.get(r[7]!.toLowerCase())?.mask, r[7]).toBe(mask);
    }
  });
});
