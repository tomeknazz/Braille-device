// Typed access to pl-braille.json plus small mask helpers.
// Mask encoding (docs/PROTOCOL.md §3): bit0 = dot 1 ... bit5 = dot 6,
// which is exactly the Unicode braille offset: char = U+2800 + mask.

import data from './pl-braille.json';

export const DOTS_PER_CELL = 6;
export const MAX_MASK = 0x3f;
const BRAILLE_BASE = 0x2800;

export interface LetterEntry {
  char: string;
  /** Polish spoken name of the letter (for TTS / announcements). */
  name: string;
  dots: number[];
  mask: number;
  verified: boolean;
}

export interface SignEntry {
  id: 'number' | 'capital';
  name: string;
  dots: number[];
  mask: number;
  verified: boolean;
  note?: string;
}

export interface DigitEntry {
  char: string;
  /** The a-j letter whose cell is reused for this digit. */
  letter: string;
  dots: number[];
  mask: number;
  verified: boolean;
}

export interface PunctuationEntry {
  char: string;
  name: string;
  dots: number[];
  mask: number;
  verified: boolean;
}

export interface BrailleTable {
  version: number;
  description: string;
  source: string;
  letters: LetterEntry[];
  signs: SignEntry[];
  digits: DigitEntry[];
  punctuation: PunctuationEntry[];
}

export const table: BrailleTable = data as BrailleTable;

function findSign(id: SignEntry['id']): SignEntry {
  const s = table.signs.find((x) => x.id === id);
  if (!s) throw new Error(`pl-braille.json: missing sign "${id}"`);
  return s;
}

export const NUMBER_SIGN: SignEntry = findSign('number');
export const CAPITAL_SIGN: SignEntry = findSign('capital');

export const letterByChar: ReadonlyMap<string, LetterEntry> = new Map(
  table.letters.map((e) => [e.char, e]),
);
export const digitByChar: ReadonlyMap<string, DigitEntry> = new Map(
  table.digits.map((e) => [e.char, e]),
);
export const punctuationByChar: ReadonlyMap<string, PunctuationEntry> = new Map(
  table.punctuation.map((e) => [e.char, e]),
);
const letterByMask: ReadonlyMap<number, LetterEntry> = new Map(
  table.letters.map((e) => [e.mask, e]),
);

export function isValidMask(mask: number): boolean {
  return Number.isInteger(mask) && mask >= 0 && mask <= MAX_MASK;
}

/** Dots 1-6 -> mask (sum of 2^(dot-1)). */
export function dotsToMask(dots: readonly number[]): number {
  let mask = 0;
  for (const d of dots) {
    if (!Number.isInteger(d) || d < 1 || d > DOTS_PER_CELL) {
      throw new RangeError(`Invalid dot number: ${d}`);
    }
    mask |= 1 << (d - 1);
  }
  return mask;
}

/** Mask -> ascending list of raised dot numbers. */
export function maskToDots(mask: number): number[] {
  const dots: number[] = [];
  for (let d = 1; d <= DOTS_PER_CELL; d++) if (mask & (1 << (d - 1))) dots.push(d);
  return dots;
}

/** Mask -> Unicode braille character (U+2800 + mask). */
export function maskToChar(mask: number): string {
  if (!isValidMask(mask)) throw new RangeError(`Invalid mask: ${mask}`);
  return String.fromCodePoint(BRAILLE_BASE + mask);
}

/** Unicode 6-dot braille character -> mask, or null for anything else. */
export function charToMask(ch: string): number | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined || ch.length !== 1) return null;
  const mask = cp - BRAILLE_BASE;
  return isValidMask(mask) ? mask : null;
}

/** Letter (a-z, Polish diacritics) that uses this mask, if any. */
export function letterForMask(mask: number): LetterEntry | undefined {
  return letterByMask.get(mask);
}

/**
 * Short Polish description of what a single cell can mean, out of context.
 * Used for the preview caption, e.g. "k", "znak liczby", "pusta".
 */
export function describeMask(mask: number): string {
  if (mask === 0) return 'pusta';
  const parts: string[] = [];
  const letter = letterByMask.get(mask);
  if (letter) parts.push(letter.char);
  for (const s of table.signs) if (s.mask === mask) parts.push(s.name);
  for (const p of table.punctuation) if (p.mask === mask) parts.push(p.name);
  return parts.length ? parts.join(' / ') : 'bez znaczenia w tabeli';
}
