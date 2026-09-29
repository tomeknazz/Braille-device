// Persists course progress in localStorage. Storage may be missing or throw
// (private window, blocked site data) — the course then simply runs from an
// empty state for this session. Profiles and IndexedDB come with week 7.

import type { Curriculum } from './curriculum';
import { emptyLeitner, sanitizeLeitner, type LeitnerState } from './leitner';
import { CourseProgress, emptyProgress, sanitize } from './progress';

export const PROGRESS_KEY = 'braillelab.progress.v1';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadProgress(curriculum: Curriculum): CourseProgress {
  try {
    const raw = storage()?.getItem(PROGRESS_KEY);
    return new CourseProgress(curriculum, raw ? sanitize(JSON.parse(raw), curriculum) : emptyProgress());
  } catch {
    return new CourseProgress(curriculum);
  }
}

/** Returns false when the progress could not be saved. */
export function saveProgress(progress: CourseProgress): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(PROGRESS_KEY, JSON.stringify(progress.toJSON()));
    return true;
  } catch {
    return false;
  }
}

export const LEITNER_KEY = 'braillelab.leitner.v1';

export function loadLeitner(): LeitnerState {
  try {
    const raw = storage()?.getItem(LEITNER_KEY);
    return raw ? sanitizeLeitner(JSON.parse(raw)) : emptyLeitner();
  } catch {
    return emptyLeitner();
  }
}

/** Returns false when the review state could not be saved. */
export function saveLeitner(state: LeitnerState): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(LEITNER_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
