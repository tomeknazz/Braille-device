// The learner's state for this browser, shared by every mode: course
// progress (Kurs reads it; Rozpoznawanie and Powtórki record attempts) and
// the Leitner boxes (both quiz modes update them).

import { curriculum } from './curriculum';
import { endSession, review, sessionTouched, type AnswerKind, type LeitnerState, type ReviewResult } from './leitner';
import type { Attempt, RecordResult } from './progress';
import { loadLeitner, loadProgress, saveLeitner, saveProgress } from './storage';

export const progress = loadProgress(curriculum);

/** Mutable on purpose: reset replaces its contents in place, so references stay valid. */
export const leitner: LeitnerState = loadLeitner();

/** Records an attempt and saves right away, so a closed tab loses nothing. */
export function recordAttempt(attempt: Attempt): RecordResult {
  const result = progress.record(attempt);
  saveProgress(progress);
  return result;
}

/** Moves a card between Leitner boxes and saves. */
export function recordReview(key: string, kind: AnswerKind, ms: number): ReviewResult {
  const result = review(leitner, key, kind, ms);
  saveLeitner(leitner);
  return result;
}

/** Closes a review session: cards are next checked against a later session number. */
export function finishReviewSession(): void {
  endSession(leitner);
  saveLeitner(leitner);
}

/**
 * Called when a review session starts. If cards were answered under the
 * current number (a session left by closing the tab or switching modes, or
 * practice in Rozpoznawanie since the last review), that period counts as a
 * finished session first, so its cards become due as intended.
 */
export function openReviewSession(): void {
  if (sessionTouched(leitner)) finishReviewSession();
}

export function persist(): boolean {
  return saveProgress(progress);
}

/** Clears course progress and review boxes (teacher option). */
export function resetAll(): void {
  progress.reset();
  saveProgress(progress);
  leitner.session = 1;
  leitner.cards = {};
  leitner.recentMs = [];
  saveLeitner(leitner);
}
