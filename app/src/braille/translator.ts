// Text -> braille cell masks (Polish, uncontracted).
//
// Rules implemented (docs/PROPOZYCJA.md §5, docs/DYDAKTYKA.md §1):
//  - input is NFC-normalised, so "z" + combining dot above becomes "ż";
//  - letters are lower-cased; the capital sign (dots 4-6) is optional and OFF
//    by default, since beginners meet it only in the last lesson (L8);
//  - a run of digits gets ONE number sign, then each digit uses the a-j cell;
//  - any run of whitespace becomes a single blank cell (leading/trailing trimmed);
//  - characters with no table entry are reported in `unknown`, never silently
//    dropped without a trace.

import {
  CAPITAL_SIGN,
  NUMBER_SIGN,
  digitByChar,
  letterByChar,
  maskToChar,
  punctuationByChar,
} from './table';

export { maskToChar };

export const CELLS_PER_PAGE = 5;

export type SegmentKind = 'letter' | 'digit' | 'punctuation' | 'space' | 'sign';

/** One source character (or inserted sign) and the cells it produced. */
export interface Segment {
  kind: SegmentKind;
  /** Source text for this segment ("" for inserted signs). */
  source: string;
  cells: number[];
  /** Human-readable label, e.g. "k", "znak liczby", "spacja". */
  label: string;
}

export interface UnknownChar {
  char: string;
  /** Index in code points of the NFC-normalised input. */
  index: number;
}

export interface TranslateOptions {
  /** Insert the capital sign (dots 4-6) before upper-case letters. Default false. */
  capitalSign?: boolean;
}

export interface Translation {
  /** NFC-normalised input. */
  normalized: string;
  cells: number[];
  segments: Segment[];
  unknown: UnknownChar[];
  warnings: string[];
}

const WS = /\s/u;

function isLetterChar(ch: string): boolean {
  return letterByChar.has(ch.toLocaleLowerCase('pl'));
}

function isUpper(ch: string): boolean {
  return ch !== ch.toLocaleLowerCase('pl') && ch === ch.toLocaleUpperCase('pl');
}

export function translate(text: string, options: TranslateOptions = {}): Translation {
  const capitalSign = options.capitalSign ?? false;
  const normalized = text.normalize('NFC');
  const chars = Array.from(normalized);

  const segments: Segment[] = [];
  const unknown: UnknownChar[] = [];
  const warnings = new Set<string>();

  let inNumber = false;
  let pendingSpace = false;
  // Index up to which the current upper-case word has already had "⠨⠨" emitted.
  let capsWordEnd = -1;

  const pushSign = (mask: number, label: string) =>
    segments.push({ kind: 'sign', source: '', cells: [mask], label });

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;

    if (WS.test(ch)) {
      inNumber = false;
      if (segments.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      segments.push({ kind: 'space', source: ' ', cells: [0], label: 'spacja' });
      pendingSpace = false;
    }

    const digit = digitByChar.get(ch);
    if (digit) {
      if (!inNumber) pushSign(NUMBER_SIGN.mask, NUMBER_SIGN.name);
      inNumber = true;
      segments.push({ kind: 'digit', source: ch, cells: [digit.mask], label: ch });
      continue;
    }

    const lower = ch.toLocaleLowerCase('pl');
    const letter = letterByChar.get(lower);
    if (letter) {
      if (inNumber && isDigitLetter(lower)) {
        warnings.add(
          'Litera a–j tuż po cyfrze wymaga znaku rozdzielającego (jeszcze niezweryfikowanego) — ' +
            'bez niego zostanie odczytana jako cyfra.',
        );
      }
      inNumber = false;

      if (capitalSign && isUpper(ch)) {
        const startsWord = i === 0 || !isLetterChar(chars[i - 1]!);
        if (startsWord) {
          let end = i;
          while (end < chars.length && isLetterChar(chars[end]!)) end++;
          const word = chars.slice(i, end);
          if (word.length >= 2 && word.every(isUpper)) {
            pushSign(CAPITAL_SIGN.mask, CAPITAL_SIGN.name);
            pushSign(CAPITAL_SIGN.mask, CAPITAL_SIGN.name);
            capsWordEnd = end;
          }
        }
        if (i >= capsWordEnd) pushSign(CAPITAL_SIGN.mask, CAPITAL_SIGN.name);
        if (!CAPITAL_SIGN.verified) {
          warnings.add('Znak wielkiej litery (punkty 4-6) nie jest jeszcze zweryfikowany z normą PZN.');
        }
      }
      segments.push({ kind: 'letter', source: ch, cells: [letter.mask], label: letter.char });
      continue;
    }

    const punct = punctuationByChar.get(ch);
    if (punct) {
      inNumber = false;
      segments.push({ kind: 'punctuation', source: ch, cells: [punct.mask], label: punct.name });
      if (!punct.verified) {
        warnings.add('Znaki interpunkcyjne nie są jeszcze zweryfikowane z normą PZN.');
      }
      continue;
    }

    inNumber = false;
    unknown.push({ char: ch, index: i });
  }

  const cells = segments.flatMap((s) => s.cells);
  return { normalized, cells, segments, unknown, warnings: [...warnings] };
}

function isDigitLetter(lower: string): boolean {
  return 'abcdefghij'.includes(lower) && lower.length === 1;
}

/** Splits cells into pages of `size` cells (the device has 5). */
export function paginate(cells: readonly number[], size: number = CELLS_PER_PAGE): number[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`Invalid page size: ${size}`);
  const pages: number[][] = [];
  for (let i = 0; i < cells.length; i += size) pages.push(cells.slice(i, i + size));
  return pages;
}

/** Cells -> Unicode braille string, e.g. [5, 21, 30] -> "⠅⠕⠞". */
export function cellsToBraille(cells: readonly number[]): string {
  return cells.map(maskToChar).join('');
}
