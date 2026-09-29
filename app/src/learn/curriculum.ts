// Typed access to curriculum.json: lessons L0-L7, each resolved to concrete
// cell masks via the braille table. The course order is data — only the
// validation below knows the rules it must respect.

import { dotsToMask, letterByChar, MAX_MASK } from '../braille/table';
import data from './curriculum.json';

/** One thing the learner must recognise: a single cell with a known answer. */
export interface LessonItem {
  /** Stable key used in progress records ("a", "ż", "dot3"). */
  key: string;
  mask: number;
  /** What the learner types to answer: the letter, or the dot number in L0. */
  answer: string;
  /** Polish spoken form, e.g. "em" or "punkt 3". */
  spoken: string;
}

export interface LessonRule {
  /** Earlier lesson whose items, with `addDots` raised, give this lesson's items. */
  from: string;
  addDots: number[];
}

export interface Lesson {
  id: string;
  title: string;
  kind: 'dots' | 'letters';
  items: LessonItem[];
  note: string;
  rule?: LessonRule;
}

export interface UnlockPolicy {
  /** How many most recent attempts are evaluated. */
  window: number;
  /** Share of correct answers in the window needed to pass (0-1). */
  minAccuracy: number;
  /** Optional: median answer time in the window must not exceed this. */
  maxMedianMs: number | null;
}

interface RawLesson {
  id: string;
  title: string;
  kind: string;
  items: string[];
  note: string;
  rule?: LessonRule;
}

interface RawCurriculum {
  version: number;
  description: string;
  unlock: UnlockPolicy;
  lessons: RawLesson[];
}

export interface Curriculum {
  version: number;
  unlock: UnlockPolicy;
  lessons: Lesson[];
}

function resolveItem(kind: Lesson['kind'], raw: string, lessonId: string): LessonItem {
  if (kind === 'dots') {
    const dot = Number(raw);
    if (!Number.isInteger(dot) || dot < 1 || dot > 6) {
      throw new Error(`curriculum ${lessonId}: "${raw}" is not a dot number 1-6`);
    }
    return { key: `dot${dot}`, mask: dotsToMask([dot]), answer: String(dot), spoken: `punkt ${dot}` };
  }
  const letter = letterByChar.get(raw);
  if (!letter) throw new Error(`curriculum ${lessonId}: "${raw}" is not in pl-braille.json`);
  return { key: letter.char, mask: letter.mask, answer: letter.char, spoken: letter.name };
}

/** Builds and validates the curriculum; throws on any inconsistency. */
export function buildCurriculum(raw: RawCurriculum): Curriculum {
  const { window, minAccuracy, maxMedianMs } = raw.unlock;
  if (!Number.isInteger(window) || window < 1) throw new Error('curriculum: unlock.window must be >= 1');
  if (!(minAccuracy > 0 && minAccuracy <= 1)) throw new Error('curriculum: unlock.minAccuracy must be in (0, 1]');
  if (maxMedianMs !== null && !(maxMedianMs > 0)) throw new Error('curriculum: unlock.maxMedianMs must be > 0 or null');

  const lessons: Lesson[] = [];
  const byId = new Map<string, Lesson>();
  for (const r of raw.lessons) {
    if (byId.has(r.id)) throw new Error(`curriculum: duplicate lesson id ${r.id}`);
    if (r.kind !== 'dots' && r.kind !== 'letters') throw new Error(`curriculum ${r.id}: unknown kind "${r.kind}"`);
    if (r.items.length === 0) throw new Error(`curriculum ${r.id}: no items`);
    const items = r.items.map((i) => resolveItem(r.kind as Lesson['kind'], i, r.id));
    if (new Set(items.map((i) => i.key)).size !== items.length) {
      throw new Error(`curriculum ${r.id}: duplicate items`);
    }
    const lesson: Lesson = { id: r.id, title: r.title, kind: r.kind, items, note: r.note };
    if (r.rule) {
      // A rule may only refer back, and must actually hold for every item.
      const base = byId.get(r.rule.from);
      if (!base) throw new Error(`curriculum ${r.id}: rule.from ${r.rule.from} is not an earlier lesson`);
      if (base.items.length !== items.length) throw new Error(`curriculum ${r.id}: rule needs as many items as ${base.id}`);
      const add = dotsToMask(r.rule.addDots);
      items.forEach((item, i) => {
        const expected = base.items[i]!.mask | add;
        if (item.mask !== expected) {
          throw new Error(`curriculum ${r.id}: "${item.key}" is not "${base.items[i]!.key}" + dots ${r.rule!.addDots.join(',')}`);
        }
      });
      lesson.rule = { from: r.rule.from, addDots: [...r.rule.addDots] };
    }
    for (const item of items) {
      if (item.mask <= 0 || item.mask > MAX_MASK) throw new Error(`curriculum ${r.id}: bad mask for ${item.key}`);
    }
    lessons.push(lesson);
    byId.set(lesson.id, lesson);
  }
  return { version: raw.version, unlock: { window, minAccuracy, maxMedianMs }, lessons };
}

export const curriculum: Curriculum = buildCurriculum(data as RawCurriculum);

export function lessonById(id: string): Lesson | undefined {
  return curriculum.lessons.find((l) => l.id === id);
}
