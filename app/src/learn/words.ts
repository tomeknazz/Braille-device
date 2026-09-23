// Word material for the "Słowa" mode (docs/DYDAKTYKA.md §3, §4.6): every
// word from words.json is translated, checked (letters only, at most 5
// cells) and tagged with the lessons its letters come from. A word is
// offered only when all those lessons are open to the learner.

import { letterByChar } from '../braille/table';
import { CELLS_PER_PAGE, translate } from '../braille/translator';
import { curriculum as defaultCurriculum, type Curriculum, type Lesson } from './curriculum';
import type { LessonStatus } from './progress';
import data from './words.json';

export interface WordEntry {
  word: string;
  /** Braille masks, one per letter (cells 1..n of the device). */
  cells: number[];
  /** Letters in order. */
  letters: string[];
  /** Polish spoken letter names, e.g. ["ka", "o", "te"]. */
  names: string[];
  /** Index (in curriculum.lessons) of the latest lesson the word needs. */
  lessonIndex: number;
  /** Id of that lesson, e.g. "L4" for "kot" (k, o from L3; t from L4). */
  lessonId: string;
  /** Every lesson its letters come from, in course order. */
  lessons: string[];
}

export interface RawWords {
  version: number;
  description?: string;
  words: string[];
}

/** Letter -> index of the letters lesson that teaches it. */
function letterLessons(curriculum: Curriculum): Map<string, number> {
  const map = new Map<string, number>();
  curriculum.lessons.forEach((lesson, i) => {
    if (lesson.kind !== 'letters') return;
    for (const item of lesson.items) if (!map.has(item.key)) map.set(item.key, i);
  });
  return map;
}

/** Builds and validates the word list; throws on the first bad word. */
export function buildWords(
  raw: RawWords,
  curriculum: Curriculum = defaultCurriculum,
  maxCells: number = CELLS_PER_PAGE,
): WordEntry[] {
  if (!Array.isArray(raw.words)) throw new Error('words: "words" must be an array');
  const byLetter = letterLessons(curriculum);
  const seen = new Set<string>();
  const out: WordEntry[] = [];

  for (const word of raw.words) {
    if (typeof word !== 'string' || word.length === 0) throw new Error(`words: invalid entry ${JSON.stringify(word)}`);
    if (word !== word.normalize('NFC') || word !== word.toLocaleLowerCase('pl') || word.trim() !== word) {
      throw new Error(`words: "${word}" must be lower-case NFC without spaces around`);
    }
    if (seen.has(word)) throw new Error(`words: duplicate "${word}"`);
    seen.add(word);

    const t = translate(word);
    if (t.unknown.length) {
      throw new Error(`words: "${word}" has characters missing from the braille table: ${t.unknown.map((u) => u.char).join(' ')}`);
    }
    const nonLetter = t.segments.find((s) => s.kind !== 'letter');
    if (nonLetter) throw new Error(`words: "${word}" may contain letters only (found ${nonLetter.label})`);
    if (t.cells.length > maxCells) throw new Error(`words: "${word}" needs ${t.cells.length} cells, the device has ${maxCells}`);

    const letters = t.segments.map((s) => s.label);
    const lessonIdx = letters.map((ch) => {
      const i = byLetter.get(ch);
      if (i === undefined) throw new Error(`words: "${word}" uses "${ch}", which no lesson teaches`);
      return i;
    });
    const lessonIndex = Math.max(...lessonIdx);
    out.push({
      word,
      cells: t.cells,
      letters,
      names: letters.map((ch) => letterByChar.get(ch)!.name),
      lessonIndex,
      lessonId: curriculum.lessons[lessonIndex]!.id,
      lessons: [...new Set(lessonIdx)].sort((a, b) => a - b).map((i) => curriculum.lessons[i]!.id),
    });
  }
  return out;
}

export const words: readonly WordEntry[] = buildWords(data as RawWords);

/** The part of CourseProgress the word picker needs (easy to fake in tests). */
export interface LessonAccess {
  status(lessonId: string): LessonStatus;
  current(): Lesson;
}

/** Words whose every letter comes from a lesson that is not locked. */
export function availableWords(list: readonly WordEntry[], access: Pick<LessonAccess, 'status'>): WordEntry[] {
  const open = new Map<string, boolean>();
  const isOpen = (id: string) => {
    let v = open.get(id);
    if (v === undefined) open.set(id, (v = access.status(id) !== 'locked'));
    return v;
  };
  return list.filter((w) => w.lessons.every(isOpen));
}

/** Words that use at least one letter of `lesson` (none for the dots lesson). */
export function wordsWithLessonLetters(list: readonly WordEntry[], lesson: Lesson): WordEntry[] {
  if (lesson.kind !== 'letters') return [];
  return list.filter((w) => w.lessons.includes(lesson.id));
}

/** Share of picks taken from the current lesson's words when there are any. */
export const PREFER_CURRENT = 0.7;

/**
 * Picks the next word: from the words of the current lesson with
 * probability PREFER_CURRENT (the rest keeps older letters fresh), never
 * one of the `recent` words unless nothing else is left (and even then not
 * the last one). Null when no word is available yet.
 */
export function pickWord(
  list: readonly WordEntry[],
  access: LessonAccess,
  random: () => number = Math.random,
  recent: readonly string[] = [],
): WordEntry | null {
  const pool = availableWords(list, access);
  if (pool.length === 0) return null;
  const notRecent = (ws: WordEntry[]) => ws.filter((w) => !recent.includes(w.word));
  const preferred = notRecent(wordsWithLessonLetters(pool, access.current()));
  const rest = notRecent(pool);
  // Everything was seen lately: at least do not repeat the very last word.
  const last = recent[recent.length - 1];
  const fallback = pool.length > 1 ? pool.filter((w) => w.word !== last) : pool;
  const from = preferred.length && random() < PREFER_CURRENT ? preferred : rest.length ? rest : fallback;
  const i = Math.min(from.length - 1, Math.floor(random() * from.length));
  return from[i]!;
}
