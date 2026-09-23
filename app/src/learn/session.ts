// The learner's course progress for this browser, shared by every mode that
// shows or records it (Kurs reads it, Rozpoznawanie records attempts).

import { curriculum } from './curriculum';
import type { Attempt, RecordResult } from './progress';
import { loadProgress, saveProgress } from './storage';

export const progress = loadProgress(curriculum);

/** Records an attempt and saves right away, so a closed tab loses nothing. */
export function recordAttempt(attempt: Attempt): RecordResult {
  const result = progress.record(attempt);
  saveProgress(progress);
  return result;
}

export function persist(): boolean {
  return saveProgress(progress);
}
