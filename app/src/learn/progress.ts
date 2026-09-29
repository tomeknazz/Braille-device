// Course progress: attempts per lesson and the unlock rule
// (docs/DYDAKTYKA.md §2.1). A lesson is passed once, in its last `window`
// attempts, at least `minAccuracy` were correct (and, if configured, the
// median answer time is within `maxMedianMs`). Passing unlocks the next
// lesson for good — a later bad streak never locks it again.

import type { Curriculum, Lesson, UnlockPolicy } from './curriculum';

export interface Attempt {
  lessonId: string;
  itemKey: string;
  correct: boolean;
  /** Time from "ready to touch" to the answer. */
  ms: number;
  /** Epoch ms, supplied by the caller. */
  at: number;
}

export interface LessonStats {
  /** Attempts counted (at most `window`). */
  attempts: number;
  correct: number;
  /** correct / attempts, or null before the first attempt. */
  accuracy: number | null;
  medianMs: number | null;
  /** Attempts still missing before the window is full. */
  missing: number;
  /** The window is full and the thresholds are met. */
  meetsCriteria: boolean;
}

export type LessonStatus = 'locked' | 'available' | 'passed';

export interface ProgressState {
  version: 1;
  attempts: Record<string, Attempt[]>;
  passed: string[];
  /** Teacher override: every lesson is available. */
  teacherUnlocked: boolean;
}

/** Attempts kept per lesson — enough for statistics, bounded for storage. */
export const MAX_STORED_ATTEMPTS = 200;

export function emptyProgress(): ProgressState {
  return { version: 1, attempts: {}, passed: [], teacherUnlocked: false };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Evaluates the last `policy.window` attempts (chronological order). */
export function evaluate(attempts: readonly Attempt[], policy: UnlockPolicy): LessonStats {
  const recent = attempts.slice(-policy.window);
  const correct = recent.filter((a) => a.correct).length;
  const accuracy = recent.length ? correct / recent.length : null;
  const medianMs = median(recent.map((a) => a.ms));
  const missing = policy.window - recent.length;
  const meetsCriteria =
    missing === 0 &&
    accuracy !== null &&
    // Compare in whole attempts so 0.8 * 20 = 16 is not lost to float error.
    correct >= Math.ceil(policy.minAccuracy * policy.window - 1e-9) &&
    (policy.maxMedianMs === null || (medianMs !== null && medianMs <= policy.maxMedianMs));
  return { attempts: recent.length, correct, accuracy, medianMs, missing, meetsCriteria };
}

export interface RecordResult {
  /** The lesson this attempt just passed, if it did. */
  passed: Lesson | null;
  /** The lesson that became available because of it, if any. */
  unlocked: Lesson | null;
}

export class CourseProgress {
  private state: ProgressState;

  constructor(
    readonly curriculum: Curriculum,
    state: ProgressState = emptyProgress(),
  ) {
    this.state = sanitize(state, curriculum);
  }

  toJSON(): ProgressState {
    return structuredClone(this.state);
  }

  get teacherUnlocked(): boolean {
    return this.state.teacherUnlocked;
  }

  private indexOf(lessonId: string): number {
    const i = this.curriculum.lessons.findIndex((l) => l.id === lessonId);
    if (i < 0) throw new Error(`Unknown lesson ${lessonId}`);
    return i;
  }

  isPassed(lessonId: string): boolean {
    return this.state.passed.includes(lessonId);
  }

  status(lessonId: string): LessonStatus {
    const i = this.indexOf(lessonId);
    if (this.isPassed(lessonId)) return 'passed';
    if (i === 0 || this.state.teacherUnlocked) return 'available';
    return this.isPassed(this.curriculum.lessons[i - 1]!.id) ? 'available' : 'locked';
  }

  attempts(lessonId: string): readonly Attempt[] {
    this.indexOf(lessonId);
    return this.state.attempts[lessonId] ?? [];
  }

  stats(lessonId: string): LessonStats {
    return evaluate(this.attempts(lessonId), this.curriculum.unlock);
  }

  /** The lesson to continue with: the first available one not yet passed. */
  current(): Lesson {
    const lessons = this.curriculum.lessons;
    return lessons.find((l) => this.status(l.id) === 'available') ?? lessons[lessons.length - 1]!;
  }

  record(attempt: Attempt): RecordResult {
    const i = this.indexOf(attempt.lessonId);
    const lesson = this.curriculum.lessons[i]!;
    if (!lesson.items.some((it) => it.key === attempt.itemKey)) {
      throw new Error(`Item "${attempt.itemKey}" is not part of ${lesson.id}`);
    }
    if (this.status(lesson.id) === 'locked') {
      throw new Error(`${lesson.id} is locked`);
    }
    const list = (this.state.attempts[lesson.id] ??= []);
    list.push({ ...attempt });
    if (list.length > MAX_STORED_ATTEMPTS) list.splice(0, list.length - MAX_STORED_ATTEMPTS);

    if (this.isPassed(lesson.id) || !this.stats(lesson.id).meetsCriteria) return { passed: null, unlocked: null };

    const next = this.curriculum.lessons[i + 1];
    const nextWasLocked = next ? this.status(next.id) === 'locked' : false;
    this.state.passed.push(lesson.id);
    return { passed: lesson, unlocked: next && nextWasLocked ? next : null };
  }

  setTeacherUnlocked(on: boolean): void {
    this.state.teacherUnlocked = on;
  }

  reset(): void {
    this.state = emptyProgress();
  }
}

/** Drops anything that does not fit the current curriculum (renamed lessons, bad records). */
export function sanitize(input: unknown, curriculum: Curriculum): ProgressState {
  const out = emptyProgress();
  if (!input || typeof input !== 'object') return out;
  const s = input as Partial<ProgressState>;
  if (s.version !== 1) return out;
  out.teacherUnlocked = s.teacherUnlocked === true;
  for (const lesson of curriculum.lessons) {
    const keys = new Set(lesson.items.map((i) => i.key));
    const raw = s.attempts?.[lesson.id];
    if (Array.isArray(raw)) {
      const valid = raw.filter(
        (a): a is Attempt =>
          !!a &&
          a.lessonId === lesson.id &&
          keys.has(a.itemKey) &&
          typeof a.correct === 'boolean' &&
          Number.isFinite(a.ms) &&
          a.ms >= 0 &&
          Number.isFinite(a.at),
      );
      if (valid.length) out.attempts[lesson.id] = valid.slice(-MAX_STORED_ATTEMPTS).map((a) => ({ ...a }));
    }
    if (Array.isArray(s.passed) && s.passed.includes(lesson.id)) out.passed.push(lesson.id);
  }
  return out;
}
