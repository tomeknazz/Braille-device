import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_LABEL,
  cellsToBraille,
  maskToChar,
  paginate,
  paginateSegments,
  translate,
} from '../src/braille/translator';

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

describe('paginateSegments (word-aware paging)', () => {
  const pagesOf = (text: string, size?: number) => paginateSegments(translate(text), size);
  const brailleOf = (text: string, size?: number) => pagesOf(text, size).map((p) => cellsToBraille(p.cells));

  it('never splits "⠼2026": "Żaba i kot 2026" -> żaba | i kot | ⠼2026', () => {
    const pages = pagesOf('Żaba i kot 2026');
    expect(pages.map((p) => p.labels)).toEqual([
      ['ż', 'a', 'b', 'a'],
      ['i', 'spacja', 'k', 'o', 't'],
      ['znak liczby', '2', '0', '2', '6'],
    ]);
    expect(pages[2]!.cells).toEqual([60, 3, 26, 3, 11]);
    expect(pages.every((p) => !p.continued)).toBe(true);
    // The old cell-based paging cut the number in two.
    expect(paginate(translate('Żaba i kot 2026').cells)).toHaveLength(4);
  });

  it('packs short words on one page, separated by one blank, and breaks between words', () => {
    // ala(3) + blank + ma(2) = 6 > 5, so "ma" starts a new page; "kota" too.
    expect(pagesOf('ala ma kota').map((p) => p.cells)).toEqual([
      [1, 7, 1],
      [13, 1],
      [5, 21, 30, 1],
    ]);
    expect(brailleOf('a b c')).toEqual(['⠁⠀⠃⠀⠉']);
    expect(pagesOf('a b c')[0]!.labels).toEqual(['a', 'spacja', 'b', 'spacja', 'c']);
  });

  it('keeps pages that are exactly full and never starts a page with a blank', () => {
    const pages = pagesOf('żaba i kot dom');
    expect(pages.map((p) => p.cells.length)).toEqual([4, 5, 3]);
    for (const p of pages) {
      expect(p.cells[0]).not.toBe(0);
      expect(p.cells.length).toBeLessThanOrEqual(5);
      expect(p.labels).toHaveLength(p.cells.length);
    }
  });

  it('splits a word longer than the display with a trailing continuation blank', () => {
    const pages = pagesOf('łóżeczko');
    expect(pages.map((p) => p.labels)).toEqual([
      ['ł', 'ó', 'ż', 'e', CONTINUATION_LABEL],
      ['c', 'z', 'k', 'o'],
    ]);
    expect(pages[0]!.cells[4]).toBe(0);
    expect(pages.map((p) => p.continued)).toEqual([true, false]);
    // A 10-letter word needs three pages: 4 + blank, 4 + blank, 2.
    expect(pagesOf('konstytucj').map((p) => p.cells.length)).toEqual([5, 5, 2]);
  });

  it('the tail of a long word may share its page with the next short word', () => {
    expect(pagesOf('kotkom a').map((p) => p.labels)).toEqual([
      ['k', 'o', 't', 'k', CONTINUATION_LABEL],
      ['o', 'm', 'spacja', 'a'],
    ]);
  });

  it('a word of exactly 5 cells is not split', () => {
    expect(pagesOf('mleko ser').map((p) => p.labels.join(','))).toEqual(['m,l,e,k,o', 's,e,r']);
  });

  it('repeats the number sign when a long number has to be split', () => {
    const pages = pagesOf('1234567');
    expect(pages.map((p) => p.labels)).toEqual([
      ['znak liczby', '1', '2', '3', CONTINUATION_LABEL],
      ['znak liczby', '4', '5', '6', '7'],
    ]);
  });

  it('repeats the capital-word sign when a long all-caps word has to be split', () => {
    const caps = 'znak wielkiej litery';
    const pages = paginateSegments(translate('KONSTYTUCJA', { capitalSign: true }));
    for (const p of pages) expect(p.labels.slice(0, 2)).toEqual([caps, caps]);
    expect(pages.map((p) => p.labels.slice(2).filter((l) => l !== CONTINUATION_LABEL).join(''))).toEqual([
      'ko', 'ns', 'ty', 'tu', 'cja',
    ]);
    for (const p of pages) expect(p.cells.length).toBeLessThanOrEqual(5);
    // Only the capitals of the word: a lower-case tail after punctuation stays bare.
    const mixed = paginateSegments(translate('KOTY,abcdef', { capitalSign: true }));
    expect(mixed.map((p) => p.labels)).toEqual([
      [caps, caps, 'k', 'o', CONTINUATION_LABEL],
      [caps, caps, 't', 'y', CONTINUATION_LABEL],
      ['przecinek', 'a', 'b', 'c', CONTINUATION_LABEL],
      ['d', 'e', 'f'],
    ]);
    // A single capital (a name) marks only the first letter: nothing to repeat.
    const name = paginateSegments(translate('Konstytucja', { capitalSign: true }));
    expect(name.map((p) => p.labels[0])).toEqual([caps, 's', 'u']);
  });

  it('never leaves a sign at the end of a page, away from its cell', () => {
    // "kot12" = k o t ⠼ 1 2 (6 cells): the number sign must travel with "1".
    const pages = pagesOf('kot12');
    expect(pages.map((p) => p.labels)).toEqual([
      ['k', 'o', 't', CONTINUATION_LABEL],
      ['znak liczby', '1', '2'],
    ]);
  });

  it('keeps punctuation attached to its word', () => {
    expect(pagesOf('tak, nie.').map((p) => p.labels)).toEqual([
      ['t', 'a', 'k', 'przecinek'],
      ['n', 'i', 'e', 'kropka'],
    ]);
  });

  it('handles empty input and custom page sizes', () => {
    expect(pagesOf('')).toEqual([]);
    expect(pagesOf('   ')).toEqual([]);
    expect(brailleOf('ala ma', 3)).toEqual(['⠁⠇⠁', '⠍⠁']);
    // A 1-cell page has no room for a continuation blank.
    expect(pagesOf('kot', 1).map((p) => p.cells)).toEqual([[5], [21], [30]]);
    expect(() => pagesOf('a', 0)).toThrow(RangeError);
  });

  it('every page fits the display and keeps all the text cells in order', () => {
    const text = 'Wlazł kotek na płotek i mruga, ładna to piosenka, niedługa 12345678';
    const t = translate(text);
    const pages = paginateSegments(t);
    const content = pages.flatMap((p) => p.labels.filter((l) => l !== 'spacja' && l !== CONTINUATION_LABEL && l !== 'znak liczby'));
    const expected = t.segments.filter((s) => s.kind !== 'space' && s.kind !== 'sign').map((s) => s.label);
    expect(content).toEqual(expected);
    for (const p of pages) {
      expect(p.cells.length).toBeGreaterThan(0);
      expect(p.cells.length).toBeLessThanOrEqual(5);
      expect(p.cells[0]).not.toBe(0);
    }
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
